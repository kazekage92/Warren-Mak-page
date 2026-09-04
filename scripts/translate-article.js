#!/usr/bin/env node
/**
 * English -> Chinese (Simplified) translation — extra-md-files/automated-
 * article-scheduler.md component 3 ("Translation"), flagged there as "the
 * highest-risk new piece": nothing in this codebase auto-translates a full
 * article today. The two existing AI-translate features are both
 * browser-only, per-field, human-in-the-loop (admin/index.html's
 * translateNaPair() and suggestGraphZh()) — this pipeline has no human step
 * by design, so translation quality/HTML-safety has to be enforced by the
 * script itself, not by a person reading it after.
 *
 * The real risk the doc calls out: the EN body already contains real markup
 * by the time this runs (`<h2>`/`<h3>` headings, `<a href="other-slug.html">`
 * internal links generate-article.js's link-insertion step wove in, the
 * graph-block `<figure>`). A naive "send the whole HTML string to an LLM and
 * ask for Chinese back" risks the model paraphrasing inside a tag, dropping
 * an href, or reordering structure. This module avoids that entirely: it
 * never sends serialized HTML to the model and never re-parses model output
 * as HTML.
 *
 * Design (matches the doc's own spec):
 *   1. Parse the EN HTML with cheerio (already a dependency).
 *   2. Walk TEXT NODES ONLY — never attributes (so every `<a href="...">`
 *      keeps its href untouched by construction) — skipping anything inside
 *      a `<figure class="graph-block ...">` subtree (those get their own
 *      steps-array translation via graph-blocks.js, not raw-HTML
 *      translation) and any whitespace-only node.
 *   3. Batch every collected text node into ONE structured LLM call keyed by
 *      stable node IDs (`{"1": "...", "2": "...", ...}` in, same-shaped JSON
 *      out) — the same strict-JSON pattern every other LLM-backed script in
 *      this directory already uses.
 *   4. Reinsert each translated string back into ITS OWN node, in the SAME
 *      cheerio tree — never a raw string replace over serialized HTML, so
 *      the translated text can never accidentally reopen/close a tag (dom-
 *      serializer HTML-escapes text-node content on output regardless of
 *      what the model returns).
 *   5. Run a structural sanity check before accepting the result: same tag
 *      count, same tag order, same href set as the EN version
 *      (checkStructuralSanity). Any mismatch THROWS rather than returning a
 *      possibly-broken result — same abort-don't-publish rule as the
 *      coverage/retention gates elsewhere in this pipeline.
 *
 * Also translates (same batched-call shape, plain text not HTML, via
 * translateFields/translateStringArray/translateFaqPairs — all thin
 * wrappers over the one translateTextMap() primitive): title, subtitle,
 * summary, SEO meta title/description/OG fields, FAQ Q&A pairs, and
 * graph-block title/step labels (component 2's ZH graph HTML is built from
 * these once this module has translated them — see graph-blocks.js).
 *
 * No admin/index.html mirror obligation — the two existing browser
 * translate features are deliberately narrower (single-field, human-
 * reviewed) and don't share this module's batched/whole-body shape.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node translate-article.js --body-file body.html
 *   node translate-article.js --fields-file fields.json --json
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';

const DEFAULT_MODEL = 'gpt-4o-mini'; // translation from an already-reviewed draft -- cheapest tier is fine, same reasoning as the reviewer/SEO steps (automated-article-scheduler.md's own open-questions section)
const DEFAULT_MAX_TOKENS = 8000; // sized for a full article body's worth of text nodes in one batch -- CJK output can run token-dense, same order of magnitude as generate-article.js's writer budget
const PROMPT_JSON_MARKER = 'same keys:\n\n'; // literal text buildBatchTranslatePrompt embeds right before its JSON payload; stubMarkerTranslator below parses it back out by this same marker

// ---------------------------------------------------------------------------
// Core primitive: batched id -> text translation
// ---------------------------------------------------------------------------

/**
 * @param {Record<string,string>} idsToTexts
 * @param {object} [opts]
 * @param {string} [opts.contextLabel] - e.g. "body HTML" / "SEO fields", folded into the prompt
 */
export function buildBatchTranslatePrompt(idsToTexts, { contextLabel } = {}) {
  const system =
    'You are a professional English-to-Chinese (Simplified) translator for a Malaysian financial ' +
    'trading education site (structured warrants, short-term trading on Bursa Malaysia). Translate ' +
    'every value in the given JSON object into natural, professional Chinese suitable for the site\'s ' +
    'existing content. Rules:\n' +
    '- Respond with a JSON object using EXACTLY the same keys as the input -- never add, remove, ' +
    'rename, or reorder keys.\n' +
    '- Translate the VALUE only; a key itself is an opaque id, never translate or alter it.\n' +
    '- Never invent, drop, or alter a number, date, percentage, or named entity (e.g. "Bursa ' +
    'Malaysia", "Warren Mak", "Trade Wizard", "OCBC Bank") -- keep proper nouns/brand names as-is ' +
    'unless the site already has an established Chinese rendering for them.\n' +
    '- Keep the same tone and register as the source (educational, direct, no added flourishes).\n' +
    '- Every value is PLAIN TEXT, not HTML -- never add markup, and if a value already contains a ' +
    'literal character like < or &, translate the surrounding words but leave that character as-is.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences.';

  const user =
    (contextLabel ? `Context: ${contextLabel}\n\n` : '') +
    'Translate every value in this JSON object into Chinese, responding with a JSON object using the ' +
    PROMPT_JSON_MARKER +
    JSON.stringify(idsToTexts);

  return { system, user };
}

export function parseBatchTranslateResponse(rawText, expectedIds) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Translation response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Translation response is not a JSON object.\nRaw response:\n${rawText}`);
  }

  const expected = new Set(expectedIds);
  const got = new Set(Object.keys(parsed));
  const missing = [...expected].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !expected.has(id));
  if (missing.length || extra.length) {
    throw new Error(
      `Translation response keys don't match the request: ` +
        `${missing.length ? `missing [${missing.join(', ')}]` : ''}${missing.length && extra.length ? '; ' : ''}` +
        `${extra.length ? `unexpected [${extra.join(', ')}]` : ''}`
    );
  }
  for (const id of expectedIds) {
    if (typeof parsed[id] !== 'string' || !parsed[id].trim()) {
      throw new Error(`Translation response has a missing/empty value for id "${id}": ${JSON.stringify(parsed[id])}`);
    }
  }
  return parsed;
}

/** DI'd caller — real OpenAI call. Same DI slot pattern as every other
 *  writer/judge function in this directory (openAISeoWriter, openAIJudge,
 *  ...): `(promptObj, opts) => string|Promise<string>`. */
export async function openAIBatchTranslator(
  { system, user },
  { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, contextLabel } = {}
) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this script for ' +
        'real, or inject a stub `translator` function to validate offline (see validate-translate-article.js).'
    );
  }
  return callOpenAIChat({
    apiKey,
    model,
    system,
    user,
    maxTokens,
    temperature: 0.2, // translation, not creative writing -- low but non-zero (natural phrasing still needs some latitude)
    callerLabel: `translate-article.js openAIBatchTranslator${contextLabel ? ` (${contextLabel})` : ''}`,
  });
}

/**
 * Deterministic, non-LLM translator for OFFLINE TESTING ONLY (CLI's
 * --stub-translate flag, and validate-translate-article.js) — parses the
 * id->text JSON map straight back out of the prompt text (rather than
 * needing a separate fixture-file-per-input-shape scheme, impractical here
 * since the id set varies with every article's own node count) and wraps
 * every value with a visible, inspectable marker. NEVER translates anything
 * for real — do not wire this into a production run.
 */
export function stubMarkerTranslator({ user }) {
  const idx = user.indexOf(PROMPT_JSON_MARKER);
  if (idx === -1) {
    throw new Error('stubMarkerTranslator: could not find the embedded JSON map in the prompt (has buildBatchTranslatePrompt changed shape?)');
  }
  const idsToTexts = JSON.parse(user.slice(idx + PROMPT_JSON_MARKER.length));
  const out = {};
  for (const [id, text] of Object.entries(idsToTexts)) out[id] = `【ZH-STUB】${text}`;
  return JSON.stringify(out);
}

/**
 * @param {Record<string,string>} idsToTexts
 * @param {object} [opts]
 * @param {Function} [opts.translator=openAIBatchTranslator]
 * @param {object} [opts.translatorOpts]
 * @param {string} [opts.contextLabel]
 * @returns {Promise<Record<string,string>>}
 */
export async function translateTextMap(idsToTexts, { translator = openAIBatchTranslator, translatorOpts = {}, contextLabel } = {}) {
  const ids = Object.keys(idsToTexts);
  if (!ids.length) return {};
  const promptObj = buildBatchTranslatePrompt(idsToTexts, { contextLabel });
  const raw = await translator(promptObj, { ...translatorOpts, contextLabel });
  return parseBatchTranslateResponse(raw, ids);
}

// ---------------------------------------------------------------------------
// Plain-text convenience wrappers -- all just shape idsToTexts differently
// and call translateTextMap(); no new translation logic of their own.
// ---------------------------------------------------------------------------

/** Translates a flat {fieldName: text} object (title/subtitle/summary/SEO
 *  fields/...), skipping any field that's empty or not a string -- those
 *  pass through unchanged rather than being sent to the model or rejected. */
export async function translateFields(fields, opts = {}) {
  const nonEmpty = Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.trim()));
  const translated = await translateTextMap(nonEmpty, { ...opts, contextLabel: opts.contextLabel || 'article fields (title/subtitle/summary/SEO)' });
  return { ...fields, ...translated };
}

/** Translates an ordered array of plain strings (graph-block step labels),
 *  preserving order and length. */
export async function translateStringArray(strings, opts = {}) {
  if (!strings.length) return [];
  const idsToTexts = {};
  strings.forEach((s, i) => {
    idsToTexts[String(i)] = s;
  });
  const translated = await translateTextMap(idsToTexts, { ...opts, contextLabel: opts.contextLabel || 'graph-block step labels' });
  return strings.map((_, i) => translated[String(i)]);
}

/** Translates an array of {question, answer} FAQ pairs (seo-optimizer.js's
 *  metadata.faq shape) in one batch, preserving pair order. */
export async function translateFaqPairs(faq, opts = {}) {
  if (!faq.length) return [];
  const idsToTexts = {};
  faq.forEach((f, i) => {
    idsToTexts[`q${i}`] = f.question;
    idsToTexts[`a${i}`] = f.answer;
  });
  const translated = await translateTextMap(idsToTexts, { ...opts, contextLabel: opts.contextLabel || 'FAQ pairs' });
  return faq.map((f, i) => ({ question: translated[`q${i}`], answer: translated[`a${i}`] }));
}

// ---------------------------------------------------------------------------
// Body-HTML translation — the highest-risk piece (see header comment)
// ---------------------------------------------------------------------------

const SKIP_SUBTREE_TAGS = new Set(['script', 'style']);

function isGraphBlockFigure(node) {
  if (node.type !== 'tag' || node.name !== 'figure') return false;
  const classAttr = node.attribs?.class || '';
  return classAttr.split(/\s+/).includes('graph-block');
}

/**
 * Walks `html` (a body-HTML fragment, same flat shape build-article-
 * document.js's bodyTextToHtml() produces and every hand-authored article
 * already uses) and collects every translatable text node: non-whitespace
 * text NOT inside a `<figure class="graph-block ...">` subtree and not
 * inside `<script>`/`<style>`.
 *
 * @returns {{$: cheerio.CheerioAPI, entries: Array<{id: string, node: object, text: string}>}}
 *   `node` is the live domhandler text node -- mutate `.data` on it (see
 *   applyTranslatedTextNodes below) to reinsert a translation in place,
 *   never build a new tree or string-replace the serialized HTML.
 */
export function collectTranslatableTextNodes(html) {
  const $ = cheerio.load(html, null, false);
  const entries = [];
  let counter = 0;

  function walk(node, skip) {
    if (node.type === 'tag') {
      const nextSkip = skip || SKIP_SUBTREE_TAGS.has(node.name) || isGraphBlockFigure(node);
      for (const child of node.children || []) walk(child, nextSkip);
      return;
    }
    if (node.type === 'text' && !skip) {
      const text = node.data ?? '';
      if (text.trim()) {
        counter += 1;
        entries.push({ id: String(counter), node, text });
      }
    }
  }

  for (const node of $.root().contents().toArray()) walk(node, false);
  return { $, entries };
}

/** Mutates each collected text node's `.data` in place with its translation
 *  and returns the re-serialized HTML. Throws if `translatedMap` is missing
 *  an id (should be unreachable -- parseBatchTranslateResponse already
 *  validates the exact key set -- kept as a defensive check since this is
 *  the step that actually writes into the live DOM tree). */
export function applyTranslatedTextNodes($, entries, translatedMap) {
  for (const entry of entries) {
    if (!(entry.id in translatedMap)) {
      throw new Error(`applyTranslatedTextNodes: no translation returned for node id "${entry.id}" ("${entry.text.slice(0, 40)}...")`);
    }
    entry.node.data = translatedMap[entry.id];
  }
  return $.root().html();
}

function structuralFingerprint(html) {
  const $ = cheerio.load(html, null, false);
  const tags = [];
  const hrefs = [];
  function walk(node) {
    if (node.type !== 'tag') return;
    tags.push(node.name);
    if (typeof node.attribs?.href === 'string') hrefs.push(node.attribs.href);
    for (const child of node.children || []) walk(child);
  }
  for (const node of $.root().contents().toArray()) walk(node);
  return { tags, hrefs };
}

/** Same tag count, same tag order, same href set (in the same order) as the
 *  EN version -- automated-article-scheduler.md component 3's own stated
 *  bar. THROWS on any mismatch rather than returning a boolean, matching
 *  every other "abort, don't publish" gate in this pipeline (coverage
 *  reviewer, fact-retention checker). By construction (only ever mutating an
 *  existing text node's `.data`, never touching structure or attributes)
 *  this should never actually fire -- it exists as the doc's own explicit
 *  belt-and-suspenders requirement, not because a specific bug is expected. */
export function checkStructuralSanity(originalHtml, translatedHtml) {
  const before = structuralFingerprint(originalHtml);
  const after = structuralFingerprint(translatedHtml);

  if (before.tags.length !== after.tags.length) {
    throw new Error(
      `Structural sanity check failed: tag count changed (${before.tags.length} -> ${after.tags.length}). Aborting -- not accepting this translation.`
    );
  }
  for (let i = 0; i < before.tags.length; i++) {
    if (before.tags[i] !== after.tags[i]) {
      throw new Error(
        `Structural sanity check failed: tag order diverged at position ${i} ("${before.tags[i]}" -> "${after.tags[i]}"). Aborting -- not accepting this translation.`
      );
    }
  }
  if (before.hrefs.length !== after.hrefs.length || before.hrefs.some((h, i) => h !== after.hrefs[i])) {
    throw new Error(
      `Structural sanity check failed: href set changed.\n  before: ${JSON.stringify(before.hrefs)}\n  after:  ${JSON.stringify(after.hrefs)}\nAborting -- not accepting this translation.`
    );
  }
}

/**
 * @param {string} html - EN body-HTML fragment
 * @param {object} [opts] - forwarded to translateTextMap (translator, translatorOpts)
 * @returns {Promise<string>} the translated (ZH) body-HTML fragment
 */
export async function translateArticleBodyHtml(html, opts = {}) {
  const { $, entries } = collectTranslatableTextNodes(html);
  if (!entries.length) return html; // nothing to translate (e.g. pure markup) -- return as-is, not an error

  const idsToTexts = Object.fromEntries(entries.map((e) => [e.id, e.text]));
  const translatedMap = await translateTextMap(idsToTexts, { ...opts, contextLabel: opts.contextLabel || 'article body HTML' });
  const translatedHtml = applyTranslatedTextNodes($, entries, translatedMap);

  checkStructuralSanity(html, translatedHtml);
  return translatedHtml;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { bodyFile: null, fieldsFile: null, model: DEFAULT_MODEL, json: false, stubTranslate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--body-file':
        opts.bodyFile = path.resolve(nextArg(argv, ++i, '--body-file'));
        break;
      case '--fields-file':
        opts.fieldsFile = path.resolve(nextArg(argv, ++i, '--fields-file'));
        break;
      case '--model':
        opts.model = nextArg(argv, ++i, '--model');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--stub-translate':
        // OFFLINE TESTING ONLY -- see stubMarkerTranslator's own doc comment.
        // Does not call OpenAI and does not actually translate anything.
        opts.stubTranslate = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.bodyFile && !opts.fieldsFile) throw new Error('One of --body-file or --fields-file is required');
  if (opts.bodyFile && opts.fieldsFile) throw new Error('Pass only one of --body-file or --fields-file, not both');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const translator = opts.stubTranslate ? stubMarkerTranslator : openAIBatchTranslator;
  const translatorOpts = { model: opts.model };

  if (opts.bodyFile) {
    const html = readFileSync(opts.bodyFile, 'utf-8');
    const translatedHtml = await translateArticleBodyHtml(html, { translator, translatorOpts });
    if (opts.json) console.log(JSON.stringify({ translatedHtml }, null, 2));
    else console.log(translatedHtml);
    return;
  }

  const fields = JSON.parse(readFileSync(opts.fieldsFile, 'utf-8'));
  const translated = await translateFields(fields, { translator, translatorOpts });
  if (opts.json) console.log(JSON.stringify(translated, null, 2));
  else console.log(translated);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
