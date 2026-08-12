#!/usr/bin/env node
/**
 * Validation harness for scrape-enanyang-articles.js. No network involved —
 * matching validate-import-source-articles.js's own no-fixture-injection
 * precedent for pure-data scripts — this validates the JSON-LD parser
 * against hand-authored HTML fixtures (one shaped like a real enanyang.my
 * page, one deliberately missing a NewsArticle block) plus a temp copy of
 * the schema for the upsertSourceArticle() wiring, never touching the real
 * admin/knowledge-graph.db or the network.
 *
 * Proves:
 *   1. extractNewsArticleLd() pulls articleBody/headline/datePublished/
 *      image/keywords correctly from a fixture shaped like the real page.
 *   2. A page with no NewsArticle JSON-LD block returns null (not a throw).
 *   3. A malformed (non-JSON) ld+json script is skipped, not fatal, when a
 *      later valid script on the same page has the real block.
 *   4. buildSourceSlug() stays unique across Chinese titles that all
 *      slugify to the same "topic" fallback, by suffixing eNanyang's own
 *      numeric article id pulled from the URL.
 *   5. cleanHeadline() strips the "/<author> | e南洋" suffix shape.
 *   6. processRow() end-to-end against an injected fetch (no real network):
 *      dry-run doesn't touch the db, a real run upserts one row, a second
 *      run is idempotent (still one row), a 404-shaped fetch failure comes
 *      back as 'fetch-error' rather than throwing, and a 429 comes back as
 *      a StopRunError instead of a normal outcome.
 *
 * Usage: node validate-scrape-enanyang-articles.js
 */

import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  extractNewsArticleLd,
  buildSourceSlug,
  extractArticleIdFromUrl,
  cleanHeadline,
  fetchEnanyangHtml,
  processRow,
  StopRunError,
} from './scrape-enanyang-articles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql');
const TEST_DB_PATH = path.join(OUTPUT_DIR, 'scrape-enanyang-articles-test.db');

function freshTempDb() {
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  const db = new DatabaseSync(TEST_DB_PATH);
  db.exec(readFileSync(SCHEMA_SQL_PATH, 'utf-8'));
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures — shaped like the real enanyang.my page structure observed
// 2026-08-12 (see scrape-enanyang-articles.js's header comment), not copied
// verbatim (no real article text needed to prove the parser works).
// ---------------------------------------------------------------------------

const REAL_LD = {
  '@context': 'https://schema.org',
  '@type': 'NewsArticle',
  name: '测试标题/麦传球 | e南洋',
  url: 'https://www.enanyang.my/news/20260101/Testimonia-Column/1234567',
  headline: '测试标题/麦传球 | e南洋',
  description: 'A short teaser.',
  image: { '@type': 'ImageObject', url: 'https://vega.enanyang.my/wp-content/uploads/2026/01/test.jpg' },
  thumbnailUrl: 'https://vega.enanyang.my/wp-content/uploads/2026/01/test.jpg',
  author: { '@type': 'Organization', name: 'e南洋' },
  isAccessibleForFree: true,
  articleBody: '这是完整的文章内容，用于测试。'.repeat(10),
  keywords: ['交易,投资,股票'],
  datePublished: '2026-01-01T12:00:00+08:00',
  dateModified: '2026-01-01T12:00:00+08:00',
};

function pageWithLd(ldBlocks) {
  const scripts = ldBlocks.map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join('\n');
  return `<!doctype html><html><head>${scripts}</head><body><p>teaser text, paywalled</p></body></html>`;
}

const REAL_PAGE_HTML = pageWithLd([
  { '@context': 'https://schema.org', '@type': 'WebPage', name: 'irrelevant WebPage block' },
  REAL_LD,
]);

const NO_NEWSARTICLE_HTML = pageWithLd([{ '@context': 'https://schema.org', '@type': 'WebPage', name: 'only a WebPage block' }]);

const MALFORMED_THEN_REAL_HTML = `<!doctype html><html><head>
<script type="application/ld+json">{not valid json,,,</script>
<script type="application/ld+json">${JSON.stringify(REAL_LD)}</script>
</head><body></body></html>`;

// ---------------------------------------------------------------------------
// Part 1 — extractNewsArticleLd()
// ---------------------------------------------------------------------------

function checks_extractNewsArticleLd() {
  console.log('=== Part 1: extractNewsArticleLd() ===\n');
  const checks = [];

  const found = extractNewsArticleLd(REAL_PAGE_HTML);
  checks.push(['finds the NewsArticle block among multiple ld+json scripts', !!found]);
  checks.push(['pulls articleBody verbatim', found?.articleBody === REAL_LD.articleBody]);
  checks.push(['pulls headline', found?.headline === REAL_LD.headline]);
  checks.push(['pulls datePublished', found?.datePublished === REAL_LD.datePublished]);
  checks.push(['pulls image.url', found?.image?.url === REAL_LD.image.url]);
  checks.push(['pulls keywords', Array.isArray(found?.keywords) && found.keywords[0] === REAL_LD.keywords[0]]);

  const missing = extractNewsArticleLd(NO_NEWSARTICLE_HTML);
  checks.push(['a page with no NewsArticle block returns null, not a throw', missing === null]);

  const afterMalformed = extractNewsArticleLd(MALFORMED_THEN_REAL_HTML);
  checks.push(['a malformed ld+json script is skipped; a later valid one is still found', afterMalformed?.articleBody === REAL_LD.articleBody]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — buildSourceSlug() / extractArticleIdFromUrl() / cleanHeadline()
// ---------------------------------------------------------------------------

function checks_slugAndHeadline() {
  console.log('\n=== Part 2: buildSourceSlug() / cleanHeadline() ===\n');
  const checks = [];

  checks.push(['extractArticleIdFromUrl pulls the trailing numeric id', extractArticleIdFromUrl('https://www.enanyang.my/news/20260101/X/1234567') === '1234567']);
  checks.push(['extractArticleIdFromUrl returns null for a non-numeric trailing segment', extractArticleIdFromUrl('https://example.com/news/not-a-number') === null]);

  const titleA = '股市为何常在季末调整?'; // slugifyTopic alone -> "topic" (no latin chars survive)
  const titleB = '“赢”字隐藏5致胜密码'; // slugifyTopic alone -> "5" (the one digit survives)
  const urlA = 'https://www.enanyang.my/news/20260624/X/1291453';
  const urlB = 'https://www.enanyang.my/news/20260617/X/1284634';
  const slugA = buildSourceSlug(titleA, urlA);
  const slugB = buildSourceSlug(titleB, urlB);
  checks.push(['two different Chinese titles that both slugify to a short/empty base still get DISTINCT slugs', slugA !== slugB]);
  checks.push(['the numeric article id from the URL is present in the slug', slugA.endsWith('-1291453')]);

  const noIdUrl = 'https://example.com/no-trailing-number-here';
  const fallbackSlug = buildSourceSlug('some title', noIdUrl);
  checks.push(['a URL with no trailing numeric id still produces a non-empty slug (hash fallback)', typeof fallbackSlug === 'string' && fallbackSlug.length > 0]);

  checks.push(['cleanHeadline strips the "/<author> | e南洋" suffix', cleanHeadline('测试标题/麦传球 | e南洋') === '测试标题']);
  checks.push(['cleanHeadline falls back to stripping only the site suffix if no "/" present', cleanHeadline('测试标题 | e南洋') === '测试标题']);
  checks.push(['cleanHeadline returns null for a non-string input', cleanHeadline(undefined) === null]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 3 — processRow() end-to-end against an injected fetch (no network)
// ---------------------------------------------------------------------------

/** Monkeypatches global.fetch for the duration of `fn`, restoring it
 *  afterward even if `fn` throws — the same "inject at the network
 *  boundary, not deeper" approach openai-client.js's own validate harness
 *  uses for its fetch-shaped dependency. */
async function withFetch(fakeFetch, fn) {
  const realFetch = global.fetch;
  global.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    global.fetch = realFetch;
  }
}

function htmlResponse(html) {
  return { ok: true, status: 200, text: async () => html };
}
function statusResponse(status) {
  return { ok: false, status, text: async () => '' };
}

async function checks_processRow() {
  console.log('\n=== Part 3: processRow() end-to-end ===\n');
  const checks = [];

  const row = { title: null, url: REAL_LD.url, publishedAt: null, category: 'fundamental analysis', keywords: [], id: 42 };

  // --- dry-run: no db touched ---
  await withFetch(
    async () => htmlResponse(REAL_PAGE_HTML),
    async () => {
      const outcome = await processRow(row, { db: null, dryRun: true });
      checks.push(['dry-run returns status "dry-run"', outcome.status === 'dry-run']);
      checks.push(['dry-run resolves a slug from the JSON-LD headline (row.title was null)', outcome.slug === buildSourceSlug(cleanHeadline(REAL_LD.headline), REAL_LD.url)]);
    }
  );

  // --- real run: upserts one row ---
  const db = freshTempDb();
  try {
    let resolvedSlug;
    await withFetch(
      async () => htmlResponse(REAL_PAGE_HTML),
      async () => {
        const outcome = await processRow(row, { db, dryRun: false });
        resolvedSlug = outcome.slug;
        checks.push(['real run returns status "ok"', outcome.status === 'ok']);
      }
    );
    const afterFirst = db.prepare('SELECT COUNT(*) AS n FROM source_articles WHERE slug = ?').get(resolvedSlug);
    checks.push(['real run inserts exactly one row', afterFirst.n === 1]);

    const written = db.prepare('SELECT title, author, original_content, category, published_at, featured_image FROM source_articles WHERE slug = ?').get(resolvedSlug);
    checks.push(['author is hardcoded to Warren Mak, not the JSON-LD publisher org', written.author === '麦传球 (Warren Mak)']);
    checks.push(['original_content matches articleBody', written.original_content === REAL_LD.articleBody]);
    checks.push(['category falls back to the row (index) value', written.category === 'fundamental analysis']);
    checks.push(['published_at comes from the JSON-LD datePublished', written.published_at === REAL_LD.datePublished]);
    checks.push(['featured_image comes from JSON-LD image.url', written.featured_image === REAL_LD.image.url]);

    // --- second run: idempotent, still one row ---
    await withFetch(
      async () => htmlResponse(REAL_PAGE_HTML),
      () => processRow(row, { db, dryRun: false })
    );
    const afterSecond = db.prepare('SELECT COUNT(*) AS n FROM source_articles WHERE slug = ?').get(resolvedSlug);
    checks.push(['second run over the same article is idempotent — still exactly one row', afterSecond.n === 1]);
  } finally {
    db.close();
  }

  // --- no NewsArticle block on the page ---
  await withFetch(
    async () => htmlResponse(NO_NEWSARTICLE_HTML),
    async () => {
      const outcome = await processRow(row, { db: null, dryRun: true });
      checks.push(['a page with no NewsArticle block -> status "no-articleBody-found", not a throw', outcome.status === 'no-articleBody-found']);
    }
  );

  // --- 404-shaped fetch failure ---
  await withFetch(
    async () => statusResponse(404),
    async () => {
      const outcome = await processRow(row, { db: null, dryRun: true });
      checks.push(['a 404 response -> status "fetch-error", not a throw that aborts the run', outcome.status === 'fetch-error']);
    }
  );

  // --- 429 -> StopRunError, not a normal outcome ---
  await withFetch(
    async () => statusResponse(429),
    async () => {
      let threwStopRunError = false;
      try {
        await processRow(row, { db: null, dryRun: true });
      } catch (err) {
        threwStopRunError = err instanceof StopRunError;
      }
      checks.push(['a 429 response throws StopRunError (caller must stop the whole run)', threwStopRunError]);
    }
  );

  // --- fetchEnanyangHtml itself: 5xx retries, exhausts, then throws a plain Error ---
  await withFetch(
    async () => statusResponse(500),
    async () => {
      let threw = false;
      let isStopRunError = false;
      try {
        await fetchEnanyangHtml('https://example.com/x', { maxAttempts: 2, baseDelayMs: 1 });
      } catch (err) {
        threw = true;
        isStopRunError = err instanceof StopRunError;
      }
      checks.push(['a persistent 5xx eventually throws (after retrying), not a StopRunError', threw && !isStopRunError]);
    }
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(SCHEMA_SQL_PATH)) throw new Error(`Missing ${path.relative(REPO_ROOT, SCHEMA_SQL_PATH)}`);

  const checks = [...checks_extractNewsArticleLd(), ...checks_slugAndHeadline(), ...(await checks_processRow())];

  console.log('\n=== Results ===');
  let allPassed = true;
  for (const [label, passed] of checks) {
    allPassed &&= passed;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}: ${label}`);
  }
  console.log(`\n${allPassed ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED'}`);
  process.exitCode = allPassed ? 0 : 1;

  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
}

main();
