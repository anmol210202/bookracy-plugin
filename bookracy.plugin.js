// Harbor eBook source plugin for Bookracy (api.bookracy.com)

const BASE = "https://api.bookracy.com";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://bookracy.com/",
  Origin: "https://bookracy.com",
};

async function fetchJson(url) {
  const res = await harbor.http(url, {
    headers: HEADERS,
    responseType: "text",
    timeoutMs: 15000,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  try {
    return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err.message}`);
  }
}

// Covers must be absolute HTTP(S) or Harbor drops them
function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

function cleanTitle(value) {
  return (value || "")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompositeId(compositeId) {
  const [md5, rawTitle, rawAuthor] = (compositeId || "").split("|");
  return {
    md5: md5 || compositeId,
    title: rawTitle ? decodeURIComponent(rawTitle) : "",
    author: rawAuthor ? decodeURIComponent(rawAuthor) : "",
  };
}

function itemToSummary(item) {
  if (!item || !item.md5) return null;

  const rawTitle = cleanTitle(item.title || item.name || "Untitled");
  const author = (item.author || item.creator || "").trim();

  // Encodes metadata into ID so detail() can query the resolver
  const compositeId = `${item.md5}|${encodeURIComponent(rawTitle)}|${encodeURIComponent(author)}`;

  return {
    id: compositeId,
    title: rawTitle,
    author: author || undefined,
    cover: abs(item.cover || item.image || item.thumbnail),
    originalLanguage: item.book_lang || item.language || "en",
    score: item.score ? Number(item.score) : undefined,
    genres: item.book_filetype ? [item.book_filetype.toUpperCase()] : [],
    isFanMade: false,
  };
}

const plugin = {
  id: "bookracy-source",
  name: "Bookracy",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let query = "bestseller";

    if (tagId?.startsWith("genre:")) {
      query = tagId.slice(6);
    } else if (tagId?.startsWith("sort:")) {
      query = tagId.slice(5);
    }

    const url = `${BASE}/api/books?query=${encodeURIComponent(query)}&lang=all&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let target = query;
    if (tagId?.startsWith("genre:")) {
      target += " " + tagId.slice(6);
    }

    const url = `${BASE}/api/books?query=${encodeURIComponent(target)}&lang=all&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  async detail(compositeId) {
    const { md5, title, author } = parseCompositeId(compositeId);

    const queryParams = new URLSearchParams();
    if (title) queryParams.set("title", author ? `${title} - ${author}` : title);
    if (author) queryParams.set("author", author);

    const url = `${BASE}/api/metadata/${md5}?${queryParams.toString()}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch {
      data = null;
    }

    const meta = data?.metadata || data || {};
    const finalTitle = cleanTitle(meta.title || title || md5);
    const finalAuthor = (meta.author || author || "").trim();

    return {
      id: compositeId,
      title: finalTitle,
      author: finalAuthor || undefined,
      cover: abs(meta.cover),
      description: meta.description || meta.synopsis || undefined,
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      isbn: meta.isbn || undefined,
      score: meta.rating ? Number(meta.rating) : undefined,
      chapters: 1,
      originalLanguage: meta.locale ? meta.locale.split("-")[0] : "en",
      isFanMade: false,
    };
  },

  async chapters(compositeId) {
    return [
      {
        id: `${compositeId}#complete`,
        chapter: "1",
        position: 0,
        title: "Complete Edition",
        publishAt: undefined,
      },
    ];
  },

  async content(chapterId) {
    const cleanChapterId = chapterId.replace(/#.*$/, "");
    const { md5, title, author } = parseCompositeId(cleanChapterId);

    const queryParams = new URLSearchParams();
    if (title) queryParams.set("title", author ? `${title} - ${author}` : title);
    if (author) queryParams.set("author", author);

    const url = `${BASE}/api/metadata/${md5}?${queryParams.toString()}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch {
      data = null;
    }

    const meta = data?.metadata || data || {};
    const bookTitle = cleanTitle(meta.title || title || "Book Overview");
    const bookAuthor = (meta.author || author) ? `by ${meta.author || author}` : "";
    const description = meta.description || meta.synopsis || "No description preview available.";

    return [
      `# ${bookTitle}`,
      bookAuthor,
      "",
      description,
      "",
      "---",
      `Direct MD5: ${md5}`,
      "This title is distributed as a full eBook archive.",
    ]
      .filter(Boolean)
      .join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "sort:rating", name: "Rating", group: "Sort" },
      { id: "genre:science-fiction", name: "Sci-Fi", group: "Genre" },
      { id: "genre:fantasy", name: "Fantasy", group: "Genre" },
      { id: "genre:cyberpunk", name: "Cyberpunk", group: "Genre" },
      { id: "genre:psychology", name: "Psychology", group: "Genre" },
      { id: "genre:philosophy", name: "Philosophy", group: "Genre" },
    ];
  },
};

if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}

return plugin;
