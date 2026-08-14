#!/usr/bin/env node
/**
 * SEO metadata generator — extra-md-files/ai-article-pipeline.md §4 Phase 4,
 * completed per extra-md-files/pipeline-phase-4-6-7-1-mvp.md §2.
 *
 * Same shape as generate-article.js but simpler: Phase 4 has no reviewer/
 * retry step in the doc, so this is ONE writer-style LLM call that turns an
 * already-written (or about-to-be-written) article's topic/title/body into
 * SEO metadata: SEO title, meta description, URL slug, OG title/description,
 * primary/secondary/long-tail keywords, an H1-H4 heading outline, and a
 * schema-friendly FAQ section — the doc's own Phase 4 field list, verbatim.
 *
 * Reuses retrieval-layer.js's buildRetrievalContext() for the checklist
 * (same "one composed query, every phase reads its own slice" contract every
 * other consumer in this directory follows) rather than re-querying the db.
 *
 * Dependency-injected the same way as every other LLM-backed script here
 * (openAI<X> + fixture<X>, selected once in main(), passed down as opts) —
 * see validate-seo-optimizer.js for the offline harness.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node seo-optimizer.js --topic "Time Decay" --title "..." --body-file body.txt
 *   node seo-optimizer.js --topic "..." --title "..." --body-file body.txt --json
 *   node seo-optimizer.js --topic "..." --title "..." --body-file body.txt \
 *     --seo-fixture-dir DIR   # fully offline, see README
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext } from './retrieval-layer.js';
import { slugifyTopic } from './generate-article.js';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SEO_MODEL = 'gpt-4o-mini'; // metadata generation from an already-written draft — cheaper tier is fine, same reasoning as the reviewer (§5)
const MAX_TOKENS = 2000; // titles/descriptions/keyword arrays/headings/FAQ — more than a judgment call, well under the writer's full article body

const REQUIRED_STRING_FIELDS = ['seoTitle', 'metaDescription', 'urlSlug', 'ogTitle', 'ogDescription'];
const REQUIRED_ARRAY_FIELDS = ['primaryKeywords', 'secondaryKeywords', 'longTailKeywords', 'headings', 'faq'];

// ---------------------------------------------------------------------------
// Prompt construction
//
// admin/index.html's New Article wizard ("Generate SEO Suggestions" button,
// Step 3) carries a hand-kept mirror of this function as buildSeoPromptBrowser
// — search admin/index.html for "mirrors scripts/seo-optimizer.js" to find
// it, and keep the two in sync if either changes. validate-admin-mirror-
// sync.js checks the two produce identical output automatically.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.title - the article's (working) title
 * @param {string} args.bodyText - the article's body text (plain text or HTML — judged as substance)
 * @param {Array<{name:string,type?:string,why?:string}>} args.checklist - retrieval-layer.js's
 *   checklist (§2 Step 6.6) — steers keyword choices toward entities the graph already knows about,
 *   same "don't invent facts the graph doesn't know" spirit as buildWriterPrompt's checklist.
 */
export function buildSeoPrompt({ topic, title, bodyText, checklist }) {
  const system =
    'You are an SEO specialist for a Malaysian trading education site (structured warrants, ' +
    'short-term trading on Bursa Malaysia). Given an article\'s topic, title, and body text, generate ' +
    'complete on-page SEO metadata. Ground every keyword/heading/FAQ in what the article actually ' +
    'says -- never invent a claim, stat, or credential that is not in the body text or the checklist ' +
    'below.\n\n' +
    'Requirements:\n' +
    '- seoTitle: <=60 characters, includes the primary keyword, compelling for search results.\n' +
    '- metaDescription: <=160 characters, includes the primary keyword, ends with a soft call to action.\n' +
    '- urlSlug: lowercase, hyphen-separated, no stopwords, <=60 characters.\n' +
    '- ogTitle / ogDescription: social-share variants (may repeat seoTitle/metaDescription if already good).\n' +
    '- primaryKeywords: 1-3 core search terms this article should rank for.\n' +
    '- secondaryKeywords: 3-8 supporting terms.\n' +
    '- longTailKeywords: 3-8 longer, more specific search phrases a reader might actually type.\n' +
    '- headings: a proper H1-H4 outline for the article, as {"level":2-4,"text":"..."} objects (no H1 -- ' +
    'the page template supplies that from the title), in document order, reflecting the body\'s actual structure.\n' +
    '- faq: 3-6 {"question":"...","answer":"..."} pairs suitable for an FAQPage schema block, answered ' +
    'only from the article\'s own content.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"seoTitle":"...","metaDescription":"...","urlSlug":"...","ogTitle":"...","ogDescription":"...",' +
    '"primaryKeywords":["..."],"secondaryKeywords":["..."],"longTailKeywords":["..."],' +
    '"headings":[{"level":2,"text":"..."}],"faq":[{"question":"...","answer":"..."}]}';

  const checklistText = checklist.length
    ? checklist.map((c) => `- "${c.name}"${c.type ? ` (${c.type})` : ''}`).join('\n')
    : '(no specific checklist items — this topic did not match the existing knowledge graph)';

  const user =
    `Topic: ${topic}\nTitle: ${title}\n\n` +
    `Known-relevant entities for this topic (ground keywords/headings in these where natural):\n${checklistText}\n\n` +
    `Article body text:\n${bodyText}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing / validation
// ---------------------------------------------------------------------------

export function parseSeoResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`SEO writer response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`SEO writer response is not an object.\nRaw response:\n${rawText}`);
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`SEO writer response missing non-empty string field "${field}": ${JSON.stringify(parsed)}`);
    }
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(parsed[field]) || !parsed[field].length) {
      throw new Error(`SEO writer response missing non-empty array field "${field}": ${JSON.stringify(parsed)}`);
    }
  }
  for (const h of parsed.headings) {
    if (!h || typeof h.level !== 'number' || h.level < 2 || h.level > 4 || typeof h.text !== 'string' || !h.text.trim()) {
      throw new Error(`SEO writer response has a malformed heading entry (needs level 2-4 + non-empty text): ${JSON.stringify(h)}`);
    }
  }
  for (const f of parsed.faq) {
    if (!f || typeof f.question !== 'string' || !f.question.trim() || typeof f.answer !== 'string' || !f.answer.trim()) {
      throw new Error(`SEO writer response has a malformed faq entry (needs non-empty question + answer): ${JSON.stringify(f)}`);
    }
  }

  return {
    seoTitle: parsed.seoTitle.trim(),
    metaDescription: parsed.metaDescription.trim(),
    urlSlug: parsed.urlSlug.trim(),
    ogTitle: parsed.ogTitle.trim(),
    ogDescription: parsed.ogDescription.trim(),
    primaryKeywords: parsed.primaryKeywords,
    secondaryKeywords: parsed.secondaryKeywords,
    longTailKeywords: parsed.longTailKeywords,
    headings: parsed.headings,
    faq: parsed.faq,
  };
}

// ---------------------------------------------------------------------------
// Writers (pluggable — same DI pattern as every sibling script)
// ---------------------------------------------------------------------------

export async function openAISeoWriter(
  { system, user },
  { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_SEO_MODEL, topic } = {}
) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this ' +
        'script for real, or pass --seo-fixture-dir to validate offline (see scripts/README.md).'
    );
  }
  return callOpenAIChat({
    apiKey,
    model,
    system,
    user,
    maxTokens: MAX_TOKENS,
    temperature: 0.3, // metadata generation — light variation is fine, unlike the reviewer's judgment call
    callerLabel: `seo-optimizer.js openAISeoWriter${topic ? ` ("${topic}")` : ''}`,
  });
}

/** Offline writer: reads <fixtureDir>/<slugifyTopic(topic)>.json — reuses
 *  generate-article.js's slugifyTopic (imported, not reimplemented) so the
 *  same fixture-key convention applies across every writer-shaped script. */
export function fixtureSeoWriter(_promptObj, { fixtureDir, topic }) {
  const fixturePath = path.join(fixtureDir, `${slugifyTopic(topic)}.json`);
  if (!existsSync(fixturePath)) {
    throw new Error(`No SEO fixture at ${path.relative(REPO_ROOT, fixturePath)} for topic "${topic}"`);
  }
  return readFileSync(fixturePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.db - anything retrieval-layer.js's buildRetrievalContext accepts
 * @param {string} args.topic
 * @param {string} args.title
 * @param {string} args.bodyText
 * @param {Function} [args.seoWriter=openAISeoWriter] - (promptObj, opts) => string|Promise<string>
 * @param {object} [args.seoWriterOpts]
 */
export async function generateSeoMetadata({ db, topic, title, bodyText, seoWriter = openAISeoWriter, seoWriterOpts = {} }) {
  const retrievalContext = buildRetrievalContext(db, topic, { candidateTitle: title });
  const promptObj = buildSeoPrompt({ topic, title, bodyText, checklist: retrievalContext.checklist });
  const raw = await seoWriter(promptObj, { ...seoWriterOpts, topic });
  const metadata = parseSeoResponse(raw);
  return { topic, title, retrievalContext, metadata };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    topic: null,
    title: null,
    bodyFilePath: null,
    model: DEFAULT_SEO_MODEL,
    seoFixtureDir: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--topic':
        opts.topic = nextArg(argv, ++i, '--topic');
        break;
      case '--title':
        opts.title = nextArg(argv, ++i, '--title');
        break;
      case '--body-file':
        opts.bodyFilePath = path.resolve(nextArg(argv, ++i, '--body-file'));
        break;
      case '--model':
        opts.model = nextArg(argv, ++i, '--model');
        break;
      case '--seo-fixture-dir':
        opts.seoFixtureDir = path.resolve(nextArg(argv, ++i, '--seo-fixture-dir'));
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.topic) throw new Error('--topic is required');
  if (!opts.title) throw new Error('--title is required');
  if (!opts.bodyFilePath) throw new Error('--body-file is required');
  return opts;
}

function printHuman(result) {
  const m = result.metadata;
  console.log(`Topic: "${result.topic}"\nTitle: "${result.title}"\n`);
  console.log(`SEO title: ${m.seoTitle}`);
  console.log(`Meta description: ${m.metaDescription}`);
  console.log(`URL slug: ${m.urlSlug}`);
  console.log(`OG title: ${m.ogTitle}`);
  console.log(`OG description: ${m.ogDescription}`);
  console.log(`\nPrimary keywords: ${m.primaryKeywords.join(', ')}`);
  console.log(`Secondary keywords: ${m.secondaryKeywords.join(', ')}`);
  console.log(`Long-tail keywords: ${m.longTailKeywords.join(', ')}`);
  console.log(`\nHeadings (${m.headings.length}):`);
  for (const h of m.headings) console.log(`  ${'  '.repeat(h.level - 2)}H${h.level}: ${h.text}`);
  console.log(`\nFAQ (${m.faq.length}):`);
  for (const f of m.faq) console.log(`  Q: ${f.question}\n  A: ${f.answer}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const seoWriter = opts.seoFixtureDir
    ? (promptObj, wOpts) => fixtureSeoWriter(promptObj, { fixtureDir: opts.seoFixtureDir, topic: wOpts.topic })
    : openAISeoWriter;

  const bodyText = readFileSync(opts.bodyFilePath, 'utf-8');

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  let result;
  try {
    result = await generateSeoMetadata({
      db,
      topic: opts.topic,
      title: opts.title,
      bodyText,
      seoWriter,
      seoWriterOpts: { model: opts.model },
    });
  } finally {
    db.close();
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
