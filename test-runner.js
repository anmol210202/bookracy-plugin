#!/usr/bin/env node

/**
 * Harbor Plugin Strict Validator
 * Validates Bookracy plugin against Harbor eBook Specifications.
 */

const fs = require("fs");
const path = require("path");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

// 1. Mock Harbor Runtime
function createMockHarbor() {
  return {
    async http(url, options = {}) {
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
        throw new Error(`Network failure on ${url}: ${err.message}`);
      }
    },
    parseHtml: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
    register: () => {}, // Mock register function
  };
}

async function runTests() {
  console.log(`\n${c.bold}${c.cyan}=== HARBOR EBOOK PLUGIN STRICT VALIDATOR ===${c.reset}\n`);

  let pass = 0; let fail = 0;
  function assert(condition, message) {
    if (condition) { console.log(` ${c.green}✔${c.reset} ${message}`); pass++; } 
    else { console.log(` ${c.red}✖${c.reset} ${message}`); fail++; }
  }

  // Phase A: Validate repo.json
  const repoPath = path.resolve("repo.json");
  assert(fs.existsSync(repoPath), "repo.json exists");
  
  let manifest = {};
  try {
    const repoData = JSON.parse(fs.readFileSync(repoPath, "utf8"));
    assert(repoData.type === "ebook", 'repo.json "type" is "ebook"');
    manifest = repoData.plugins[0];
    assert(manifest && manifest.id, "repo.json contains a valid plugin manifest");
  } catch (e) {
    assert(false, `repo.json parsing failed: ${e.message}`);
  }

  // Phase B: Load Plugin
  const pluginPath = path.resolve(manifest.entry || "bookracy.plugin.js");
  assert(fs.existsSync(pluginPath), `Plugin entry file (${path.basename(pluginPath)}) exists`);

  let plugin;
  try {
    const code = fs.readFileSync(pluginPath, "utf8");
    const runner = new (Object.getPrototypeOf(async function(){}).constructor)(
      "harbor", 
      `${code}\nif (typeof plugin !== 'undefined') return plugin;`
    );
    plugin = await runner(createMockHarbor());
    assert(plugin.id === manifest.id, `Plugin ID matches manifest ("${plugin.id}")`);
  } catch (e) {
    console.error(`\n${c.red}Fatal Plugin Load Error:${c.reset}`, e);
    process.exit(1);
  }

  // Phase C: Interface Check
  ["popular", "search", "detail", "chapters", "content"].forEach(method => {
    assert(typeof plugin[method] === "function", `Implements ${method}()`);
  });

  let testBookId = null;
  let testChapterId = null;

  // Phase D: Functional Tests
  console.log(`\n${c.bold}Testing Catalog Discovery (popular):${c.reset}`);
  try {
    const items = await plugin.popular(0);
    assert(Array.isArray(items), "popular(0) returns an array");
    if (items.length > 0) {
      const book = items[0];
      testBookId = book.id;
      assert(typeof book.id === "string", "Summary includes string ID");
      assert(typeof book.title === "string", "Summary includes string Title");
      assert(!book.cover || book.cover.startsWith("http"), "Cover URL is absolute HTTP(S)");
      console.log(`   ${c.dim}Sample:${c.reset} ${book.title} (${book.id})`);
    }
  } catch (e) { assert(false, `popular() failed: ${e.message}`); }

  console.log(`\n${c.bold}Testing Query Search:${c.reset}`);
  try {
    const items = await plugin.search("Artemis", 0);
    assert(Array.isArray(items), 'search("Artemis") returns an array');
    if (items.length > 0) {
      assert(items[0].id, "Search result contains an ID");
      console.log(`   ${c.dim}Sample:${c.reset} ${items[0].title}`);
    }
  } catch (e) { assert(false, `search() failed: ${e.message}`); }

  if (testBookId) {
    console.log(`\n${c.bold}Testing Metadata Resolution (detail):${c.reset}`);
    try {
      const detail = await plugin.detail(testBookId);
      assert(detail && detail.id === testBookId, "detail() returns matching ID");
      assert(typeof detail.title === "string", "Detail includes title");
      assert(!detail.cover || detail.cover.startsWith("http"), "Detail cover is absolute");
    } catch (e) { assert(false, `detail() failed: ${e.message}`); }

    console.log(`\n${c.bold}Testing Chapters:${c.reset}`);
    try {
      const chapters = await plugin.chapters(testBookId);
      assert(Array.isArray(chapters) && chapters.length > 0, "chapters() returned data");
      
      const chap = chapters[0];
      testChapterId = chap.id;
      assert(typeof chap.id === "string", "Chapter includes ID");
      assert(chap.position === undefined || typeof chap.position === "number", "Chapter position is a number");
      console.log(`   ${c.dim}Chapter 1 ID:${c.reset} ${testChapterId}`);
    } catch (e) { assert(false, `chapters() failed: ${e.message}`); }

    if (testChapterId) {
      console.log(`\n${c.bold}Testing Chapter Content:${c.reset}`);
      try {
        const content = await plugin.content(testChapterId);
        assert(typeof content === "string" && content.length > 0, `content() returned string (${content.length} chars)`);
      } catch (e) { assert(false, `content() failed: ${e.message}`); }
    }
  }

  console.log(`\n${c.bold}${c.cyan}=== TEST SUMMARY ===${c.reset}`);
  console.log(` Passed: ${c.green}${pass}${c.reset}`);
  console.log(` Failed: ${c.red}${fail}${c.reset}`);

  if (fail > 0) process.exit(1);
  else console.log(`\n${c.green}${c.bold}Ready for deployment!${c.reset}\n`);
}

runTests();
