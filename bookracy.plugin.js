// Harbor eBook source plugin for Bookracy (api.bookracy.com)

const BASE = "https://api.bookracy.com";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://bookracy.com/",
  Origin: "https://bookracy.com",
};

// In-memory cache for fast lookups during an active session
const cache = new Map();

async function fetchJson(url) {
  const res = await harbor.http(url, {
    headers: HEADERS,
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
  return BASE + (url.startsWith("/") ? url : "/" + url);
}

function cleanTitle(val) {
  return (val || "")
    .replace(/[^\p{L}\p{N}'’\-: ]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function itemToSummary(item) {
  if (!item || !item.md5) return null;

  const title = cleanTitle(item.title || "Untitled");
  const author = (item.author || "").trim();
  const id = String(item.md5).trim();

  // Store in session cache
  cache.set(id, {
    title,
    author,
    filetype: item.book_filetype,
    filesize: item.book_size,
    description: item.description,
  });

  return {
    id,
    title,
    author: author || undefined,
    originalLanguage: item.book_lang || "en",
    score: item.score ? Number(item.score) : undefined,
    genres: item.book_filetype ? [item.book_filetype.toUpperCase()] : [],
    isFanMade: false,
  };
}

const plugin = {
  id: "bookracy-source",
  name: "Bookracy",

  // Popular Shelf: Direct Bookracy English catalog feed
  async popular(offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let query = "bestseller";

    if (tagId?.startsWith("genre:")) {
      query = tagId.slice(6);
    } else if (tagId === "sort:rating") {
      query = "award";
    } else if (tagId === "sort:popular") {
      query = "popular";
    }

    const url = `${BASE}/api/books?query=${encodeURIComponent(query)}&lang=en&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  // Search: Direct Bookracy English index lookup
  async search(query, offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let target = query;
    if (tagId?.startsWith("genre:")) {
      target += " " + tagId.slice(6);
    }

    const url = `${BASE}/api/books?query=${encodeURIComponent(target)}&lang=en&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  // Detail: Stateless resolution with fallback query if cache is empty
  async detail(id) {
    let cached = cache.get(id);

    // If cache is empty (e.g. app reopened or fresh worker), re-query Bookracy by MD5
    if (!cached || !cached.title) {
      try {
        const lookup = await fetchJson(`${BASE}/api/books?query=${encodeURIComponent(id)}&lang=all&limit=1`);
        const item = Array.isArray(lookup) ? lookup[0] : (lookup.results || [])[0];
        if (item) {
          cached = {
            title: cleanTitle(item.title),
            author: (item.author || "").trim(),
            description: item.description,
            filetype: item.book_filetype,
          };
          cache.set(id, cached);
        }
      } catch {
        // Fallback continues below
      }
    }

    let title = cached?.title || id;
    let author = cached?.author || "";
    let cover = undefined;
    let description = cached?.description;
    let genres = cached?.filetype ? [cached.filetype.toUpperCase()] : [];
    let isbn = undefined;
    let score = undefined;

    // Query Bookracy's Apple Books metadata endpoint for cover and synopsis
    try {
      const queryParams = new URLSearchParams();
      if (title && title !== id) {
        queryParams.set("title", author ? `${title} - ${author}` : title);
      }
      if (author) {
        queryParams.set("author", author);
      }

      const metaResp = await fetchJson(`${BASE}/api/metadata/${id}?${queryParams.toString()}`);
      const meta = metaResp?.metadata || metaResp || {};

      if (meta.title) title = cleanTitle(meta.title);
      if (meta.author) author = meta.author.trim();
      if (meta.cover) cover = abs(meta.cover);
      if (meta.description || meta.synopsis) description = meta.description || meta.synopsis;
      if (Array.isArray(meta.genres) && meta.genres.length > 0) genres = meta.genres;
      if (meta.isbn) isbn = meta.isbn;
      if (meta.rating) score = Number(meta.rating);
    } catch {
      // Fallback retains clean title and author
    }

    return {
      id,
      title,
      author: author || undefined,
      cover,
      description: description || "Available on Bookracy.",
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
        id: `${id}:1`,
        chapter: "1",
        position: 0,
        title: "Complete Edition",
      },
    ];
  },

  async content(chapterId) {
    const id = chapterId.split(":")[0];
    const cached = cache.get(id);
    const title = cached?.title || "Book Overview";
    const author = cached?.author ? `by ${cached.author}` : "";

    return [
      `# ${title}`,
      author,
      "",
      "This book is available as a complete eBook file on Bookracy.",
      "",
      "---",
      `MD5: ${id}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "sort:rating", name: "Award Winners", group: "Sort" },
      { id: "genre:science-fiction", name: "Sci-Fi", group: "Genre" },
      { id: "genre:fantasy", name: "Fantasy", group: "Genre" },
      { id: "genre:cyberpunk", name: "Cyberpunk", group: "Genre" },
      { id: "genre:thriller", name: "Thriller", group: "Genre" },
      { id: "genre:philosophy", name: "Philosophy", group: "Genre" },
    ];
  },
};

// Harbor compatibility registration
if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}
if (typeof globalThis !== "undefined") {
  globalThis.plugin = plugin;
}

return plugin;
