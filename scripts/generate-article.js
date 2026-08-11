#!/usr/bin/env node
/**
 * Article generation pipeline — extra-md-files/ai-article-pipeline.md §4
 * Phase 3 (AI Content Generation) built in the SAME pass as §5's coverage
 * reviewer, per the doc's own build-order instruction: "build the §5
 * coverage-reviewer sub-step in the same pass as this phase, not retrofitted
 * later."
 *
 * Order of operations (§5's "AI path"):
 *   1. Pick topic (--topic)
 *   2. Query knowledge-graph.db for candidate entities/facts — reuses
 *      retrieval-layer.js's buildRetrievalContext() (§2 Step 6) rather than
 *      building a second query, per that file's own stated contract.
 *   3. Build the checklist — retrieval context's `checklist` (§2 Step 6.6)
 *      plus any manually-curated --must-include-facts, merged into one list.
 *   4. Generate draft — writer LLM call (buildWriterPrompt below), checklist
 *      included in the prompt.
 *   5. Review draft against checklist — reviewer LLM call, a SEPARATE call
 *      from the writer (coverage-reviewer.js's buildReviewPrompt) — never the
 *      writer self-checking its own output (§5: shares the same blind spots
 *      that caused the omission in the first place).
 *   6. (<=1 retry) feed missing/partial items back to the writer as a repair
 *      prompt, regenerate, re-review once. Whatever is still missing/partial
 *      afterward is handed to Phase 8 (the human) as-is — never silently
 *      dropped or force-inserted (§5's own explicit cap + rationale).
 *   7. Return the draft + coverage result together — Phase 8's job (the
 *      admin's Knowledge Coverage panel) picks this up from here; this script
 *      does not publish anything itself.
 *
 * Phase 3's fuller scope (SEO optimisation = §4 Phase 4, internal-link
 * insertion = Phase 5, content-hierarchy enforcement = Phase 6) is NOT built
 * here — those are later, separate build-order items that also consume
 * retrieval-layer.js's context (see that file's own phase-to-field mapping).
 * This script's writer call still receives `nearDuplicates`/`suggestedLinks`
 * so it can steer away from duplicate coverage and mention related articles
 * naturally, but it does not auto-insert `<a>` tags or generate meta tags.
 *
 * Both the writer and the reviewer are dependency-injected (same pattern as
 * every other LLM-backed script in this directory) so this is testable
 * without spending API calls — see validate-generate-article.js.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node generate-article.js --topic "Time Decay"
 *   node generate-article.js --topic "..." --must-include-facts facts.json
 *   node generate-article.js --topic "..." --source-file column.txt   # optional single reference text (§4 Phase 1's manual-paste fallback)
 *   node generate-article.js --topic "..." --json                    # machine-readable output
 *   node generate-article.js --topic "..." \
 *     --writer-fixture-dir DIR --reviewer-fixture-dir DIR             # fully offline, see README
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext } from './retrieval-layer.js';
import { buildReviewPrompt, parseReviewResponse, summarizeReview, openAIReviewer, fixtureReviewer } from './coverage-reviewer.js';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_WRITER_MODEL = 'gpt-4o'; // generation task — worth the stronger tier (§6)
const DEFAULT_REVIEWER_MODEL = 'gpt-4o-mini'; // judgment task — "can be the same or a cheaper model than the writer" (§5)
const MAX_RETRIES_ALLOWED = 1; // §5: "Cap auto-repair at 1 retry" — not a tunable-up-forever knob
const MAX_TOKENS = 4000; // a full article body (title+summary+body_text JSON) — the largest single-call budget in this directory

// ---------------------------------------------------------------------------
// Checklist assembly — §5 "The checklist": entities + must-include facts
// ---------------------------------------------------------------------------

/** Merges retrieval-layer.js's entity checklist (§2 Step 6.6) with manually-
 *  curated must-include facts (§5's second checklist source, "specific
 *  claims/numbers/dates/credentials the admin marks non-negotiable") into one
 *  flat list both the writer and reviewer prompts consume unchanged. */
export function buildFullChecklist(entityChecklist, mustIncludeFacts) {
  const factItems = mustIncludeFacts.map((fact) => ({
    name: fact,
    type: 'fact',
    why: 'marked as a must-include fact for this article — non-negotiable',
  }));
  return [...entityChecklist, ...factItems];
}

function formatChecklistForWriter(checklist) {
  if (!checklist.length) return '(no specific checklist items — this topic did not match the existing graph; write from the topic alone)';
  return checklist.map((c) => `- "${c.name}"${c.type ? ` (${c.type})` : ''}${c.why ? ` — ${c.why}` : ''}`).join('\n');
}

// ---------------------------------------------------------------------------
// Writer prompt construction (Phase 3)
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.topic
 * @param {Array} args.checklist - buildFullChecklist() output
 * @param {Array} args.mustIncludeFacts - raw fact strings, for the prompt's own callout
 * @param {Array} args.articleSummaries - retrieval-layer.js's articleSummaries (title/summary only,
 *   deliberately NOT full body_text — keeps the prompt small per §5's own "no need to resend full
 *   source articles" stance, and reduces the temptation to paraphrase an existing page sentence-by-
 *   sentence, which §4 Phase 3 explicitly forbids)
 * @param {Array} args.nearDuplicates - retrieval-layer.js's nearDuplicates
 * @param {string|null} [args.sourceText] - optional single reference text (e.g. a manually-pasted
 *   Nanyang column — §4 Phase 1's fallback for paywalled content; Phase 1's import pipeline itself
 *   is not built, this is just an optional extra input)
 */
export function buildWriterPrompt({ topic, checklist, mustIncludeFacts, articleSummaries, nearDuplicates, sourceText }) {
  const system =
    'You are ghostwriting an article for Warren Mak, a Malaysian trading educator: 32 years of ' +
    'market experience, former Head of 5 departments at Bursa Malaysia, weekly Nanyang Siang Pau ' +
    'columnist since January 2018. Write for retail traders learning structured warrants and ' +
    'short-term trading on Bursa Malaysia.\n\n' +
    'Writing principles (apply to every article): write like Warren Mak -- direct, practical, ' +
    'credibility-backed; maintain educational accuracy; explain clearly; write naturally and avoid ' +
    'repetitive wording; preserve his teaching style; prioritise readability; create GENUINELY ' +
    'ORIGINAL content.\n\n' +
    'You may be given SUMMARIES of related articles already published on the site. Treat them as ' +
    'background context only -- NEVER copy paragraphs, lightly paraphrase, rewrite sentence-by-' +
    'sentence, or reproduce another article\'s structure. Produce new structure, new wording, new ' +
    'flow, new explanations. If a near-duplicate warning is given for an existing article, angle ' +
    'this new article differently from it (a different strategy, audience, or angle) instead of ' +
    'restating the same ground.\n\n' +
    'You are given a CHECKLIST of entities/facts this article should cover -- cover every item ' +
    'somewhere in the article, substantively (not just a passing mention); a separate reviewer will ' +
    'check this afterward, so do not skip any. Must-include facts are non-negotiable and must appear ' +
    'accurately, exactly as given -- never alter a number, date, or credential.\n\n' +
    (sourceText
      ? 'You are also given ONE specific source text to draw ideas from -- extract ideas, reorganise ' +
        'concepts, explain differently; do not reproduce its wording or structure.\n\n'
      : '') +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"title":"...","summary":"<1-2 sentence summary>","body_text":"<the full article body as plain ' +
    'paragraphs separated by blank lines -- no HTML>"}';

  const userParts = [`Topic: ${topic}`];
  userParts.push(`\nChecklist (${checklist.length} item(s)) -- cover every one substantively:\n${formatChecklistForWriter(checklist)}`);
  if (mustIncludeFacts.length) {
    userParts.push(`\nMust-include facts (non-negotiable, must appear accurately):\n${mustIncludeFacts.map((f) => `- ${f}`).join('\n')}`);
  }
  if (articleSummaries.length) {
    userParts.push(
      `\nRelated articles already published on this site (background only -- do not copy):\n` +
        articleSummaries
          .slice(0, 5)
          .map((a) => `- "${a.title}" (${a.slug}): ${a.summary}`)
          .join('\n')
    );
  }
  if (nearDuplicates.length) {
    userParts.push(
      `\nNear-duplicate coverage warnings -- angle this new article differently from these:\n` +
        nearDuplicates.map((d) => `- [${d.level}] "${d.title}": ${d.note}`).join('\n')
    );
  }
  if (sourceText) {
    userParts.push(`\nSource text to draw ideas from (do not reproduce verbatim):\n${sourceText}`);
  }

  return { system, user: userParts.join('\n') };
}

/** The repair prompt for §5 step 6's single retry: feeds the missing/partial
 *  items straight back to the writer with the existing draft, asking for a
 *  targeted revision rather than a from-scratch rewrite — "keep everything
 *  that already works" is what keeps this a repair, not a second Phase 3 call
 *  that happens to throw away the first draft's good parts. */
export function buildRepairPrompt({ topic, checklist, draft, missing, partial }) {
  const system =
    'You are revising a draft article to fix specific coverage gaps a separate reviewer flagged. ' +
    'Keep everything that already works in the draft -- do not rewrite the whole article from ' +
    'scratch, only extend or adjust it so every listed gap is substantively covered. Do not remove ' +
    'or contradict anything already correct in the draft.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"title":"...","summary":"...","body_text":"<the full REVISED article body, plain paragraphs, no HTML>"}';

  const gapLines = [
    ...missing.map((i) => `- MISSING entirely: "${i.name}"`),
    ...partial.map((i) => `- Only PARTIALLY covered: "${i.name}" (current evidence: "${i.evidence || '(none)'}")`),
  ];

  const user =
    `Topic: ${topic}\n\n` +
    `Current draft title: ${draft.title}\n` +
    `Current draft body text:\n${draft.body_text}\n\n` +
    `Coverage gaps to fix (from a separate reviewer pass):\n${gapLines.join('\n')}\n\n` +
    `Full checklist for reference (${checklist.length} item(s)):\n${formatChecklistForWriter(checklist)}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Writer response parsing
// ---------------------------------------------------------------------------

export function parseWriterResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Writer response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (
    !parsed ||
    typeof parsed.title !== 'string' || !parsed.title.trim() ||
    typeof parsed.summary !== 'string' || !parsed.summary.trim() ||
    typeof parsed.body_text !== 'string' || !parsed.body_text.trim()
  ) {
    throw new Error(`Writer response missing non-empty "title"/"summary"/"body_text": ${JSON.stringify(parsed)}`);
  }
  return { title: parsed.title.trim(), summary: parsed.summary.trim(), body_text: parsed.body_text.trim() };
}

// ---------------------------------------------------------------------------
// Writers (pluggable — same dependency-injection pattern as every sibling script)
// ---------------------------------------------------------------------------

export async function openAIWriter(
  { system, user },
  { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_WRITER_MODEL, topic, attempt } = {}
) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this ' +
        'script for real, or pass --writer-fixture-dir to validate offline (see scripts/README.md).'
    );
  }
  return callOpenAIChat({
    apiKey,
    model,
    system,
    user,
    maxTokens: MAX_TOKENS,
    temperature: 0.7, // generation task, not judgment — some variation is fine/expected here
    callerLabel: `generate-article.js openAIWriter${topic ? ` ("${topic}"${attempt ? `, ${attempt}` : ''})` : ''}`,
  });
}

export function slugifyTopic(topic) {
  return topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'topic';
}

/** Offline writer: reads <fixtureDir>/<slug>.json for the initial attempt, or
 *  <fixtureDir>/<slug>.repair.json for the post-review retry — two files
 *  because a real run makes two DIFFERENT writer calls (initial + repair),
 *  and a fixture harness needs to be able to tell them apart. */
export function fixtureWriter(_promptObj, { fixtureDir, topic, attempt }) {
  const key = slugifyTopic(topic) + (attempt === 'repair' ? '.repair' : '');
  const fixturePath = path.join(fixtureDir, `${key}.json`);
  if (!existsSync(fixturePath)) {
    throw new Error(`No writer fixture at ${path.relative(REPO_ROOT, fixturePath)} for topic "${topic}" (attempt=${attempt})`);
  }
  return readFileSync(fixturePath, 'utf-8');
}

/** Adapts coverage-reviewer.js's fixtureReviewer (which takes a bare
 *  `fixturePath`) to this script's <fixtureDir>/<slug>[.repair].json naming,
 *  mirroring fixtureWriter above so both fixture directories are laid out
 *  the same way. */
export function fixtureReviewerByTopic(promptObj, { fixtureDir, topic, attempt }) {
  const key = slugifyTopic(topic) + (attempt === 'repair' ? '.repair' : '');
  return fixtureReviewer(promptObj, { fixturePath: path.join(fixtureDir, `${key}.json`) });
}

// ---------------------------------------------------------------------------
// Orchestration — the §5 "AI path" order of operations, steps 2-7
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.db - anything retrieval-layer.js's buildRetrievalContext accepts
 * @param {string} args.topic
 * @param {string[]} [args.mustIncludeFacts]
 * @param {string|null} [args.sourceText]
 * @param {Function} args.writer - (promptObj, opts) => string|Promise<string>
 * @param {object} [args.writerOpts]
 * @param {Function} args.reviewer - (promptObj, opts) => string|Promise<string>
 * @param {object} [args.reviewerOpts]
 * @param {number} [args.maxRetries=1] - capped at MAX_RETRIES_ALLOWED (§5)
 */
export async function generateArticleWithReview({
  db,
  topic,
  mustIncludeFacts = [],
  sourceText = null,
  writer,
  writerOpts = {},
  reviewer,
  reviewerOpts = {},
  maxRetries = MAX_RETRIES_ALLOWED,
}) {
  if (maxRetries > MAX_RETRIES_ALLOWED) {
    throw new Error(`maxRetries cannot exceed ${MAX_RETRIES_ALLOWED} — §5 explicitly caps auto-repair at 1 retry.`);
  }

  // Step 2-3: retrieval-layer.js's one composed query, then merge in must-include facts.
  const retrievalContext = buildRetrievalContext(db, topic);
  const checklist = buildFullChecklist(retrievalContext.checklist, mustIncludeFacts);

  // Step 4: writer call (initial).
  const writerPrompt = buildWriterPrompt({
    topic,
    checklist,
    mustIncludeFacts,
    articleSummaries: retrievalContext.articleSummaries,
    nearDuplicates: retrievalContext.nearDuplicates,
    sourceText,
  });
  let draft = parseWriterResponse(await writer(writerPrompt, { ...writerOpts, topic, attempt: 'initial' }));

  // Step 5: reviewer call — a SEPARATE LLM call, never the writer self-checking.
  let review = parseReviewResponse(
    await reviewer(buildReviewPrompt({ checklist, draftText: draft.body_text }), { ...reviewerOpts, topic, attempt: 'initial' })
  );
  let summary = summarizeReview(review);
  let retryCount = 0;

  // Step 6: <=1 auto-repair retry, only if there's an actual checklist to have gaps against.
  if (!summary.allCovered && checklist.length && retryCount < maxRetries) {
    const repairPrompt = buildRepairPrompt({ topic, checklist, draft, missing: summary.missing, partial: summary.partial });
    draft = parseWriterResponse(await writer(repairPrompt, { ...writerOpts, topic, attempt: 'repair' }));
    review = parseReviewResponse(
      await reviewer(buildReviewPrompt({ checklist, draftText: draft.body_text }), { ...reviewerOpts, topic, attempt: 'repair' })
    );
    summary = summarizeReview(review);
    retryCount = 1;
  }

  // Step 7: hand off to Phase 8 with the coverage result attached — this function does not publish.
  return { topic, retrievalContext, checklist, draft, review, summary, retryCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    topic: null,
    writerModel: DEFAULT_WRITER_MODEL,
    reviewerModel: DEFAULT_REVIEWER_MODEL,
    mustIncludeFactsPath: null,
    sourceFilePath: null,
    maxRetries: MAX_RETRIES_ALLOWED,
    writerFixtureDir: null,
    reviewerFixtureDir: null,
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
      case '--writer-model':
        opts.writerModel = nextArg(argv, ++i, '--writer-model');
        break;
      case '--reviewer-model':
        opts.reviewerModel = nextArg(argv, ++i, '--reviewer-model');
        break;
      case '--must-include-facts':
        opts.mustIncludeFactsPath = path.resolve(nextArg(argv, ++i, '--must-include-facts'));
        break;
      case '--source-file':
        opts.sourceFilePath = path.resolve(nextArg(argv, ++i, '--source-file'));
        break;
      case '--max-retries': {
        const n = Number(nextArg(argv, ++i, '--max-retries'));
        if (!Number.isInteger(n) || n < 0) throw new Error('--max-retries must be a non-negative integer');
        opts.maxRetries = n;
        break;
      }
      case '--writer-fixture-dir':
        opts.writerFixtureDir = path.resolve(nextArg(argv, ++i, '--writer-fixture-dir'));
        break;
      case '--reviewer-fixture-dir':
        opts.reviewerFixtureDir = path.resolve(nextArg(argv, ++i, '--reviewer-fixture-dir'));
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.topic) throw new Error('--topic is required');
  return opts;
}

function printHuman(result) {
  console.log(`Topic: "${result.topic}"`);
  if (result.retrievalContext.note) console.log(`Retrieval note: ${result.retrievalContext.note}`);
  console.log(`Checklist: ${result.checklist.length} item(s)\n`);

  console.log(`--- Draft ---`);
  console.log(`Title: ${result.draft.title}`);
  console.log(`Summary: ${result.draft.summary}`);
  console.log(`Body (${result.draft.body_text.length} chars): ${result.draft.body_text.slice(0, 200)}${result.draft.body_text.length > 200 ? '…' : ''}\n`);

  console.log(`--- Coverage (after ${result.retryCount} repair retr${result.retryCount === 1 ? 'y' : 'ies'}) ---`);
  console.log(`covered: ${result.summary.covered.length}, partial: ${result.summary.partial.length}, missing: ${result.summary.missing.length}`);
  for (const item of [...result.summary.partial, ...result.summary.missing]) {
    console.log(`  - [${item.status}] ${item.name}${item.evidence ? ` — "${item.evidence}"` : ''}`);
  }
  if (result.summary.missing.length || result.summary.partial.length) {
    console.log(`\n! Gaps remain after the retry cap — handing off to Phase 8 (human review) as-is, nothing auto-inserted.`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const writer = opts.writerFixtureDir
    ? (promptObj, wOpts) => fixtureWriter(promptObj, { fixtureDir: opts.writerFixtureDir, topic: wOpts.topic, attempt: wOpts.attempt })
    : openAIWriter;
  const reviewer = opts.reviewerFixtureDir
    ? (promptObj, rOpts) => fixtureReviewerByTopic(promptObj, { fixtureDir: opts.reviewerFixtureDir, topic: rOpts.topic, attempt: rOpts.attempt })
    : openAIReviewer;

  let mustIncludeFacts = [];
  if (opts.mustIncludeFactsPath) {
    mustIncludeFacts = JSON.parse(readFileSync(opts.mustIncludeFactsPath, 'utf-8'));
    if (!Array.isArray(mustIncludeFacts) || !mustIncludeFacts.every((fact) => typeof fact === 'string' && fact.length > 0)) {
      throw new Error(
        `--must-include-facts must be a JSON array of non-empty strings (file: ${opts.mustIncludeFactsPath})`
      );
    }
  }
  const sourceText = opts.sourceFilePath ? readFileSync(opts.sourceFilePath, 'utf-8') : null;

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  let result;
  try {
    result = await generateArticleWithReview({
      db,
      topic: opts.topic,
      mustIncludeFacts,
      sourceText,
      writer,
      writerOpts: { model: opts.writerModel },
      reviewer,
      reviewerOpts: { model: opts.reviewerModel },
      maxRetries: opts.maxRetries,
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
