#!/usr/bin/env node
/**
 * Validation harness for fact-retention-checker.js — per
 * extra-md-files/ai-article-pipeline.md §3's own validation note: "Can be
 * validated against the existing hand-authored sample (admin/knowledge-
 * graph.db) by hand-editing a copy to simulate a regression and confirming
 * the checker catches it. Doesn't need the real extraction pipeline first."
 *
 * What this does:
 *   1. Copies admin/knowledge-graph.db to scripts/output/ (gitignored).
 *   2. Hand-edits the copy via raw SQL to simulate three cases at once on one
 *      article (structured-warrant-risks-time-decay-malaysia):
 *        - a harmless REWORD  -> must be judged "retained" (not "dropped",
 *          which a naive exact-string diff would wrongly report — this is
 *          the whole reason §3 asks for a semantic/LLM diff, not a text diff)
 *        - a DROPPED entity + its edges -> must be judged "dropped"
 *        - an ALTERED edge relation      -> must be judged "altered"
 *   3. Extracts old/new entity-edge state from the two DBs.
 *   4. Prints the exact prompt the checker would send to the judge.
 *   5. Runs the checker against a recorded judge response
 *      (scripts/output/fact-retention-fixture.json) via --judge-fixture, and
 *      asserts the three planted cases come back with the expected status.
 *
 * No OPENAI_API_KEY / network access needed — see step 5 and
 * scripts/README.md "Validating without an API key" for how the fixture
 * response was produced.
 *
 * Usage: node validate-fact-retention-checker.js
 */

import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  getArticleEntityEdgeState,
  buildJudgePrompt,
  checkFactRetention,
  fixtureJudge,
} from './fact-retention-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');

const SLUG = 'structured-warrant-risks-time-decay-malaysia';
const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');
const REGRESSED_DB = path.join(OUTPUT_DIR, 'knowledge-graph.regression-test.db');
const FIXTURE_PATH = path.join(OUTPUT_DIR, 'fact-retention-fixture.json');

function planRegression(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const article = db.prepare('SELECT id FROM articles WHERE slug = ?').get(SLUG);
    if (!article) throw new Error(`Sample db is missing article "${SLUG}" — did the schema change?`);

    // Case 1 — harmless REWORD: "Time Decay (Theta)" -> "Theta Decay". Same
    // real-world concept, different string. A naive text diff would call
    // every edge touching it "dropped"; the LLM judge should call it
    // "retained" for the entity and leave its edges classified on their own
    // merits (not corrupted collateral damage from the rename).
    db.prepare('UPDATE entities SET name = ? WHERE name = ?').run('Theta Decay', 'Time Decay (Theta)');

    // Case 2 — DROPPED entity: remove "Leverage" from this article entirely
    // (its article_entities row + the edges that depended on it). Simulates
    // a re-extraction pass silently losing a fact.
    const leverage = db.prepare('SELECT id FROM entities WHERE name = ?').get('Leverage');
    db.prepare('DELETE FROM article_entities WHERE article_id = ? AND entity_id = ?').run(
      article.id,
      leverage.id
    );
    db.prepare('DELETE FROM edges WHERE source_entity_id = ? OR target_entity_id = ?').run(
      leverage.id,
      leverage.id
    );

    // Case 3 — ALTERED edge: "Risk Management" -[related_to]-> "Theta Decay"
    // (renamed from Time Decay above) becomes "-[contradicts]->". Same pair
    // of entities, different (in fact opposite-sounding) relation — a
    // relevance_score/row-count check would miss this; the row still exists.
    db.prepare(
      `UPDATE edges SET relation = 'contradicts'
       WHERE relation = 'related_to'
         AND source_entity_id = (SELECT id FROM entities WHERE name = 'Risk Management')
         AND target_entity_id = (SELECT id FROM entities WHERE name = 'Theta Decay')`
    ).run();
  } finally {
    db.close();
  }
}

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`1. Copying ${path.relative(REPO_ROOT, ORIGINAL_DB)} -> ${path.relative(REPO_ROOT, REGRESSED_DB)}`);
  copyFileSync(ORIGINAL_DB, REGRESSED_DB);

  console.log('2. Hand-editing the copy to plant one reword + one drop + one alter...');
  planRegression(REGRESSED_DB);

  console.log('3. Extracting old/new entity-edge state...');
  const oldState = getArticleEntityEdgeState(ORIGINAL_DB, SLUG);
  const newState = getArticleEntityEdgeState(REGRESSED_DB, SLUG);
  console.log('   OLD:', JSON.stringify(oldState));
  console.log('   NEW:', JSON.stringify(newState));

  const promptObj = buildJudgePrompt({ slug: SLUG, oldState, newState });
  console.log('\n4. Prompt the checker would send to the judge:\n');
  console.log('--- system ---\n' + promptObj.system);
  console.log('\n--- user ---\n' + promptObj.user + '\n');

  if (!existsSync(FIXTURE_PATH)) {
    console.log(
      `5. No recorded judge response yet at ${path.relative(REPO_ROOT, FIXTURE_PATH)}.\n` +
        '   Run with OPENAI_API_KEY set to call the real judge and record one, or see\n' +
        '   scripts/README.md "Validating without an API key" for how to produce it by hand.\n' +
        '   Stopping here — nothing to assert against yet.'
    );
    return;
  }

  console.log(`5. Running the checker against the recorded fixture at ${path.relative(REPO_ROOT, FIXTURE_PATH)}...`);
  checkFactRetention({
    slug: SLUG,
    oldState,
    newState,
    judge: fixtureJudge,
    judgeOpts: { fixturePath: FIXTURE_PATH },
  }).then((result) => {
    console.log('\nJudge result:', JSON.stringify(result, null, 2));

    const byName = new Map(result.items.map((i) => [i.name, i.status]));
    const assertions = [
      // Rewording must not read as a drop — this is the entire point of an
      // LLM/semantic judge over a text diff (§3's worked example, verbatim).
      ['Time Decay (Theta)', 'retained'],
      ['Leverage', 'dropped'],
    ];

    let allPassed = true;
    for (const [name, expected] of assertions) {
      const actual = byName.get(name);
      const passed = actual === expected;
      allPassed &&= passed;
      console.log(`  ${passed ? 'PASS' : 'FAIL'}: "${name}" expected "${expected}", got "${actual}"`);
    }

    // The altered edge is reported keyed by "source -> target" per the
    // prompt's naming convention for edges — check loosely by relation text
    // rather than assume the judge's exact name formatting.
    const alteredEdge = result.items.find(
      (i) => /risk management/i.test(i.name) && /(theta decay|time decay)/i.test(i.name)
    );
    const alteredPassed = alteredEdge?.status === 'altered';
    allPassed &&= alteredPassed;
    console.log(
      `  ${alteredPassed ? 'PASS' : 'FAIL'}: Risk Management -> Theta Decay edge expected "altered", got ` +
        `${alteredEdge ? `"${alteredEdge.status}"` : '(not found in judge output)'}`
    );

    console.log(`\n${allPassed ? 'ALL ASSERTIONS PASSED' : 'SOME ASSERTIONS FAILED'}`);
    process.exitCode = allPassed ? 0 : 1;
  });
}

main();
