#!/usr/bin/env node
/**
 * Drift check between each scripts/*.js prompt-building function and its
 * hand-kept browser mirror in admin/index.html.
 *
 * admin/index.html is a standalone, self-contained page (root CLAUDE.md: no
 * build step, no imports from this dev-only scripts/ directory), so it can't
 * `import` these functions — it carries copy-pasted vanilla-JS reimplementations
 * instead, each flagged with a "// mirrors scripts/X.js's Y()" comment and a
 * "Keep in sync if either changes" note. Nothing has ever enforced that note;
 * this script does, by literally running both sides and diffing their output.
 *
 * How it works (no build step needed to make this work either):
 *   1. Import the real functions from scripts/*.js — these are the source of truth.
 *   2. Slice the mirror functions' source text straight out of admin/index.html
 *      (brace-matched, string/comment-aware — see extractFunctionSource below)
 *      and eval them in a small vm sandbox to get callables.
 *   3. Call both sides with identical fixtures and assert the output strings
 *      are byte-for-byte equal.
 *
 * Scope is deliberately the PROMPT-BUILDING functions (the ones that return a
 * literal string or {system,user} object baked directly into an LLM call) plus
 * the small formatting helpers spliced directly into those prompts, PLUS the
 * two deterministic HTML-assembly functions extra-md-files/automated-article-
 * scheduler.md explicitly calls out as carrying the same sync obligation
 * (buildFlowGraphHtml, buildArticleDocument) — not every mirrored function in
 * admin/index.html. Response-PARSING mirrors
 * (parseReviewResponseBrowser, parseSeoResponseBrowser, kgParseExtractionResponse,
 * kgParseJudgeResponse) and the checklist-retrieval mirrors (kcTokenize/
 * kcFindSeedEntities/kcExpandRelatedEntities/kcBuildChecklist) are out of scope:
 * the parsers' shapes already diverge slightly by necessity (the browser
 * versions also do the DOM-safe escaping their render step needs), and the
 * retrieval mirrors run against a materially different data source (the JSON
 * graph mirror vs. a live SQLite `db` handle via .prepare().all()), so a
 * literal string/deep-equal diff isn't the right tool for either — see
 * retrieval-layer.js's own README section on that db-vs-JSON split.
 *
 * Covers:
 *   - coverage-reviewer.js:      formatChecklist   <-> kcFormatChecklist
 *   - coverage-reviewer.js:      buildReviewPrompt <-> buildReviewPromptBrowser
 *   - seo-optimizer.js:          buildSeoPrompt    <-> buildSeoPromptBrowser
 *   - extract-entities.js:       buildExtractionPrompt <-> kgBuildExtractionPrompt
 *   - fact-retention-checker.js: formatState       <-> kgFormatState
 *   - fact-retention-checker.js: buildJudgePrompt  <-> kgBuildJudgePrompt
 *   - generate-article.js:       buildWriterPrompt <-> buildWriterPromptBrowser
 *   - generate-article.js:       buildRepairPrompt <-> buildRepairPromptBrowser
 *   - graph-blocks.js:           buildFlowGraphHtml <-> buildFlowGraphHtml (same name both sides)
 *   - build-article-document.js: buildArticleDocument <-> buildArticleDocument (same name both sides)
 *
 * Usage: node validate-admin-mirror-sync.js
 * Exits non-zero if any pair's output diverges.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildReviewPrompt, formatChecklist } from './coverage-reviewer.js';
import { buildSeoPrompt } from './seo-optimizer.js';
import { buildExtractionPrompt } from './extract-entities.js';
import { buildJudgePrompt, formatState } from './fact-retention-checker.js';
import { buildWriterPrompt, buildRepairPrompt } from './generate-article.js';
import { buildFlowGraphHtml } from './graph-blocks.js';
import { buildArticleDocument } from './build-article-document.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADMIN_HTML_PATH = path.join(REPO_ROOT, 'admin', 'index.html');

// ---------------------------------------------------------------------------
// Extraction: pull the mirror functions' source text out of admin/index.html
// ---------------------------------------------------------------------------

/** Scans `src` from `openBraceIdx` (must point at a `{`) and returns the
 *  slice through its matching `}`, tracking single/double-quoted strings and
 *  // and /* *\/ comments so braces inside them don't throw off the count.
 *  Sufficient for the target functions below: none of them use template
 *  literals or regex literals, confirmed by inspection — see the header. */
function extractBalancedBlock(src, openBraceIdx) {
  let depth = 0;
  let inString = null; // "'" or '"' while inside a string literal
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openBraceIdx; i < src.length; i++) {
    const c = src[i];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && src[i + 1] === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++; // skip the escaped character, whatever it is
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inString = c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      inLineComment = true;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      inBlockComment = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  throw new Error(`extractBalancedBlock: ran off the end of the file without closing brace depth`);
}

/** Finds `function <name>(...) { ... }` in admin/index.html and returns its
 *  full source text (signature + body). Assumes a single-line, brace-free
 *  parameter list, true of every mirror function this script pulls. */
function extractFunctionSource(html, name) {
  const sigRe = new RegExp(`function\\s+${name}\\s*\\(`);
  const sigMatch = sigRe.exec(html);
  if (!sigMatch) {
    throw new Error(
      `Could not find "function ${name}(" in admin/index.html — has it been renamed or removed? ` +
        `If intentional, update this validator's target list too.`
    );
  }
  const parenOpen = sigMatch.index + sigMatch[0].length - 1;
  let parenDepth = 0;
  let i = parenOpen;
  for (; i < html.length; i++) {
    if (html[i] === '(') parenDepth++;
    else if (html[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const braceOpen = html.indexOf('{', i);
  if (braceOpen === -1) throw new Error(`extractFunctionSource: no "{" found after ${name}(...)`);
  const body = extractBalancedBlock(html, braceOpen);
  return html.slice(sigMatch.index, braceOpen) + body;
}

/** Finds a single-line `var <name> = [...];` declaration and returns its
 *  full source text verbatim (used for KG_ENTITY_TYPES/KG_RELATIONS, which
 *  kgBuildExtractionPrompt below references as free variables). */
function extractVarDecl(html, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*\\[[^\\]]*\\]\\s*;`);
  const m = re.exec(html);
  if (!m) throw new Error(`Could not find "var ${name} = [...];" in admin/index.html`);
  return m[0];
}

/** General-purpose sibling of extractVarDecl above, for `var <name> = <expr>;`
 *  declarations extractVarDecl's single-line-array-literal regex can't handle:
 *  NAV_HTML/FOOTER_HTML (an array literal followed by `.join('\n')`) and
 *  CTA_PRESETS (a multi-line object literal whose own values are themselves
 *  `.join('\n')`-ed array literals). Scans from just after `=`, bracket/brace/
 *  paren-depth- and string-aware (same spirit as extractBalancedBlock above,
 *  generalized to all three opener characters since `.join(...)` calls appear
 *  inside these expressions), stopping at the first top-level `;`. */
function extractVarStatementSource(html, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) throw new Error(`Could not find "var ${name} = ..." in admin/index.html`);
  const exprStart = m.index + m[0].length;

  let depth = 0;
  let inString = null;
  let i = exprStart;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) break;
  }
  if (i >= html.length) throw new Error(`extractVarStatementSource: ran off the end of the file looking for "${name}"'s closing ";"`);
  return html.slice(m.index, i + 1);
}

function loadAdminMirrors() {
  const html = readFileSync(ADMIN_HTML_PATH, 'utf-8');

  const moduleSrc = [
    extractVarDecl(html, 'KG_ENTITY_TYPES'),
    extractVarDecl(html, 'KG_RELATIONS'),
    // formatChecklistItemsBrowser is a private helper both kcFormatChecklist and
    // formatChecklistForWriterBrowser call (mirrors scripts/checklist-format.js's
    // formatChecklistItems()) — not itself in this validator's target list (it's asserted
    // transitively through those two), but it must still be in-scope for the sandbox eval below
    // to resolve the call.
    extractFunctionSource(html, 'formatChecklistItemsBrowser'),
    extractFunctionSource(html, 'kcFormatChecklist'),
    extractFunctionSource(html, 'buildReviewPromptBrowser'),
    extractFunctionSource(html, 'buildSeoPromptBrowser'),
    extractFunctionSource(html, 'kgFormatState'),
    extractFunctionSource(html, 'kgBuildJudgePrompt'),
    extractFunctionSource(html, 'kgBuildExtractionPrompt'),
    // formatChecklistForWriterBrowser is a private helper buildWriterPromptBrowser/
    // buildRepairPromptBrowser both call — not itself in this validator's target list (it's
    // asserted transitively through those two), but it must still be in-scope for the sandbox
    // eval below to resolve the call.
    extractFunctionSource(html, 'formatChecklistForWriterBrowser'),
    extractFunctionSource(html, 'buildWriterPromptBrowser'),
    extractFunctionSource(html, 'buildRepairPromptBrowser'),
    // escapeHtml is a dependency of buildFlowGraphHtml below (the 5th pair) --
    // not itself a validated pair, same "in-scope for the sandbox eval, not
    // separately asserted" treatment as formatChecklistItemsBrowser above.
    extractFunctionSource(html, 'escapeHtml'),
    extractFunctionSource(html, 'buildFlowGraphHtml'),
    // buildArticleDocument's own dependencies (6th pair) -- escapeAttr/
    // jsonLdScript/truncateWords/truncateChars/formatMonthYear/
    // formatMonthYearZh/readingTimeTextZh plus the three static-chrome
    // constants and substituteGraphPlaceholders. naGraphBlocks is NOT
    // extracted from admin's source (it's mutated all over that file as the
    // wizard's live graph-panel state) -- it's synthesized below as an empty
    // array instead, which is exactly the state buildArticleDocument sees for
    // a document with no graph blocks inserted, the only case this validator
    // needs (see build-article-document.js's own header comment on why its
    // Node buildArticleDocument() expects already-final body HTML instead).
    // escapeAttr is NOT run through extractFunctionSource: its body is
    // `escapeHtml(str).replace(/"/g, '&quot;')` — that regex literal contains
    // a bare `"`, which extractBalancedBlock's string/comment-aware scanner
    // (deliberately regex-literal-blind per its own doc comment — "none of
    // the target functions use ... regex literals", true until this one)
    // misreads as the START of a string literal, then runs away consuming
    // admin/index.html far past escapeAttr's real closing brace looking for a
    // matching quote. escapeAttr is a two-line, effectively-frozen dependency
    // (not itself a validated pair, same treatment as naGraphBlocks below),
    // so it's simplest to inline its known-correct source verbatim here
    // rather than teach the scanner to distinguish regex literals from
    // division — re-copy this line if admin/index.html's escapeAttr ever
    // changes.
    "function escapeAttr(str) { return escapeHtml(str).replace(/\"/g, '&quot;'); }",
    extractFunctionSource(html, 'jsonLdScript'),
    extractFunctionSource(html, 'truncateWords'),
    extractFunctionSource(html, 'truncateChars'),
    extractFunctionSource(html, 'formatMonthYear'),
    extractFunctionSource(html, 'formatMonthYearZh'),
    extractFunctionSource(html, 'readingTimeTextZh'),
    extractVarStatementSource(html, 'NAV_HTML'),
    extractVarStatementSource(html, 'FOOTER_HTML'),
    extractVarStatementSource(html, 'CTA_PRESETS'),
    'var naGraphBlocks = [];',
    extractFunctionSource(html, 'substituteGraphPlaceholders'),
    extractFunctionSource(html, 'buildArticleDocument'),
    // Expose everything to the sandbox's global scope so the harness can read it back.
    [
      'globalThis.__mirrors__ = {',
      '  kcFormatChecklist: kcFormatChecklist,',
      '  buildReviewPromptBrowser: buildReviewPromptBrowser,',
      '  buildSeoPromptBrowser: buildSeoPromptBrowser,',
      '  kgFormatState: kgFormatState,',
      '  kgBuildJudgePrompt: kgBuildJudgePrompt,',
      '  kgBuildExtractionPrompt: kgBuildExtractionPrompt,',
      '  buildWriterPromptBrowser: buildWriterPromptBrowser,',
      '  buildRepairPromptBrowser: buildRepairPromptBrowser,',
      '  buildFlowGraphHtml: buildFlowGraphHtml,',
      '  buildArticleDocument: buildArticleDocument',
      '};',
    ].join('\n'),
  ].join('\n\n');

  const sandbox = { console };
  vm.createContext(sandbox);
  try {
    vm.runInContext(moduleSrc, sandbox, { filename: 'admin/index.html (extracted mirrors)' });
  } catch (err) {
    throw new Error(
      `Failed to evaluate the extracted admin/index.html mirror functions — the extraction ` +
        `logic above may need updating to match a structural change in admin/index.html.\n` +
        `Underlying error: ${err.message}`
    );
  }
  return sandbox.__mirrors__;
}

// ---------------------------------------------------------------------------
// Fixtures — deliberately stress quotes, apostrophes, HTML markup, newlines,
// and non-ASCII text, since those are exactly the characters most likely to
// reveal a copy-paste slip (an un-escaped quote, a dropped '--' vs '—', etc.)
// ---------------------------------------------------------------------------

const CHECKLIST_EMPTY = [];
const CHECKLIST_SAMPLE = [
  { name: 'Time Decay (Theta)', type: 'concept', why: 'directly matches the topic' },
  {
    name: 'Bursa Malaysia',
    type: 'organization',
    why: 'related to the topic via: Structured Warrants --[part_of]--> Bursa Malaysia',
  },
  { name: 'Leverage', why: 'related to the topic via: Time Decay (Theta) --[related_to]--> Leverage' }, // no type
  {
    name: 'Warrant\'s "Extrinsic" Value & <Risk> Tags',
    type: 'edge-case',
    why: 'stress-tests quotes, apostrophes, ampersands, and angle brackets',
  },
];

const DRAFT_TEXT_SAMPLE =
  'Time decay (theta) erodes a structured warrant\'s extrinsic value every day, all else held constant.\n\n' +
  'Second paragraph with "quotes", <b>markup</b>, an ampersand & an em dash — plus 中文测试字符.';

const KG_STATE_EMPTY = { entities: [], edges: [] };
const KG_STATE_OLD = {
  entities: [
    { name: 'Time Decay (Theta)', type: 'concept' },
    { name: 'Leverage', type: 'concept' },
  ],
  edges: [{ source: 'Time Decay (Theta)', relation: 'related_to', target: 'Leverage' }],
};
const KG_STATE_NEW = {
  entities: [
    { name: 'Theta Decay', type: 'concept' }, // harmless rename
    // "Leverage" dropped entirely
  ],
  edges: [],
};

const ARTICLE_SUMMARIES_EMPTY = [];
const ARTICLE_SUMMARIES_SAMPLE = [
  {
    slug: 'time-decay-warrants',
    title: 'Time Decay and Your Structured Warrants',
    summary: 'Explains how theta erodes a warrant\'s "extrinsic" value & <intrinsic> value over time.',
  },
  {
    slug: 'leverage-basics',
    title: 'Leverage Basics for New Traders',
    summary: 'Covers leverage and risk sizing for 中文测试 readers — an em dash too.',
  },
];

const NEAR_DUPLICATES_EMPTY = [];
const NEAR_DUPLICATES_SAMPLE = [
  {
    level: 'high',
    title: 'Time Decay and Your Structured Warrants',
    note: 'Same core concept -- angle this one differently, e.g. "risk sizing" not "definition".',
  },
];

const MUST_INCLUDE_FACTS_EMPTY = [];
const MUST_INCLUDE_FACTS_SAMPLE = [
  'Warren Mak has 32 years of market experience',
  'Former Head of 5 departments at Bursa Malaysia',
];

const SOURCE_TEXT_SAMPLE =
  'A pasted reference column with "quotes", <b>markup</b>, an ampersand & an em dash — plus 中文测试字符.';

const REPAIR_DRAFT_SAMPLE = {
  title: 'Time Decay and Your Structured Warrants',
  summary: 'A short summary with "quotes" & <html>.',
  body_text: DRAFT_TEXT_SAMPLE,
};
const REPAIR_MISSING_EMPTY = [];
const REPAIR_MISSING_SAMPLE = [
  { name: 'Bursa Malaysia' },
  { name: 'Warrant\'s "Extrinsic" Value & <Risk> Tags' },
];
const REPAIR_PARTIAL_EMPTY = [];
const REPAIR_PARTIAL_SAMPLE = [
  { name: 'Leverage', evidence: 'mentioned once but not explained' },
  { name: 'Time Decay (Theta)' }, // no `evidence` field -- exercises the "(none)" fallback
];

// ---------------------------------------------------------------------------
// Comparison harness
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : len;
}

function assertEqual(label, actual, expected) {
  checks++;
  if (actual === expected) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${label}`);
  if (typeof actual === 'string' && typeof expected === 'string') {
    const idx = firstDiffIndex(actual, expected);
    const window = 40;
    console.error(`       first diff at char ${idx}`);
    console.error(`       original: ...${JSON.stringify(expected.slice(Math.max(0, idx - window), idx + window))}...`);
    console.error(`       mirror:   ...${JSON.stringify(actual.slice(Math.max(0, idx - window), idx + window))}...`);
  } else {
    console.error(`       original: ${JSON.stringify(expected)}`);
    console.error(`       mirror:   ${JSON.stringify(actual)}`);
  }
}

function comparePromptObjects(label, mirrorResult, originalResult) {
  assertEqual(`${label} — system`, mirrorResult.system, originalResult.system);
  assertEqual(`${label} — user`, mirrorResult.user, originalResult.user);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`Extracting mirror functions from ${path.relative(REPO_ROOT, ADMIN_HTML_PATH)}...`);
const mirrors = loadAdminMirrors();

console.log('\ncoverage-reviewer.js formatChecklist <-> kcFormatChecklist');
assertEqual('empty checklist', mirrors.kcFormatChecklist(CHECKLIST_EMPTY), formatChecklist(CHECKLIST_EMPTY));
assertEqual('sample checklist', mirrors.kcFormatChecklist(CHECKLIST_SAMPLE), formatChecklist(CHECKLIST_SAMPLE));

console.log('\ncoverage-reviewer.js buildReviewPrompt <-> buildReviewPromptBrowser');
comparePromptObjects(
  'empty checklist',
  mirrors.buildReviewPromptBrowser(CHECKLIST_EMPTY, DRAFT_TEXT_SAMPLE),
  buildReviewPrompt({ checklist: CHECKLIST_EMPTY, draftText: DRAFT_TEXT_SAMPLE })
);
comparePromptObjects(
  'sample checklist',
  mirrors.buildReviewPromptBrowser(CHECKLIST_SAMPLE, DRAFT_TEXT_SAMPLE),
  buildReviewPrompt({ checklist: CHECKLIST_SAMPLE, draftText: DRAFT_TEXT_SAMPLE })
);

console.log('\nseo-optimizer.js buildSeoPrompt <-> buildSeoPromptBrowser');
const SEO_ARGS_EMPTY = { topic: 'Time Decay', title: 'Time Decay and Your Structured Warrants', bodyText: DRAFT_TEXT_SAMPLE, checklist: CHECKLIST_EMPTY };
const SEO_ARGS_SAMPLE = { ...SEO_ARGS_EMPTY, checklist: CHECKLIST_SAMPLE };
comparePromptObjects(
  'empty checklist',
  mirrors.buildSeoPromptBrowser(SEO_ARGS_EMPTY.topic, SEO_ARGS_EMPTY.title, SEO_ARGS_EMPTY.bodyText, SEO_ARGS_EMPTY.checklist),
  buildSeoPrompt(SEO_ARGS_EMPTY)
);
comparePromptObjects(
  'sample checklist',
  mirrors.buildSeoPromptBrowser(SEO_ARGS_SAMPLE.topic, SEO_ARGS_SAMPLE.title, SEO_ARGS_SAMPLE.bodyText, SEO_ARGS_SAMPLE.checklist),
  buildSeoPrompt(SEO_ARGS_SAMPLE)
);

console.log('\nextract-entities.js buildExtractionPrompt <-> kgBuildExtractionPrompt');
const ARTICLE_SAMPLE = {
  slug: 'time-decay-warrants',
  title: 'Time Decay and Your Structured Warrants',
  body_text: 'Sample body text with "quotes" & <html> markup.\n\n中文测试.',
};
const EXISTING_ENTITIES_EMPTY = [];
const EXISTING_ENTITIES_SAMPLE = [
  { name: 'Bursa Malaysia', type: 'organization' },
  { name: 'Leverage', type: 'concept' },
];
comparePromptObjects(
  'no existing entities',
  mirrors.kgBuildExtractionPrompt(ARTICLE_SAMPLE, EXISTING_ENTITIES_EMPTY),
  buildExtractionPrompt({ article: ARTICLE_SAMPLE, existingEntities: EXISTING_ENTITIES_EMPTY })
);
comparePromptObjects(
  'sample existing entities',
  mirrors.kgBuildExtractionPrompt(ARTICLE_SAMPLE, EXISTING_ENTITIES_SAMPLE),
  buildExtractionPrompt({ article: ARTICLE_SAMPLE, existingEntities: EXISTING_ENTITIES_SAMPLE })
);

console.log('\nfact-retention-checker.js formatState <-> kgFormatState');
assertEqual('empty state', mirrors.kgFormatState(KG_STATE_EMPTY), formatState(KG_STATE_EMPTY));
assertEqual('sample state', mirrors.kgFormatState(KG_STATE_OLD), formatState(KG_STATE_OLD));

console.log('\nfact-retention-checker.js buildJudgePrompt <-> kgBuildJudgePrompt');
comparePromptObjects(
  'old vs new state',
  mirrors.kgBuildJudgePrompt('time-decay-warrants', KG_STATE_OLD, KG_STATE_NEW),
  buildJudgePrompt({ slug: 'time-decay-warrants', oldState: KG_STATE_OLD, newState: KG_STATE_NEW })
);

console.log('\ngenerate-article.js buildWriterPrompt <-> buildWriterPromptBrowser');
comparePromptObjects(
  'empty inputs, no source text',
  mirrors.buildWriterPromptBrowser('Time Decay', CHECKLIST_EMPTY, MUST_INCLUDE_FACTS_EMPTY, ARTICLE_SUMMARIES_EMPTY, NEAR_DUPLICATES_EMPTY, null),
  buildWriterPrompt({
    topic: 'Time Decay',
    checklist: CHECKLIST_EMPTY,
    mustIncludeFacts: MUST_INCLUDE_FACTS_EMPTY,
    articleSummaries: ARTICLE_SUMMARIES_EMPTY,
    nearDuplicates: NEAR_DUPLICATES_EMPTY,
    sourceText: null,
  })
);
comparePromptObjects(
  'sample inputs, no source text',
  mirrors.buildWriterPromptBrowser('Time Decay', CHECKLIST_SAMPLE, MUST_INCLUDE_FACTS_SAMPLE, ARTICLE_SUMMARIES_SAMPLE, NEAR_DUPLICATES_SAMPLE, null),
  buildWriterPrompt({
    topic: 'Time Decay',
    checklist: CHECKLIST_SAMPLE,
    mustIncludeFacts: MUST_INCLUDE_FACTS_SAMPLE,
    articleSummaries: ARTICLE_SUMMARIES_SAMPLE,
    nearDuplicates: NEAR_DUPLICATES_SAMPLE,
    sourceText: null,
  })
);
comparePromptObjects(
  'sample inputs, with source text',
  mirrors.buildWriterPromptBrowser('Time Decay', CHECKLIST_SAMPLE, MUST_INCLUDE_FACTS_SAMPLE, ARTICLE_SUMMARIES_SAMPLE, NEAR_DUPLICATES_SAMPLE, SOURCE_TEXT_SAMPLE),
  buildWriterPrompt({
    topic: 'Time Decay',
    checklist: CHECKLIST_SAMPLE,
    mustIncludeFacts: MUST_INCLUDE_FACTS_SAMPLE,
    articleSummaries: ARTICLE_SUMMARIES_SAMPLE,
    nearDuplicates: NEAR_DUPLICATES_SAMPLE,
    sourceText: SOURCE_TEXT_SAMPLE,
  })
);

console.log('\ngenerate-article.js buildRepairPrompt <-> buildRepairPromptBrowser');
comparePromptObjects(
  'empty checklist/missing/partial',
  mirrors.buildRepairPromptBrowser('Time Decay', CHECKLIST_EMPTY, REPAIR_DRAFT_SAMPLE, REPAIR_MISSING_EMPTY, REPAIR_PARTIAL_EMPTY),
  buildRepairPrompt({ topic: 'Time Decay', checklist: CHECKLIST_EMPTY, draft: REPAIR_DRAFT_SAMPLE, missing: REPAIR_MISSING_EMPTY, partial: REPAIR_PARTIAL_EMPTY })
);
comparePromptObjects(
  'sample checklist/missing/partial',
  mirrors.buildRepairPromptBrowser('Time Decay', CHECKLIST_SAMPLE, REPAIR_DRAFT_SAMPLE, REPAIR_MISSING_SAMPLE, REPAIR_PARTIAL_SAMPLE),
  buildRepairPrompt({ topic: 'Time Decay', checklist: CHECKLIST_SAMPLE, draft: REPAIR_DRAFT_SAMPLE, missing: REPAIR_MISSING_SAMPLE, partial: REPAIR_PARTIAL_SAMPLE })
);

console.log('\ngraph-blocks.js buildFlowGraphHtml <-> admin buildFlowGraphHtml');
const GRAPH_TITLE_SAMPLE = 'Warrant\'s "Extrinsic" Value & <Risk> Tags — A Quick Primer';
const GRAPH_STEPS_SAMPLE = [
  'Identify the "setup" & confirm the signal',
  'Size the position — never risk more than 5%',
  'Manage <stop-loss> levels as time decay accelerates',
  '中文测试步骤标签',
];
assertEqual('empty steps', mirrors.buildFlowGraphHtml(GRAPH_TITLE_SAMPLE, []), buildFlowGraphHtml(GRAPH_TITLE_SAMPLE, []));
assertEqual('sample steps', mirrors.buildFlowGraphHtml(GRAPH_TITLE_SAMPLE, GRAPH_STEPS_SAMPLE), buildFlowGraphHtml(GRAPH_TITLE_SAMPLE, GRAPH_STEPS_SAMPLE));

console.log('\nbuild-article-document.js buildArticleDocument <-> admin buildArticleDocument');
const ARTICLE_STATE_SAMPLE = {
  titleEn: 'Time Decay and Your Structured Warrants',
  titleZh: '时间损耗与您的结构性凭单',
  subtitleEn: 'Why theta erodes a warrant\'s "extrinsic" value & <intrinsic> value every day',
  subtitleZh: '为什么theta每天都在侵蚀凭单的"外在"与<内在>价值',
  categoryEn: 'Structured Warrants',
  categoryZh: '结构性凭单',
  authorEn: 'Warren Mak',
  authorZh: '麦传球 Warren Mak',
  publishDate: '2026-08-14',
  tags: 'time decay, theta, structured warrants, 中文测试',
  ctaPreset: 'warrants',
  slug: 'time-decay-structured-warrants',
  metaTitle: '',
  metaDescription: 'A guide to time decay in structured warrants on Bursa Malaysia — quotes "included" & <tested>.',
  canonicalUrl: 'https://www.warrenmak.asia/articles/time-decay-structured-warrants.html',
  bodyEnHtml: '<h2>What Is Time Decay?</h2><p>Time decay erodes value daily — even if the stock stays "flat".</p>',
  bodyZhHtml: '<h2>什么是时间损耗？</h2><p>时间损耗每天侵蚀价值——即使股价"不动"。</p>',
  readingTimeText: '5 min read',
  ogImageUrl: 'https://www.warrenmak.asia/assets/images/og-image.jpg',
};
assertEqual(
  'sample state, "warrants" CTA preset',
  mirrors.buildArticleDocument(ARTICLE_STATE_SAMPLE),
  buildArticleDocument(ARTICLE_STATE_SAMPLE)
);
assertEqual(
  'sample state, "shortterm" CTA preset',
  mirrors.buildArticleDocument({ ...ARTICLE_STATE_SAMPLE, ctaPreset: 'shortterm' }),
  buildArticleDocument({ ...ARTICLE_STATE_SAMPLE, ctaPreset: 'shortterm' })
);
assertEqual(
  'sample state, explicit metaTitle (overrides the titleEn fallback)',
  mirrors.buildArticleDocument({ ...ARTICLE_STATE_SAMPLE, metaTitle: 'A Different SEO Title' }),
  buildArticleDocument({ ...ARTICLE_STATE_SAMPLE, metaTitle: 'A Different SEO Title' })
);

console.log(`\n${checks} check(s), ${failures} failure(s).`);
if (failures > 0) {
  console.error(
    '\nOne or more scripts/*.js functions have drifted from their admin/index.html mirror. ' +
      'Update whichever side is stale (search admin/index.html for "mirrors scripts/" to find ' +
      'its copy) and re-run this script.'
  );
  process.exit(1);
}
console.log('\nAll admin/index.html mirrors match their scripts/*.js originals.');
