#!/usr/bin/env node

/**
 * Enhanced Harbor Plugin Strict Test Suite
 * Simulates Harbor's exact installation, network domain auditing, and runtime checks.
 */

const fs = require("fs");
const path = require("path");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

const networkAudit = new Set();

function createHarborHarness() {
  return {
    async http(url, options = {}) {
      const parsedUrl = new URL(url);
      networkAudit.add(parsedUrl.hostname);

      // Verify domain policy: only api.bookracy.com or bookracy.com
      if (!parsedUrl.hostname.includes("bookracy.com")) {
        throw new Error(`DISALLOWED_DOMAIN: Contacted '${parsedUrl.hostname}' (Only Bookracy allowed)`);
      }

      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body,
        });
        return {
          ok: response.ok,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: options.responseType === "arraybuffer" 
            ? await response.arrayBuffer() 
            : await response.text(),
        };
      } catch (err) {
        throw new Error(`HTTP fetch failed for ${url}: ${err.message}`);
      }
    },
    parseHtml: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
    register: (p) => { globalThis.__registered_plugin = p; },
  };
}

async function runTests() {
  console.log(`\n${c.bold}${c.cyan}=== HARBOR EBOOK EXTENDED TEST SUITE ===${c.reset}\n`);

  let pass = 0; let fail = 0;
  function assert(condition, message) {
    if (condition) { console.log(` ${c.green}✔${c.reset} ${message}`); pass++; } 
    else { console.log(` ${c.red}✖${c.reset} ${message}`); fail++; }
  }

  // 1. Manifest Validation
  const repoPath = path.resolve("repo.json");
  assert(fs.existsSync(repoPath), "repo.json exists");
  
  let manifest = {};
  try {
    const repoData = JSON.parse(fs.readFileSync(repoPath, "utf8"));
    assert(repoData.type === "ebook", 'repo.json "type" is "ebook"');
    manifest = repoData.plugins[0];
    assert(manifest && manifest.id === "bookracy-source", "Plugin ID is 'bookracy-source'");
    assert(manifest.entry === "bookracy.plugin.js", "Entry points to 'bookracy.plugin.js'");
  } catch (e) {
    assert(false, `repo.json failed: ${e.message}`);
  }

  // 2. Plugin Load Simulation
  const pluginPath = path.resolve(manifest.entry || "bookracy.plugin.js");
  assert(fs.existsSync(pluginPath), "bookracy.plugin.js exists");

  let plugin;
  try {
    const code = fs.readFileSync(pluginPath, "utf8");
    const harness = createHarborHarness();
    const runner = new (Object.getPrototypeOf(async function(){}).constructor)("harbor", code);
    plugin = await runner(harness) || globalThis.__registered_plugin || globalThis.plugin;
    assert(typeof plugin === "object" && plugin !== null, "Plugin exports valid object");
    assert(plugin.id === manifest.id, "Plugin ID strictly matches repo.json");
  } catch (e) {
    console.error(`\n${c.red}Fatal Plugin Execution Error:${c.reset}`, e);
    process.exit(1);
  }

  // 3. Interface Contract Check
  ["popular", "search", "detail", "chapters", "content"].forEach(m => {
    assert(typeof plugin[m] === "function", `Implements required method: ${m}()`);
  });

  // 4. Harbor Installation Simulation: popular(0)
  console.log(`\n${c.bold}1. Harbor Installation: Testing popular(0)${c.reset}`);
  let popularBooks = [];
  try {
    popularBooks = await plugin.popular(0);
    assert(Array.isArray(popularBooks) && popularBooks.length >= 5, `popular(0) returned ${popularBooks.length} items`);
    
    // Check that items are clean English books
    const hasRussian = popularBooks.some(b => /[\u0400-\u04FF]/.test(b.title));
    assert(!hasRussian, "Popular list contains no Cyrillic books");

    const sample = popularBooks[0];
    assert(typeof sample.id === "string" && !sample.id.includes("|"), `ID is clean string: "${sample.id}"`);
    assert(typeof sample.title === "string" && sample.title.length > 0, `Title is clean string: "${sample.title}"`);
    assert(sample.originalLanguage === "en", "originalLanguage is declared 'en'");
    console.log(`   ${c.dim}Sample Popular:${c.reset} ${c.bold}${sample.title}${c.reset} (${sample.id})`);
  } catch (e) {
    assert(false, `popular(0) failed: ${e.message}`);
  }

  // 5. Harbor Installation Simulation: search("test")
  console.log(`\n${c.bold}2. Harbor Installation: Testing search() variations${c.reset}`);
  let searchBooks = [];
  try {
    // Test generic search used by Harbor validator
    const genericSearch = await plugin.search("test", 0);
    assert(Array.isArray(genericSearch), "search('test', 0) succeeds");

    // Test standard book search
    searchBooks = await plugin.search("Dune", 0);
    assert(Array.isArray(searchBooks) && searchBooks.length > 0, `search('Dune', 0) returned ${searchBooks.length} results`);
    const found = searchBooks[0];
    console.log(`   ${c.dim}Sample Search Result:${c.reset} ${c.bold}${found.title}${c.reset} by ${found.author || "Unknown"}`);
  } catch (e) {
    assert(false, `search() failed: ${e.message}`);
  }

  // 6. Harbor Installation Simulation: detail(id)
  const testId = popularBooks[0]?.id || searchBooks[0]?.id;
  assert(Boolean(testId), "Resolved a test book ID from previous steps");

  console.log(`\n${c.bold}3. Harbor Installation: Testing detail('${testId}')${c.reset}`);
  try {
    const detail = await plugin.detail(testId);
    assert(typeof detail === "object" && detail.id === testId, "detail() returns matching ID");
    assert(typeof detail.title === "string" && detail.title.length > 0, `detail.title is present: "${detail.title}"`);
    assert(!detail.cover || detail.cover.startsWith("http"), "detail.cover is absolute HTTP(S)");
    assert(typeof detail.description === "string", "detail.description is present");
    console.log(`   ${c.dim}Enriched Cover URL:${c.reset} ${detail.cover || "none"}`);
  } catch (e) {
    assert(false, `detail() failed: ${e.message}`);
  }

  // 7. Harbor Installation Simulation: chapters(id)
  let chapterId = null;
  console.log(`\n${c.bold}4. Harbor Installation: Testing chapters('${testId}')${c.reset}`);
  try {
    const chapters = await plugin.chapters(testId);
    assert(Array.isArray(chapters) && chapters.length > 0, `chapters() returned ${chapters.length} chapter(s)`);
    const chap = chapters[0];
    chapterId = chap.id;
    assert(typeof chap.id === "string" && chap.id.length > 0, `Chapter ID is valid: "${chap.id}"`);
    assert(chap.position === 0, "Chapter position is zero-based number (0)");
  } catch (e) {
    assert(false, `chapters() failed: ${e.message}`);
  }

  // 8. Harbor Installation Simulation: content(chapterId)
  console.log(`\n${c.bold}5. Harbor Installation: Testing content('${chapterId}')${c.reset}`);
  try {
    const content = await plugin.content(chapterId);
    assert(typeof content === "string" && content.length > 0, `content() returned text (${content.length} chars)`);
  } catch (e) {
    assert(false, `content() failed: ${e.message}`);
  }

  // 9. Tag Filter Test
  console.log(`\n${c.bold}6. Filter & Genre Routing: Testing popular(0, 'genre:science-fiction')${c.reset}`);
  try {
    const filtered = await plugin.popular(0, "genre:science-fiction");
    assert(Array.isArray(filtered) && filtered.length > 0, `Filtered query returned ${filtered.length} books`);
    console.log(`   ${c.dim}Sci-Fi Sample:${c.reset} ${filtered[0].title}`);
  } catch (e) {
    assert(false, `Genre filter failed: ${e.message}`);
  }

  // 10. Network Audit Check
  console.log(`\n${c.bold}7. Network Domain Audit:${c.reset}`);
  const domains = Array.from(networkAudit);
  console.log(`   ${c.dim}Domains contacted:${c.reset} ${domains.join(", ")}`);
  assert(!domains.some(d => d.includes("openlibrary.org")), "Verified 0 requests to Open Library");
  assert(domains.every(d => d.includes("bookracy.com")), "All requests routed exclusively through Bookracy");

  // Summary
  console.log(`\n${c.bold}${c.cyan}=== TEST SUMMARY ===${c.reset}`);
  console.log(` Passed: ${c.green}${pass}${c.reset}`);
  console.log(` Failed: ${c.red}${fail}${c.reset}`);

  if (fail > 0) {
    console.log(`\n${c.red}${c.bold}Fix the failures above before deploying to Harbor.${c.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}100% Harbor Installation Compliant! Ready for deployment.${c.reset}\n`);
  }
}

runTests();
