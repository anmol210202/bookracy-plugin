// Harbor eBook source plugin for Bookracy & Open Library Feeds

const BOOKRACY_BASE = "https://api.bookracy.com";
const OPENLIBRARY_BASE = "https://openlibrary.org";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://bookracy.com/",
  Origin: "https://bookracy.com",
};

// In-memory cache to keep IDs clean (hex MD5 only) without breaking Harbor routing
const metadataCache = new Map();

async function fetchJson(url, customHeaders = HEADERS) {
  const res = await harbor.http(url, {
    headers: customHeaders,
    responseType: "text",
    timeoutMs: 15000,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  try {
    return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${err.message}`);
  }
}

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  return BOOKRACY_BASE + (url.startsWith("/") ? url : "/" + url);
}

function cleanTitle(val) {
  return (val || "")
    .replace(/[^\p{L}\p{N}'’\-: ]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const plugin = {
  id: "bookracy-source",
  name: "Bookracy",

  // Popular Shelf: Sources curated trending books with verified covers & metadata
  async popular(offset, tagId) {
    const span = tagId === "sort:rating" ? "daily" : "weekly";
    const page = Math.floor(offset / 30) + 1;
    const url = `${OPENLIBRARY_BASE}/trending/${span}.json?limit=30&page=${page}`;

    const data = await fetchJson(url, { Accept: "application/json" });
    const works = data.works || [];

    return works.map((w) => {
      const title = cleanTitle(w.title || "Untitled");
      const author = (w.author_name && w.author_name[0]) || "Unknown Author";
      const workId = (w.key || "").replace(/^\/works\//, "");
      const cleanId = `ol_${workId || Math.random().toString(36).slice(2, 10)}`;

      metadataCache.set(cleanId, {
        title,
        author,
        openLibraryId: workId || undefined,
        cover: w.cover_i ? `https://covers.openlibrary.org/b/id/${w.cover_i}-L.jpg` : undefined,
      });

      return {
        id: cleanId,
        title,
        author,
        openLibraryId: workId || undefined,
        cover: w.cover_i ? `https://covers.openlibrary.org/b/id/${w.cover_i}-L.jpg` : undefined,
        originalLanguage: "en",
        genres: (w.subject || []).slice(0, 3),
        score: w.ratings_average ? Number(w.ratings_average) : undefined,
        isFanMade: false,
      };
    });
  },

  // Query Search: Direct Bookracy English index lookup
  async search(query, offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let target = query;
    if (tagId?.startsWith("genre:")) {
      target += " " + tagId.slice(6);
    }

    const url = `${BOOKRACY_BASE}/api/books?query=${encodeURIComponent(target)}&lang=en&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];

    return list.map((item) => {
      if (!item || !item.md5) return null;

      const title = cleanTitle(item.title || "Untitled");
      const author = (item.author || "").trim();
      const cleanId = item.md5.trim();

      metadataCache.set(cleanId, {
        title,
        author,
        filetype: item.book_filetype,
        filesize: item.book_size,
      });

      return {
        id: cleanId,
        title,
        author: author || undefined,
        originalLanguage: item.book_lang || "en",
        score: item.score ? Number(item.score) : undefined,
        genres: item.book_filetype ? [item.book_filetype.toUpperCase()] : [],
        isFanMade: false,
      };
    }).filter(Boolean);
  },

  async detail(id) {
    const cached = metadataCache.get(id) || {};
    let title = cached.title || id;
    let author = cached.author || "";
    let cover = cached.cover;
    let openLibraryId = cached.openLibraryId;
    let description = undefined;
    let genres = [];
    let isbn = undefined;
    let score = undefined;

    // Resolve enriched metadata from Bookracy lookup if it's an MD5
    if (!id.startsWith("ol_")) {
      const queryParams = new URLSearchParams();
      if (title) queryParams.set("title", author ? `${title} - ${author}` : title);
      if (author) queryParams.set("author", author);

      try {
        const data = await fetchJson(`${BOOKRACY_BASE}/api/metadata/${id}?${queryParams.toString()}`);
        const meta = data?.metadata || data || {};

        title = cleanTitle(meta.title || title);
        author = (meta.author || author).trim();
        cover = abs(meta.cover) || cover;
        description = meta.description || meta.synopsis;
        genres = Array.isArray(meta.genres) ? meta.genres : genres;
        isbn = meta.isbn || undefined;
        score = meta.rating ? Number(meta.rating) : undefined;
      } catch {
        // Fall back to clean title and author
      }
    }

    return {
      id,
      title,
      author: author || undefined,
      cover,
      openLibraryId,
      description: description || `Available via Bookracy eBook index.`,
      genres,
      isbn,
      score,
      chapters: 1,
      originalLanguage: "en",
      isFanMade: false,
    };
  },

  async chapters(id) {
    return [
      {
        id: `${id}_full`,
        chapter: "1",
        position: 0,
        title: "Complete Edition",
      },
    ];
  },

  async content(chapterId) {
    const baseId = chapterId.replace(/_full$/, "");
    const cached = metadataCache.get(baseId) || {};
    const title = cached.title || "Book Overview";
    const author = cached.author ? `by ${cached.author}` : "";

    return [
      `# ${title}`,
      author,
      "",
      "This title is provided through the Bookracy eBook network.",
      "",
      "---",
      `Source ID: ${baseId}`,
    ].filter(Boolean).join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "sort:rating", name: "Rating", group: "Sort" },
      { id: "genre:science-fiction", name: "Sci-Fi", group: "Genre" },
      { id: "genre:fantasy", name: "Fantasy", group: "Genre" },
      { id: "genre:cyberpunk", name: "Cyberpunk", group: "Genre" },
      { id: "genre:thriller", name: "Thriller", group: "Genre" },
    ];
  },
};

if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}

return plugin;
