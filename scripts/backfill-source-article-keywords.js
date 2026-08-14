#!/usr/bin/env node
/**
 * One-off backfill: populates `source_articles.keywords` for rows that were
 * scraped/imported before scrape-enanyang-articles.js started writing that
 * column, or whose keywords otherwise drifted out of sync with
 * scripts/output/tradewizard-index.json (TradeWizard's own filter tags —
 * see schema.sql's comment on the column).
 *
 * Does NOT re-fetch anything and does NOT touch any other column: for each
 * row in the index file it looks up the matching `source_articles` row by
 * `original_url` using findExistingSlugByUrl() (imported from
 * scrape-enanyang-articles.js, reused not reimplemented — the same lookup
 * processRow() uses there), and runs a single-column
 * `UPDATE source_articles SET keywords = ? WHERE slug = ?`.
 *
 * FALLBACK MATCH — verified against the real data before this script's
 * first run (423-row index vs. 423-row table): findExistingSlugByUrl()'s
 * exact canonicalizeUrl() match only found 117/423 rows. The other ~306
 * fail not because they're unscraped, but because the URL *path* differs
 * between the two sources — processRow() stores `ld.url` (the article's own
 * JSON-LD canonical URL, e.g. ".../NYPLUS/674146") in preference to the
 * index's `row.url` (e.g. ".../Testimonia-Column/674146") when they
 * disagree, and canonicalizeUrl() only strips query/hash/trailing-slash, not
 * a differing path segment. The trailing numeric eNanyang article id is
 * stable across both, so for any row the exact match misses, this script
 * falls back to matching on that id (extractArticleIdFromUrl(), same
 * import scrape-enanyang-articles.js already uses for buildSourceSlug() —
 * reused, not reimplemented). This raised the match rate to 422/423 in
 * that same verification run (the one remaining row is a genuinely
 * unscraped URL). Confirmed with the user before adding this fallback.
 *
 * Index rows that still have no match after both attempts (not yet
 * scraped/imported) are logged and skipped — there's nothing to backfill
 * onto.
 *
 * Usage (from scripts/):
 *   node backfill-source-article-keywords.js                          # real run
 *   node backfill-source-article-keywords.js --dry-run                # print planned updates only, no db write
 *   node backfill-source-article-keywords.js --no-mirror              # skip regenerating admin/knowledge-graph.json after the db write
 *   node backfill-source-article-keywords.js --index-file output/custom.json  # (default shown)
 *   node backfill-source-article-keywords.js --db ../admin/knowledge-graph.db # (default shown)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { findExistingSlugByUrl, extractArticleIdFromUrl } from './scrape-enanyang-articles.js';
import { nextArg } from './cli-args.js';
import { regenerateJsonMirror } from './extract-articles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql'), 'utf-8');

const DEFAULT_INDEX_FILE = path.join(__dirname, 'output', 'tradewizard-index.json');
const DEFAULT_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    mirror: true,
    indexFile: DEFAULT_INDEX_FILE,
    dbPath: DEFAULT_DB,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--no-mirror':
        opts.mirror = false;
        break;
      case '--index-file':
        opts.indexFile = path.resolve(nextArg(argv, ++i, '--index-file'));
        break;
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.indexFile)) {
    throw new Error(`Index file not found: ${path.relative(REPO_ROOT, opts.indexFile)}`);
  }
  const rows = JSON.parse(readFileSync(opts.indexFile, 'utf-8'));
  if (!Array.isArray(rows)) throw new Error(`${opts.indexFile} did not contain a JSON array.`);

  console.log(`Loaded ${rows.length} row(s) from ${path.relative(REPO_ROOT, opts.indexFile)}${opts.dryRun ? ' (--dry-run: no db writes)' : ''}...`);

  const db = new DatabaseSync(opts.dbPath);
  db.exec(SCHEMA_SQL);

  // `CREATE TABLE IF NOT EXISTS` (above) does not retrofit columns onto an
  // already-existing table, and this db predates schema.sql's `keywords`
  // column (added for scrape-enanyang-articles.js's processRow(), which
  // already writes it — the live db just never got migrated). Add it here,
  // once, additively — no-op on any db that already has it.
  const hasKeywordsColumn = db
    .prepare("PRAGMA table_info(source_articles)")
    .all()
    .some((col) => col.name === 'keywords');
  if (!hasKeywordsColumn) {
    if (opts.dryRun) {
      console.log('  [migration] source_articles.keywords column is missing — would ALTER TABLE to add it (skipped: --dry-run).');
    } else {
      db.exec('ALTER TABLE source_articles ADD COLUMN keywords TEXT');
      console.log('  [migration] Added missing source_articles.keywords column.');
    }
  }
  // In a real run the column above is guaranteed to exist by this point; in
  // --dry-run against a not-yet-migrated db it still doesn't, so guard the
  // column-referencing statements below rather than preparing them against
  // a column that isn't there yet.
  const columnExists = hasKeywordsColumn || !opts.dryRun;

  const updateStmt = columnExists ? db.prepare('UPDATE source_articles SET keywords = ? WHERE slug = ?') : null;
  const selectStmt = columnExists ? db.prepare('SELECT keywords FROM source_articles WHERE slug = ?') : null;

  // Fallback lookup: eNanyang article id -> slug, built once from every
  // existing source_articles row (see the file header comment for why exact
  // original_url matching alone misses ~72% of rows).
  const idToSlug = new Map();
  for (const srcRow of db.prepare('SELECT slug, original_url FROM source_articles').all()) {
    const id = extractArticleIdFromUrl(srcRow.original_url);
    if (id && !idToSlug.has(id)) idToSlug.set(id, srcRow.slug);
  }

  let updated = 0;
  let unmatched = 0;
  let unchanged = 0;
  let matchedByUrl = 0;
  let matchedById = 0;

  for (const row of rows) {
    let slug = findExistingSlugByUrl(db, row.url);
    if (slug) {
      matchedByUrl++;
    } else {
      const id = extractArticleIdFromUrl(row.url);
      slug = id ? idToSlug.get(id) ?? null : null;
      if (slug) matchedById++;
    }
    if (!slug) {
      unmatched++;
      console.log(`  [no-match] ${row.url} — no source_articles row with this original_url or article id, skipped.`);
      continue;
    }

    const keywordsJson = JSON.stringify(row.keywords ?? []);
    const existing = selectStmt ? selectStmt.get(slug) : null;
    if (existing?.keywords === keywordsJson) {
      unchanged++;
      continue;
    }

    if (!opts.dryRun) {
      updateStmt.run(keywordsJson, slug);
    }
    updated++;
    console.log(`  [${opts.dryRun ? 'would-update' : 'updated'}] ${slug} — keywords -> ${keywordsJson}`);
  }

  if (!opts.dryRun && opts.mirror) {
    const mirrorPath = path.join(REPO_ROOT, 'admin', 'knowledge-graph.json');
    regenerateJsonMirror(db, mirrorPath);
    console.log(`Regenerated ${path.relative(REPO_ROOT, mirrorPath)}.`);
  }

  db.close();

  console.log(
    `\n${rows.length} index row(s) processed: ${updated} ${opts.dryRun ? 'would be updated' : 'updated'}, ${unchanged} already up to date, ${unmatched} unmatched (no source_articles row) ` +
      `[matched ${matchedByUrl} by exact original_url, ${matchedById} by article-id fallback].`
  );
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
