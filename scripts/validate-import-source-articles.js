#!/usr/bin/env node
/**
 * Validation harness for import-source-articles.js. No LLM involved, so —
 * matching retrieval-layer.js's own no-fixture-needed precedent for pure-
 * data scripts — this validates directly against a temp copy of the schema
 * rather than a fixture-injection harness: applies
 * admin/knowledge-graph.schema.sql to a scratch db and a scratch pending
 * directory under scripts/output/ (both gitignored), never touching the
 * real admin/knowledge-graph.db.
 *
 * Proves:
 *   1. A pending file missing "title" or "originalContent" is rejected with
 *      a clear per-file error, not a thrown exception that aborts the run.
 *   2. A pending file with no "slug" gets one auto-generated from "title"
 *      via generate-article.js's slugifyTopic (reused, not reimplemented).
 *   3. upsertSourceArticle() is idempotent: running it twice for the same
 *      slug leaves exactly one row, with the second call's field values.
 *   4. --dry-run touches neither the db (no rows written).
 *   5. A real CLI run writes the expected row(s); running the CLI a SECOND
 *      time over the same pending files is a no-op re-upsert — still
 *      exactly one row per slug, never a duplicate.
 *   6. --slug filters to only the matching pending file.
 *   7. A malformed pending file makes the CLI exit non-zero, while valid
 *      files in the same run still get written (isolated failure, matching
 *      extract-entities.js's per-item outcome pattern).
 *
 * Usage: node validate-import-source-articles.js
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadPendingFile, upsertSourceArticle } from './import-source-articles.js';
import { slugifyTopic } from './generate-article.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql');
const TEST_DB_PATH = path.join(OUTPUT_DIR, 'import-source-articles-test.db');
const PENDING_DIR = path.join(OUTPUT_DIR, 'import-source-articles-pending');

function freshTempDb() {
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  const db = new DatabaseSync(TEST_DB_PATH);
  db.exec(readFileSync(SCHEMA_SQL_PATH, 'utf-8'));
  return db;
}

function resetPendingDir() {
  if (existsSync(PENDING_DIR)) rmSync(PENDING_DIR, { recursive: true, force: true });
  mkdirSync(PENDING_DIR, { recursive: true });
}

function writePending(fileName, obj) {
  writeFileSync(path.join(PENDING_DIR, fileName), JSON.stringify(obj), 'utf-8');
}

// ---------------------------------------------------------------------------
// Part 1 — loadPendingFile() validation + slug auto-generation
// ---------------------------------------------------------------------------

function checks_loadPendingFile() {
  console.log('=== Part 1: loadPendingFile() ===\n');
  const checks = [];
  resetPendingDir();

  writePending('missing-title.json', { originalContent: 'Some pasted text.' });
  const r1 = loadPendingFile(path.join(PENDING_DIR, 'missing-title.json'));
  checks.push(['missing title -> error, not a throw', !!r1.error && !r1.record]);

  writePending('missing-content.json', { title: 'A Title' });
  const r2 = loadPendingFile(path.join(PENDING_DIR, 'missing-content.json'));
  checks.push(['missing originalContent -> error, not a throw', !!r2.error && !r2.record]);

  writePending('malformed.json', 'not even json {');
  const r3 = loadPendingFile(path.join(PENDING_DIR, 'malformed.json'));
  checks.push(['malformed JSON -> error, not a throw', !!r3.error]);

  const title = 'Bottom Fishing With Put Warrants: A Fresh Angle';
  writePending('no-slug.json', { title, originalContent: 'Full pasted column text goes here.' });
  const r4 = loadPendingFile(path.join(PENDING_DIR, 'no-slug.json'));
  checks.push(['no slug provided -> record present', !!r4.record]);
  checks.push(['slug auto-generated via slugifyTopic(title)', r4.record && r4.record.slug === slugifyTopic(title)]);

  writePending('explicit-slug.json', { title: 'Whatever Title', slug: 'my-custom-slug', originalContent: 'Text.' });
  const r5 = loadPendingFile(path.join(PENDING_DIR, 'explicit-slug.json'));
  checks.push(['explicit slug in the file is respected, not overwritten', r5.record && r5.record.slug === 'my-custom-slug']);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — upsertSourceArticle() idempotency
// ---------------------------------------------------------------------------

function checks_upsertIdempotency() {
  console.log('\n=== Part 2: upsertSourceArticle() idempotency ===\n');
  const checks = [];
  const db = freshTempDb();
  try {
    const base = {
      title: 'Original Title',
      slug: 'idempotency-test-slug',
      original_url: 'https://example.com/a',
      published_at: '2026-01-01',
      author: 'Warren Mak',
      category: 'Column',
      original_content: 'First version of the content.',
      featured_image: null,
      notes: null,
    };
    upsertSourceArticle(db, base);
    const afterFirst = db.prepare('SELECT COUNT(*) AS n FROM source_articles WHERE slug = ?').get(base.slug);
    checks.push(['first upsert inserts exactly one row', afterFirst.n === 1]);

    const rowNoKeywords = db.prepare('SELECT keywords FROM source_articles WHERE slug = ?').get(base.slug);
    checks.push(['a record with no keywords field defaults to null (loadPendingFile has no equivalent field)', rowNoKeywords.keywords === null]);

    upsertSourceArticle(db, { ...base, title: 'Updated Title', original_content: 'Second version of the content.', keywords: JSON.stringify(['warrants', 'ipo']) });
    const afterSecond = db.prepare('SELECT COUNT(*) AS n FROM source_articles WHERE slug = ?').get(base.slug);
    checks.push(['second upsert (same slug) still exactly one row — no duplicate', afterSecond.n === 1]);

    const row = db.prepare('SELECT title, original_content, status, keywords FROM source_articles WHERE slug = ?').get(base.slug);
    checks.push(['second upsert overwrote the title with the new value', row.title === 'Updated Title']);
    checks.push(['second upsert overwrote original_content with the new value', row.original_content === 'Second version of the content.']);
    checks.push(['second upsert overwrote keywords with the new value', row.keywords === JSON.stringify(['warrants', 'ipo'])]);
    checks.push(['status is "imported" after upsert', row.status === 'imported']);
  } finally {
    db.close();
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Part 3 — CLI-level: --dry-run, a real run, a second (no-op) run, --slug, errors
// ---------------------------------------------------------------------------

function runCli(extraArgs) {
  try {
    // --no-mirror: a real run would otherwise regenerate the real
    // admin/knowledge-graph.json from THIS TEST_DB_PATH (the mirror path is
    // not derived from --db — see import-source-articles.js's own comment),
    // clobbering it with this validator's fixture data. Same isolation
    // precedent as validate-extract-articles.js's own CLI invocation.
    const stdout = execFileSync(
      'node',
      ['--no-warnings', 'import-source-articles.js', '--db', TEST_DB_PATH, '--pending-dir', PENDING_DIR, '--no-mirror', ...extraArgs],
      { cwd: __dirname, encoding: 'utf-8' }
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function countRows(dbPath, slug) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM source_articles WHERE slug = ?').get(slug).n;
  } finally {
    db.close();
  }
}

function checks_cli() {
  console.log('\n=== Part 3: CLI-level ===\n');
  const checks = [];

  resetPendingDir();
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  const db = freshTempDb();
  db.close();

  writePending('cli-article-a.json', { title: 'CLI Article A', originalContent: 'Content A.' });
  writePending('cli-article-b.json', { title: 'CLI Article B', originalContent: 'Content B.' });

  // --dry-run must not write anything.
  const dryRun = runCli(['--dry-run']);
  console.log('--- --dry-run stdout ---\n' + dryRun.stdout);
  checks.push(['--dry-run exits 0', dryRun.exitCode === 0]);
  checks.push(['--dry-run writes nothing to the db', countRows(TEST_DB_PATH, slugifyTopic('CLI Article A')) === 0]);

  // A real run writes both.
  const realRun = runCli([]);
  console.log('--- real run stdout ---\n' + realRun.stdout);
  checks.push(['real run exits 0', realRun.exitCode === 0]);
  checks.push(['real run writes article A', countRows(TEST_DB_PATH, slugifyTopic('CLI Article A')) === 1]);
  checks.push(['real run writes article B', countRows(TEST_DB_PATH, slugifyTopic('CLI Article B')) === 1]);

  // Running it again over the SAME pending files must be a no-op re-upsert, not a duplicate row.
  const secondRun = runCli([]);
  checks.push(['second run over the same pending files exits 0', secondRun.exitCode === 0]);
  checks.push(['second run: still exactly one row for article A, not two', countRows(TEST_DB_PATH, slugifyTopic('CLI Article A')) === 1]);
  checks.push(['second run: still exactly one row for article B, not two', countRows(TEST_DB_PATH, slugifyTopic('CLI Article B')) === 1]);

  // --slug filters to only the matching file.
  writePending('cli-article-c.json', { title: 'CLI Article C', originalContent: 'Content C.' });
  const slugRun = runCli(['--slug', slugifyTopic('CLI Article C')]);
  checks.push(['--slug run exits 0', slugRun.exitCode === 0]);
  checks.push(['--slug run writes only the matching article', countRows(TEST_DB_PATH, slugifyTopic('CLI Article C')) === 1]);
  checks.push(['--slug run does not re-touch a non-matching article (still 1 row, not re-inserted)', countRows(TEST_DB_PATH, slugifyTopic('CLI Article A')) === 1]);

  // A malformed file in the mix: CLI must exit non-zero but still write the valid ones.
  writePending('cli-broken.json', { originalContent: 'No title here.' });
  const brokenRun = runCli([]);
  checks.push(['a run with one malformed pending file exits non-zero', brokenRun.exitCode !== 0]);
  checks.push(['valid files in the same run are still written despite the one error', countRows(TEST_DB_PATH, slugifyTopic('CLI Article A')) === 1]);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(SCHEMA_SQL_PATH)) throw new Error(`Missing ${path.relative(REPO_ROOT, SCHEMA_SQL_PATH)}`);

  const checks = [...checks_loadPendingFile(), ...checks_upsertIdempotency(), ...checks_cli()];

  console.log('\n=== Results ===');
  let allPassed = true;
  for (const [label, passed] of checks) {
    allPassed &&= passed;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}: ${label}`);
  }
  console.log(`\n${allPassed ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED'}`);
  process.exitCode = allPassed ? 0 : 1;

  // Cleanup scratch fixtures.
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  if (existsSync(PENDING_DIR)) rmSync(PENDING_DIR, { recursive: true, force: true });
}

main();
