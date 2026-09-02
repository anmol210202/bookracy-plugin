#!/usr/bin/env node

/**
 * Harbor Plugin Test Runner & Validator
 * Zero-dependency: uses Node.js 18+ native fetch
 */

const fs = require("fs");
const path = require("path");

// ANSI color codes for terminal output
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

// 1. Mock Harbor Runtime Environment
function createMockHarbor() {
  return {
    async http(url, options = {}) {
      const method = options.method || "GET";
      const headers = options.headers || {};
      const body = options.body;

      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
        });

        const status = response.status;
        const ok = response.ok;
        const respHeaders = Object.fromEntries(response.headers.entries());

        let responseBody;
        if (options.responseType === "arraybuffer") {
          responseBody = await response.arrayBuffer();
        } else {
          responseBody = await response.text();
        }

        return {
          ok,
          status,
          headers: respHeaders,
          body: responseBody,
        };
      } catch (err) {
        throw new Error(`Network failure on ${url}: ${err.message}`);
      }
    },

    parseHtml(html) {
      // Lightweight DOM fallback for HTML scrapers
      return {
        querySelector: () => null,
        querySelectorAll: () => [],
      };
    },

    async grpc() {
      throw new Error("gRPC not implemented in mock harness");
    },
  };
}

// 2. Verification Suite
async function runTests() {
  console.log(`\n${c.bold}${c.cyan}=== HARBOR EBOOK PLUGIN VALIDATOR ===${c.reset}\n`);

  let passCount = 0;
  let failCount = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(` ${c.green}✔${c.reset} ${message}`);
      passCount++;
    } else {
      console.log(` ${c.red}✖${c.reset} ${message}`);
      failCount++;
    }
  }

  // Phase A: Validate repo.json
  const repoPath = path.resolve("repo.json");
  assert(fs.existsSync(repoPath), "repo.json exists");

  let repoData = {};
  try {
    repoData = JSON.parse(fs.readFileSync(repoPath, "utf8"));
    assert(repoData.type === "ebook", 'repo.json "type" is "ebook"');
    assert(Array.isArray(repoData.plugins) && repoData.plugins.length > 0, 'repo.json contains "plugins" array');
  } catch (err) {
    assert(false, `repo.json JSON syntax valid: ${err.message}`);
  }

  const manifest = repoData.plugins?.[0] || {};
  const pluginFileName = manifest.entry || "bookracy.plugin.js";
  const pluginPath = path.resolve(pluginFileName);

  assert(fs.existsSync(pluginPath), `Plugin entry file (${pluginFileName}) exists`);

  // Phase B: Load Plugin Code in Harbor Sandbox
  let plugin;
  try {
    const code = fs.readFileSync(pluginPath, "utf8");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction(
      "harbor",
      `
      ${code}
      if (typeof plugin !== 'undefined') return plugin;
      `
    );

    const mockHarbor = createMockHarbor();
    plugin = await runner(mockHarbor);

    assert(typeof plugin === "object" && plugin !== null, "Plugin evaluated and returned object");
    assert(plugin.id === manifest.id, `Plugin ID matches manifest ("${plugin.id}")`);
  } catch (err) {
    assert(false, `Plugin load error: ${err.stack || err.message}`);
    console.log(`\n${c.red}Terminating suite due to critical initialization error.${c.reset}`);
    return;
  }

  // Phase C: Validate Required Interface Methods
  const requiredMethods = ["popular", "search", "detail", "chapters", "content"];
  for (const method of requiredMethods) {
    assert(typeof plugin[method] === "function", `Implements required method: ${method}()`);
  }

  // Phase D: Functional API Tests
  let testBookId = null;
  let testChapterId = null;

  // Test tags()
  if (typeof plugin.tags === "function") {
    try {
      const tags = await plugin.tags();
      assert(Array.isArray(tags) && tags.length > 0, `tags() returned ${tags.length} filters`);
    } catch (err) {
      assert(false, `tags() failed: ${err.message}`);
    }
  }

  // Test popular()
  console.log(`\n${c.bold}Testing Catalog Discovery:${c.reset}`);
  try {
    const popularItems = await plugin.popular(0);
    assert(Array.isArray(popularItems), "popular(0) returns an Array");
    if (popularItems.length > 0) {
      assert(true, `popular(0) returned ${popularItems.length} items`);
      const first = popularItems[0];
      testBookId = first.id;
      console.log(`   ${c.dim}Sample popular book:${c.reset} ${c.bold}${first.title}${c.reset} (${first.id})`);
    } else {
      console.log(`   ${c.yellow}⚠ popular(0) returned 0 items (network or query empty)${c.reset}`);
    }
  } catch (err) {
    assert(false, `popular(0) execution failed: ${err.message}`);
  }

  // Test search()
  console.log(`\n${c.bold}Testing Query Search:${c.reset}`);
  try {
    const searchQuery = "Artemis";
    const searchItems = await plugin.search(searchQuery, 0);
    assert(Array.isArray(searchItems), `search("${searchQuery}", 0) returns an Array`);
    if (searchItems.length > 0) {
      assert(true, `search("${searchQuery}") returned ${searchItems.length} items`);
      const match = searchItems[0];
      if (!testBookId) testBookId = match.id;
      console.log(`   ${c.dim}Sample search result:${c.reset} ${c.bold}${match.title}${c.reset} by ${match.author || "Unknown"}`);
    } else {
      console.log(`   ${c.yellow}⚠ search("${searchQuery}") returned 0 items${c.reset}`);
    }
  } catch (err) {
    assert(false, `search() execution failed: ${err.message}`);
  }

  // Test detail()
  if (testBookId) {
    console.log(`\n${c.bold}Testing Metadata Resolution:${c.reset}`);
    try {
      const detail = await plugin.detail(testBookId);
      assert(typeof detail === "object" && detail !== null, `detail("${testBookId}") returns object`);
      assert(Boolean(detail.title), `Detail includes valid title: "${detail.title}"`);
      console.log(`   ${c.dim}Cover URL:${c.reset} ${detail.cover || "none"}`);
      console.log(`   ${c.dim}Genres:${c.reset} ${(detail.genres || []).join(", ") || "none"}`);
    } catch (err) {
      assert(false, `detail("${testBookId}") failed: ${err.message}`);
    }

    // Test chapters()
    console.log(`\n${c.bold}Testing Table of Contents:${c.reset}`);
    try {
      const chapters = await plugin.chapters(testBookId);
      assert(Array.isArray(chapters) && chapters.length > 0, `chapters("${testBookId}") returned ${chapters.length} chapters`);
      if (chapters.length > 0) {
        testChapterId = chapters[0].id;
        console.log(`   ${c.dim}First chapter ID:${c.reset} ${testChapterId}`);
      }
    } catch (err) {
      assert(false, `chapters("${testBookId}") failed: ${err.message}`);
    }

    // Test content()
    if (testChapterId) {
      console.log(`\n${c.bold}Testing Chapter Content:${c.reset}`);
      try {
        const content = await plugin.content(testChapterId);
        assert(typeof content === "string" && content.length > 0, `content("${testChapterId}") returned valid text (${content.length} chars)`);
      } catch (err) {
        assert(false, `content("${testChapterId}") failed: ${err.message}`);
      }
    }
  }

  // Final Scorecard
  console.log(`\n${c.bold}${c.cyan}=== TEST SUMMARY ===${c.reset}`);
  console.log(` Passed: ${c.green}${passCount}${c.reset}`);
  console.log(` Failed: ${c.red}${failCount}${c.reset}`);

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}All plugin interface checks passed successfully!${c.reset}\n`);
  }
}

runTests().catch((err) => {
  console.error("Runner crash:", err);
  process.exit(1);
});
