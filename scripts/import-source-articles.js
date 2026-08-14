#!/usr/bin/env node
/**
 * Source-article sync script — Phase 1 (Source Article Collection) MVP, per
 * extra-md-files/pipeline-phase-4-6-7-1-mvp.md §5. Mirrors extract-articles.js's
 * role: a local/developer-run Node script, no LLM, that syncs data staged by
 * the browser (admin/index.html's "Import Source Article" form) into the db.
 *
 * Manual-paste import only — no live scanning of any external domain (owner
 * decision, see that doc's header). The admin form stages one JSON file per
 * staged import at admin/source-articles-pending/<slug>.json via a single-
 * file GitHub Contents API commit; this script reads every file in that
 * directory and upserts it into the `source_articles` table (schema in
 * admin/knowledge-graph.schema.sql), same idempotent
 * INSERT ... ON CONFLICT(slug) DO UPDATE pattern extract-articles.js uses
 * for `articles`.
 *
 * Pending file shape (one object per file):
 *   { title, originalUrl, publishedAt, author, category, originalContent,
 *     featuredImage, notes, slug? }
 * `slug` is generated from `title` (via generate-article.js's slugifyTopic —
 * reused, not reimplemented) if the file doesn't already carry one.
 *
 * Usage (from scripts/):
 *   node import-source-articles.js                                    # sync every pending file
 *   node import-source-articles.js --dry-run                          # parse + print only, no db write
 *   node import-source-articles.js --slug <slug>                      # sync one file only (by its computed slug)
 *   node import-source-articles.js --no-mirror                        # skip regenerating admin/knowledge-graph.json after the db write
 *   node import-source-articles.js --pending-dir ../admin/source-articles-pending  # (default shown)
 *   node import-source-articles.js --db ../admin/knowledge-graph.db   # (default shown)
 *
 * A real (non-dry-run) run also regenerates admin/knowledge-graph.json
 * (extract-articles.js's regenerateJsonMirror(), reused not reimplemented) so
 * the newly-synced source_articles rows are viewable without a sqlite client
 * — see that function's own comment in extract-articles.js.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { slugifyTopic } from './generate-article.js';
import { nextArg } from './cli-args.js';
import { regenerateJsonMirror } from './extract-articles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCHEMA_SQL = readFileSync(path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql'), 'utf-8');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    mirror: true,
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    pendingDir: path.join(REPO_ROOT, 'admin', 'source-articles-pending'),
    onlySlug: null,
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
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--pending-dir':
        opts.pendingDir = path.resolve(nextArg(argv, ++i, '--pending-dir'));
        break;
      case '--slug':
        opts.onlySlug = nextArg(argv, ++i, '--slug');
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Pending file loading / validation
// ---------------------------------------------------------------------------

function listPendingFiles(pendingDir) {
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(pendingDir, f));
}

/** Reads and validates one pending file. Returns { record } on success, or
 *  { error } on a validation failure — never throws, so one bad file doesn't
 *  abort the rest of the run (matches extract-entities.js's per-item outcome
 *  pattern, "a failure is isolated" for single-item processing). */
export function loadPendingFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { error: `Malformed JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed.title !== 'string' || !parsed.title.trim()) {
    return { error: 'Missing required non-empty field "title"' };
  }
  if (typeof parsed.originalContent !== 'string' || !parsed.originalContent.trim()) {
    return { error: 'Missing required non-empty field "originalContent"' };
  }

  const slug = (parsed.slug && String(parsed.slug).trim()) || slugifyTopic(parsed.title);

  return {
    record: {
      title: parsed.title.trim(),
      slug,
      original_url: parsed.originalUrl ?? null,
      published_at: parsed.publishedAt ?? null,
      author: parsed.author ?? null,
      category: parsed.category ?? null,
      original_content: parsed.originalContent.trim(),
      featured_image: parsed.featuredImage ?? null,
      notes: parsed.notes ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------

/** Idempotent upsert keyed on slug — same ON CONFLICT DO UPDATE shape as
 *  extract-articles.js's upsertArticles(). Always sets status='imported' and
 *  a fresh import_date; the rest of the lifecycle (reviewed/ready/generated/
 *  published/ignored) is out of this script's scope (see schema comment).
 *
 * `record.keywords` (a JSON-encoded array of TradeWizard's own filter tags —
 * see schema.sql's own comment on the column) is optional and defaults to
 * null: only scrape-enanyang-articles.js's processRow() currently populates
 * it (from the TradeWizard index row), while loadPendingFile()'s manual-
 * paste pending files below have no equivalent field to carry. */
export function upsertSourceArticle(db, record) {
  const stmt = db.prepare(`
    INSERT INTO source_articles
      (title, slug, original_url, published_at, author, category, keywords, original_content, featured_image, import_date, status, notes)
    VALUES
      (@title, @slug, @original_url, @published_at, @author, @category, @keywords, @original_content, @featured_image, @import_date, 'imported', @notes)
    ON CONFLICT(slug) DO UPDATE SET
      title             = excluded.title,
      original_url      = excluded.original_url,
      published_at      = excluded.published_at,
      author            = excluded.author,
      category          = excluded.category,
      keywords          = excluded.keywords,
      original_content  = excluded.original_content,
      featured_image    = excluded.featured_image,
      import_date       = excluded.import_date,
      status            = 'imported',
      notes             = excluded.notes
  `);
  stmt.run({ ...record, keywords: record.keywords ?? null, import_date: new Date().toISOString().slice(0, 10) });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const files = listPendingFiles(opts.pendingDir);
  console.log(`Found ${files.length} pending file(s) in ${path.relative(REPO_ROOT, opts.pendingDir)}`);

  const outcomes = [];
  let matchCount = 0; // files whose slug matched --slug (only meaningful when opts.onlySlug is set)
  let db = null;
  if (!opts.dryRun) {
    db = new DatabaseSync(opts.dbPath);
    db.exec(SCHEMA_SQL);
  }

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const { record, error } = loadPendingFile(filePath);

    if (error) {
      outcomes.push({ fileName, slug: null, status: 'error', detail: error });
      continue;
    }
    if (opts.onlySlug && record.slug !== opts.onlySlug) {
      outcomes.push({ fileName, slug: record.slug, status: 'skipped', detail: `does not match --slug ${opts.onlySlug}` });
      continue;
    }
    matchCount++;
    if (opts.dryRun) {
      outcomes.push({ fileName, slug: record.slug, status: 'dry-run', detail: `title="${record.title}"` });
      continue;
    }

    try {
      upsertSourceArticle(db, record);
      outcomes.push({ fileName, slug: record.slug, status: 'ok', detail: `title="${record.title}"` });
    } catch (err) {
      outcomes.push({ fileName, slug: record.slug, status: 'error', detail: err.message });
    }
  }

  if (db) {
    if (opts.mirror) {
      const mirrorPath = path.join(REPO_ROOT, 'admin', 'knowledge-graph.json');
      regenerateJsonMirror(db, mirrorPath);
      console.log(`\nRegenerated ${path.relative(REPO_ROOT, mirrorPath)}.`);
    }
    db.close();
  }

  console.log('\nResults:');
  for (const o of outcomes) {
    console.log(`  [${o.status}] ${o.fileName}${o.slug ? ` (${o.slug})` : ''} — ${o.detail}`);
  }

  const errorCount = outcomes.filter((o) => o.status === 'error').length;
  console.log(`\n${outcomes.length} file(s) processed, ${errorCount} error(s).`);

  if (opts.onlySlug && matchCount === 0) {
    console.error(`\nError: no pending file matched --slug ${opts.onlySlug}`);
    process.exitCode = 1;
    return;
  }

  if (errorCount) process.exitCode = 1;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
