#!/usr/bin/env node
/**
 * eNanyang article full-text scraper — script 2 of 2 from
 * extra-md-files/nanyang-scraper.md ("Nanyang / TradeWizard Article Scraper
 * — Build Plan"). Reads scrape-tradewizard-index.js's output (or a single
 * `--url`), fetches each eNanyang article page, parses its `NewsArticle`
 * JSON-LD block for the full article text, and upserts into the
 * `source_articles` table via import-source-articles.js's
 * upsertSourceArticle() (imported, not reimplemented).
 *
 * Live-verified 2026-08-12 against enanyang.my (see nanyang-scraper.md's
 * "Key discovery"): the page's own visible UI shows only a teaser behind a
 * "注册并解锁完整内容" paywall prompt, but the SAME anonymous HTTP response
 * carries an `application/ld+json` NewsArticle block whose `articleBody`
 * holds the complete article text — confirmed both on a 2026 article and on
 * two 2018 articles (resolves that doc's open question 2: this is not a
 * recent-articles-only quirk). No login/cookies/session needed at all.
 * Flag this every time this file is read, not just once: reading full
 * content through the SEO/structured-data channel instead of the reader-
 * facing unlock flow the page clearly signals it wants used is a business/
 * ToS call, not a technical one — see this file's "Execution gate" note
 * below and nanyang-scraper.md's fuller writeup before ever removing the
 * --limit/--url guard on a real run.
 *
 * SLUG FIX vs. the build plan's literal wording: the plan says "reuse
 * generate-article.js's slugifyTopic(title)" — but slugifyTopic strips
 * every non-[a-z0-9] character, and eNanyang titles are Chinese
 * (e.g. "股市为何常在季末调整?"), so slugifyTopic alone collapses EVERY
 * title to the same fallback "topic" string. Verified against the real
 * 432-row tradewizard-index.json this would happen on effectively every
 * row, and since source_articles.slug has a UNIQUE index
 * (idx_source_articles_slug), every upsert after the first would silently
 * overwrite the same one row instead of creating distinct rows. Fixed here
 * by suffixing the slug with eNanyang's own permanent numeric article id —
 * the trailing path segment of every enanyang.my article URL (e.g.
 * ".../1284634" -> "1284634") — which is present in both the index-driven
 * and single --url code paths, unlike TradeWizard's own catalog id (which
 * script 1 kept on each row "for future dedupe/checkpointing" but which
 * isn't available in --url mode).
 *
 * Usage (from scripts/):
 *   node scrape-enanyang-articles.js --url <enanyang-url> --dry-run   # parse + print one article, no db write
 *   node scrape-enanyang-articles.js --dry-run                       # parse + print every row in the index, no db write
 *   node scrape-enanyang-articles.js --limit 3                       # real run, first 3 index rows only
 *   node scrape-enanyang-articles.js --url <enanyang-url>             # real run, one article
 *   node scrape-enanyang-articles.js --slug <slug>                    # real run, one row matching a computed slug
 *   node scrape-enanyang-articles.js --start-after <slug>             # resume after a given slug (checkpointing)
 *   node scrape-enanyang-articles.js --delay-ms 1500                  # override the between-request delay (default 1200ms)
 *   node scrape-enanyang-articles.js --index-file output/custom.json  # override the index input path
 *   node scrape-enanyang-articles.js --db ../admin/knowledge-graph.db # (default shown)
 *
 * EXECUTION GATE — per nanyang-scraper.md: do not run this against the full
 * ~400+ row index until the user has looped in their supervisor. Testing
 * with --limit or a single --url is fine at any time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import { slugifyTopic } from './generate-article.js';
import { upsertSourceArticle } from './import-source-articles.js';
import { nextArg } from './cli-args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql'), 'utf-8');

const DEFAULT_INDEX_FILE = path.join(__dirname, 'output', 'tradewizard-index.json');
const DEFAULT_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');
const AUTHOR = '麦传球 (Warren Mak)'; // the JSON-LD's own `author` field is the publisher (e南洋), not him — hardcode per the build plan
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000; // retry backoff base, not the between-request politeness delay
const DEFAULT_DELAY_MS = 1200; // between-request politeness delay

// ---------------------------------------------------------------------------
// Thrown when a fetch comes back 429/403 — treated as "stop the whole run",
// distinct from an ordinary network error/404/5xx which is logged and
// skipped so one bad page never aborts the rest (per the build plan's open
// question 3).
// ---------------------------------------------------------------------------
export class StopRunError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    indexFile: DEFAULT_INDEX_FILE,
    dbPath: DEFAULT_DB,
    url: null,
    limit: null,
    delayMs: DEFAULT_DELAY_MS,
    onlySlug: null,
    startAfter: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--index-file':
        opts.indexFile = path.resolve(nextArg(argv, ++i, '--index-file'));
        break;
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--url':
        opts.url = nextArg(argv, ++i, '--url');
        break;
      case '--limit': {
        const raw = nextArg(argv, ++i, '--limit');
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer, got "${raw}"`);
        opts.limit = n;
        break;
      }
      case '--delay-ms': {
        const raw = nextArg(argv, ++i, '--delay-ms');
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--delay-ms must be a non-negative integer, got "${raw}"`);
        opts.delayMs = n;
        break;
      }
      case '--slug':
        opts.onlySlug = nextArg(argv, ++i, '--slug');
        break;
      case '--start-after':
        opts.startAfter = nextArg(argv, ++i, '--start-after');
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (opts.url && (opts.onlySlug || opts.startAfter)) {
    throw new Error('--url targets a single article directly; it cannot be combined with --slug or --start-after.');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Slug — see this file's header comment for why plain slugifyTopic(title)
// isn't enough on its own for Chinese titles.
// ---------------------------------------------------------------------------

/** Pulls eNanyang's own permanent numeric article id from the trailing path
 *  segment of an article URL (e.g. ".../news/20260617/.../1284634" ->
 *  "1284634"). Returns null if the URL doesn't end in one (shouldn't happen
 *  for real enanyang.my URLs, but don't throw over it). */
export function extractArticleIdFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last && /^\d+$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** Builds a slug that stays unique across the whole (mostly-Chinese-titled)
 *  corpus: slugifyTopic(title) suffixed with eNanyang's own article id when
 *  the URL carries one, falling back to a short hash of the URL itself in
 *  the rare case it doesn't (so two articles never silently collide and
 *  overwrite each other via source_articles' UNIQUE slug index). */
export function buildSourceSlug(title, url) {
  const base = slugifyTopic(title || '');
  const articleId = extractArticleIdFromUrl(url);
  if (articleId) return `${base}-${articleId}`;
  const hash = createHash('sha1').update(url || String(Math.random())).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// JSON-LD parsing — pure function over an HTML string, no network/fs, so
// it's directly unit-testable against a saved fixture (see
// validate-scrape-enanyang-articles.js).
// ---------------------------------------------------------------------------

/** Finds the `NewsArticle` block among a page's `application/ld+json`
 *  scripts. Handles a bare object, an array of objects, or an `@graph`
 *  wrapper (WordPress sites vary in which shape they emit) even though the
 *  live enanyang.my page observed during development only used the bare-
 *  object shape — being lenient here costs nothing and avoids a future
 *  false "no-articleBody-found" if the site's markup shifts slightly.
 *  Returns null (never throws) if no script parses or none is a
 *  NewsArticle — the caller treats that as a per-page skip, not a fatal
 *  error, since one bad page must not abort the whole run. */
export function extractNewsArticleLd(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).html();
    if (!raw || !raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed block on the page — skip it, don't abort
    }
    const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const types = Array.isArray(candidate['@type']) ? candidate['@type'] : [candidate['@type']];
      if (types.includes('NewsArticle')) return candidate;
    }
  }
  return null;
}

/** eNanyang's observed headline shape is "<title>/<author byline> | e南洋"
 *  — strips both the site-name suffix and the author-byline segment, since
 *  this is only used as a title fallback when no index-row title is
 *  available (single --url mode). Falls back to stripping only the site
 *  suffix if the "/" byline separator isn't present, in case the shape
 *  varies on other pages. */
export function cleanHeadline(headline) {
  if (typeof headline !== 'string') return null;
  const withoutSuffix = headline.replace(/\s*\|\s*e南洋\s*$/, '').trim();
  const slashIdx = withoutSuffix.lastIndexOf('/');
  const cleaned = slashIdx === -1 ? withoutSuffix : withoutSuffix.slice(0, slashIdx).trim();
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// Fetch — same retry-with-backoff shape as scrape-tradewizard-index.js's
// fetchTradeWizardIndexHtml, plus the 429/403 -> StopRunError distinction
// that script doesn't need (it's a single fetch, not a per-article loop).
// ---------------------------------------------------------------------------

export async function fetchEnanyangHtml(url, { maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      lastErr = err;
      if (!isLastAttempt) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new Error(`Network error fetching ${url} (attempt ${attempt + 1}/${maxAttempts}): ${err.message}`);
    }
    if (res.status === 429 || res.status === 403) {
      throw new StopRunError(
        `HTTP ${res.status} from ${url} — treating as a block/rate-limit signal and stopping the run ` +
          '(nanyang-scraper.md open question 3: this is deliberately NOT logged-and-skipped like an ordinary error).'
      );
    }
    if (!res.ok) {
      if (!isLastAttempt && res.status >= 500) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new Error(`GET ${url} returned HTTP ${res.status} (attempt ${attempt + 1}/${maxAttempts})`);
    }
    return res.text();
  }
  throw lastErr ?? new Error(`Failed to fetch ${url} after ${maxAttempts} attempt(s).`);
}

// ---------------------------------------------------------------------------
// Per-row processing — one outcome object, never throws except StopRunError
// (which the caller must let propagate to abort the whole run).
// ---------------------------------------------------------------------------

/** row: { title, url, publishedAt, category, keywords, id, slug } — `title`,
 *  `publishedAt`, `category`, `id` may be null (single --url mode). `row.slug`
 *  is a PRE-FETCH identifier computed from whatever title was already known
 *  (the index row's title, or null in --url mode); the outcome returned here
 *  carries its own `slug`, resolved from the real title once the page has
 *  been fetched, which is what actually gets written to the db — the two
 *  can differ in --url mode (nothing knows the real title until the JSON-LD
 *  headline is parsed), so callers must log/key off the outcome's `slug`,
 *  not `row.slug`, once a row has been processed. */
export async function processRow(row, { db, dryRun }) {
  let html;
  try {
    html = await fetchEnanyangHtml(row.url);
  } catch (err) {
    if (err instanceof StopRunError) throw err;
    return { status: 'fetch-error', detail: err.message };
  }

  let ld;
  try {
    ld = extractNewsArticleLd(html);
  } catch (err) {
    return { status: 'parse-error', detail: err.message };
  }
  if (!ld || typeof ld.articleBody !== 'string' || !ld.articleBody.trim()) {
    return { status: 'no-articleBody-found', detail: 'No NewsArticle JSON-LD block with a non-empty articleBody was found on the page.' };
  }

  const title = (row.title && row.title.trim()) || cleanHeadline(ld.headline || ld.name) || 'Untitled';
  const slug = buildSourceSlug(title, row.url);
  const record = {
    title,
    slug,
    original_url: ld.url || row.url,
    published_at: ld.datePublished || row.publishedAt || null,
    author: AUTHOR,
    category: row.category ?? null,
    original_content: ld.articleBody.trim(),
    featured_image: ld.image?.url || ld.thumbnailUrl || null,
    notes:
      `Auto-imported via scrape-enanyang-articles.js from ${row.url}` +
      (row.id != null ? ` (TradeWizard index id ${row.id})` : ''),
  };

  if (dryRun) {
    return { status: 'dry-run', slug, detail: `title="${record.title}" bodyLength=${record.original_content.length}` };
  }

  try {
    upsertSourceArticle(db, record);
    return { status: 'ok', slug, detail: `title="${record.title}" bodyLength=${record.original_content.length}` };
  } catch (err) {
    return { status: 'error', slug, detail: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let rows;
  if (opts.url) {
    rows = [{ title: null, url: opts.url, publishedAt: null, category: null, keywords: [], id: null }];
  } else {
    if (!existsSync(opts.indexFile)) {
      throw new Error(
        `Index file not found: ${path.relative(REPO_ROOT, opts.indexFile)} — run scrape-tradewizard-index.js first, or pass --url for a single article.`
      );
    }
    rows = JSON.parse(readFileSync(opts.indexFile, 'utf-8'));
    if (!Array.isArray(rows)) throw new Error(`${opts.indexFile} did not contain a JSON array.`);
  }

  rows = rows.map((row) => ({ ...row, slug: buildSourceSlug(row.title, row.url) }));

  if (opts.startAfter) {
    const idx = rows.findIndex((r) => r.slug === opts.startAfter);
    if (idx === -1) {
      console.error(`Warning: --start-after slug "${opts.startAfter}" not found in the index — processing from the beginning instead.`);
    } else {
      rows = rows.slice(idx + 1);
    }
  }

  if (opts.onlySlug) {
    rows = rows.filter((r) => r.slug === opts.onlySlug);
    if (rows.length === 0) {
      console.error(`Error: no row matched --slug ${opts.onlySlug}`);
      process.exitCode = 1;
      return;
    }
  }

  if (opts.limit != null) rows = rows.slice(0, opts.limit);

  console.log(`Processing ${rows.length} article(s)${opts.dryRun ? ' (--dry-run: no db writes)' : ''}...`);

  let db = null;
  if (!opts.dryRun) {
    db = new DatabaseSync(opts.dbPath);
    db.exec(SCHEMA_SQL);
  }

  const outcomes = [];
  let stopped = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let outcome;
    try {
      outcome = await processRow(row, { db, dryRun: opts.dryRun });
    } catch (err) {
      if (err instanceof StopRunError) {
        console.error(`\nStopping run: ${err.message}`);
        outcomes.push({ slug: row.slug, url: row.url, status: 'stopped', detail: err.message });
        stopped = true;
        break;
      }
      outcome = { status: 'error', detail: err.message };
    }
    // outcome.slug (resolved from the real title post-fetch) can differ from
    // row.slug (the pre-fetch guess) in --url mode — see processRow's doc
    // comment. Prefer it for logging so what's printed matches what got
    // written to the db.
    const loggedSlug = outcome.slug ?? row.slug;
    outcomes.push({ slug: loggedSlug, url: row.url, ...outcome });
    console.log(`  [${outcome.status}] ${loggedSlug} — ${outcome.detail}`);

    if (!stopped && i < rows.length - 1) await sleep(opts.delayMs);
  }

  if (db) db.close();

  const okCount = outcomes.filter((o) => o.status === 'ok' || o.status === 'dry-run').length;
  const badCount = outcomes.length - okCount;
  console.log(
    `\n${outcomes.length} article(s) processed: ${okCount} ok, ${badCount} error(s)/skip(s)${stopped ? ' (run stopped early — see message above)' : ''}.`
  );

  if (badCount > 0) process.exitCode = 1;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
