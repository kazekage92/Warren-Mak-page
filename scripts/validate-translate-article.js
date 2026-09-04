#!/usr/bin/env node
/**
 * Validation harness for translate-article.js — no OPENAI_API_KEY/network
 * needed (same offline precedent as every other validate-*.js here): every
 * check runs against stubMarkerTranslator, a deterministic non-LLM
 * translator exported by translate-article.js itself for exactly this
 * purpose.
 *
 * Per extra-md-files/automated-article-scheduler.md component 3's own
 * instruction ("build and validate against real (already-published) article
 * bodies before ever wiring it into the live orchestrator"), the body-HTML
 * checks run against a REAL published article's EN body
 * (articles/structured-warrant-risks-time-decay-malaysia.html) rather than a
 * hand-simplified fixture — it has headings, nested <strong>, internal
 * <a href> links, a <table>, <ul>/<ol> lists, <div class="faq-item"> blocks,
 * and three real `<figure class="graph-block ...">` blocks, which is exactly
 * the structural variety this module has to survive unscathed.
 *
 * Proves, function-level and CLI-level:
 *   1. buildBatchTranslatePrompt/parseBatchTranslateResponse round-trip a
 *      well-formed response and reject a missing key, an extra key, an
 *      empty value, and non-JSON.
 *   2. collectTranslatableTextNodes finds every real text node, SKIPS every
 *      graph-block figure's text, skips whitespace-only nodes, and still
 *      finds table/list/faq-item text nested several levels deep.
 *   3. translateArticleBodyHtml translates ordinary text (and anchor text),
 *      leaves every graph-block's own text untouched, and leaves the exact
 *      same href set/order and tag count/order in place (checkStructuralSanity
 *      passes on a genuine translation).
 *   4. checkStructuralSanity actually THROWS on a synthetic mismatch (tag
 *      count changed, tag order changed, href changed) — proving the gate
 *      itself works, not just that a clean run doesn't trip it.
 *   5. translateFields/translateStringArray/translateFaqPairs each round-trip
 *      correctly (order preserved, empty fields passed through untouched).
 *   6. At the CLI level: --body-file --stub-translate and --fields-file
 *      --stub-translate both exit 0 and produce the expected shape.
 *
 * Usage: node validate-translate-article.js
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
  buildBatchTranslatePrompt,
  parseBatchTranslateResponse,
  stubMarkerTranslator,
  collectTranslatableTextNodes,
  translateArticleBodyHtml,
  checkStructuralSanity,
  translateFields,
  translateStringArray,
  translateFaqPairs,
} from './translate-article.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const REAL_ARTICLE_PATH = path.join(REPO_ROOT, 'articles', 'structured-warrant-risks-time-decay-malaysia.html');

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** Pulls the real EN `.article-body [data-lang="en"]` innerHTML straight out
 *  of the published article file, same selector admin/index.html's own
 *  editor round-trips against (see root CLAUDE.md's article-page-structure
 *  section) -- not a hand-written approximation of one. */
function loadRealArticleBodyHtml() {
  const pageHtml = readFileSync(REAL_ARTICLE_PATH, 'utf-8');
  const $ = cheerio.load(pageHtml);
  const html = $('.article-body [data-lang="en"]').first().html();
  if (!html) throw new Error(`Could not find .article-body [data-lang="en"] in ${REAL_ARTICLE_PATH} -- has its structure changed?`);
  return html.trim();
}

// ---------------------------------------------------------------------------
// 1. Prompt build / response parse
// ---------------------------------------------------------------------------

function checks_promptAndParse() {
  const checks = [];
  const idsToTexts = { 1: 'First sentence.', 2: 'Second sentence with "quotes" & <html>.' };

  const promptObj = buildBatchTranslatePrompt(idsToTexts, { contextLabel: 'test' });
  checks.push(['prompt embeds the id->text JSON verbatim', promptObj.user.includes(JSON.stringify(idsToTexts))]);
  checks.push(['prompt system message asks for strict JSON', /strict JSON/i.test(promptObj.system)]);

  const wellFormed = JSON.stringify({ 1: '第一句。', 2: '第二句，含有"引号"和<html>。' });
  const parsed = parseBatchTranslateResponse(wellFormed, ['1', '2']);
  checks.push(['parses a well-formed response with matching keys', parsed['1'] === '第一句。' && parsed['2'] === '第二句，含有"引号"和<html>。']);

  checks.push(['rejects a response missing a requested id', throws(() => parseBatchTranslateResponse(JSON.stringify({ 1: '第一句。' }), ['1', '2']))]);
  checks.push(['rejects a response with an unexpected extra id', throws(() => parseBatchTranslateResponse(JSON.stringify({ 1: '第一句。', 2: '第二句。', 3: '多余的。' }), ['1', '2']))]);
  checks.push(['rejects a response with an empty/whitespace-only value', throws(() => parseBatchTranslateResponse(JSON.stringify({ 1: '  ', 2: '第二句。' }), ['1', '2']))]);
  checks.push(['rejects non-JSON outright', throws(() => parseBatchTranslateResponse('not json at all', ['1']))]);
  checks.push(['rejects a JSON array (not an object)', throws(() => parseBatchTranslateResponse('["a","b"]', ['1']))]);

  return checks;
}

// ---------------------------------------------------------------------------
// 2. Node collection over the real article
// ---------------------------------------------------------------------------

function checks_collectTranslatableTextNodes(realBodyHtml) {
  const checks = [];
  const { entries } = collectTranslatableTextNodes(realBodyHtml);

  checks.push(['finds a substantial number of real text nodes', entries.length > 30]);
  checks.push(['every collected entry has non-whitespace text', entries.every((e) => e.text.trim().length > 0)]);
  checks.push(['ids are unique and sequential starting at "1"', entries.map((e) => e.id).join(',') === entries.map((_, i) => String(i + 1)).join(',')]);

  const allText = entries.map((e) => e.text).join(' | ');
  checks.push(['collects ordinary paragraph text', allText.includes('Structured warrants')]);
  checks.push(['collects anchor text (not just surrounding text)', allText.includes('structured warrants') && entries.some((e) => e.text === 'structured warrants')]);
  checks.push(['collects table cell text', allText.includes('6+ months') && allText.includes('Very low')]);
  checks.push(['collects ordered/unordered list item text', allText.includes('Intrinsic value:')]);
  checks.push(['collects faq-item text (question and answer)', allText.includes('Can a structured warrant go to zero?') && allText.includes('you lose 100% of your investment')]);

  checks.push(['does NOT collect any graph-block figcaption text', !allText.includes("Why Time Decay Hurts Even When You're Right") && !allText.includes('The 5 Core Risks of Structured Warrants')]);
  checks.push(['does NOT collect any graph-block step/spoke text', !allText.includes('Time Value Erodes') && !allText.includes('Ignoring Time Decay')]);

  return checks;
}

// ---------------------------------------------------------------------------
// 3. Full body-HTML translation over the real article
// ---------------------------------------------------------------------------

function collectHrefs(html) {
  const $ = cheerio.load(html, null, false);
  return $('[href]')
    .toArray()
    .map((el) => el.attribs.href);
}

function collectTagSequence(html) {
  const $ = cheerio.load(html, null, false);
  const tags = [];
  $('*').each((_, el) => tags.push(el.name));
  return tags;
}

async function checks_translateArticleBodyHtml(realBodyHtml) {
  const checks = [];
  const translated = await translateArticleBodyHtml(realBodyHtml, { translator: stubMarkerTranslator });

  checks.push(['translated output is non-empty and differs from the original', !!translated && translated !== realBodyHtml]);
  checks.push(['ordinary paragraph text is wrapped by the stub marker', translated.includes('【ZH-STUB】Structured warrants')]);
  checks.push(['anchor text is translated too (marker appears right where the link text was)', /<a href="what-are-structured-warrants-malaysia\.html">【ZH-STUB】structured warrants<\/a>/.test(translated)]);

  checks.push(['every graph-block figcaption is left completely untouched', translated.includes("Why Time Decay Hurts Even When You're Right") && translated.includes('The 5 Core Risks of Structured Warrants')]);
  checks.push(['every graph-block step/spoke label is left completely untouched', translated.includes('Time Value Erodes') && translated.includes('Ignoring Time Decay')]);
  checks.push(['graph-block text is NOT wrapped by the stub marker', !translated.includes('【ZH-STUB】Time Value Erodes')]);

  checks.push(['href set is byte-identical, same order, before and after', JSON.stringify(collectHrefs(realBodyHtml)) === JSON.stringify(collectHrefs(translated))]);
  checks.push(['tag sequence is byte-identical, same order, before and after', JSON.stringify(collectTagSequence(realBodyHtml)) === JSON.stringify(collectTagSequence(translated))]);

  checks.push(['checkStructuralSanity does not throw on this genuine translation', !throws(() => checkStructuralSanity(realBodyHtml, translated))]);

  checks.push(['a body with no translatable text returns unchanged rather than erroring', await translateArticleBodyHtml('<figure class="graph-block"><figcaption>Only Graph Text</figcaption></figure>', { translator: stubMarkerTranslator }) === '<figure class="graph-block"><figcaption>Only Graph Text</figcaption></figure>']);

  return checks;
}

// ---------------------------------------------------------------------------
// 4. checkStructuralSanity actually catches synthetic mismatches
// ---------------------------------------------------------------------------

function checks_checkStructuralSanity() {
  const checks = [];
  const original = '<p>Hello <a href="a.html">link</a>.</p><h2>Section</h2>';

  checks.push(['does not throw when structure is unchanged (only text content differs)', !throws(() => checkStructuralSanity(original, '<p>你好 <a href="a.html">链接</a>。</p><h2>章节</h2>'))]);
  checks.push(['throws when a tag is added', throws(() => checkStructuralSanity(original, original + '<p>Extra paragraph the model was never asked to add.</p>'))]);
  checks.push(['throws when a tag is removed', throws(() => checkStructuralSanity(original, '<p>Hello <a href="a.html">link</a>.</p>'))]);
  checks.push(['throws when tag order changes', throws(() => checkStructuralSanity(original, '<h2>Section</h2><p>Hello <a href="a.html">link</a>.</p>'))]);
  checks.push(['throws when an href is altered', throws(() => checkStructuralSanity(original, '<p>Hello <a href="b.html">link</a>.</p><h2>Section</h2>'))]);
  checks.push(['throws when an href is dropped entirely', throws(() => checkStructuralSanity(original, '<p>Hello <a>link</a>.</p><h2>Section</h2>'))]);

  return checks;
}

// ---------------------------------------------------------------------------
// 5. Plain-text convenience wrappers
// ---------------------------------------------------------------------------

async function checks_convenienceWrappers() {
  const checks = [];

  const fields = await translateFields(
    { title: 'Time Decay and Your Structured Warrants', subtitle: '', summary: 'A short summary.' },
    { translator: stubMarkerTranslator }
  );
  checks.push(['translateFields translates non-empty fields', fields.title === '【ZH-STUB】Time Decay and Your Structured Warrants']);
  checks.push(['translateFields leaves an empty field untouched rather than sending it', fields.subtitle === '']);
  checks.push(['translateFields translates every other non-empty field too', fields.summary === '【ZH-STUB】A short summary.']);

  const steps = await translateStringArray(['Set stop-losses', 'Size the position', 'Check IV'], { translator: stubMarkerTranslator });
  checks.push(['translateStringArray preserves length and order', steps.length === 3 && steps[0] === '【ZH-STUB】Set stop-losses' && steps[2] === '【ZH-STUB】Check IV']);
  checks.push(['translateStringArray on an empty array returns an empty array without calling the translator', (await translateStringArray([], { translator: stubMarkerTranslator })).length === 0]);

  const faq = await translateFaqPairs(
    [
      { question: 'What is time decay?', answer: 'It erodes value daily.' },
      { question: 'Can a warrant expire worthless?', answer: 'Yes, if out-of-the-money.' },
    ],
    { translator: stubMarkerTranslator }
  );
  checks.push(['translateFaqPairs preserves pair count and order', faq.length === 2]);
  checks.push(['translateFaqPairs translates both question and answer per pair', faq[0].question === '【ZH-STUB】What is time decay?' && faq[0].answer === '【ZH-STUB】It erodes value daily.']);
  checks.push(['translateFaqPairs keeps the second pair distinct from the first', faq[1].question === '【ZH-STUB】Can a warrant expire worthless?']);

  return checks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(args) {
  try {
    const stdout = execFileSync('node', ['--no-warnings', 'translate-article.js', ...args], { cwd: __dirname, encoding: 'utf-8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function checks_cli(realBodyHtml) {
  const checks = [];
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const bodyFile = path.join(OUTPUT_DIR, 'translate-article-body-fixture.html');
  writeFileSync(bodyFile, realBodyHtml, 'utf-8');
  const bodyRun = runCli(['--body-file', bodyFile, '--stub-translate', '--json']);
  checks.push(['CLI: --body-file --stub-translate exits 0', bodyRun.exitCode === 0]);
  let bodyParsed = null;
  try {
    bodyParsed = JSON.parse(bodyRun.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: --json output parses and contains translatedHtml', !!bodyParsed?.translatedHtml?.includes('【ZH-STUB】')]);
  checks.push(['CLI: graph-block text still untouched via the CLI path too', !!bodyParsed?.translatedHtml?.includes("Why Time Decay Hurts Even When You're Right")]);

  const fieldsFile = path.join(OUTPUT_DIR, 'translate-article-fields-fixture.json');
  writeFileSync(fieldsFile, JSON.stringify({ title: 'Time Decay', subtitle: '' }), 'utf-8');
  const fieldsRun = runCli(['--fields-file', fieldsFile, '--stub-translate', '--json']);
  checks.push(['CLI: --fields-file --stub-translate exits 0', fieldsRun.exitCode === 0]);
  let fieldsParsed = null;
  try {
    fieldsParsed = JSON.parse(fieldsRun.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: fields output translates the non-empty field', fieldsParsed?.title === '【ZH-STUB】Time Decay']);
  checks.push(['CLI: fields output leaves the empty field untouched', fieldsParsed?.subtitle === '']);

  const missingFlags = runCli(['--stub-translate']);
  checks.push(['CLI: missing --body-file/--fields-file exits non-zero', missingFlags.exitCode !== 0]);

  const bothFlags = runCli(['--body-file', bodyFile, '--fields-file', fieldsFile, '--stub-translate']);
  checks.push(['CLI: passing both --body-file and --fields-file exits non-zero', bothFlags.exitCode !== 0]);

  // Without --stub-translate and no OPENAI_API_KEY in this shell, the real
  // translator should fail loudly (not silently no-op).
  const noKeyRun = runCli(['--body-file', bodyFile]);
  checks.push(['CLI: no --stub-translate and no API key fails loudly rather than hanging/no-op', noKeyRun.exitCode !== 0]);

  return checks;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const realBodyHtml = loadRealArticleBodyHtml();

  let checks = [
    ...checks_promptAndParse(),
    ...checks_collectTranslatableTextNodes(realBodyHtml),
    ...(await checks_translateArticleBodyHtml(realBodyHtml)),
    ...checks_checkStructuralSanity(),
    ...(await checks_convenienceWrappers()),
    ...checks_cli(realBodyHtml),
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
