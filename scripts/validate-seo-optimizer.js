#!/usr/bin/env node
/**
 * Validation harness for seo-optimizer.js — same fixture-injection spirit as
 * validate-generate-article.js (extra-md-files/pipeline-phase-4-6-7-1-mvp.md
 * §2's own instruction: "No OPENAI_API_KEY/network needed").
 *
 * Builds the checklist straight out of the real hand-authored sample db
 * (admin/knowledge-graph.db, read-only) via generateSeoMetadata() itself, so
 * the fixture only has to satisfy the response SHAPE, not any particular
 * checklist content.
 *
 * Proves, function-level and CLI-level:
 *   1. A well-formed fixture round-trips through generateSeoMetadata() with
 *      every required field present and correctly typed/shaped.
 *   2. parseSeoResponse rejects a response missing a required string field.
 *   3. parseSeoResponse rejects a response missing a required array field.
 *   4. parseSeoResponse rejects a malformed heading entry (bad level / empty text).
 *   5. parseSeoResponse rejects a malformed faq entry (missing question/answer).
 *   6. parseSeoResponse rejects non-JSON.
 *   7. At the CLI level: --json output round-trips the same shape and exits 0.
 *
 * Usage: node validate-seo-optimizer.js
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateSeoMetadata, parseSeoResponse, fixtureSeoWriter } from './seo-optimizer.js';
import { slugifyTopic } from './generate-article.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const SEO_FIXTURE_DIR = path.join(OUTPUT_DIR, 'seo-fixtures');
const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');

const TOPIC = 'Time Decay';
const TITLE = 'Time Decay and Your Structured Warrants';
const BODY_TEXT =
  'Time decay (theta) erodes a structured warrant\'s value as expiry approaches. Traders who hold ' +
  'warrants too close to expiry often see returns eaten away by this effect, even if the underlying ' +
  'moves in their favour. Understanding implied volatility alongside time decay helps traders time ' +
  'entries and exits more effectively on Bursa Malaysia.';

function wellFormedSeoResponse() {
  return {
    seoTitle: 'Time Decay in Structured Warrants Malaysia | Guide',
    metaDescription: 'Learn how time decay (theta) affects structured warrants on Bursa Malaysia and how to time your trades around it.',
    urlSlug: 'time-decay-structured-warrants-malaysia',
    ogTitle: 'Time Decay and Structured Warrants: What Traders Must Know',
    ogDescription: 'A practical guide to time decay (theta) in Bursa Malaysia structured warrants.',
    primaryKeywords: ['time decay structured warrants'],
    secondaryKeywords: ['theta decay malaysia', 'structured warrant expiry'],
    longTailKeywords: ['how does time decay affect structured warrants in malaysia'],
    headings: [
      { level: 2, text: 'What Is Time Decay?' },
      { level: 3, text: 'How Theta Erodes Warrant Value' },
    ],
    faq: [
      { question: 'What is time decay in structured warrants?', answer: 'Time decay is the erosion of a warrant\'s value as it approaches expiry.' },
      { question: 'How can traders manage time decay?', answer: 'By avoiding holding warrants too close to expiry and monitoring implied volatility.' },
    ],
  };
}

function checks_wellFormed() {
  const checks = [];
  const parsed = parseSeoResponse(JSON.stringify(wellFormedSeoResponse()));
  checks.push(['well-formed response parses without throwing', !!parsed]);
  checks.push(['seoTitle is a trimmed non-empty string', typeof parsed.seoTitle === 'string' && parsed.seoTitle.length > 0]);
  checks.push(['primaryKeywords is a non-empty array', Array.isArray(parsed.primaryKeywords) && parsed.primaryKeywords.length > 0]);
  checks.push(['headings entries carry level + text', parsed.headings.every((h) => typeof h.level === 'number' && typeof h.text === 'string')]);
  checks.push(['faq entries carry question + answer', parsed.faq.every((f) => typeof f.question === 'string' && typeof f.answer === 'string')]);
  return checks;
}

function checks_malformed() {
  const checks = [];

  const missingString = wellFormedSeoResponse();
  delete missingString.metaDescription;
  checks.push(['rejects a response missing a required string field', throws(() => parseSeoResponse(JSON.stringify(missingString)))]);

  const emptyString = { ...wellFormedSeoResponse(), seoTitle: '   ' };
  checks.push(['rejects a required string field that is only whitespace', throws(() => parseSeoResponse(JSON.stringify(emptyString)))]);

  const missingArray = wellFormedSeoResponse();
  delete missingArray.faq;
  checks.push(['rejects a response missing a required array field', throws(() => parseSeoResponse(JSON.stringify(missingArray)))]);

  const emptyArray = { ...wellFormedSeoResponse(), primaryKeywords: [] };
  checks.push(['rejects a required array field that is empty', throws(() => parseSeoResponse(JSON.stringify(emptyArray)))]);

  const badHeadingLevel = { ...wellFormedSeoResponse(), headings: [{ level: 1, text: 'Bad H1 -- template already supplies this' }] };
  checks.push(['rejects a heading with an out-of-range level (1 or 5+)', throws(() => parseSeoResponse(JSON.stringify(badHeadingLevel)))]);

  const badHeadingText = { ...wellFormedSeoResponse(), headings: [{ level: 2, text: '' }] };
  checks.push(['rejects a heading with empty text', throws(() => parseSeoResponse(JSON.stringify(badHeadingText)))]);

  const badFaq = { ...wellFormedSeoResponse(), faq: [{ question: 'Only a question, no answer' }] };
  checks.push(['rejects a faq entry missing an answer', throws(() => parseSeoResponse(JSON.stringify(badFaq)))]);

  checks.push(['rejects non-JSON raw text outright', throws(() => parseSeoResponse('not json at all'))]);

  return checks;
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function checks_functionLevel(db) {
  const checks = [];
  mkdirSync(SEO_FIXTURE_DIR, { recursive: true });
  const fixturePath = path.join(SEO_FIXTURE_DIR, `${slugifyTopic(TOPIC)}.json`);
  writeFileSync(fixturePath, JSON.stringify(wellFormedSeoResponse()), 'utf-8');

  const seoWriter = (promptObj, opts) => fixtureSeoWriter(promptObj, { fixtureDir: SEO_FIXTURE_DIR, topic: opts.topic });
  const result = await generateSeoMetadata({ db, topic: TOPIC, title: TITLE, bodyText: BODY_TEXT, seoWriter });

  checks.push(['generateSeoMetadata() returns metadata with all required fields', !!(result.metadata && result.metadata.seoTitle && result.metadata.faq.length)]);
  checks.push(['generateSeoMetadata() carries the retrieval context through (checklist reused, not re-queried)', Array.isArray(result.retrievalContext.checklist)]);
  checks.push(['generateSeoMetadata() echoes topic/title back unchanged', result.topic === TOPIC && result.title === TITLE]);

  return checks;
}

function runCli(extraArgs) {
  try {
    const stdout = execFileSync('node', ['--no-warnings', 'seo-optimizer.js', '--db', ORIGINAL_DB, ...extraArgs], { cwd: __dirname, encoding: 'utf-8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function checks_cli() {
  const checks = [];
  const bodyFile = path.join(OUTPUT_DIR, 'seo-fixtures', 'body.txt');
  writeFileSync(bodyFile, BODY_TEXT, 'utf-8');

  const run = runCli(['--topic', TOPIC, '--title', TITLE, '--body-file', bodyFile, '--seo-fixture-dir', SEO_FIXTURE_DIR, '--json']);
  console.log('--- CLI stdout ---\n' + run.stdout);
  checks.push(['CLI: exits 0 against a well-formed fixture', run.exitCode === 0]);

  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // leave parsed null — next assertion reports the failure
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: --json output metadata.seoTitle matches the fixture', parsed?.metadata?.seoTitle === wellFormedSeoResponse().seoTitle]);
  checks.push(['CLI: --json output metadata.faq round-trips with the right length', parsed?.metadata?.faq?.length === wellFormedSeoResponse().faq.length]);

  // Missing required CLI args should fail loudly, not silently produce empty metadata.
  const missingTitleRun = runCli(['--topic', TOPIC, '--body-file', bodyFile, '--seo-fixture-dir', SEO_FIXTURE_DIR]);
  checks.push(['CLI: missing --title exits non-zero', missingTitleRun.exitCode !== 0]);

  return checks;
}

async function main() {
  if (!existsSync(ORIGINAL_DB)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, ORIGINAL_DB)} — run \`npm run extract\` first.`);
  }

  let checks = [...checks_wellFormed(), ...checks_malformed()];

  const db = new DatabaseSync(ORIGINAL_DB, { readOnly: true });
  try {
    checks = checks.concat(await checks_functionLevel(db));
  } finally {
    db.close();
  }

  checks = checks.concat(checks_cli());

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
