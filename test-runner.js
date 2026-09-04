#!/usr/bin/env node

/**
 * Harbor Plugin Strict Harness & Concurrency Simulator
 */

const fs = require("fs");
const path = require("path");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

let activeRequests = 0;
let peakRequests = 0;
const domainsContacted = new Set();

function createHarborHarness() {
  return {
    async http(url, options = {}) {
      activeRequests++;
      peakRequests = Math.max(peakRequests, activeRequests);

      const parsed = new URL(url);
      domainsContacted.add(parsed.hostname);

      if (activeRequests > 6) {
        activeRequests--;
        throw new Error(`CONCURRENCY_OVERFLOW: ${activeRequests} simultaneous requests exceeds Harbor's limit of 6!`);
      }

      if (!parsed.hostname.includes("bookracy.com")) {
        activeRequests--;
        throw new Error(`DOMAIN_LEAK: Disallowed domain '${parsed.hostname}'. Must use Bookracy only.`);
      }

      if (url.includes("NaN")) {
        activeRequests--;
        throw new Error(`INVALID_PARAMETER: URL contains 'NaN': ${url}`);
      }

      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body,
        });

        const status = response.status;
        const ok = response.ok;
        const respHeaders = Object.fromEntries(response.headers.entries());
        const body = options.responseType === "arraybuffer"
          ? await response.arrayBuffer()
          : await response.text();

        activeRequests--;
        return { ok, status, headers: respHeaders, body };
      } catch (err) {
        activeRequests--;
        throw err;
      }
    },
    parseHtml: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
    register: (p) => { globalThis.__harbor_plugin = p; },
  };
}

async function runTests() {
  console.log(`\n${c.bold}${c.cyan}=== HARBOR RUNTIME HARNESS & SIMULATOR ===${c.reset}\n`);

  let pass = 0;
  let fail = 0;
  function assert(cond, msg) {
    if (cond) { console.log(` ${c.green}✔${c.reset} ${msg}`); pass++; }
    else { console.log(` ${c.red}✖${c.reset} ${msg}`); fail++; }
  }

  // 1. Manifest
  const repoData = JSON.parse(fs.readFileSync("repo.json", "utf8"));
  assert(repoData.type === "ebook", "repo.json type is 'ebook'");
  const manifest = repoData.plugins[0];
  assert(manifest.version === "1.7.0", "repo.json version is bumped to 1.7.0");

  // 2. Load Plugin in Harbor Sandbox
  const code = fs.readFileSync("bookracy.plugin.js", "utf8");
  const harness = createHarborHarness();
  const runner = new (Object.getPrototypeOf(async function () {}).constructor)("harbor", code);
  const plugin = (await runner(harness)) || globalThis.__harbor_plugin || globalThis.plugin;
  assert(plugin && plugin.id === manifest.id, "Plugin registered and matches manifest ID");

  // 3. Test popular(undefined)
  console.log(`\n${c.bold}1. Testing popular(undefined) [Initial Harbor View]:${c.reset}`);
  let popularBooks = [];
  try {
    const t0 = Date.now();
    popularBooks = await plugin.popular(undefined, undefined);
    const elapsed = Date.now() - t0;

    assert(Array.isArray(popularBooks) && popularBooks.length > 0, `popular() returned ${popularBooks.length} books in ${elapsed}ms`);
    assert(elapsed < 15000, `popular() responded under 15000ms threshold (${elapsed}ms)`);

    const invalidCovers = popularBooks.filter(b => b.cover && !b.cover.startsWith("http"));
    assert(invalidCovers.length === 0, "All present covers are absolute HTTP(S)");

    const sample = popularBooks[0];
    console.log(`   ${c.dim}Sample Book:${c.reset} ${c.bold}${sample.title}${c.reset} by ${sample.author || "Unknown"}`);
  } catch (e) {
    assert(false, `popular() failed: ${e.message}`);
  }

  // 4. Test search() variations
  console.log(`\n${c.bold}2. Testing search() variations:${c.reset}`);
  let searchBooks = [];
  try {
    const emptySearch = await plugin.search("", undefined);
    assert(Array.isArray(emptySearch) && emptySearch.length > 0, "search('', undefined) handles empty query cleanly");

    searchBooks = await plugin.search("Dune", 0);
    assert(Array.isArray(searchBooks) && searchBooks.length > 0, `search('Dune') returned ${searchBooks.length} books`);

    const invalidSearchCovers = searchBooks.filter(b => b.cover && !b.cover.startsWith("http"));
    assert(invalidSearchCovers.length === 0, "All present search covers are absolute HTTP(S)");
    console.log(`   ${c.dim}Search Match:${c.reset} ${searchBooks[0].title} by ${searchBooks[0].author || "Unknown"}`);
  } catch (e) {
    assert(false, `search() failed: ${e.message}`);
  }

  // 5. Test detail(), chapters(), content()
  const testId = popularBooks[0]?.id || searchBooks[0]?.id;
  console.log(`\n${c.bold}3. Testing detail(), chapters(), content():${c.reset}`);
  try {
    const detail = await plugin.detail(testId);
    assert(detail && detail.id === testId, "detail() returned correct ID");
    assert(typeof detail.title === "string" && detail.title.length > 0 && detail.title !== "undefined", `detail.title is valid: "${detail.title}"`);
    assert(!detail.cover || detail.cover.startsWith("http"), "detail.cover is absolute HTTP(S)");

    const chapters = await plugin.chapters(testId);
    assert(Array.isArray(chapters) && chapters.length > 0, `chapters() returned ${chapters.length} chapter`);

    const content = await plugin.content(chapters[0].id);
    assert(typeof content === "string" && content.length > 0, `content() returned readable text (${content.length} chars)`);
  } catch (e) {
    assert(false, `Reader pipeline failed: ${e.message}`);
  }

  // 6. Network audit & Concurrency Check
  console.log(`\n${c.bold}4. Network Safety & Concurrency Audit:${c.reset}`);
  console.log(`   ${c.dim}Peak in-flight requests:${c.reset} ${peakRequests} (Max allowed: 6)`);
  assert(peakRequests <= 6, `Peak concurrency (${peakRequests}) safely within Harbor's 6-request ceiling`);

  const domains = Array.from(domainsContacted);
  console.log(`   ${c.dim}Domains contacted:${c.reset} ${domains.join(", ")}`);
  assert(!domains.some(d => d.includes("openlibrary.org")), "Zero calls to Open Library");
  assert(domains.every(d => d.includes("bookracy.com")), "All calls routed exclusively to Bookracy");

  console.log(`\n${c.bold}${c.cyan}=== TEST SUMMARY ===${c.reset}`);
  console.log(` Passed: ${c.green}${pass}${c.reset}`);
  console.log(` Failed: ${c.red}${fail}${c.reset}`);

  if (fail > 0) {
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}All Harbor constraints passed cleanly! Ready to deploy.${c.reset}\n`);
  }
}

runTests();
