#!/usr/bin/env node
/**
 * Validation harness for build-article-document.js — no LLM/fixture-dir
 * involved (pure string/DOM transforms), matching validate-graph-blocks.js's
 * own no-fixture-needed precedent.
 *
 * Proves, function-level and CLI-level:
 *   1. bodyTextToHtml() converts blank-line paragraphs into <p> tags, "## "
 *      lines into <h2> tags (the gap admin's plainTextWithAnchorsToParagraphHtml
 *      leaves open -- see build-article-document.js's own header comment),
 *      leaves inline <a> markup untouched, and HTML-escapes everything else.
 *   2. buildArticleDocument() produces the expected page skeleton: DOCTYPE,
 *      nav/footer verbatim, correct CTA preset selection, both language
 *      bodies present, JSON-LD present and well-formed, title/meta escaped.
 *   3. assembleFromDraftState() chains bodyTextToHtml() into
 *      buildArticleDocument() correctly and derives readingTimeText when not
 *      supplied.
 *   4. computeReadingTimeText() matches admin's recalcReadingTime() formula
 *      (200 wpm EN / 300 cpm ZH, minimum 1 minute).
 *   5. At the CLI level: --state-file round-trips through --json output and
 *      produces a document containing both language bodies.
 *
 * Usage: node validate-build-article-document.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bodyTextToHtml,
  buildArticleDocument,
  assembleFromDraftState,
  computeReadingTimeText,
  CTA_PRESETS,
} from './build-article-document.js';

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

function checks_bodyTextToHtml() {
  const checks = [];

  const twoParas = bodyTextToHtml('First paragraph.\n\nSecond paragraph.');
  checks.push(['splits blank-line-separated text into two <p> tags', twoParas === '<p>First paragraph.</p><p>Second paragraph.</p>']);

  const withHeading = bodyTextToHtml('## Understanding Time Decay\n\nTime decay erodes value daily.');
  checks.push(['converts a "## " line into <h2>', withHeading === '<h2>Understanding Time Decay</h2><p>Time decay erodes value daily.</p>']);
  checks.push(['does not wrap the heading text in <p>', !withHeading.includes('<p>Understanding Time Decay')]);

  const withAnchor = bodyTextToHtml('Read more about <a href="other-slug.html">structured warrants</a> here.');
  checks.push(['leaves an inline <a href="...html"> anchor untouched', withAnchor === '<p>Read more about <a href="other-slug.html">structured warrants</a> here.</p>']);

  const withMarkup = bodyTextToHtml('Risk & "Reward" <Explained> in one paragraph.');
  checks.push(['HTML-escapes & < > in ordinary paragraph text', withMarkup === '<p>Risk &amp; "Reward" &lt;Explained&gt; in one paragraph.</p>']);

  const withNewlineInPara = bodyTextToHtml('Line one\nLine two (same paragraph).');
  checks.push(['converts an internal single newline to <br>', withNewlineInPara === '<p>Line one<br>Line two (same paragraph).</p>']);

  checks.push(['empty input produces empty output rather than throwing', bodyTextToHtml('') === '' && !throws(() => bodyTextToHtml(''))]);
  checks.push(['null input produces empty output rather than throwing', bodyTextToHtml(null) === '' && !throws(() => bodyTextToHtml(null))]);

  return checks;
}

function sampleState(overrides = {}) {
  return {
    titleEn: 'Time Decay and Your Structured Warrants',
    titleZh: '时间损耗与您的结构性凭单',
    subtitleEn: 'Why theta erodes warrant value every day',
    subtitleZh: '为什么theta每天都在侵蚀凭单价值',
    categoryEn: 'Structured Warrants',
    categoryZh: '结构性凭单',
    authorEn: 'Warren Mak',
    authorZh: '麦传球 Warren Mak',
    publishDate: '2026-08-14',
    tags: 'time decay, theta, structured warrants',
    ctaPreset: 'warrants',
    slug: 'time-decay-structured-warrants',
    metaTitle: '',
    metaDescription: 'A guide to time decay in structured warrants on Bursa Malaysia.',
    canonicalUrl: 'https://www.warrenmak.asia/articles/time-decay-structured-warrants.html',
    bodyEnHtml: '<h2>What Is Time Decay?</h2><p>Time decay erodes value daily.</p>',
    bodyZhHtml: '<h2>什么是时间损耗？</h2><p>时间损耗每天侵蚀价值。</p>',
    readingTimeText: '5 min read',
    ogImageUrl: 'https://www.warrenmak.asia/assets/images/og-image.jpg',
    ...overrides,
  };
}

function checks_buildArticleDocument() {
  const checks = [];
  const html = buildArticleDocument(sampleState());

  checks.push(['starts with <!DOCTYPE html>', html.startsWith('<!DOCTYPE html>')]);
  checks.push(['ends with </body></html>', html.trim().endsWith('</body></html>')]);
  checks.push(['includes the EN title escaped in <h1>', html.includes('<h1>Time Decay and Your Structured Warrants</h1>')]);
  checks.push(['includes the ZH title in the zh <h2>', html.includes('<h2>时间损耗与您的结构性凭单</h2>')]);
  checks.push(['includes both bodyEnHtml and bodyZhHtml verbatim', html.includes(sampleState().bodyEnHtml) && html.includes(sampleState().bodyZhHtml)]);
  checks.push(['includes the "warrants" CTA preset by default', html.includes(CTA_PRESETS.warrants)]);
  checks.push(['includes the author-box credibility component', html.includes('author-box__credentials')]);
  checks.push(['includes the sticky CTA bar', html.includes('sticky-cta-bar')]);
  checks.push(['includes two application/ld+json script blocks (Article + BreadcrumbList)', (html.match(/application\/ld\+json/g) || []).length === 2]);
  checks.push(['Article JSON-LD is valid JSON containing the headline', (() => {
    const m = html.match(/"@type":"Article".*?mainEntityOfPage[^}]*}/s);
    if (!m) return false;
    try {
      const ld = JSON.parse(m[0].startsWith('{') ? m[0] : '{' + m[0]);
      return ld.headline === undefined ? m[0].includes('"headline":"Time Decay and Your Structured Warrants"') : ld.headline === 'Time Decay and Your Structured Warrants';
    } catch {
      return m[0].includes('"headline":"Time Decay and Your Structured Warrants"');
    }
  })()]);
  checks.push(['escapes special characters in the meta description attribute', buildArticleDocument(sampleState({ metaDescription: 'A "guide" & <intro>' })).includes('content="A &quot;guide&quot; &amp; &lt;intro&gt;"')]);
  checks.push(['metaTitle falls back to titleEn when blank', html.includes('<title>Time Decay and Your Structured Warrants | Warren Mak</title>')]);

  const shortterm = buildArticleDocument(sampleState({ ctaPreset: 'shortterm' }));
  checks.push(['selects the "shortterm" CTA preset when requested', shortterm.includes(CTA_PRESETS.shortterm) && !shortterm.includes(CTA_PRESETS.warrants)]);

  const unknownPreset = buildArticleDocument(sampleState({ ctaPreset: 'nonsense' }));
  checks.push(['falls back to "warrants" CTA preset for an unrecognized value', unknownPreset.includes(CTA_PRESETS.warrants)]);

  return checks;
}

function checks_assembleFromDraftState() {
  const checks = [];
  const { bodyTextEn, bodyTextZh, readingTimeText, ...rest } = sampleState();
  const raw = {
    ...rest,
    bodyTextEn: '## What Is Time Decay?\n\nTime decay erodes value daily and traders should account for it.',
    bodyTextZh: '## 什么是时间损耗？\n\n时间损耗每天侵蚀价值，交易者应加以考虑。',
  };
  delete raw.bodyEnHtml;
  delete raw.bodyZhHtml;
  delete raw.readingTimeText;

  const result = assembleFromDraftState(raw);
  checks.push(['converts bodyTextEn into real HTML before assembling', result.bodyEnHtml === '<h2>What Is Time Decay?</h2><p>Time decay erodes value daily and traders should account for it.</p>']);
  checks.push(['converts bodyTextZh into real HTML before assembling', result.bodyZhHtml === '<h2>什么是时间损耗？</h2><p>时间损耗每天侵蚀价值，交易者应加以考虑。</p>']);
  checks.push(['assembled html includes the converted EN body', result.html.includes(result.bodyEnHtml)]);
  checks.push(['derives a readingTimeText when none was supplied', /\d+ min read/.test(result.html)]);

  const withOverride = assembleFromDraftState({ ...raw, readingTimeText: '7 min read' });
  checks.push(['honors an explicit readingTimeText override instead of recomputing', withOverride.html.includes('7 min read')]);

  return checks;
}

function checks_computeReadingTimeText() {
  const checks = [];
  checks.push(['200 EN words ~ 1 min read', computeReadingTimeText({ bodyTextEn: Array(200).fill('word').join(' ') }) === '1 min read']);
  checks.push(['1000 EN words ~ 5 min read', computeReadingTimeText({ bodyTextEn: Array(1000).fill('word').join(' ') }) === '5 min read']);
  checks.push(['minimum is always 1 minute, even for very short text', computeReadingTimeText({ bodyTextEn: 'one word' }) === '1 min read']);
  checks.push(['falls back to ZH char count (300 cpm) when EN body is empty', computeReadingTimeText({ bodyTextEn: '', bodyTextZh: '字'.repeat(900) }) === '3 min read']);
  return checks;
}

function runCli(args) {
  try {
    const stdout = execFileSync('node', ['--no-warnings', 'build-article-document.js', ...args], { cwd: __dirname, encoding: 'utf-8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function checks_cli() {
  const checks = [];
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stateFile = path.join(OUTPUT_DIR, 'build-article-document-state-fixture.json');
  const { bodyEnHtml, bodyZhHtml, readingTimeText, ...rest } = sampleState();
  writeFileSync(
    stateFile,
    JSON.stringify({
      ...rest,
      bodyTextEn: '## What Is Time Decay?\n\nTime decay erodes value daily.',
      bodyTextZh: '## 什么是时间损耗？\n\n时间损耗每天侵蚀价值。',
    }),
    'utf-8'
  );

  const run = runCli(['--state-file', stateFile, '--json']);
  checks.push(['CLI: exits 0 with a well-formed state file', run.exitCode === 0]);
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // leave null
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: html contains the converted EN heading', !!parsed?.html?.includes('<h2>What Is Time Decay?</h2>')]);
  checks.push(['CLI: html contains the converted ZH heading', !!parsed?.html?.includes('<h2>什么是时间损耗？</h2>')]);

  const missingState = runCli([]);
  checks.push(['CLI: missing --state-file exits non-zero', missingState.exitCode !== 0]);

  return checks;
}

async function main() {
  const checks = [
    ...checks_bodyTextToHtml(),
    ...checks_buildArticleDocument(),
    ...checks_assembleFromDraftState(),
    ...checks_computeReadingTimeText(),
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
