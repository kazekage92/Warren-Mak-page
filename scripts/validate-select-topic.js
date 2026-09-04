#!/usr/bin/env node
/**
 * Validation harness for select-topic.js — no LLM anywhere in that file, so
 * (matching retrieval-layer.js's/import-source-articles.js's own
 * no-fixture-needed precedent for pure-data scripts) this runs the REAL
 * parser against the REAL WARREN-MAK-NANYANG-ARTICLES.md and the REAL
 * hand-authored sample admin/knowledge-graph.db (read-only — never written
 * to), plus a temp history ledger under scripts/output/ (gitignored) so the
 * real admin/auto-article-history.json is never touched by this run.
 *
 * Usage: node validate-select-topic.js
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseNanyangCatalog, loadHistory, appendHistoryEntry, computeGapScore, selectTopic } from './select-topic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SELECT_TOPIC_DIR = path.join(OUTPUT_DIR, 'select-topic-fixtures');
const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');
const REAL_CATALOG_PATH = path.join(REPO_ROOT, 'WARREN-MAK-NANYANG-ARTICLES.md');

// ---------------------------------------------------------------------------
// Part 0 — parseNanyangCatalog() against the REAL catalog file
// ---------------------------------------------------------------------------

function runCatalogParseCheck(catalogText) {
  console.log('=== Part 0: parseNanyangCatalog() (real WARREN-MAK-NANYANG-ARTICLES.md) ===\n');
  const checks = [];

  const catalog = parseNanyangCatalog(catalogText);
  console.log(`Parsed ${catalog.length} candidate entries.`);

  checks.push(['finds a reasonable number of candidate entries (>10)', catalog.length > 10]);

  const dates = catalog.map((e) => e.date);
  checks.push(['no two entries share the same date (dedup collapsed list/table duplicates)', new Set(dates).size === dates.length]);

  checks.push(['no entry title is a generic placeholder like "(Testimonia Column)"', catalog.every((e) => !/^\(.*\)$/.test(e.title))]);

  const putWarrants = catalog.find((e) => e.date === '2018-07-11');
  checks.push(['finds the first structured-warrants-series entry (2018-07-11)', Boolean(putWarrants)]);
  checks.push(['that entry has its real (non-inferred) title', putWarrants?.inferred === false]);
  checks.push(['that entry title carries the English translation', /Put Warrants/i.test(putWarrants?.title ?? '')]);
  checks.push(['that entry carries its enanyang.my URL', /^https:\/\/www\.enanyang\.my\//.test(putWarrants?.url ?? '')]);

  const bracketEntry = catalog.find((e) => e.date === '2018-10-17');
  checks.push(['finds the bracket-titled placeholder entry (2018-10-17)', Boolean(bracketEntry)]);
  checks.push(['that entry is flagged inferred: true', bracketEntry?.inferred === true]);
  checks.push(['that entry title has its brackets stripped', bracketEntry?.title === 'Warrant Pricing Dynamics']);

  // 2024-01-17 appears BOTH as a "Monthly Income Strategy" category entry AND
  // as a non-placeholder row in the "Recent Articles" table -- must collapse
  // to exactly one candidate, keeping the richer list-section version.
  const dupDateMatches = catalog.filter((e) => e.date === '2024-01-17');
  checks.push(['a title duplicated between the category list and the table collapses to ONE entry', dupDateMatches.length === 1]);
  checks.push(['...and keeps the richer list-section entry (has a URL), not the table restatement', Boolean(dupDateMatches[0]?.url)]);

  checks.push(['every entry has a non-empty section label', catalog.every((e) => typeof e.section === 'string' && e.section.length > 0)]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0.5 — loadHistory() / appendHistoryEntry()
// ---------------------------------------------------------------------------

function runHistoryLedgerCheck() {
  console.log('\n=== Part 0.5: loadHistory() / appendHistoryEntry() ===\n');
  const checks = [];

  const missingPath = path.join(SELECT_TOPIC_DIR, 'does-not-exist.json');
  checks.push(['loadHistory() on a missing file returns []', Array.isArray(loadHistory(missingPath)) && loadHistory(missingPath).length === 0]);

  const malformedJsonPath = path.join(SELECT_TOPIC_DIR, 'malformed.json');
  writeFileSync(malformedJsonPath, 'not json', 'utf-8');
  let threwOnMalformedJson = false;
  try {
    loadHistory(malformedJsonPath);
  } catch {
    threwOnMalformedJson = true;
  }
  checks.push(['loadHistory() throws on invalid JSON', threwOnMalformedJson]);

  const notArrayPath = path.join(SELECT_TOPIC_DIR, 'not-array.json');
  writeFileSync(notArrayPath, JSON.stringify({ foo: 'bar' }), 'utf-8');
  let threwOnNotArray = false;
  try {
    loadHistory(notArrayPath);
  } catch {
    threwOnNotArray = true;
  }
  checks.push(['loadHistory() throws when the top level is not an array', threwOnNotArray]);

  const malformedEntryPath = path.join(SELECT_TOPIC_DIR, 'malformed-entry.json');
  writeFileSync(malformedEntryPath, JSON.stringify([{ nanyangTitle: 'X' }]), 'utf-8');
  let threwOnMalformedEntry = false;
  try {
    loadHistory(malformedEntryPath);
  } catch {
    threwOnMalformedEntry = true;
  }
  checks.push(['loadHistory() throws on an entry missing slug/publishedAt', threwOnMalformedEntry]);

  const roundTripPath = path.join(SELECT_TOPIC_DIR, 'round-trip.json');
  if (existsSync(roundTripPath)) rmSync(roundTripPath);
  const afterFirst = appendHistoryEntry(roundTripPath, { nanyangTitle: 'Topic A', slug: 'topic-a', publishedAt: '2026-01-01T00:00:00Z' });
  checks.push(['appendHistoryEntry() on a fresh path creates a 1-entry ledger', afterFirst.length === 1]);
  const afterSecond = appendHistoryEntry(roundTripPath, { nanyangTitle: 'Topic B', slug: 'topic-b', publishedAt: '2026-01-15T00:00:00Z' });
  checks.push(['appendHistoryEntry() appends (2 entries now), does not overwrite the first', afterSecond.length === 2 && afterSecond[0].nanyangTitle === 'Topic A']);
  const reloaded = loadHistory(roundTripPath);
  checks.push(['loadHistory() after two appends round-trips both entries from disk', reloaded.length === 2 && reloaded[1].nanyangTitle === 'Topic B']);

  let threwOnEmptyTitle = false;
  try {
    appendHistoryEntry(roundTripPath, { nanyangTitle: '  ', slug: 'x', publishedAt: '2026-01-01T00:00:00Z' });
  } catch {
    threwOnEmptyTitle = true;
  }
  checks.push(['appendHistoryEntry() rejects an empty/whitespace-only nanyangTitle', threwOnEmptyTitle]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1 — computeGapScore() / selectTopic() against the REAL sample db + REAL catalog
// ---------------------------------------------------------------------------

function runSelectionCheck(db, catalogText) {
  console.log('\n=== Part 1: selectTopic() (real sample db + real catalog) ===\n');
  const checks = [];

  const result = selectTopic(db, { catalogText, history: [] });
  console.log(`Selected: ${result.selected ? `"${result.selected.title}"` : '(none)'}`);

  checks.push(['selectTopic() finds at least one eligible candidate (only 12 articles exist vs. 23 catalog entries)', result.selected !== null]);
  checks.push(['every scored candidate carries a gapScore in [0, 1]', result.candidates.every((c) => c.gapScore >= 0 && c.gapScore <= 1)]);
  checks.push(['the selected candidate is never a "high" duplicate-risk one (excluded by default)', result.selected?.duplicateRiskVerdict !== 'high']);
  checks.push(['candidates are sorted by gapScore descending', result.candidates.every((c, i) => i === 0 || result.candidates[i - 1].gapScore >= c.gapScore)]);
  checks.push(['totalCatalogSize matches parseNanyangCatalog()\'s own count', result.totalCatalogSize === parseNanyangCatalog(catalogText).length]);
  checks.push(['usedFilteredCount is 0 with an empty history', result.usedFilteredCount === 0]);

  // Known near-duplicate case: "Bottom-Fishing with Structured Warrants" (2020-08-05)
  // is, by title/topic, essentially the source column for the real published
  // "bottom-fishing-structured-warrants-malaysia" article -- must score a
  // WEAKER (or equal) gap than a candidate with no real-article counterpart,
  // and must land at duplicateRisk "high".
  const bottomFishing = result.candidates.find((c) => c.date === '2020-08-05');
  const novelCandidate = result.candidates.find((c) => c.date === '2024-10-09'); // "8 Factors Why Traders Lose" — no real-article counterpart
  checks.push(['found the known near-duplicate candidate (Bottom-Fishing, 2020-08-05)', Boolean(bottomFishing)]);
  checks.push(['found a known genuinely-novel candidate (2024-10-09)', Boolean(novelCandidate)]);
  checks.push(['the near-duplicate candidate scores duplicateRisk "high"', bottomFishing?.duplicateRiskVerdict === 'high']);
  checks.push(['the near-duplicate candidate has a strictly lower gapScore than the novel one', (bottomFishing?.gapScore ?? 1) < (novelCandidate?.gapScore ?? 0)]);
  checks.push(['the near-duplicate candidate is excluded from `selected` (never the pick)', result.selected?.date !== '2020-08-05']);

  // --include-high-risk equivalent at the function level: turning off the
  // exclusion should make the near-duplicate candidate itself become
  // eligible again (still present in `candidates`, just no longer filtered
  // out of what COULD be selected).
  const resultIncludingHighRisk = selectTopic(db, { catalogText, history: [], excludeHighDuplicateRisk: false });
  checks.push(['excludeHighDuplicateRisk:false still returns the same total candidate count', resultIncludingHighRisk.candidates.length === result.candidates.length]);

  // computeGapScore() itself, isolated: an empty duplicateRisk/nearDuplicates
  // context (a topic matching nothing) scores a full 1.0 gap.
  checks.push(['computeGapScore() on an empty context scores 1 (nothing resembles it)', computeGapScore({ duplicateRisk: { titleSlugMatches: [] }, nearDuplicates: [] }) === 1]);
  checks.push(['computeGapScore() on a perfect title/slug match scores 0', computeGapScore({ duplicateRisk: { titleSlugMatches: [{ titleSimilarityScore: 1, slugSimilarityScore: 1 }] }, nearDuplicates: [] }) === 0]);

  // Inferred-title penalty: two synthetic contexts with identical similarity
  // signals should score the inferred one strictly lower once passed through
  // the real slugifyTopic()/buildRetrievalContext() plumbing on the sample
  // db, for a topic that matches nothing in the graph (a clean, isolated 1.0
  // vs. 0.8 comparison, not entangled with any real near-duplicate).
  const novelTopicText = 'Something Genuinely Unrelated To Any Existing Entity Whatsoever';
  const cleanCatalogText =
    `## Section\n` +
    `- **2026-01-01 — ${novelTopicText} A**\n` +
    `- **2026-01-02 — [${novelTopicText} B]**\n`;
  const inferredPenaltyResult = selectTopic(db, { catalogText: cleanCatalogText, history: [] });
  const confirmedCandidate = inferredPenaltyResult.candidates.find((c) => c.date === '2026-01-01');
  const inferredCandidate = inferredPenaltyResult.candidates.find((c) => c.date === '2026-01-02');
  checks.push(['a confirmed-title candidate with no graph match scores gapScore 1', confirmedCandidate?.gapScore === 1]);
  checks.push(['an inferred-title candidate with the same (no) graph match scores lower (the 0.8 penalty)', inferredCandidate?.gapScore === 0.8]);
  checks.push(['the confirmed-title candidate is preferred over the inferred one when otherwise tied', inferredPenaltyResult.selected?.date === '2026-01-01']);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1.5 — history-ledger filtering actually removes a candidate
// ---------------------------------------------------------------------------

function runLedgerFilterCheck(db, catalogText) {
  console.log('\n=== Part 1.5: history-ledger filtering ===\n');
  const checks = [];

  const withoutHistory = selectTopic(db, { catalogText, history: [] });
  const someUsedTitle = withoutHistory.candidates[0].title;

  const withHistory = selectTopic(db, {
    catalogText,
    history: [{ nanyangTitle: someUsedTitle, slug: 'whatever-slug', publishedAt: '2026-01-01T00:00:00Z' }],
  });

  checks.push(['a title present in the history ledger is excluded from `candidates` entirely', !withHistory.candidates.some((c) => c.title === someUsedTitle)]);
  checks.push(['usedFilteredCount reflects exactly the one filtered title', withHistory.usedFilteredCount === 1]);
  checks.push(['the selection still picks something else (still 22 other eligible candidates)', withHistory.selected !== null && withHistory.selected.title !== someUsedTitle]);
  checks.push(['history matching is case/whitespace-insensitive', selectTopic(db, { catalogText, history: [{ nanyangTitle: `  ${someUsedTitle.toUpperCase()}  `, slug: 'x', publishedAt: '2026-01-01T00:00:00Z' }] }).usedFilteredCount === 1]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — CLI-level: select-topic.js subprocess
// ---------------------------------------------------------------------------

function runCli(extraArgs) {
  try {
    const stdout = execFileSync('node', ['--no-warnings', 'select-topic.js', ...extraArgs], { cwd: __dirname, encoding: 'utf-8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function runPart2() {
  console.log('\n=== Part 2: CLI-level (select-topic.js subprocess) ===\n');
  const checks = [];

  const emptyHistoryPath = path.join(SELECT_TOPIC_DIR, 'cli-empty-history.json');
  writeFileSync(emptyHistoryPath, '[]', 'utf-8');

  const run = runCli(['--db', ORIGINAL_DB, '--catalog', REAL_CATALOG_PATH, '--history', emptyHistoryPath, '--json']);
  console.log('--- CLI stdout ---\n' + run.stdout);
  checks.push(['CLI: exits 0 when a topic is selected', run.exitCode === 0]);

  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // leave parsed null — the next assertion fails and reports it
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: --json output has a selected topic with a candidateSlug', typeof parsed?.selected?.candidateSlug === 'string' && parsed.selected.candidateSlug.length > 0]);
  checks.push(['CLI: --json output carries the full ranked candidates list', Array.isArray(parsed?.candidates) && parsed.candidates.length === parsed?.totalCatalogSize]);

  // --mark-used: real subprocess run against a real (empty) temp ledger —
  // must write the entry, then a SECOND run against the now-updated ledger
  // must no longer pick the same topic.
  const markUsedHistoryPath = path.join(SELECT_TOPIC_DIR, 'cli-mark-used-history.json');
  writeFileSync(markUsedHistoryPath, '[]', 'utf-8');
  const firstRun = runCli(['--db', ORIGINAL_DB, '--catalog', REAL_CATALOG_PATH, '--history', markUsedHistoryPath, '--mark-used', '--json']);
  checks.push(['CLI --mark-used: exits 0', firstRun.exitCode === 0]);
  let firstParsed = null;
  try {
    firstParsed = JSON.parse(firstRun.stdout);
  } catch {
    // leave null
  }
  const ledgerAfterMarkUsed = JSON.parse(readFileSync(markUsedHistoryPath, 'utf-8'));
  checks.push(['CLI --mark-used: the ledger file now has exactly 1 entry', ledgerAfterMarkUsed.length === 1]);
  checks.push(['CLI --mark-used: the ledger entry records the topic that was actually selected', ledgerAfterMarkUsed[0]?.nanyangTitle === firstParsed?.selected?.title]);

  const secondRun = runCli(['--db', ORIGINAL_DB, '--catalog', REAL_CATALOG_PATH, '--history', markUsedHistoryPath, '--json']);
  let secondParsed = null;
  try {
    secondParsed = JSON.parse(secondRun.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: a second run against the now-updated ledger picks a DIFFERENT topic', secondParsed?.selected?.title !== firstParsed?.selected?.title]);
  checks.push(['CLI: the second run\'s usedFilteredCount reflects the one now-used title', secondParsed?.usedFilteredCount === 1]);

  // Exhausted-catalog abort path, end-to-end through the CLI: a tiny
  // single-entry catalog whose one entry is already in the history ledger.
  const tinyCatalogPath = path.join(SELECT_TOPIC_DIR, 'cli-tiny-catalog.md');
  writeFileSync(tinyCatalogPath, `## Section\n- **2024-01-01 — Only Entry (Only Entry English)**\n  - URL: https://example.com/1\n`, 'utf-8');
  const tinyHistoryPath = path.join(SELECT_TOPIC_DIR, 'cli-tiny-history.json');
  writeFileSync(
    tinyHistoryPath,
    JSON.stringify([{ nanyangTitle: 'Only Entry (Only Entry English)', slug: 'only-entry', publishedAt: '2026-01-01T00:00:00Z' }]),
    'utf-8'
  );
  const exhaustedRun = runCli(['--db', ORIGINAL_DB, '--catalog', tinyCatalogPath, '--history', tinyHistoryPath, '--json']);
  checks.push(['CLI: exhausted catalog (everything already used) exits non-zero', exhaustedRun.exitCode !== 0]);
  let exhaustedParsed = null;
  try {
    exhaustedParsed = JSON.parse(exhaustedRun.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: exhausted-catalog --json output has selected: null with a clear reason', exhaustedParsed?.selected === null && typeof exhaustedParsed?.reason === 'string' && exhaustedParsed.reason.length > 0]);

  // --mark-used with nothing selected must fail loudly, not silently no-op.
  const markUsedNoSelectionRun = runCli(['--db', ORIGINAL_DB, '--catalog', tinyCatalogPath, '--history', tinyHistoryPath, '--mark-used']);
  checks.push(['CLI: --mark-used with no eligible topic exits non-zero with a clear error', markUsedNoSelectionRun.exitCode !== 0 && /nothing to record/i.test(markUsedNoSelectionRun.stderr)]);

  // A missing catalog file fails loudly.
  const missingCatalogRun = runCli(['--db', ORIGINAL_DB, '--catalog', path.join(SELECT_TOPIC_DIR, 'nonexistent.md'), '--history', emptyHistoryPath]);
  checks.push(['CLI: a missing --catalog file exits non-zero with a clear error', missingCatalogRun.exitCode !== 0 && /not found/i.test(missingCatalogRun.stderr)]);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(SELECT_TOPIC_DIR, { recursive: true });
  if (!existsSync(ORIGINAL_DB)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, ORIGINAL_DB)} — run \`npm run extract\` first.`);
  }
  if (!existsSync(REAL_CATALOG_PATH)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, REAL_CATALOG_PATH)}.`);
  }
  const catalogText = readFileSync(REAL_CATALOG_PATH, 'utf-8');

  const checks = [...runCatalogParseCheck(catalogText), ...runHistoryLedgerCheck()];

  const db = new DatabaseSync(ORIGINAL_DB, { readOnly: true });
  try {
    checks.push(...runSelectionCheck(db, catalogText));
    checks.push(...runLedgerFilterCheck(db, catalogText));
  } finally {
    db.close();
  }

  checks.push(...runPart2());

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
