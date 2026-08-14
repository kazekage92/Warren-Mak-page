#!/usr/bin/env node
/**
 * TradeWizard article-index scraper — script 1 of 2 from
 * extra-md-files/nanyang-scraper.md ("Nanyang / TradeWizard Article Scraper
 * — Build Plan"). Read that doc's "Key discovery" section before touching
 * this file; it records the live investigation this parser is built from.
 *
 * `https://www.thetradewizard.com/articles` is a Next.js client-rendered
 * page, but a plain unauthenticated GET already returns the full ~432-row
 * dataset server-side, embedded as a React Server Component "flight"
 * payload: one `self.__next_f.push([1, "...escaped JSON..."])` script tag
 * whose unescaped string contains `"data":[{"id":...,"date":...,"title":
 * ...,"category":...,"keywords":[...],"link":"https://www.enanyang.my/
 * news/..."}, ...]`. This script finds that one push call among the ~24 on
 * the page, unescapes it, bracket-matches the `"data":[...]` array out of
 * it, and JSON.parses that slice directly — verified against the live page
 * to parse cleanly into exactly the row count the site's own UI reports
 * ("432 results"), so no Playwright/headless-browser render is needed
 * (resolves the doc's "open question 1").
 *
 * This script ONLY builds the URL/metadata index — it does not fetch any
 * individual eNanyang article body. That is scrape-enanyang-articles.js
 * (script 2, stubbed but not yet implemented — see that file).
 *
 * Usage (from scripts/):
 *   node scrape-tradewizard-index.js --dry-run                 # fetch + parse + print, no write
 *   node scrape-tradewizard-index.js                           # writes output/tradewizard-index.json
 *   node scrape-tradewizard-index.js --out output/custom.json  # override output path
 *   node scrape-tradewizard-index.js --html-file page.html     # parse a saved HTML file instead of fetching (offline testing)
 *   node scrape-tradewizard-index.js --source-url <url>        # override the fetch URL (default shown below)
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextArg } from './cli-args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SOURCE_URL = 'https://www.thetradewizard.com/articles';
const DEFAULT_OUT = path.join(__dirname, 'output', 'tradewizard-index.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    outPath: DEFAULT_OUT,
    htmlFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--source-url':
        opts.sourceUrl = nextArg(argv, ++i, '--source-url');
        break;
      case '--out':
        opts.outPath = path.resolve(nextArg(argv, ++i, '--out'));
        break;
      case '--html-file':
        opts.htmlFile = path.resolve(nextArg(argv, ++i, '--html-file'));
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Fetch (dependency-injectable via --html-file, same "don't require network
// to test the parser" precedent as every fixture-driven script here)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches the TradeWizard articles page HTML with a small retry-with-backoff
 *  (network errors and 5xx only — mirrors openai-client.js's isRetryable
 *  shape, not its code, since this isn't an OpenAI call). */
export async function fetchTradeWizardIndexHtml(sourceUrl, { maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    let res;
    try {
      res = await fetch(sourceUrl, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      lastErr = err;
      if (!isLastAttempt) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new Error(`Network error fetching ${sourceUrl} (attempt ${attempt + 1}/${maxAttempts}): ${err.message}`);
    }
    if (!res.ok) {
      if (!isLastAttempt && res.status >= 500) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw new Error(`GET ${sourceUrl} returned HTTP ${res.status} (attempt ${attempt + 1}/${maxAttempts})`);
    }
    return res.text();
  }
  throw lastErr ?? new Error(`Failed to fetch ${sourceUrl} after ${maxAttempts} attempt(s).`);
}

// ---------------------------------------------------------------------------
// Parsing — pure function, no network/fs, so it's directly unit-testable
// against a saved HTML fixture (see this file's own header comment).
// ---------------------------------------------------------------------------

// Matches every `self.__next_f.push([1, "<escaped JSON string>"])` call. The
// captured group is still JSON-string-escaped (e.g. `\"`, `\\`) — the caller
// must JSON.parse('"' + group + '"') to get the real string back.
const NEXT_F_PUSH_RE = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;

// A more specific marker than plain `"data":[` so this doesn't latch onto
// some unrelated "data" array elsewhere in the flight payload — this exact
// prefix (an object whose first key is "id") is what the real row array
// starts with, verified against the live page.
const DATA_MARKER = '"data":[{"id"';
const BRACKET_MARKER = '"data":['; // same prefix, used to locate the '[' itself

/** Finds the "data":[...] array inside `text` (starting search at the first
 *  DATA_MARKER match) via bracket-matching and JSON.parses just that slice —
 *  more robust than trying to parse the whole flight-payload chunk (which
 *  isn't strict JSON end-to-end, e.g. `["$","$L2c",null,{...}]` module refs
 *  mixed in) when only this one array is actually needed. */
function extractDataArray(text) {
  const markerIdx = text.indexOf(DATA_MARKER);
  if (markerIdx === -1) return null;
  const start = markerIdx + BRACKET_MARKER.length - 1; // position of the opening '['
  let depth = 0;
  let end = -1;
  for (let p = start; p < text.length; p++) {
    if (text[p] === '[') depth++;
    else if (text[p] === ']') {
      depth--;
      if (depth === 0) {
        end = p;
        break;
      }
    }
  }
  if (end === -1) return null;
  return JSON.parse(text.slice(start, end + 1));
}

/** Parses the raw HTML of https://www.thetradewizard.com/articles into the
 *  full row list. Throws a clear error (rather than returning an empty
 *  array) if the page's flight-payload shape has changed and no chunk
 *  contains the expected "data":[{"id":... marker — a silent empty result
 *  here would be far more confusing than a loud failure. */
export function extractTradeWizardRows(html) {
  let match;
  NEXT_F_PUSH_RE.lastIndex = 0;
  while ((match = NEXT_F_PUSH_RE.exec(html))) {
    let unescaped;
    try {
      unescaped = JSON.parse('"' + match[1] + '"');
    } catch {
      continue; // not a validly-escaped chunk (shouldn't happen) — skip, don't abort
    }
    const rawRows = extractDataArray(unescaped);
    if (!rawRows) continue;

    return rawRows.map((row) => ({
      id: row.id ?? null, // TradeWizard's own stable numeric id — kept for future dedupe/checkpointing (script 2's job, not this one)
      title: typeof row.title === 'string' ? row.title.trim() : '',
      url: row.link ?? null,
      publishedAt: row.date ?? null,
      category: typeof row.category === 'string' ? row.category.trim() : null,
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
    }));
  }
  throw new Error(
    `Could not find the article-data flight payload (looked for ${JSON.stringify(DATA_MARKER)} inside any ` +
      'self.__next_f.push(...) chunk) — the page structure may have changed since this parser was written.'
  );
}

/** Drops rows that repeat an already-seen `url`, keeping the first occurrence
 *  of each. TradeWizard's own index has been observed to list the same
 *  `enanyang.my` URL more than once (e.g. a re-categorized/re-tagged repost
 *  of the same column) — left un-deduped here, script 2
 *  (`scrape-enanyang-articles.js`) would fetch and upsert the same article
 *  twice per run under two different `id`/`title` pairs, and since its slug
 *  is derived from the title, a title difference between those two rows
 *  would produce two DIFFERENT slugs for the same underlying article —
 *  i.e. an actual duplicate `source_articles` row, not just a wasted fetch.
 *  Rows with a falsy `url` are kept as-is (never deduped against each
 *  other) since there's no dedup key for them. */
export function dedupeRowsByUrl(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    if (row.url) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
    }
    deduped.push(row);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const html = opts.htmlFile ? readFileSync(opts.htmlFile, 'utf-8') : await fetchTradeWizardIndexHtml(opts.sourceUrl);

  const parsedRows = extractTradeWizardRows(html);
  const rows = dedupeRowsByUrl(parsedRows);
  const duplicateUrlCount = parsedRows.length - rows.length;

  console.log(`Parsed ${parsedRows.length} row(s) from ${opts.htmlFile ?? opts.sourceUrl}`);
  if (duplicateUrlCount) {
    console.log(`Dropped ${duplicateUrlCount} duplicate-URL row(s), keeping the first occurrence of each — ${rows.length} unique row(s) remain.`);
  }

  if (opts.dryRun) {
    console.log('\nFirst 3 rows:');
    for (const row of rows.slice(0, 3)) console.log(' ', JSON.stringify(row));
    console.log('Last 3 rows:');
    for (const row of rows.slice(-3)) console.log(' ', JSON.stringify(row));
    console.log('\n(--dry-run: nothing written)');
    return;
  }

  mkdirSync(path.dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`Wrote ${rows.length} row(s) to ${path.relative(REPO_ROOT, opts.outPath)}`);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
