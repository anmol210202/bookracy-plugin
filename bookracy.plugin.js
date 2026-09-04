// Harbor eBook source plugin for Bookracy (api.bookracy.com)

const BASE = "https://api.bookracy.com";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://bookracy.com/",
  Origin: "https://bookracy.com",
};

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
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

function cleanTitle(val) {
  return (val || "")
    .replace(/[^\p{L}\p{N}'’\-: ]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isEnglishBook(item) {
  if (!item || !item.title) return false;
  if (/[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF]/.test(item.title)) {
    return false;
  }
  const lang = (item.book_lang || "").toLowerCase().trim();
  if (lang && !lang.includes("en") && !lang.includes("eng") && lang !== "unknown" && lang !== "") {
    return false;
  }
  return true;
}

function itemToSummary(item) {
  if (!item || !item.md5) return null;

  const id = String(item.md5).trim();
  const title = cleanTitle(item.title || "Untitled");
  const author = (item.author || "").trim();

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
    originalLanguage: "en",
    score: item.score ? Number(item.score) : undefined,
    genres: item.book_filetype ? [item.book_filetype.toUpperCase()] : ["EPUB"],
    isFanMade: false,
  };
}

const plugin = {
  id: "bookracy-source",
  name: "Bookracy",

  async popular(offset, tagId) {
    const safeOffset = Number(offset) || 0;
    const page = Math.floor(safeOffset / 30) + 1;
    let query = "novel";

    if (tagId === "sort:rating") {
      query = "award winner";
    } else if (tagId === "sort:popular") {
      query = "novel";
    }

    const url = `${BASE}/api/books?query=${encodeURIComponent(query)}&lang=all&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];

    return list.filter(isEnglishBook).map(itemToSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const safeOffset = Number(offset) || 0;
    const page = Math.floor(safeOffset / 30) + 1;
    let target = (query || "").trim() || "fiction";

    const url = `${BASE}/api/books?query=${encodeURIComponent(target)}&lang=all&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];

    return list.filter(isEnglishBook).map(itemToSummary).filter(Boolean);
  },

  async detail(id) {
    let cached = cache.get(id);

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
      } catch (_) {}
    }

    let title = cached?.title || id;
    let author = cached?.author || "";
    let cover = undefined;
    let description = cached?.description;
    let genres = cached?.filetype ? [cached.filetype.toUpperCase()] : [];
    let isbn = undefined;
    let score = undefined;

    try {
      const qParams = new URLSearchParams();
      if (title && title !== id) {
        qParams.set("title", author ? `${title} - ${author}` : title);
      }
      if (author) {
        qParams.set("author", author);
      }

      const metaResp = await fetchJson(`${BASE}/api/metadata/${id}?${qParams.toString()}`);
      const meta = metaResp?.metadata || metaResp || {};

      if (meta.title) title = cleanTitle(meta.title);
      if (meta.author) author = meta.author.trim();
      if (meta.cover) cover = abs(meta.cover);
      if (meta.description || meta.synopsis) description = meta.description || meta.synopsis;
      if (Array.isArray(meta.genres) && meta.genres.length > 0) genres = meta.genres;
      if (meta.isbn) isbn = meta.isbn;
      if (meta.rating) score = Number(meta.rating);
    } catch (_) {}

    return {
      id,
      title,
      author: author || undefined,
      cover,
      description: description || "Available on Bookracy eBook network.",
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
        pages: 0,
        language: "en",
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
      cached?.description || "This title is available on the Bookracy network.",
      "",
      "---",
      `Source ID: ${id}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "sort:rating", name: "Top Rated", group: "Sort" },
    ];
  },
};

if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}
if (typeof globalThis !== "undefined") {
  globalThis.plugin = plugin;
}

return plugin;
