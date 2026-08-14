#!/usr/bin/env node
/**
 * Validation harness for extract-entities.js's --batch-size mode (build-order
 * step 4 — extra-md-files/ai-article-pipeline.md). Same spirit and fixture-
 * injection approach as validate-extract-entities.js (which this deliberately
 * doesn't duplicate assertions from — that file covers batch-size-1
 * behavior; this one is batch-size > 1 only), no OPENAI_API_KEY/network
 * needed.
 *
 * Exercises processArticleBatch() and the `--batch-size` CLI flag on the
 * same two real articles used by validate-extract-entities.js ("Put
 * Warrant", "Structured Warrants" both appear in each), proving:
 *   1. ONE fixture response covering both articles is accepted, and each
 *      article's entities/edges land under its own row correctly (not
 *      cross-contaminated between the two blocks).
 *   2. An entity named identically in both articles' blocks within the SAME
 *      batch response collapses to a single `entities` row — this is the
 *      actual dedup race build-order step 4 exists to close: the model
 *      producing consistent naming across articles in one response, instead
 *      of two concurrent calls each holding a stale view of the other.
 *   3. A per-article regression (one article's block in the batch drops a
 *      previously-captured fact) is still caught by the checker, scoped to
 *      that one article — the OTHER article in the same batch reads "ok".
 *   4. A malformed batch response (missing block for a requested slug) fails
 *      every article in that batch, not a silent partial result.
 *   5. At the CLI level: `--batch-size 2` on the same two-article db
 *      produces one batch fixture lookup (not two single-article ones) and
 *      the summary reflects one "ok" + one "regression" like Part 2 in the
 *      non-batch harness, still exiting non-zero.
 *
 * Usage: node validate-extract-entities-batch.js
 */

import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  listArticles,
  processArticleBatch,
  parseBatchExtractionResponse,
  fixtureExtractor,
} from './extract-entities.js';
import { getArticleEntityEdgeState, fixtureJudge } from './fact-retention-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const EXTRACT_FIXTURE_DIR = path.join(OUTPUT_DIR, 'extract-fixtures');
const JUDGE_FIXTURE_DIR = path.join(OUTPUT_DIR, 'judge-fixtures');

const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');
const FN_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-batch-test.db'); // Part 1 — function-level
const CLI_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-batch-cli-test.db'); // Part 2 — CLI-level
const MALFORMED_TEST_DB = path.join(OUTPUT_DIR, 'knowledge-graph.extract-batch-malformed-test.db'); // Part 3

const SLUG_A = 'what-are-structured-warrants-malaysia';
const SLUG_B = 'hedging-with-put-warrants-malaysia';
const BATCH_KEY = `${SLUG_A}+${SLUG_B}`;

// One raw response covering BOTH articles. "Structured Warrants" and
// "Put Warrant" appear in both blocks with the SAME exact name — this is
// what a real batched call is expected to do (Part 1's assertion #2 below
// checks it collapses to one entities row each, not two). Article B's block
// deliberately omits "Risk Management" to simulate a regression scoped to
// just that one article, same worked example as the non-batch harness.
const BATCH_RESPONSE_CLEAN = {
  articles: [
    {
      slug: SLUG_A,
      entities: [
        { name: 'Structured Warrants', type: 'topic', relevance_score: 0.95 },
        { name: 'Call Warrant', type: 'product', relevance_score: 0.7 },
        { name: 'Put Warrant', type: 'product', relevance_score: 0.6 },
        { name: 'Bursa Malaysia', type: 'organization', relevance_score: 0.5 },
      ],
      edges: [
        { source: 'Call Warrant', relation: 'part_of', target: 'Structured Warrants' },
        { source: 'Put Warrant', relation: 'part_of', target: 'Structured Warrants' },
      ],
    },
    {
      slug: SLUG_B,
      entities: [
        { name: 'Hedging', type: 'strategy', relevance_score: 0.95 },
        { name: 'Put Warrant', type: 'product', relevance_score: 0.9 }, // same name as article A's block, on purpose
        { name: 'Structured Warrants', type: 'topic', relevance_score: 0.5 }, // ditto
        // "Risk Management" deliberately omitted — this article's regression case.
      ],
      edges: [
        { source: 'Hedging', relation: 'related_to', target: 'Put Warrant' },
        { source: 'Put Warrant', relation: 'part_of', target: 'Structured Warrants' },
      ],
    },
  ],
};

const JUDGE_A = {
  items: [
    { name: 'Bursa Malaysia', status: 'retained', note: 'unchanged' },
    { name: 'Call Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Put Warrant', status: 'retained', note: 'unchanged' },
    { name: 'Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Call Warrant -> Structured Warrants', status: 'retained', note: 'unchanged' },
    { name: 'Put Warrant -> Structured Warrants', status: 'retained', note: 'unchanged' },
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
  // processArticleBatch's fixture key is slugs.join('+') in WHATEVER order the
  // caller handed it articles — Part 1/3 below construct [A, B] explicitly,
  // but Part 2 (CLI) queries the db with `ORDER BY id`, which happens to put
  // B (hedging-...) before A (what-are-...) in the real seed db. Rather than
  // assume/hardcode one order, write the identical response under both key
  // orderings so lookup doesn't depend on row-id ordering that could shift.
  writeFileSync(path.join(EXTRACT_FIXTURE_DIR, `${BATCH_KEY}.json`), JSON.stringify(BATCH_RESPONSE_CLEAN), 'utf-8');
  writeFileSync(path.join(EXTRACT_FIXTURE_DIR, `${SLUG_B}+${SLUG_A}.json`), JSON.stringify(BATCH_RESPONSE_CLEAN), 'utf-8');
  writeFileSync(path.join(JUDGE_FIXTURE_DIR, `${SLUG_A}.json`), JSON.stringify(JUDGE_A), 'utf-8');
  writeFileSync(path.join(JUDGE_FIXTURE_DIR, `${SLUG_B}.json`), JSON.stringify(JUDGE_B), 'utf-8');
}

// ---------------------------------------------------------------------------
// Part 0 — parseBatchExtractionResponse: missing-slug-block failure mode
// (no db, no fixtures on disk — a raw batch response string).
// ---------------------------------------------------------------------------

function runMissingSlugCheck() {
  console.log('=== Part 0: parseBatchExtractionResponse missing-slug handling ===\n');
  const checks = [];

  const raw = JSON.stringify({
    articles: [{ slug: SLUG_A, entities: [{ name: 'Structured Warrants', type: 'topic', relevance_score: 0.9 }], edges: [] }],
    // SLUG_B's block is entirely absent.
  });

  let threw = false;
  try {
    parseBatchExtractionResponse(raw, [SLUG_A, SLUG_B]);
  } catch (err) {
    threw = /missing block\(s\) for/.test(err.message) && err.message.includes(SLUG_B);
  }
  checks.push(['throws naming the missing slug when a requested article has no block', threw]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1 — function-level: run processArticleBatch() directly, assert the
// write + checker classification are correct per-article, and that shared
// entity names within the one batch response collapse to single rows.
// ---------------------------------------------------------------------------

async function runPart1() {
  console.log('\n=== Part 1: function-level (processArticleBatch) ===\n');
  copyFileSync(ORIGINAL_DB, FN_TEST_DB);

  const extract = (promptObj, opts) => fixtureExtractor(promptObj, { fixtureDir: EXTRACT_FIXTURE_DIR, slug: opts.slug });
  const judge = (promptObj, opts) => fixtureJudge(promptObj, { fixturePath: path.join(JUDGE_FIXTURE_DIR, `${opts.slug}.json`) });

  const db = new DatabaseSync(FN_TEST_DB);
  let resultsBySlug;
  try {
    const articles = [listArticles(db, { onlySlug: SLUG_A })[0], listArticles(db, { onlySlug: SLUG_B })[0]];
    const results = await processArticleBatch(db, articles, {
      dbPath: FN_TEST_DB,
      model: 'unused-in-fixture-mode',
      dryRun: false,
      skipChecker: false,
      extract,
      extractOpts: {},
      judge,
      judgeOpts: {},
    });
    resultsBySlug = Object.fromEntries(results.map((r) => [r.slug, r]));
  } finally {
    db.close();
  }

  const checks = [];
  checks.push(['one LLM call covered both articles — batch returns exactly 2 results', Object.keys(resultsBySlug).length === 2]);
  checks.push(['Article A (clean) status === "ok"', resultsBySlug[SLUG_A]?.status === 'ok']);
  checks.push(['Article B (dropped fact) status === "regression"', resultsBySlug[SLUG_B]?.status === 'regression']);
  checks.push([
    'Article B regression names exactly "Risk Management"',
    resultsBySlug[SLUG_B]?.dropped?.length === 1 && resultsBySlug[SLUG_B].dropped[0].name === 'Risk Management',
  ]);

  const verifyDb = new DatabaseSync(FN_TEST_DB, { readOnly: true });
  try {
    const countByName = (name) =>
      verifyDb.prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ? COLLATE NOCASE').get(name).n;
    checks.push([
      '"Put Warrant" is a single entity row despite appearing in BOTH articles\' blocks of the same batch response',
      countByName('Put Warrant') === 1,
    ]);
    checks.push([
      '"Structured Warrants" is a single entity row despite appearing in BOTH articles\' blocks',
      countByName('Structured Warrants') === 1,
    ]);

    const bEntities = getArticleEntityEdgeState(FN_TEST_DB, SLUG_B).entities.map((e) => e.name);
    checks.push(['Article B no longer has "Risk Management" (drop actually written)', !bEntities.includes('Risk Management')]);
    const aEntities = getArticleEntityEdgeState(FN_TEST_DB, SLUG_A).entities.map((e) => e.name);
    checks.push(['Article A has its own 4 entities (not merged/cross-contaminated with B\'s block)', aEntities.length === 4]);
  } finally {
    verifyDb.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — CLI-level: `node extract-entities.js --batch-size 2` against the
// same two-article db, single batch fixture, one summary covering both.
// ---------------------------------------------------------------------------

function makeTrimmedDb(dest) {
  copyFileSync(ORIGINAL_DB, dest);
  const db = new DatabaseSync(dest);
  try {
    const doomedIds = db
      .prepare('SELECT id FROM articles WHERE slug NOT IN (?, ?)')
      .all(SLUG_B, SLUG_A)
      .map((r) => r.id);
    if (doomedIds.length) {
      const placeholders = doomedIds.map(() => '?').join(',');
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

function runCli(dbPath, extraArgs) {
  try {
    const stdout = execFileSync(
      'node',
      [
        '--no-warnings',
        'extract-entities.js',
        '--db',
        dbPath,
        '--batch-size',
        '2',
        '--extract-fixture-dir',
        EXTRACT_FIXTURE_DIR,
        '--judge-fixture-dir',
        JUDGE_FIXTURE_DIR,
        ...extraArgs,
      ],
      { cwd: __dirname, encoding: 'utf-8' }
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '' };
  }
}

function runPart2() {
  console.log('\n=== Part 2: CLI-level (--batch-size 2) ===\n');
  const checks = [];

  makeTrimmedDb(CLI_TEST_DB);
  const run = runCli(CLI_TEST_DB, []);
  console.log('--- --batch-size 2 run stdout ---\n' + run.stdout);
  checks.push(['run mentions "1 call(s) total" (both articles went out in one LLM call)', /1 call\(s\) total/.test(run.stdout)]);
  checks.push(['exit code is non-zero (article B\'s regression happened)', run.exitCode !== 0]);
  checks.push(['both articles appear in the summary', run.stdout.includes(SLUG_A) && run.stdout.includes(SLUG_B)]);
  checks.push(['reports the regression status', /regression: 1/.test(run.stdout)]);
  checks.push(['reports the ok status', /ok: 1/.test(run.stdout)]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 3 — a malformed batch response (missing block for a requested slug)
// fails BOTH articles in that batch, not a silent partial result.
// ---------------------------------------------------------------------------

async function runPart3() {
  console.log('\n=== Part 3: malformed batch response fails the whole batch ===\n');
  copyFileSync(ORIGINAL_DB, MALFORMED_TEST_DB);
  // ORIGINAL_DB is the hand-authored sample, already seeded with entities for
  // every real article — capture article A's PRE-EXISTING seed state so the
  // assertion below can prove nothing changed, rather than wrongly expecting
  // zero entities (writeExtractionResult would only ever REPLACE this, never
  // start from empty).
  const beforeAEntities = getArticleEntityEdgeState(MALFORMED_TEST_DB, SLUG_A).entities.map((e) => e.name).sort();

  const malformedFixtureDir = path.join(OUTPUT_DIR, 'extract-fixtures-malformed');
  mkdirSync(malformedFixtureDir, { recursive: true });
  // Only article A's block — B's is missing, same shape a truncated/broken
  // model response would produce.
  writeFileSync(
    path.join(malformedFixtureDir, `${BATCH_KEY}.json`),
    JSON.stringify({ articles: [BATCH_RESPONSE_CLEAN.articles[0]] }),
    'utf-8'
  );

  const extract = (promptObj, opts) => fixtureExtractor(promptObj, { fixtureDir: malformedFixtureDir, slug: opts.slug });
  const judge = (promptObj, opts) => fixtureJudge(promptObj, { fixturePath: path.join(JUDGE_FIXTURE_DIR, `${opts.slug}.json`) });

  const db = new DatabaseSync(MALFORMED_TEST_DB);
  let results;
  try {
    const articles = [listArticles(db, { onlySlug: SLUG_A })[0], listArticles(db, { onlySlug: SLUG_B })[0]];
    results = await processArticleBatch(db, articles, {
      dbPath: MALFORMED_TEST_DB,
      model: 'unused-in-fixture-mode',
      dryRun: false,
      skipChecker: false,
      extract,
      extractOpts: {},
      judge,
      judgeOpts: {},
    });
  } finally {
    db.close();
  }

  const checks = [];
  checks.push(['both articles come back as "error" (whole batch fails together)', results.every((r) => r.status === 'error')]);
  checks.push([
    'the error message names the missing slug',
    results.every((r) => typeof r.error === 'string' && r.error.includes(SLUG_B)),
  ]);

  const verifyDb = new DatabaseSync(MALFORMED_TEST_DB, { readOnly: true });
  try {
    const afterAEntities = getArticleEntityEdgeState(MALFORMED_TEST_DB, SLUG_A).entities.map((e) => e.name).sort();
    // Article A's block WAS present and valid in the malformed response, but
    // since the whole batch is trusted together-or-not-at-all (parse throws
    // before any write happens), its pre-existing seed state should be
    // completely untouched — not replaced, not partially written.
    checks.push([
      'article A was NOT written either (parse failed before any write — seed state unchanged)',
      JSON.stringify(afterAEntities) === JSON.stringify(beforeAEntities),
    ]);
  } finally {
    verifyDb.close();
  }

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
  const checks = [...runMissingSlugCheck(), ...(await runPart1()), ...runPart2(), ...(await runPart3())];

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
