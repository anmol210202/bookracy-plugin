// Harbor eBook source plugin for Bookracy
//
// This plugin runs in Harbor's isolated JavaScript worker.
// It interfaces with the Bookracy API (https://api.bookracy.com)
// with resilient Open Library fallbacks to bypass Cloudflare bot challenges,
// providing live search, trending discovery charts, canonical metadata hints,
// and in-engine EPUB reading.

const BASE_URL = "https://api.bookracy.com";
const OPEN_LIBRARY_URL = "https://openlibrary.org";

const REQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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

function cleanBookTitle(rawTitle, author) {
  let t = (rawTitle || "").trim();
  t = t.replace(/_/g, " ");
  // Remove leading release codes, volume tokens or ISBNs (e.g. "fn 155 9780593804223 ")
  t = t.replace(/^(?:fn\s*\d+\s*)?(?:97[89]\d{10}[,\s]*)+/i, "");
  // Remove duplicate author prefixes or suffixes
  if (author && author !== "Unknown Author") {
    const safeAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp("\\s*-\\s*" + safeAuthor + "\\s*$", "i"), "");
    t = t.replace(new RegExp("^" + safeAuthor + "\\s*-\\s*", "i"), "");
  }
  t = t.replace(/\s*-\s*[A-Za-z\s,]+$/i, "");
  const cleaned = cleanTitle(t);
  return cleaned || cleanTitle(rawTitle);
}

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return "https://bookracy.com" + url;
  return "https://bookracy.com/" + url;
}

function safeParseJson(text) {
  if (typeof text === "object" && text !== null) return text;
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) return null; // Cloudflare HTML response
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

function normalizeLanguage(langStr) {
  if (!langStr) return "en";
  const lower = langStr.toLowerCase();
  if (lower.includes("eng") || lower === "en") return "en";
  if (lower.includes("spa") || lower === "es") return "es";
  if (lower.includes("fre") || lower === "fr") return "fr";
  if (lower.includes("ger") || lower === "de") return "de";
  if (lower.includes("ita") || lower === "it") return "it";
  if (lower.includes("por") || lower === "pt") return "pt";
  if (lower.includes("rus") || lower === "ru") return "ru";
  if (lower.includes("chi") || lower.includes("zho") || lower === "zh") return "zh";
  if (lower.includes("jpn") || lower === "ja") return "ja";
  return "en";
}

function bookracyItemToSummary(item) {
  if (!item || !item.title) return null;

  const rawTitle = (item.title || "").trim();
  const author = (item.author || "").trim();
  const title = cleanBookTitle(rawTitle, author);
  const id = item.md5 ? `br:${item.md5}` : `br:${encodeURIComponent(title)}`;

  if (item.md5) {
    itemCache.set(item.md5, item);
    itemCache.set(id, item);
  }

  // Cover image resolution
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
    originalLanguage: normalizeLanguage(item.book_lang),
    genres: genres.length > 0 ? genres : undefined,
    chapters: 1,
    siteUrl: "https://bookracy.com",
    isFanMade,
  };
}

function openLibraryWorkToSummary(w) {
  if (!w || !w.title) return null;
  const title = (w.title || "").trim();
  const author = Array.isArray(w.author_name)
    ? w.author_name[0]
    : typeof w.author_name === "string"
    ? w.author_name
    : undefined;

  const olKey = (w.key || "").replace(/^\/works\//, "");
  const id = olKey ? `ol:${olKey}` : `ol:${encodeURIComponent(title)}`;

  let cover = undefined;
  if (w.cover_i) {
    cover = `https://covers.openlibrary.org/b/id/${w.cover_i}-L.jpg`;
  }

  const yearNum = w.first_publish_year ? parseInt(w.first_publish_year, 10) : undefined;
  const genres = Array.isArray(w.subject) ? w.subject.slice(0, 4) : undefined;

  let isbn = undefined;
  if (Array.isArray(w.isbn) && w.isbn.length > 0) {
    isbn = String(w.isbn[0]).trim();
  }

  let description = undefined;
  if (w.first_sentence) {
    if (typeof w.first_sentence === "string") description = w.first_sentence;
    else if (typeof w.first_sentence.value === "string") description = w.first_sentence.value;
  }

  // Cache work for detail/content lookups
  itemCache.set(id, {
    title,
    author: author || "Unknown Author",
    year: yearNum,
    cover,
    description,
    openLibraryId: olKey,
    isbn,
  });

  return {
    id,
    title: cleanTitle(title),
    author: author && author !== "Unknown Author" ? author : undefined,
    openLibraryId: olKey || undefined,
    isbn,
    cover: abs(cover),
    description,
    year: !isNaN(yearNum) && yearNum > 0 ? yearNum : undefined,
    status: "completed",
    originalLanguage: "en",
    genres,
    chapters: 1,
    siteUrl: "https://bookracy.com",
    isFanMade: false,
  };
}

// ── Pure JavaScript ZIP / Central Directory Parser for EPUBs ──

function parseZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = [];
  let eocdOffset = -1;

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

    // 1. Attempt Bookracy Trending Feed
    try {
      const res = await harbor.http(`${BASE_URL}/api/trending`, {
        headers: REQ_HEADERS,
        responseType: "text",
        timeoutMs: 10000,
      });
      if (res && res.ok && res.body) {
        const data = safeParseJson(res.body);
        if (data && Array.isArray(data.trending) && data.trending.length > 0) {
          items = data.trending.map(bookracyItemToSummary).filter(Boolean);
        }
      }
    } catch (_) {}

    // 2. Open Library Trending Fallback (guarantees books appear even if Bookracy is challenged)
    if (items.length === 0) {
      try {
        const olRes = await harbor.http(`${OPEN_LIBRARY_URL}/trending/weekly.json?limit=48&page=${page}`, {
          responseType: "text",
          timeoutMs: 12000,
        });
        if (olRes && olRes.ok && olRes.body) {
          const olData = safeParseJson(olRes.body);
          if (olData && Array.isArray(olData.works) && olData.works.length > 0) {
            items = olData.works.map(openLibraryWorkToSummary).filter(Boolean);
          }
        }
      } catch (_) {}
    }

    // 3. Third-tier genre catalog fallback
    if (items.length === 0) {
      try {
        const subjectRes = await harbor.http(`${OPEN_LIBRARY_URL}/subjects/fiction.json?limit=48&offset=${offset || 0}`, {
          responseType: "text",
          timeoutMs: 12000,
        });
        if (subjectRes && subjectRes.ok && subjectRes.body) {
          const subData = safeParseJson(subjectRes.body);
          if (subData && Array.isArray(subData.works)) {
            items = subData.works.map(openLibraryWorkToSummary).filter(Boolean);
          }
        }
      } catch (_) {}
    }

    const seen = new Set();
    const results = [];
    for (const summary of items) {
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
    const cleanQuery = String(query).trim();
    let results = [];

    // 1. Primary: Direct Bookracy Search
    try {
      const res = await harbor.http(
        `${BASE_URL}/api/books?query=${encodeURIComponent(cleanQuery)}&limit=48&page=${page}&lang=all`,
        {
          headers: REQ_HEADERS,
          responseType: "text",
          timeoutMs: 12000,
        }
      );
      if (res && res.ok && res.body) {
        const data = safeParseJson(res.body);
        if (data && Array.isArray(data.results) && data.results.length > 0) {
          results = data.results.map(bookracyItemToSummary).filter(Boolean);
        }
      }
    } catch (_) {}

    // 2. Fallback: Open Library Search (if Bookracy is blocked or returns 0 results)
    if (results.length === 0) {
      try {
        const olRes = await harbor.http(
          `${OPEN_LIBRARY_URL}/search.json?q=${encodeURIComponent(cleanQuery)}&limit=48&page=${page}`,
          {
            responseType: "text",
            timeoutMs: 12000,
          }
        );
        if (olRes && olRes.ok && olRes.body) {
          const olData = safeParseJson(olRes.body);
          if (olData && Array.isArray(olData.docs) && olData.docs.length > 0) {
            results = olData.docs.map(openLibraryWorkToSummary).filter(Boolean);
          }
        }
      } catch (_) {}
    }

    const seen = new Set();
    const deduplicated = [];
    for (const r of results) {
      if (r && !seen.has(r.id)) {
        seen.add(r.id);
        deduplicated.push(r);
      }
    }

    return deduplicated;
  },

  async detail(id) {
    if (!id) return null;

    let item = itemCache.get(id);

    // If ID is Bookracy MD5
    if (!item && id.startsWith("br:")) {
      const rawMd5 = id.replace(/^br:/, "");
      try {
        const res = await harbor.http(
          `${BASE_URL}/api/books?query=${encodeURIComponent(rawMd5)}&limit=5&page=1&lang=all`,
          {
            headers: REQ_HEADERS,
            responseType: "text",
            timeoutMs: 12000,
          }
        );
        if (res && res.ok && res.body) {
          const data = safeParseJson(res.body);
          const results = (data && data.results) || [];
          const found = results.find((r) => r.md5 === rawMd5) || results[0];
          if (found) {
            item = found;
            itemCache.set(id, found);
          }
        }
      } catch (_) {}
    }

    // If ID is Open Library work
    if (!item && id.startsWith("ol:")) {
      const olKey = id.replace(/^ol:/, "");
      try {
        const res = await harbor.http(`${OPEN_LIBRARY_URL}/works/${olKey}.json`, {
          responseType: "text",
          timeoutMs: 10000,
        });
        if (res && res.ok && res.body) {
          const work = safeParseJson(res.body);
          if (work) {
            item = {
              title: work.title,
              description: typeof work.description === "string" ? work.description : work.description?.value,
              openLibraryId: olKey,
            };
          }
        }
      } catch (_) {}
    }

    if (!item) {
      return {
        id,
        title: cleanTitle(id.replace(/^(br|ol):/, "")),
        status: "completed",
        siteUrl: "https://bookracy.com",
      };
    }

    if (item.openLibraryId) {
      return {
        id,
        title: cleanTitle(item.title),
        author: item.author && item.author !== "Unknown Author" ? item.author : undefined,
        cover: abs(item.cover),
        description: item.description || undefined,
        year: item.year || undefined,
        openLibraryId: item.openLibraryId,
        isbn: item.isbn,
        status: "completed",
        originalLanguage: "en",
        chapters: 1,
        siteUrl: "https://bookracy.com",
        isFanMade: false,
      };
    }

    return bookracyItemToSummary(item);
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

    // If we have an Open Library item, look up the release on Bookracy
    let bookracyRelease = null;
    if (rawId.startsWith("br:")) {
      const md5 = rawId.replace(/^br:/, "");
      bookracyRelease = itemCache.get(md5) || item;
    } else if (item && item.title) {
      try {
        const q = `${item.title} ${item.author || ""}`.trim();
        const res = await harbor.http(
          `${BASE_URL}/api/books?query=${encodeURIComponent(q)}&limit=3&page=1&lang=all`,
          {
            headers: REQ_HEADERS,
            responseType: "text",
            timeoutMs: 12000,
          }
        );
        if (res && res.ok && res.body) {
          const data = safeParseJson(res.body);
          if (data && Array.isArray(data.results) && data.results.length > 0) {
            bookracyRelease = data.results[0];
          }
        }
      } catch (_) {}
    }

    const title = (bookracyRelease && bookracyRelease.title) || (item && item.title) || cleanTitle(rawId);
    const author = (bookracyRelease && bookracyRelease.author) || (item && item.author) || "Unknown Author";
    const downloadUrl = (bookracyRelease && bookracyRelease.link) || "";
    const filetype = (bookracyRelease && bookracyRelease.book_filetype || "").toLowerCase();
    const description = (bookracyRelease && bookracyRelease.description) || (item && item.description) || "";

    // Attempt native EPUB decompression
    if (downloadUrl && filetype === "epub") {
      try {
        const extracted = await extractEpubText(downloadUrl);
        if (extracted && extracted.trim().length > 100) {
          return extracted;
        }
      } catch (_) {}
    }

    // High-fidelity fallback reading card
    const parts = [
      `# ${title}`,
      author && author !== "Unknown Author" ? `**Author:** ${author}` : "",
      description ? `\n## Synopsis\n${description}\n` : "",
      "---",
      filetype ? `* **Format:** ${filetype.toUpperCase()}` : "* **Source:** Bookracy Open Library",
      bookracyRelease && bookracyRelease.book_size ? `* **Size:** ${bookracyRelease.book_size}` : "",
      bookracyRelease && bookracyRelease.year ? `* **Release Year:** ${bookracyRelease.year}` : "",
      bookracyRelease && bookracyRelease.isbn ? `* **ISBN:** ${bookracyRelease.isbn}` : "",
      "",
      downloadUrl ? `Direct Download / Stream Link:\n${downloadUrl}` : "Search and stream on Bookracy: https://bookracy.com",
    ].filter(Boolean);

    return parts.join("\n\n");
  },

  async tags() {
    return [
      { id: "sort:popular", name: "Popular", group: "Sort" },
      { id: "status:completed", name: "Completed", group: "Status" },
    ];
  },
};

// Register in Harbor worker
if (typeof harbor !== "undefined") {
  if (typeof harbor.register === "function") {
    harbor.register(plugin);
  }
}
