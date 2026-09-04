// Harbor eBook source plugin for Bookracy
//
// This plugin runs in Harbor's isolated JavaScript worker.
// It interfaces with the Bookracy API (https://api.bookracy.com)
// with resilient Open Library discovery and an embedded pure-JS DEFLATE
// engine to decompress and extract real EPUB chapters directly into Harbor Reader.

const BASE_URL = "https://api.bookracy.com";
const OPEN_LIBRARY_URL = "https://openlibrary.org";

const REQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://bookracy.com/",
  "Origin": "https://bookracy.com",
};

const DOWNLOAD_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Referer": "https://bookracy.com/",
  "Origin": "https://bookracy.com",
  "Accept": "*/*",
};

// Caches for browsing sessions
const itemCache = new Map();
const epubCache = new Map();

// ── Pure JavaScript RFC 1951 Raw Deflate Decompressor (tiny-inflate) ──

function Tree() {
  this.table = new Uint16Array(16);
  this.trans = new Uint16Array(288);
}

function Data(source, dest) {
  this.source = source;
  this.sourceIndex = 0;
  this.tag = 0;
  this.bitcount = 0;
  this.dest = dest;
  this.destLen = 0;
  this.ltree = new Tree();
  this.dtree = new Tree();
}

const sltree = new Tree();
const sdtree = new Tree();
const length_bits = new Uint8Array(30);
const length_base = new Uint16Array(30);
const dist_bits = new Uint8Array(30);
const dist_base = new Uint16Array(30);
const clcidx = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const code_tree = new Tree();
const lengths = new Uint8Array(288 + 32);

function tinf_build_bits_base(bits, base, delta, first) {
  let i;
  for (i = 0; i < delta; ++i) bits[i] = 0;
  for (i = 0; i < 30 - delta; ++i) bits[i + delta] = (i / delta) | 0;
  let sum = first;
  for (i = 0; i < 30; ++i) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

function tinf_build_fixed_trees(lt, dt) {
  let i;
  for (i = 0; i < 16; ++i) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 16; ++i) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; ++i) dt.trans[i] = i;
}

function tinf_build_tree(t, lens, num) {
  let i;
  for (i = 0; i < 16; ++i) t.table[i] = 0;
  for (i = 0; i < num; ++i) t.table[lens[i]]++;
  t.table[0] = 0;
  const offs = new Uint16Array(16);
  let sum = 0;
  for (i = 0; i < 16; ++i) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (i = 0; i < num; ++i) {
    if (lens[i]) t.trans[offs[lens[i]]++] = i;
  }
}

function tinf_getbit(d) {
  if (!d.bitcount--) {
    d.tag = d.source[d.sourceIndex++];
    d.bitcount = 7;
  }
  const bit = d.tag & 1;
  d.tag >>>= 1;
  return bit;
}

function tinf_read_bits(d, num, base) {
  if (!num) return base;
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  const val = d.tag & (0xffff >>> (16 - num));
  d.tag >>>= num;
  d.bitcount -= num;
  return val + base;
}

function tinf_decode_symbol(d, t) {
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  let sum = 0, cur = 0, len = 0;
  let tag = d.tag;
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    ++len;
    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  d.tag = tag;
  d.bitcount -= len;
  return t.trans[sum + cur];
}

function tinf_decode_trees(d, lt, dt) {
  let hlit = tinf_read_bits(d, 5, 257);
  let hdist = tinf_read_bits(d, 5, 1);
  let hclen = tinf_read_bits(d, 4, 4);
  let i, num;
  for (i = 0; i < 19; ++i) lengths[i] = 0;
  for (i = 0; i < hclen; ++i) lengths[clcidx[i]] = tinf_read_bits(d, 3, 0);
  tinf_build_tree(code_tree, lengths, 19);
  for (num = 0; num < hlit + hdist;) {
    const sym = tinf_decode_symbol(d, code_tree);
    switch (sym) {
      case 16: {
        const prev = lengths[num - 1];
        for (let len = tinf_read_bits(d, 2, 3); len; --len) lengths[num++] = prev;
        break;
      }
      case 17:
        for (let len = tinf_read_bits(d, 3, 3); len; --len) lengths[num++] = 0;
        break;
      case 18:
        for (let len = tinf_read_bits(d, 7, 11); len; --len) lengths[num++] = 0;
        break;
      default:
        lengths[num++] = sym;
        break;
    }
  }
  tinf_build_tree(lt, lengths, hlit);
  tinf_build_tree(dt, lengths.subarray(hlit), hdist);
}

function tinf_inflate_block_data(d, lt, dt) {
  while (true) {
    const sym = tinf_decode_symbol(d, lt);
    if (sym === 256) return 0;
    if (sym < 256) {
      d.dest[d.destLen++] = sym;
    } else {
      const length = tinf_read_bits(d, length_bits[sym - 257], length_base[sym - 257]);
      const dist = tinf_decode_symbol(d, dt);
      const offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);
      for (let i = 0; i < length; ++i) {
        d.dest[d.destLen++] = d.dest[offs + i];
      }
    }
  }
}

function tinf_inflate_uncompressed_block(d) {
  let length = d.source[d.sourceIndex + 1];
  length = 256 * length + d.source[d.sourceIndex];
  d.sourceIndex += 4;
  d.bitcount = 0;
  d.tag = 0;
  while (length--) d.dest[d.destLen++] = d.source[d.sourceIndex++];
  return 0;
}

let inflateInitialized = false;
function initInflate() {
  if (inflateInitialized) return;
  tinf_build_bits_base(length_bits, length_base, 4, 3);
  tinf_build_bits_base(dist_bits, dist_base, 2, 1);
  length_bits[28] = 0;
  length_base[28] = 258;
  tinf_build_fixed_trees(sltree, sdtree);
  inflateInitialized = true;
}

function inflateRaw(source, dest) {
  initInflate();
  const d = new Data(source, dest);
  let bfinal;
  do {
    bfinal = tinf_getbit(d);
    const btype = tinf_read_bits(d, 2, 0);
    switch (btype) {
      case 0:
        tinf_inflate_uncompressed_block(d);
        break;
      case 1:
        tinf_inflate_block_data(d, sltree, sdtree);
        break;
      case 2:
        tinf_decode_trees(d, d.ltree, d.dtree);
        tinf_inflate_block_data(d, d.ltree, d.dtree);
        break;
      default:
        throw new Error("Invalid deflate block type: " + btype);
    }
  } while (!bfinal);
  return d.destLen;
}

// ── Pure JavaScript ZIP Parser ──

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
        files.push({
          filename,
          method,
          compSize,
          uncompSize,
          data: bytes.subarray(dataOffset, dataOffset + compSize),
        });
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

function decompressEntry(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.data;
  if (entry.method === 8) {
    const dest = new Uint8Array(entry.uncompSize);
    try {
      inflateRaw(entry.data, dest);
      return dest;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function extractTocFromZip(entries) {
  const tocEntry = entries.find((e) => e.filename.toLowerCase().endsWith("toc.ncx"));
  if (tocEntry) {
    const raw = decompressEntry(tocEntry);
    if (raw) {
      const xml = new TextDecoder().decode(raw);
      const baseDir = tocEntry.filename.substring(0, tocEntry.filename.lastIndexOf("/") + 1);
      const regex = /<navPoint[^>]*>[\s\S]*?<navLabel>\s*<text>(.*?)<\/text>\s*<\/navLabel>\s*<content\s+src="([^"#]+)(?:#[^"]*)?"\s*\/?>/gi;
      const chapters = [];
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const title = htmlToText(match[1]);
        let file = match[2].trim();
        if (!file.startsWith("http") && !file.startsWith("/")) {
          file = baseDir + file;
        }
        chapters.push({ title, file });
      }
      if (chapters.length > 0) return chapters;
    }
  }

  // Fallback: collect all xhtml / html chapter files in order
  const contentFiles = entries
    .filter((e) => {
      const fn = e.filename.toLowerCase();
      return (
        (fn.endsWith(".xhtml") || fn.endsWith(".html") || fn.endsWith(".htm")) &&
        !fn.includes("nav.xhtml") &&
        !fn.includes("toc.xhtml") &&
        !fn.includes("cover")
      );
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));

  return contentFiles.map((f, i) => ({
    title: `Section ${i + 1}`,
    file: f.filename,
  }));
}

// ── Text Formatting Helpers ──

function htmlToText(html) {
  let text = String(html || "")
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<(h[1-6])[^>]*>(.*?)<\/\1>/gi, "\n\n### $2\n\n")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/(p|div|blockquote|li)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

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
  t = t.replace(/^(?:fn\s*\d+\s*)?(?:97[89]\d{10}[,\s]*)+/i, "");
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
  if (trimmed.startsWith("<")) return null;
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

// ── EPUB Fetch & Unpack Helper ──

async function loadAndCacheEpub(bookId, downloadUrl) {
  if (epubCache.has(bookId)) {
    return epubCache.get(bookId);
  }

  try {
    const res = await harbor.http(downloadUrl, {
      method: "GET",
      headers: DOWNLOAD_HEADERS,
      responseType: "base64",
      timeoutMs: 25000,
    });

    if (!res || !res.ok || !res.body) return null;

    const binStr = atob(res.body);
    const len = binStr.length;
    if (len > 15 * 1024 * 1024) return null; // 15MB limit

    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }

    const entries = parseZipEntries(bytes);
    if (!entries || entries.length === 0) return null;

    const chapters = extractTocFromZip(entries);
    const cachedData = { entries, chapters };
    epubCache.set(bookId, cachedData);
    return cachedData;
  } catch (_) {
    return null;
  }
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

    // 2. Open Library Trending Fallback
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

    // 1. Direct Bookracy Search
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

    // 2. Fallback Open Library Search
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
    const title = summary ? summary.title : "Read Book";

    // Resolve direct download URL for this book
    let item = itemCache.get(id);
    let downloadUrl = (item && item.link) || "";
    const filetype = (item && item.book_filetype || "").toLowerCase();

    // If discovered via Open Library, find Bookracy release
    if (!downloadUrl && item && item.title) {
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
            const best = data.results[0];
            downloadUrl = best.link || "";
            itemCache.set(id, best);
          }
        }
      } catch (_) {}
    }

    // Try loading and extracting Table of Contents from EPUB
    if (downloadUrl && (filetype === "epub" || downloadUrl.includes(".epub"))) {
      const cached = await loadAndCacheEpub(id, downloadUrl);
      if (cached && cached.chapters && cached.chapters.length > 0) {
        return cached.chapters.map((ch, idx) => ({
          id: `${id}#${ch.file}`,
          chapter: String(idx + 1),
          title: ch.title || `Chapter ${idx + 1}`,
          position: idx,
          volume: "1",
          volumeTitle: "Main",
          publishAt: summary && summary.year ? String(summary.year) : undefined,
        }));
      }
    }

    // Single complete volume fallback
    return [
      {
        id: `${id}#full`,
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
    const hashIndex = (chapterId || "").indexOf("#");
    const rawId = hashIndex !== -1 ? chapterId.substring(0, hashIndex) : chapterId;
    const targetFile = hashIndex !== -1 ? chapterId.substring(hashIndex + 1) : "full";

    let item = itemCache.get(rawId);

    // Resolve Bookracy release if needed
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

    const downloadUrl = (bookracyRelease && bookracyRelease.link) || (item && item.link) || "";
    const title = (bookracyRelease && bookracyRelease.title) || (item && item.title) || cleanTitle(rawId);
    const author = (bookracyRelease && bookracyRelease.author) || (item && item.author) || "Unknown Author";
    const filetype = (bookracyRelease && bookracyRelease.book_filetype || "").toLowerCase();

    // Decompress EPUB and extract chapter text
    if (downloadUrl && (filetype === "epub" || downloadUrl.includes(".epub"))) {
      const cached = await loadAndCacheEpub(rawId, downloadUrl);
      if (cached && cached.entries) {
        // Specific chapter requested
        if (targetFile && targetFile !== "full") {
          const entry = cached.entries.find(
            (e) => e.filename === targetFile || e.filename.endsWith("/" + targetFile) || e.filename.endsWith(targetFile)
          );
          if (entry) {
            const rawBytes = decompressEntry(entry);
            if (rawBytes) {
              const htmlStr = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
              const prose = htmlToText(htmlStr);
              if (prose && prose.length > 20) {
                return prose;
              }
            }
          }
        }

        // Entire book or first section requested
        const readableEntries = cached.entries.filter((e) => {
          const fn = e.filename.toLowerCase();
          return (
            (fn.endsWith(".xhtml") || fn.endsWith(".html") || fn.endsWith(".htm")) &&
            !fn.includes("nav.xhtml") &&
            !fn.includes("toc.xhtml") &&
            !fn.includes("cover")
          );
        });

        const fullBookSections = [];
        for (const e of readableEntries) {
          const rawBytes = decompressEntry(e);
          if (rawBytes) {
            const htmlStr = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
            const prose = htmlToText(htmlStr);
            if (prose && prose.length > 30) {
              fullBookSections.push(prose);
            }
          }
        }

        if (fullBookSections.length > 0) {
          return fullBookSections.join("\n\n---\n\n");
        }
      }
    }

    // Fallback if download link or decompression failed
    const parts = [
      `# ${title}`,
      author && author !== "Unknown Author" ? `**Author:** ${author}` : "",
      item && item.description ? `\n## Synopsis\n${item.description}\n` : "",
      "---",
      filetype ? `* **Format:** ${filetype.toUpperCase()}` : "* **Source:** Bookracy",
      downloadUrl ? `Direct Download / Stream Link:\n${downloadUrl}` : "",
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
