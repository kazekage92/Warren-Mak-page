#!/usr/bin/env node
/**
 * Validation harness for graph-blocks.js — no LLM/fixture-dir involved
 * (pure string/DOM transforms), matching validate-extract-articles.js's own
 * no-fixture-needed precedent for pure-data scripts.
 *
 * Proves, function-level and CLI-level:
 *   1. buildFlowGraphHtml() produces the expected `.graph-block--flow` shape
 *      (one <li> per step, HTML-escaped title/labels, the "hand-authored"
 *      comment convention preserved).
 *   2. validateGraphSteps() accepts 2-5 non-empty labels, rejects too few,
 *      too many, non-array, and blank/whitespace-only entries.
 *   3. insertGraphIntoBody() picks the first <h2> at or past the body's
 *      text midpoint; falls back to the last <h2> when none qualifies;
 *      falls back to appending at the end when there is no <h2> at all or
 *      no measurable text.
 *   4. At the CLI level: --title/--step(s) round-trip through --json output,
 *      and --body-file actually merges the graph into the given body.
 *
 * Usage: node validate-graph-blocks.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFlowGraphHtml, validateGraphSteps, insertGraphIntoBody } from './graph-blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function checks_buildFlowGraphHtml() {
  const checks = [];

  const html = buildFlowGraphHtml('How to Manage Risk', ['Set stop-losses', 'Size the position', 'Check IV']);
  checks.push(['starts with the hand-authored comment convention', html.startsWith('<!-- graph block: hand-authored, do not edit via admin WYSIWYG -->')]);
  checks.push(['carries the flow figure + figcaption + ordered list classes', html.includes('graph-block graph-block--flow') && html.includes('graph-flow graph-flow--steps')]);
  checks.push(['emits exactly one <li> per step', (html.match(/<li class="graph-flow__step">/g) || []).length === 3]);
  checks.push(['title appears in the figcaption', html.includes('<figcaption class="graph-block__title">How to Manage Risk</figcaption>')]);

  const escaped = buildFlowGraphHtml('Risk & "Reward" <Explained>', ['Step one & two', 'Quote "this" step']);
  checks.push(['escapes & < > in the title', escaped.includes('Risk &amp; "Reward" &lt;Explained&gt;')]);
  checks.push(['escapes & in a step label', escaped.includes('Step one &amp; two')]);
  checks.push(['does NOT escape quotes (matches admin escapeHtml, which only handles & < >)', escaped.includes('Quote "this" step')]);

  const empty = buildFlowGraphHtml('No Steps', []);
  checks.push(['zero steps produces an empty <ol> rather than throwing', empty.includes('<ol class="graph-flow graph-flow--steps"></ol>')]);

  return checks;
}

function checks_validateGraphSteps() {
  const checks = [];
  checks.push(['accepts 2 non-empty labels', !throws(() => validateGraphSteps(['a', 'b']))]);
  checks.push(['accepts 5 non-empty labels', !throws(() => validateGraphSteps(['a', 'b', 'c', 'd', 'e']))]);
  checks.push(['rejects 1 label (below minimum)', throws(() => validateGraphSteps(['only one']))]);
  checks.push(['rejects 6 labels (above maximum)', throws(() => validateGraphSteps(['a', 'b', 'c', 'd', 'e', 'f']))]);
  checks.push(['rejects a non-array', throws(() => validateGraphSteps('not an array'))]);
  checks.push(['rejects a blank/whitespace-only label', throws(() => validateGraphSteps(['a', '   ']))]);
  checks.push(['rejects a non-string label', throws(() => validateGraphSteps(['a', 42]))]);
  return checks;
}

function checks_insertGraphIntoBody() {
  const checks = [];
  const GRAPH = '<!-- graph block: hand-authored, do not edit via admin WYSIWYG -->TESTGRAPH';

  // Four headings (A/B/C/D), sized so the running plain-text total crosses the
  // midpoint exactly at C -- proves the loop stops at the FIRST qualifying h2
  // rather than always falling through to the last one (D).
  const fourHeadingBody =
    '<h2>A</h2><p>' + 'a'.repeat(300) + '</p>' +
    '<h2>B</h2><p>' + 'b'.repeat(10) + '</p>' +
    '<h2>C</h2><p>' + 'c'.repeat(10) + '</p>' +
    '<h2>D</h2><p>' + 'd'.repeat(300) + '</p>';
  const fourResult = insertGraphIntoBody(fourHeadingBody, GRAPH);
  checks.push(['inserts right after the first h2 whose start crosses the midpoint (C, not D)', fourResult.includes('<h2>C</h2>' + GRAPH) && !fourResult.includes('<h2>D</h2>' + GRAPH)]);
  checks.push(['graph appears exactly once', (fourResult.match(/TESTGRAPH/g) || []).length === 1]);

  // A single h2 right at the very start, with all the real content after it --
  // no h2 "starts past the midpoint", so the fallback (last h2) is used, which is
  // also the only h2 that exists.
  const earlyOnlyBody = '<h2>Only Heading</h2><p>' + 'y'.repeat(1000) + '</p>';
  const earlyResult = insertGraphIntoBody(earlyOnlyBody, GRAPH);
  checks.push(['falls back to the only/last h2 when none starts past the midpoint', earlyResult.startsWith('<h2>Only Heading</h2>' + GRAPH)]);

  // No h2 at all -- appended at the very end, not guessed mid-string.
  const noHeadingBody = '<p>Just a paragraph, no headings at all.</p>';
  const noHeadingResult = insertGraphIntoBody(noHeadingBody, GRAPH);
  checks.push(['appends at the end when the body has no h2', noHeadingResult === noHeadingBody + GRAPH]);

  // Empty body -- no measurable text, appended (not thrown).
  checks.push(['handles an empty body without throwing', !throws(() => insertGraphIntoBody('', GRAPH)) && insertGraphIntoBody('', GRAPH) === GRAPH]);

  return checks;
}

function runCli(args) {
  try {
    const stdout = execFileSync('node', ['--no-warnings', 'graph-blocks.js', ...args], { cwd: __dirname, encoding: 'utf-8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function checks_cli() {
  const checks = [];

  const run = runCli(['--title', 'How to Manage Risk', '--step', 'Set stop-losses', '--step', 'Size the position', '--json']);
  checks.push(['CLI: exits 0 with 2 well-formed steps', run.exitCode === 0]);
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // leave parsed null -- next assertion reports the failure
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: --json output steps round-trip', parsed?.steps?.length === 2]);
  checks.push(['CLI: --json output graphHtml matches buildFlowGraphHtml()', parsed?.graphHtml === buildFlowGraphHtml('How to Manage Risk', ['Set stop-losses', 'Size the position'])]);

  const missingTitle = runCli(['--step', 'Only a step']);
  checks.push(['CLI: missing --title exits non-zero', missingTitle.exitCode !== 0]);

  const tooFewSteps = runCli(['--title', 'Not Enough Steps', '--step', 'Only one']);
  checks.push(['CLI: fewer than 2 steps exits non-zero', tooFewSteps.exitCode !== 0]);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const bodyFile = path.join(OUTPUT_DIR, 'graph-blocks-body-fixture.html');
  writeFileSync(bodyFile, '<h2>Intro</h2><p>Short.</p><h2>Main</h2><p>' + 'z'.repeat(300) + '</p>', 'utf-8');
  const bodyRun = runCli(['--title', 'Merged', '--step', 'One', '--step', 'Two', '--body-file', bodyFile, '--json']);
  checks.push(['CLI: exits 0 with --body-file', bodyRun.exitCode === 0]);
  let bodyParsed = null;
  try {
    bodyParsed = JSON.parse(bodyRun.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: --body-file output contains both the original body and the graph', !!bodyParsed?.bodyHtml?.includes('<h2>Main</h2>') && !!bodyParsed?.bodyHtml?.includes('graph-block--flow')]);

  return checks;
}

async function main() {
  const checks = [
    ...checks_buildFlowGraphHtml(),
    ...checks_validateGraphSteps(),
    ...checks_insertGraphIntoBody(),
    ...checks_cli(),
  ];

  console.log('=== Results ===');
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
