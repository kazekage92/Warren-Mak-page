#!/usr/bin/env node
/**
 * Validation harness for extract-entities.js — same spirit as
 * validate-fact-retention-checker.js (extra-md-files/ai-article-pipeline.md
 * §3's own note: hand-edit/hand-author fixtures against a copy of the real
 * db, no OPENAI_API_KEY/network needed).
 *
 * Exercises the actual "extract -> write -> checker" pipeline end to end on
 * two real articles that already share entities in the hand-authored sample
 * ("Put Warrant", "Structured Warrants") — proving:
 *   1. A harmless rename survives the checker as "retained" (same worked
 *      example as §3's own doc: renaming an entity is not the same as
 *      dropping it), and the rename is really written to the db, not just
 *      judged.
 *   2. A genuinely dropped entity (simulated: the extractor fixture just
 *      omits it) is written as dropped AND the checker flags it — this is
 *      the regression the whole §3 gate exists to catch.
 *   3. Entity reuse/dedup works ACROSS articles processed in the same run:
 *      "Put Warrant"/"Structured Warrants" end up as one row each, not
 *      duplicated, after both articles are processed.
 *   4. At the CLI/orchestration level: the default (continue past a
 *      regression, exit non-zero at the end) and --stop-on-regression
 *      (halt before the next article) behaviors both work as documented.
 *
 * Usage: node validate-extract-entities.js
 */

import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  listArticles,
  processArticle,
  fixtureExtractor,
  parseExtractionResponse,
  writeExtractionResult,
} from './extract-entities.js';
import { getArticleEntityEdgeState, fixtureJudge } from './fact-retention-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const EXTRACT_FIXTURE_DIR = path.join(OUTPUT_DIR, 'extract-fixtures');
const JUDGE_FIXTURE_DIR = path.join(OUTPUT_DIR, 'judge-fixtures');

const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');
const FN_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-test.db'); // Part 1 — function-level
const CLI_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-cli-test.db'); // Part 2 — CLI-level
const WRITE_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-write-test.db'); // Part 0b — write-layer dedup

// Article A — a clean pass: every OLD entity/edge should read "retained",
// including one deliberate harmless rename (Company Warrants -> Structured
// Product Warrants), the exact case §3's doc uses as its worked example.
const SLUG_A = 'what-are-structured-warrants-malaysia';
const EXTRACTION_A = {
  entities: [
    { name: 'Structured Warrants', type: 'topic', relevance_score: 0.95 },
    { name: 'Call Warrant', type: 'product', relevance_score: 0.7 },
    { name: 'Put Warrant', type: 'product', relevance_score: 0.7 },
    { name: 'Bursa Malaysia', type: 'organization', relevance_score: 0.5 },
    { name: 'Structured Product Warrants', type: 'product', relevance_score: 0.4 }, // renamed from "Company Warrants"
  ],
  edges: [
    { source: 'Call Warrant', relation: 'part_of', target: 'Structured Warrants' },
    { source: 'Put Warrant', relation: 'part_of', target: 'Structured Warrants' },
    { source: 'Structured Warrants', relation: 'distinguished_from', target: 'Structured Product Warrants' },
  ],
};
const JUDGE_A = {
  items: [
    { name: 'Bursa Malaysia', status: 'retained', note: 'unchanged' },
    { name: 'Call Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Company Warrants', status: 'retained', note: 'renamed to Structured Product Warrants, same concept' },
    { name: 'Put Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Call Warrant -> Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Put Warrant -> Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Structured Warrants -> Company Warrants', status: 'retained', note: 'target renamed, same relation' },
  ],
};

// Article B — a simulated regression: the extractor fixture just omits
// "Risk Management" entirely, as a real extraction pass silently dropping a
// fact would. The checker must catch it.
const SLUG_B = 'hedging-with-put-warrants-malaysia';
const EXTRACTION_B = {
  entities: [
    { name: 'Hedging', type: 'strategy', relevance_score: 0.95 },
    { name: 'Put Warrant', type: 'product', relevance_score: 0.9 },
    { name: 'Structured Warrants', type: 'topic', relevance_score: 0.5 },
    // "Risk Management" deliberately omitted.
  ],
  edges: [
    { source: 'Hedging', relation: 'related_to', target: 'Put Warrant' },
    { source: 'Put Warrant', relation: 'part_of', target: 'Structured Warrants' },
  ],
};
const JUDGE_B = {
  items: [
    { name: 'Hedging', status: 'retained', note: 'unchanged' },
    { name: 'Put Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Risk Management', status: 'dropped', note: 'no equivalent entity in NEW' },
    { name: 'Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Hedging -> Put Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Put Warrant -> Structured Warrants', status: 'retained', note: 'unchanged' },
  ],
};

function writeFixtures() {
  mkdirSync(EXTRACT_FIXTURE_DIR, { recursive: true });
  mkdirSync(JUDGE_FIXTURE_DIR, { recursive: true });
  writeFileSync(path.join(EXTRACT_FIXTURE_DIR, `${SLUG_A}.json`), JSON.stringify(EXTRACTION_A), 'utf-8');
  writeFileSync(path.join(EXTRACT_FIXTURE_DIR, `${SLUG_B}.json`), JSON.stringify(EXTRACTION_B), 'utf-8');
  writeFileSync(path.join(JUDGE_FIXTURE_DIR, `${SLUG_A}.json`), JSON.stringify(JUDGE_A), 'utf-8');
  writeFileSync(path.join(JUDGE_FIXTURE_DIR, `${SLUG_B}.json`), JSON.stringify(JUDGE_B), 'utf-8');
}

// ---------------------------------------------------------------------------
// Part 0a — parseExtractionResponse's own case-insensitive entity dedup
// (no db, no fixtures on disk — a raw extractor response string).
// ---------------------------------------------------------------------------

function runDedupParseCheck() {
  console.log('=== Part 0a: parseExtractionResponse entity dedup ===\n');
  const checks = [];

  const raw = JSON.stringify({
    entities: [
      { name: 'Bursa Malaysia', type: 'organization', relevance_score: 0.5 },
      { name: 'bursa malaysia', type: 'organization', relevance_score: 0.9 }, // case-insensitive dup of the above
      { name: 'Put Warrant', type: 'product', relevance_score: 0.7 },
    ],
    edges: [
      // References the dropped-casing duplicate — must still resolve, to the kept entity's name.
      { source: 'BURSA MALAYSIA', relation: 'related_to', target: 'Put Warrant' },
    ],
  });
  const result = parseExtractionResponse(raw);

  checks.push(['dedups the case-insensitive duplicate (3 in, 2 out)', result.entities.length === 2]);
  checks.push([
    'keeps the first occurrence\'s exact name + score ("Bursa Malaysia", 0.5)',
    result.entities.some((e) => e.name === 'Bursa Malaysia' && e.relevance_score === 0.5),
  ]);
  checks.push(['drops the later-cased duplicate ("bursa malaysia")', !result.entities.some((e) => e.name === 'bursa malaysia')]);
  checks.push([
    'edge referencing the dropped casing still resolves, normalized to the kept name',
    result.edges.length === 1 && result.edges[0].source === 'Bursa Malaysia' && result.edges[0].target === 'Put Warrant',
  ]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0b — article_entities UNIQUE(article_id, entity_id) + insertArticleEntity's
// ON CONFLICT DO UPDATE, as defense in depth: calls writeExtractionResult()
// directly (bypassing parseExtractionResponse's own dedup, tested above) with
// two response entities that resolve to the SAME existing db entity via
// case-insensitive name matching, proving the write layer still collapses
// them into one article_entities row instead of erroring or duplicating.
// ---------------------------------------------------------------------------

function runDedupWriteLayerCheck() {
  console.log('\n=== Part 0b: writeExtractionResult / article_entities UNIQUE (defense in depth) ===\n');
  copyFileSync(ORIGINAL_DB, WRITE_TEST_DB);

  const db = new DatabaseSync(WRITE_TEST_DB);
  let articleId;
  try {
    articleId = listArticles(db, { onlySlug: SLUG_A })[0].id;
    writeExtractionResult(db, {
      articleId,
      extraction: {
        entities: [
          { name: 'Structured Warrants', type: 'topic', relevance_score: 0.3 },
          { name: 'structured warrants', type: 'topic', relevance_score: 0.95 }, // same entity id, different casing
        ],
        edges: [],
      },
    });
  } finally {
    db.close();
  }

  const checks = [];
  const verifyDb = new DatabaseSync(WRITE_TEST_DB, { readOnly: true });
  try {
    const rows = verifyDb
      .prepare(
        'SELECT relevance_score FROM article_entities ' +
          'WHERE article_id = ? AND entity_id = (SELECT id FROM entities WHERE name = ? COLLATE NOCASE)'
      )
      .all(articleId, 'Structured Warrants');
    checks.push(['exactly one article_entities row for the collided entity (no duplicate)', rows.length === 1]);
    checks.push([
      'ON CONFLICT DO UPDATE kept the later relevance_score (0.95, from the second write)',
      rows[0]?.relevance_score === 0.95,
    ]);
  } finally {
    verifyDb.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1 — function-level: run processArticle() directly against a full copy
// of the real db, assert the write + checker classification are correct.
// ---------------------------------------------------------------------------

async function runPart1() {
  console.log('=== Part 1: function-level (processArticle) ===\n');
  copyFileSync(ORIGINAL_DB, FN_TEST_DB);

  const extract = (promptObj, opts) => fixtureExtractor(promptObj, { fixtureDir: EXTRACT_FIXTURE_DIR, slug: opts.slug });
  const judge = (promptObj, opts) => fixtureJudge(promptObj, { fixturePath: path.join(JUDGE_FIXTURE_DIR, `${opts.slug}.json`) });

  const db = new DatabaseSync(FN_TEST_DB);
  const results = {};
  try {
    for (const slug of [SLUG_B, SLUG_A]) {
      const article = listArticles(db, { onlySlug: slug })[0];
      results[slug] = await processArticle(db, article, {
        dbPath: FN_TEST_DB,
        model: 'unused-in-fixture-mode',
        dryRun: false,
        skipChecker: false,
        extract,
        extractOpts: {},
        judge,
        judgeOpts: {},
      });
    }
  } finally {
    db.close();
  }

  const checks = [];
  checks.push(['Article A (clean rename) status === "ok"', results[SLUG_A].status === 'ok']);
  checks.push(['Article B (dropped fact) status === "regression"', results[SLUG_B].status === 'regression']);
  checks.push([
    'Article B regression names exactly "Risk Management"',
    results[SLUG_B].dropped?.length === 1 && results[SLUG_B].dropped[0].name === 'Risk Management',
  ]);

  // Re-open read-only and inspect the actual written rows.
  const verifyDb = new DatabaseSync(FN_TEST_DB, { readOnly: true });
  try {
    const countByName = (name) =>
      verifyDb.prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ? COLLATE NOCASE').get(name).n;
    checks.push(['"Put Warrant" is a single entity row (reused across A & B)', countByName('Put Warrant') === 1]);
    checks.push([
      '"Structured Warrants" is a single entity row (reused across A & B)',
      countByName('Structured Warrants') === 1,
    ]);

    const aEntities = getArticleEntityEdgeState(FN_TEST_DB, SLUG_A).entities.map((e) => e.name);
    checks.push([
      'Article A now has "Structured Product Warrants" (rename actually written)',
      aEntities.includes('Structured Product Warrants'),
    ]);
    checks.push(['Article A no longer has "Company Warrants" (old name replaced)', !aEntities.includes('Company Warrants')]);

    const bEntities = getArticleEntityEdgeState(FN_TEST_DB, SLUG_B).entities.map((e) => e.name);
    checks.push(['Article B no longer has "Risk Management" (drop actually written)', !bEntities.includes('Risk Management')]);
  } finally {
    verifyDb.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — CLI-level: run the real `node extract-entities.js` process against
// a 2-article db (hedging first by id, then what-are — regression then
// clean), proving --stop-on-regression halts before the second article and
// the default mode continues past it with a non-zero final exit code.
// ---------------------------------------------------------------------------

function makeTrimmedDb() {
  copyFileSync(ORIGINAL_DB, CLI_TEST_DB);
  const db = new DatabaseSync(CLI_TEST_DB);
  try {
    const doomedIds = db
      .prepare('SELECT id FROM articles WHERE slug NOT IN (?, ?)')
      .all(SLUG_B, SLUG_A)
      .map((r) => r.id);
    if (doomedIds.length) {
      const placeholders = doomedIds.map(() => '?').join(',');
      // FK-referencing rows first (node:sqlite enforces foreign_keys by default).
      db.prepare(`DELETE FROM article_entities WHERE article_id IN (${placeholders})`).run(...doomedIds);
      db.prepare(`DELETE FROM links WHERE source_article_id IN (${placeholders}) OR target_article_id IN (${placeholders})`).run(
        ...doomedIds,
        ...doomedIds
      );
      db.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).run(...doomedIds);
    }
  } finally {
    db.close();
  }
}

function runCli(extraArgs) {
  try {
    const stdout = execFileSync(
      'node',
      ['--no-warnings', 'extract-entities.js', '--db', CLI_TEST_DB, '--extract-fixture-dir', EXTRACT_FIXTURE_DIR, '--judge-fixture-dir', JUDGE_FIXTURE_DIR, ...extraArgs],
      { cwd: __dirname, encoding: 'utf-8' }
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '' };
  }
}

function runPart2() {
  console.log('\n=== Part 2: CLI-level (extract-entities.js subprocess) ===\n');
  const checks = [];

  // 2a — default mode: continues past B's regression, still processes A, exits non-zero overall.
  makeTrimmedDb();
  const defaultRun = runCli([]);
  console.log('--- default run stdout ---\n' + defaultRun.stdout);
  checks.push(['default run: exit code is non-zero (a regression occurred)', defaultRun.exitCode !== 0]);
  checks.push(['default run: both articles appear in the summary', defaultRun.stdout.includes(SLUG_B) && defaultRun.stdout.includes(SLUG_A)]);
  checks.push(['default run: reports the regression status', /regression: 1/.test(defaultRun.stdout)]);
  checks.push(['default run: reports the ok status', /ok: 1/.test(defaultRun.stdout)]);

  // 2b — --stop-on-regression: halts immediately after B, never attempts A
  // (which would otherwise surface as a fixture-not-found "error" entry if
  // the halt didn't actually happen, since A's fixture is still on disk —
  // the absence of ANY mention of SLUG_A is the actual proof here).
  makeTrimmedDb();
  const stopRun = runCli(['--stop-on-regression']);
  console.log('--- --stop-on-regression run stdout ---\n' + stopRun.stdout);
  checks.push(['stop-on-regression run: exit code is non-zero', stopRun.exitCode !== 0]);
  checks.push(['stop-on-regression run: halts before article A runs', !stopRun.stdout.includes(SLUG_A)]);
  checks.push(['stop-on-regression run: still processed article B', stopRun.stdout.includes(SLUG_B)]);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(ORIGINAL_DB)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, ORIGINAL_DB)} — run \`npm run extract\` first.`);
  }

  writeFixtures();
  const checks = [...runDedupParseCheck(), ...runDedupWriteLayerCheck(), ...(await runPart1()), ...runPart2()];

  console.log('\n=== Results ===');
  let allPassed = true;
  for (const [label, passed] of checks) {
    allPassed &&= passed;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}: ${label}`);
  }
  console.log(`\n${allPassed ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED'}`);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
