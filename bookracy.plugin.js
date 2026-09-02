// Harbor eBook source plugin for Bookracy (api.bookracy.com)

const BASE = "https://api.bookracy.com";

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Referer: "https://bookracy.com/",
  Origin: "https://bookracy.com",
};

async function fetchJson(url) {
  const res = await harbor.http(url, {
    headers: HEADERS,
    responseType: "text",
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

function cleanText(val) {
  return (val || "")
    .replace(/[^\p{L}\p{N}'’\-: ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCover(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  return BASE + (url.startsWith("/") ? url : "/" + url);
}

function itemToSummary(item) {
  if (!item) return null;

  // Bookracy items key off MD5 or hash ID
  const id = item.md5 || item.id || item.file_id;
  if (!id) return null;

  const rawTitle = item.title || item.name || "Untitled";
  const author = item.author || item.creator || "";
  const cover = normalizeCover(item.cover || item.image || item.thumbnail);

  return {
    id: String(id),
    title: cleanText(rawTitle),
    author: cleanText(author),
    cover,
    originalLanguage: item.language || item.book_lang || "en",
    score: item.rating ? Number(item.rating) : undefined,
    genres: Array.isArray(item.genres)
      ? item.genres
      : item.extension
        ? [item.extension.toUpperCase()]
        : [],
    isFanMade: false,
  };
}

const plugin = {
  id: "bookracy-source",
  name: "Bookracy",

  async popular(offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let query = "trending";

    if (tagId && tagId.startsWith("genre:")) {
      query = tagId.slice(6);
    } else if (tagId && tagId.startsWith("sort:")) {
      query = tagId.slice(5);
    }

    const url = `${BASE}/api/search?q=${encodeURIComponent(query)}&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || data.items || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / 30) + 1;
    let target = query;
    if (tagId && tagId.startsWith("genre:")) {
      target += " " + tagId.slice(6);
    }

    const url = `${BASE}/api/search?q=${encodeURIComponent(target)}&page=${page}&limit=30`;
    const data = await fetchJson(url);
    const list = Array.isArray(data) ? data : data.results || data.items || [];
    return list.map(itemToSummary).filter(Boolean);
  },

  async detail(id) {
    // Queries the metadata enrichment endpoint with Apple Books / Google Books fallback
    const url = `${BASE}/api/metadata/${id}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch {
      data = null;
    }

    const meta = data?.metadata || data || {};
    const title = cleanText(meta.title || id);
    const author = cleanText(meta.author || "");
    const cover = normalizeCover(meta.cover);

    return {
      id: String(id),
      title,
      author,
      cover,
      description: meta.description || meta.synopsis || "No description available.",
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      isbn: meta.isbn || undefined,
      score: meta.rating ? Number(meta.rating) : undefined,
      chapters: 1,
      volumes: 1,
      originalLanguage: meta.locale?.split("-")[0] || "en",
    };
  },

  async chapters(id) {
    // Single-file publications (EPUB/PDF) expose one unified chapter entry
    return [
      {
        id: `${id}#full`,
        chapter: "1",
        position: 0,
        title: "Complete Edition",
        pages: 0,
        language: "en",
      },
    ];
  },

  async content(chapterId) {
    const rawId = chapterId.replace(/#.*$/, "");
    const metaUrl = `${BASE}/api/metadata/${rawId}`;
    const data = await fetchJson(metaUrl);
    const meta = data?.metadata || data || {};

    const title = meta.title || "Book Content";
    const author = meta.author ? `by ${meta.author}` : "";
    const description = meta.description || "No preview text available.";

    // Text fallback for readers expecting raw chapter blocks
    return [
      `# ${title}`,
      author,
      "",
      description,
      "",
      "---",
      "Notice: This release is a complete eBook package.",
    ].join("\n\n");
  },

  async tags() {
    return [
      { id: "genre:science-fiction", name: "Sci-Fi", group: "Genre" },
      { id: "genre:fantasy", name: "Fantasy", group: "Genre" },
      { id: "genre:cyberpunk", name: "Cyberpunk", group: "Genre" },
      { id: "genre:psychology", name: "Psychology", group: "Genre" },
      { id: "genre:philosophy", name: "Philosophy", group: "Genre" },
      { id: "sort:trending", name: "Trending", group: "Sort" },
      { id: "sort:popular", name: "Popular", group: "Sort" },
    ];
  },
};

return plugin;
