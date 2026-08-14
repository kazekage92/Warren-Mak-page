#!/usr/bin/env node
/**
 * Validation harness for extract-articles.js's `links` backfill
 * (extra-md-files/ai-article-pipeline.md §2 Step 5's "links" half — see that
 * script's own header for why this needed no LLM and wasn't really gated on
 * Step 4). No LLM involved, so — matching retrieval-layer.js's/
 * import-source-articles.js's own no-fixture-needed precedent for pure-data
 * scripts — this validates against a temp copy of the schema under
 * scripts/output/ (gitignored), never touching the real
 * admin/knowledge-graph.db.
 *
 * Proves:
 *   1. Real extraction over the real articles/*.html finds a nonzero number
 *      of internal_links per article (sanity check that the fixture-free
 *      approach below is exercising real parsing, not a mock).
 *   2. backfillLinks() writes exactly one `links` row per internal_links
 *      entry whose target_slug resolves to a known article, and each row's
 *      target_article_id/link_text match the parsed record.
 *   3. A dangling link (target_slug with no matching article) is skipped —
 *      not written as a broken foreign key — and counted in skippedDangling.
 *   4. Re-running the backfill (DELETE-then-INSERT per source article) is
 *      idempotent: running it twice leaves the same row count, not doubled.
 *   5. Editing an article's links (simulated: re-run with a shrunk record
 *      set) actually updates the table rather than merely adding to it —
 *      proves this is a real re-derivation, not an append-only log.
 *   6. A CLI run (`node extract-articles.js --db <temp>`) against the real
 *      articles/ dir populates `links` with the same row count the
 *      function-level call produced, and running it a second time is a
 *      byte-for-byte no-op on row count (safe to re-run, matching
 *      `articles`' own contract).
 *
 * Usage: node validate-extract-articles.js
 */

import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { extractArticle, listArticleFiles, upsertArticles, backfillLinks } from './extract-articles.js';

/** Mirrors main()'s own extraction loop (extract-articles.js isolates
 *  per-file failures rather than throwing) — there are no malformed articles
 *  in the real repo today, so any thrown error here is itself a real bug to
 *  surface, not something to swallow silently. */
function extractArticlesForTest(articlesDir) {
  return listArticleFiles(articlesDir).map((f) => extractArticle(f));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTICLES_DIR = path.join(REPO_ROOT, 'articles');
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEST_DB_PATH = path.join(OUTPUT_DIR, 'extract-articles-links-test.db');

function freshTempDb() {
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  const db = new DatabaseSync(TEST_DB_PATH);
  db.exec(readFileSync(SCHEMA_SQL_PATH, 'utf-8'));
  return db;
}

function countLinks(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM links').get().n;
}

// ---------------------------------------------------------------------------
// Part 1 — function-level: real extraction + backfillLinks() against a temp db
// ---------------------------------------------------------------------------

function checks_functionLevel() {
  console.log('=== Part 1: function-level (real articles/, temp db) ===\n');
  const checks = [];

  const records = extractArticlesForTest(ARTICLES_DIR);
  checks.push(['real extraction returns all 12 articles', records.length === 12]);
  const totalInternalLinks = records.reduce((sum, r) => sum + r.internal_links.length, 0);
  checks.push(['real extraction finds a nonzero number of internal links overall', totalInternalLinks > 0]);
  checks.push(['every article has at least one internal link', records.every((r) => r.internal_links.length > 0)]);

  const db = freshTempDb();
  try {
    upsertArticles(db, records);
    const { inserted, skippedDangling } = backfillLinks(db, records);

    checks.push(['backfillLinks() reports inserted === totalInternalLinks (no real dangling links in the repo today)', inserted === totalInternalLinks]);
    checks.push(['backfillLinks() reports zero dangling this run', skippedDangling === 0]);
    checks.push(['links table row count matches inserted count', countLinks(db) === inserted]);

    // Spot-check one specific row's shape against the source record.
    const sample = records.find((r) => r.internal_links.length > 0);
    const sampleLink = sample.internal_links[0];
    const sourceId = db.prepare('SELECT id FROM articles WHERE slug = ?').get(sample.slug).id;
    const targetId = db.prepare('SELECT id FROM articles WHERE slug = ?').get(sampleLink.target_slug).id;
    const row = db
      .prepare('SELECT * FROM links WHERE source_article_id = ? AND target_article_id = ?')
      .get(sourceId, targetId);
    checks.push(['a specific real link round-trips into the links table', !!row]);
    checks.push(['...with the exact link_text parsed from .article-related', row && row.link_text === sampleLink.link_text]);

    // --- Dangling link handling: inject a fake record pointing nowhere. ---
    const danglingRecords = [
      {
        slug: '__validate_dangling_source__',
        internal_links: [{ target_slug: '__no_such_article__', link_text: 'Nowhere' }],
      },
    ];
    // This synthetic slug has no articles row, so backfillLinks() must skip it
    // via its own "sourceId not found" guard -- separately prove the
    // target-side dangling guard using a REAL source article pointed at a
    // fake target.
    const realSourceSlug = records[0].slug;
    const withFakeTarget = [
      { slug: realSourceSlug, internal_links: [{ target_slug: '__no_such_article__', link_text: 'Nowhere' }] },
    ];
    const before = countLinks(db);
    const { inserted: insertedFake, skippedDangling: skippedFake } = backfillLinks(db, withFakeTarget);
    checks.push(['a target_slug with no matching article is skipped, not inserted', insertedFake === 0 && skippedFake === 1]);
    checks.push(['the dangling attempt still cleared the real source\'s old links (DELETE ran)', countLinks(db) === before - records[0].internal_links.length]);
    checks.push(['synthetic slug with no articles row is silently ignored (sourceId guard)', backfillLinks(db, danglingRecords).inserted === 0]);

    // Restore real state for the idempotency checks below.
    backfillLinks(db, records);
    const afterRestore = countLinks(db);
    checks.push(['restoring the real records brings the count back to the original total', afterRestore === inserted]);

    // --- Idempotency: re-running with the same records must not double rows. ---
    backfillLinks(db, records);
    checks.push(['re-running backfillLinks() with identical records leaves the same row count', countLinks(db) === afterRestore]);

    // --- Re-derivation, not append-only: shrink one article's links and re-run. ---
    const shrunk = records.map((r) =>
      r.slug === sample.slug ? { ...r, internal_links: r.internal_links.slice(0, 1) } : r
    );
    backfillLinks(db, shrunk);
    const afterShrink = db.prepare('SELECT COUNT(*) AS n FROM links WHERE source_article_id = ?').get(sourceId).n;
    checks.push(['re-running with fewer internal_links for one article actually removes the extra rows (re-derivation, not append)', afterShrink === 1]);

    // Restore again so the temp db reflects real state for Part 2's CLI comparison.
    backfillLinks(db, records);
  } finally {
    db.close();
  }

  return { checks, totalInternalLinks };
}

// ---------------------------------------------------------------------------
// Part 2 — CLI-level: extract-articles.js --db <temp>, run twice
// ---------------------------------------------------------------------------

function runCli(dbPath) {
  try {
    const stdout = execFileSync(
      'node',
      ['--no-warnings', 'extract-articles.js', '--db', dbPath, '--no-mirror'],
      { cwd: __dirname, encoding: 'utf-8' }
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function checks_cli(expectedTotalInternalLinks) {
  console.log('\n=== Part 2: CLI-level (extract-articles.js subprocess) ===\n');
  const checks = [];
  const cliDbPath = path.join(OUTPUT_DIR, 'extract-articles-links-cli-test.db');
  if (existsSync(cliDbPath)) rmSync(cliDbPath);

  const run1 = runCli(cliDbPath);
  console.log('--- first CLI run stdout (tail) ---\n' + run1.stdout.split('\n').slice(-6).join('\n'));
  checks.push(['first CLI run exits 0', run1.exitCode === 0]);
  checks.push(['first CLI run stdout reports the backfilled link count', run1.stdout.includes(`Backfilled links: ${expectedTotalInternalLinks} row(s) written`)]);

  const db1 = new DatabaseSync(cliDbPath, { readOnly: true });
  const countAfterFirst = countLinks(db1);
  db1.close();
  checks.push(['links table row count after first CLI run matches function-level total', countAfterFirst === expectedTotalInternalLinks]);

  const run2 = runCli(cliDbPath);
  checks.push(['second CLI run (same articles/, no changes) exits 0', run2.exitCode === 0]);
  const db2 = new DatabaseSync(cliDbPath, { readOnly: true });
  const countAfterSecond = countLinks(db2);
  db2.close();
  checks.push(['second CLI run leaves the same row count -- safe to re-run, no duplication', countAfterSecond === countAfterFirst]);

  if (existsSync(cliDbPath)) rmSync(cliDbPath);
  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(SCHEMA_SQL_PATH)) throw new Error(`Missing ${path.relative(REPO_ROOT, SCHEMA_SQL_PATH)}`);
  if (!existsSync(ARTICLES_DIR)) throw new Error(`Missing ${path.relative(REPO_ROOT, ARTICLES_DIR)}`);

  const { checks: part1Checks, totalInternalLinks } = checks_functionLevel();
  const checks = [...part1Checks, ...checks_cli(totalInternalLinks)];

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
