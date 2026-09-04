// Harbor eBook source plugin for Bookracy
//
// This plugin runs in Harbor's isolated JavaScript worker.
// It interfaces with the Bookracy open-library API (https://api.bookracy.com)
// to provide live search, trending discovery charts, canonical metadata hints,
// and in-terminal/in-app eBook reading via pure JavaScript EPUB extraction.

const BASE_URL = "https://api.bookracy.com";

const REQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://bookracy.com/",
  "Origin": "https://bookracy.com",
};

// In-memory cache for book items during a browsing session
const itemCache = new Map();

function cleanTitle(value) {
  return (value || "")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/\s+(?:kol|كول)$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(str) {
  return (str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return "https://bookracy.com" + url;
  return "https://bookracy.com/" + url;
}

function toSummary(item) {
  if (!item || !item.title) return null;

  const rawTitle = (item.title || "").trim();
  const author = (item.author || "").trim();

  // Strip trailing " - Author Name" from title if present
  let displayTitle = rawTitle;
  if (author && author !== "Unknown Author") {
    const authorRegex = new RegExp("\\s*-\\s*" + escapeRegex(author) + "\\s*$", "i");
    displayTitle = displayTitle.replace(authorRegex, "");
  }

  const title = cleanTitle(displayTitle) || cleanTitle(rawTitle);
  const id = item.md5 || title;

  if (item.md5) {
    itemCache.set(item.md5, item);
    itemCache.set(id, item);
  }

  // Cover resolution
  let cover = item.book_image || item.cover || item.external_cover_url;
  if (!cover && item.md5) {
    cover = `${BASE_URL}/cover/${item.md5}/thumbnail.jpg`;
  }

  const yearNum = item.year ? parseInt(item.year, 10) : undefined;
  const isFanMade = /(?:fan[ -]?made|fan edition|summary of|study guide|sparknotes|companion to|cliffnotes)/i.test(rawTitle);

  const genres = [];
  if (item.series) genres.push(item.series);
  if (item.book_filetype) genres.push(item.book_filetype.toUpperCase());

  return {
    id,
    title,
    seriesTitle: item.series ? item.series.trim() : undefined,
    author: author && author !== "Unknown Author" ? author : undefined,
    cover: abs(cover),
    description: (item.description || "").trim() || undefined,
    year: !isNaN(yearNum) && yearNum > 0 ? yearNum : undefined,
    isbn: item.isbn ? String(item.isbn).trim() : undefined,
    status: "completed",
    originalLanguage: item.book_lang ? item.book_lang.toLowerCase().replace(/\s*\[.*\]\s*/, "") : "en",
    genres: genres.length > 0 ? genres : undefined,
    chapters: 1,
    siteUrl: "https://bookracy.com",
    isFanMade,
  };
}

// ── Pure JavaScript ZIP / Central Directory Parser for EPUBs ──

function parseZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = [];
  let eocdOffset = -1;

  // Scan backwards for End of Central Directory (0x06054b50)
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) return files;

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let pos = cdOffset;

  for (let i = 0; i < totalEntries && pos < eocdOffset; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const filename = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    if (localHeaderOffset + 30 <= bytes.length) {
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      if (dataOffset + compSize <= bytes.length) {
        const compressedData = bytes.subarray(dataOffset, dataOffset + compSize);
        files.push({ filename, method, compSize, uncompSize, data: compressedData });
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

// ── In-Engine EPUB Text Extractor ──

async function extractEpubText(url) {
  const res = await harbor.http(url, {
    method: "GET",
    headers: {
      "User-Agent": REQ_HEADERS["User-Agent"],
      "Referer": "https://bookracy.com/",
    },
    responseType: "base64",
    timeoutMs: 20000,
  });

  if (!res.ok || !res.body) return null;

  const binaryString = atob(res.body);
  const len = binaryString.length;
  // Guard against files exceeding memory limits
  if (len > 10 * 1024 * 1024) return null;

  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const entries = parseZipEntries(bytes);
  const contentEntries = entries.filter((e) => {
    const fn = e.filename.toLowerCase();
    return (
      (fn.endsWith(".xhtml") || fn.endsWith(".html") || fn.endsWith(".htm")) &&
      !fn.includes("nav.xhtml") &&
      !fn.includes("toc.xhtml") &&
      !fn.includes("cover")
    );
  });

  if (contentEntries.length === 0) return null;

  const chapterTexts = [];
  for (const entry of contentEntries) {
    let uncompressedData = null;

    if (entry.method === 0) {
      uncompressedData = entry.data;
    } else if (entry.method === 8 && typeof DecompressionStream !== "undefined") {
      try {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(entry.data);
            controller.close();
          },
        });
        const ds = stream.pipeThrough(new DecompressionStream("deflate-raw"));
        const reader = ds.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        uncompressedData = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          uncompressedData.set(c, offset);
          offset += c.length;
        }
      } catch (_) {}
    }

    if (uncompressedData) {
      const htmlStr = new TextDecoder("utf-8", { fatal: false }).decode(uncompressedData);

      if (typeof harbor.parseHtml === "function") {
        try {
          const doc = harbor.parseHtml(htmlStr);
          const blocks = doc.querySelectorAll("h1, h2, h3, h4, p, blockquote");
          const text = blocks.map((b) => b.text().trim()).filter(Boolean).join("\n\n");
          if (text) chapterTexts.push(text);
        } catch (_) {}
      } else {
        const text = htmlStr
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<br\s*[\/]?>/gi, "\n")
          .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, "\"")
          .replace(/&apos;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/&mdash;/g, "—")
          .replace(/&ndash;/g, "–")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (text) chapterTexts.push(text);
      }
    }
  }

  return chapterTexts.length > 0 ? chapterTexts.join("\n\n---\n\n") : null;
}

// ── Harbor EBookProvider Implementation ──

const plugin = {
  id: "bookracy",
  name: "Bookracy",

  async popular(offset, tagId) {
    const page = Math.floor((offset || 0) / 48) + 1;
    let items = [];

    if (tagId === "sort:recent") {
      try {
        const res = await harbor.http(`${BASE_URL}/api/recent`, {
          headers: REQ_HEADERS,
          responseType: "json",
          timeoutMs: 12000,
        });
        const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        if (data && Array.isArray(data.recent) && data.recent.length > 0) {
          items = data.recent;
        }
      } catch (_) {}
    } else if (offset === 0 || !offset) {
      try {
        const res = await harbor.http(`${BASE_URL}/api/trending`, {
          headers: REQ_HEADERS,
          responseType: "json",
          timeoutMs: 12000,
        });
        const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        if (data && Array.isArray(data.trending) && data.trending.length > 0) {
          items = data.trending;
        }
      } catch (_) {}
    }

    // Fallback if trending was empty or offset goes beyond trending batch
    if (items.length === 0) {
      const query = tagId === "sort:recent" ? "new" : "fiction";
      try {
        const res = await harbor.http(
          `${BASE_URL}/api/books?query=${encodeURIComponent(query)}&limit=48&page=${page}&lang=all`,
          {
            headers: REQ_HEADERS,
            responseType: "json",
            timeoutMs: 12000,
          }
        );
        const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        items = (data && data.results) || [];
      } catch (_) {}
    }

    const seen = new Set();
    const results = [];
    for (const raw of items) {
      const summary = toSummary(raw);
      if (summary && !seen.has(summary.id)) {
        seen.add(summary.id);
        results.push(summary);
      }
    }

    return results;
  },

  async search(query, offset, tagId) {
    if (!query || !String(query).trim()) return [];

    const page = Math.floor((offset || 0) / 48) + 1;
    let items = [];

    try {
      const res = await harbor.http(
        `${BASE_URL}/api/books?query=${encodeURIComponent(query.trim())}&limit=48&page=${page}&lang=all`,
        {
          headers: REQ_HEADERS,
          responseType: "json",
          timeoutMs: 15000,
        }
      );
      const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
      items = (data && data.results) || [];
    } catch (_) {
      return [];
    }

    const seen = new Set();
    const results = [];
    for (const raw of items) {
      const summary = toSummary(raw);
      if (summary && !seen.has(summary.id)) {
        seen.add(summary.id);
        results.push(summary);
      }
    }

    return results;
  },

  async detail(id) {
    if (!id) return null;

    let item = itemCache.get(id);

    if (!item) {
      try {
        const res = await harbor.http(
          `${BASE_URL}/api/books?query=${encodeURIComponent(id)}&limit=5&page=1&lang=all`,
          {
            headers: REQ_HEADERS,
            responseType: "json",
            timeoutMs: 12000,
          }
        );
        const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        const results = (data && data.results) || [];
        item = results.find((r) => r.md5 === id) || results[0];
        if (item && item.md5) {
          itemCache.set(item.md5, item);
        }
      } catch (_) {}
    }

    if (!item) {
      return {
        id,
        title: cleanTitle(id),
        status: "completed",
        siteUrl: "https://bookracy.com",
      };
    }

    return toSummary(item);
  },

  async chapters(id) {
    const summary = await this.detail(id);
    const title = summary ? summary.title : "Read Complete Book";

    return [
      {
        id: id + "#full",
        chapter: "1",
        title: title || "Complete Volume",
        position: 0,
        volume: "1",
        volumeTitle: "Main",
        publishAt: summary && summary.year ? String(summary.year) : undefined,
      },
    ];
  },

  async content(chapterId) {
    const rawId = (chapterId || "").replace(/#full$/, "");
    let item = itemCache.get(rawId);

    if (!item) {
      try {
        const res = await harbor.http(
          `${BASE_URL}/api/books?query=${encodeURIComponent(rawId)}&limit=5&page=1&lang=all`,
          {
            headers: REQ_HEADERS,
            responseType: "json",
            timeoutMs: 12000,
          }
        );
        const data = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        const results = (data && data.results) || [];
        item = results.find((r) => r.md5 === rawId) || results[0];
        if (item && item.md5) {
          itemCache.set(item.md5, item);
        }
      } catch (_) {}
    }

    const title = item ? cleanTitle(item.title) : cleanTitle(rawId);
    const author = item ? item.author : "Unknown Author";
    const downloadUrl = item ? (item.link || "") : "";
    const filetype = item ? (item.book_filetype || "").toLowerCase() : "";

    // Attempt native in-engine EPUB text extraction
    if (downloadUrl && filetype === "epub") {
      try {
        const extracted = await extractEpubText(downloadUrl);
        if (extracted && extracted.trim().length > 100) {
          return extracted;
        }
      } catch (_) {
        // Fall through to reader fallback
      }
    }

    // High-fidelity fallback reading card
    const parts = [
      `# ${title}`,
      author && author !== "Unknown Author" ? `**Author:** ${author}` : "",
      item && item.description ? `\n## Synopsis\n${item.description}\n` : "",
      "---",
      `* **Format:** ${(filetype || "EBOOK").toUpperCase()}`,
      item && item.book_size ? `* **Size:** ${item.book_size}` : "",
      item && item.year ? `* **Release Year:** ${item.year}` : "",
      item && item.isbn ? `* **ISBN:** ${item.isbn}` : "",
      item && item.publisher ? `* **Publisher:** ${item.publisher}` : "",
      "",
      downloadUrl ? `Direct Download / Stream Link:\n${downloadUrl}` : "",
    ].filter(Boolean);

    return parts.join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular / Trending", group: "Sort" },
      { id: "sort:recent", name: "Recently Added", group: "Sort" },
      { id: "status:completed", name: "Completed", group: "Status" },
    ];
  },
};

// Register in Harbor worker
if (typeof harbor !== "undefined" && typeof harbor.register === "function") {
  harbor.register(plugin);
}

return plugin;
