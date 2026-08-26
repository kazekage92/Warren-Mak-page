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
 *   6. (<=1 retry) feed missing/partial items — and, per extra-md-files/
 *      article-length-expansion.md, a still-under-target word count — back
 *      to the writer as a repair prompt, regenerate, re-review once.
 *      Whatever is still missing/partial/short afterward is handed to
 *      Phase 8 (the human) as-is — never silently dropped, force-inserted,
 *      or retried past the cap (§5's own explicit cap + rationale, and the
 *      length target's own "soft target, never blocks" decision). Steps
 *      5-6 are wrapped so a reviewer/repair failure never discards the
 *      writer's already-paid-for draft — see generateArticleWithReview()'s
 *      own doc comment for the `reviewCoverageFailed` fallback this returns
 *      instead of throwing (mirrors admin/index.html's browser counterpart).
 *   7. §4 Phase 5 — auto-insert internal links: once the final draft is
 *      settled (after any repair retry), wrap the first verbatim mention of
 *      each `suggestedLinks` entity in an ordinary `<a>` tag pointing at that
 *      article, via retrieval-layer.js's `insertSuggestedLinks()`. Runs once,
 *      on the FINAL body text — not before review, so the reviewer always
 *      judges the writer's own plain-text coverage, never text this pipeline
 *      itself modified.
 *   8. Return the linked draft + coverage result + link-insertion report
 *      together — Phase 8's job (the admin's Knowledge Coverage panel) picks
 *      this up from here; this script does not publish anything itself.
 *
 * The writer's (and repair's) response also carries two fields beyond
 * title/summary/body_text, added for extra-md-files/automated-article-
 * scheduler.md component 2 ("Chart auto-generation") even though that
 * component's own consumer (graph-blocks.js) is NOT built in this pass —
 * these are additive to what this file already produces, not a new phase:
 *   - `suggestedGraphSteps`: 2-5 short imperative-style labels summarizing
 *     the article's own core process/sequence, grounded in the draft's own
 *     already-reviewed body text (never inventing a new claim).
 *   - `body_text` section breaks: real section-heading paragraphs are
 *     prefixed with "## " on their own line, so a future HTML assembler has
 *     real heading structure to build on instead of one undifferentiated
 *     block of paragraphs. See parseWriterResponse()'s validation of both.
 *
 * Phase 3's fuller scope (SEO optimisation = §4 Phase 4, content-hierarchy
 * enforcement = Phase 6) is NOT built here — those are separate, standalone
 * build-order items that also consume retrieval-layer.js's context (see that
 * file's own phase-to-field mapping). Phase 5 (internal-link insertion) IS
 * built here, as step 7 above — the one piece of "Phase 3's fuller scope"
 * that naturally belongs at the end of this pipeline rather than standing
 * alone, since it needs the already-finished draft body text to insert into.
 * This script's writer call still receives `nearDuplicates`/`suggestedLinks`
 * so it can steer away from duplicate coverage and mention related articles
 * naturally in its own words; step 7 is what turns those natural mentions
 * into real `<a>` links afterward. Meta-tag generation is still not this
 * script's job — call `seo-optimizer.js` separately for that.
 *
 * Both the writer and the reviewer are dependency-injected (same pattern as
 * every other LLM-backed script in this directory) so this is testable
 * without spending API calls — see validate-generate-article.js.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node generate-article.js --topic "Time Decay"
 *   node generate-article.js --topic "..." --must-include-facts facts.json
 *   node generate-article.js --topic "..." --source-file column.txt   # optional single reference text (§4 Phase 1's manual-paste fallback)
 *   node generate-article.js --topic "..." --source-keyword ipo       # §4 Phase 2: narrow candidateSourceArticles to a source_articles.keywords facet
 *   node generate-article.js --topic "..." --source-category "fundamental analysis"
 *   node generate-article.js --topic "..." --json                    # machine-readable output
 *   node generate-article.js --topic "..." --target-words 500        # override the 2,200-word soft length target (0 disables it)
 *   node generate-article.js --topic "..." \
 *     --writer-fixture-dir DIR --reviewer-fixture-dir DIR             # fully offline, see README
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext, insertSuggestedLinks, CONTRAST_RELATIONS } from './retrieval-layer.js';
import { buildReviewPrompt, parseReviewResponse, summarizeReview, openAIReviewer, fixtureReviewer } from './coverage-reviewer.js';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';
import { formatChecklistItems } from './checklist-format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_WRITER_MODEL = 'gpt-4o'; // generation task — worth the stronger tier (§6)
const DEFAULT_REVIEWER_MODEL = 'gpt-4o-mini'; // judgment task — "can be the same or a cheaper model than the writer" (§5)
const MAX_RETRIES_ALLOWED = 1; // §5: "Cap auto-repair at 1 retry" — not a tunable-up-forever knob
const MAX_TOKENS = 8000; // a full article body (title+summary+body_text JSON) — the largest single-call budget in this directory; headroom over the new 10-minute-read target (TARGET_BODY_WORD_COUNT_EN = 2,200 words ≈ 2,900 tokens of body alone at ~1.3 tokens/word, plus JSON envelope/heading-marker/inline-emphasis overhead and margin for the repair pass expanding further) — re-tune from real data.completion_tokens usage (see callOpenAIChat) rather than guessing further

// extra-md-files/article-length-expansion.md: a "10-minute read" target — ~2,200-2,500 words of
// English body_text at ~230 wpm reading speed. A SOFT target only (owner decision, 2026-08-21):
// never blocks Save-as-Draft/Publish, informational the same way reviewCoverageFailed/
// offTopicSections already are below — see generateArticleWithReview()'s wordCount/
// meetsLengthTarget return fields. Chinese (zh) bodies are produced separately, by the translate*
// functions elsewhere (never generated fresh by this pipeline), so there is no separate zh target
// constant here — see that doc's "Open questions" section for the reading-speed assumption this is
// based on, and its own note that a CJK-adjusted target is a separate, not-yet-built concern for
// whichever pass eventually generates/checks zh body length.
const TARGET_BODY_WORD_COUNT_EN = 2200;

// extra-md-files/automated-article-scheduler.md component 2 ("Chart auto-generation"):
// the writer must also return 2-5 short imperative-style labels summarizing the
// article's own core process/sequence, grounded in the draft's own already-reviewed
// body text — this is the input graph-blocks.js (not built in this pass) will turn into
// a `.graph-block--flow` diagram, and body_text must carry at least one "## " section-
// break line so an HTML assembler downstream has real heading structure to work with
// instead of one undifferentiated block of paragraphs. Both are validated in
// parseWriterResponse() below, same strictness as every other required field here.
const MIN_GRAPH_STEPS = 2;
const MAX_GRAPH_STEPS = 5;
const SECTION_BREAK_PATTERN = /^##\s+\S.*$/m; // a line starting "## " — the assembler's future <h2> marker

// ---------------------------------------------------------------------------
// Checklist assembly — §5 "The checklist": entities + must-include facts
// ---------------------------------------------------------------------------

/** Lowercased, punctuation-stripped word list — the unit `factsNearDuplicate`
 *  compares over. */
function factTokens(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Token-set Jaccard similarity (0..1) between two strings. */
function jaccardSimilarity(a, b) {
  const ta = new Set(factTokens(a));
  const tb = new Set(factTokens(b));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// A fact only collapses into an earlier fact when it's essentially the same
// sentence reworded, not merely on-topic — 0.8 is deliberately high so that
// e.g. "Warren Mak has 32 years of market experience" and "Warren spent 32
// years at Bursa Malaysia" (different claims that share some words) both
// survive as independent, independently-reviewable checklist rows.
const FACT_NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.8;

/** True if `a` and `b` are a near-exact restatement of the same fact — exact
 *  case-insensitive match, or high enough word-overlap (Jaccard) to be the
 *  same claim reworded. This is deliberately NOT "one string contains the
 *  other": a plain-containment check would also swallow facts that merely
 *  mention a shared name inside an otherwise distinct sentence (see module
 *  doc comment above buildFullChecklist). Empty strings never "match"
 *  anything, so they can't blanket-dedupe the checklist. */
function factsNearDuplicate(a, b) {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb || jaccardSimilarity(a, b) >= FACT_NEAR_DUPLICATE_JACCARD_THRESHOLD;
}

/** Merges retrieval-layer.js's entity checklist (§2 Step 6.6) with manually-
 *  curated must-include facts (§5's second checklist source, "specific
 *  claims/numbers/dates/credentials the admin marks non-negotiable") into one
 *  flat list both the writer and reviewer prompts consume unchanged.
 *
 *  A must-include fact is only skipped when it's a near-exact restatement
 *  (see factsNearDuplicate above) of a fact ALREADY IN THE LIST — never
 *  against a plain entity-name checklist item. "Bursa Malaysia" (an entity)
 *  and "Warren spent 32 years at Bursa Malaysia" (a fact) are different
 *  claims — one naming a thing, the other making a claim about it — and both
 *  deserve independent reviewer verification, even though the fact's text
 *  contains the entity's name. Only two facts that restate the same claim
 *  collapse to one row. */
export function buildFullChecklist(entityChecklist, mustIncludeFacts) {
  const merged = [...entityChecklist];
  const addedFacts = [];
  for (const fact of mustIncludeFacts) {
    if (addedFacts.some((existingFact) => factsNearDuplicate(existingFact, fact))) continue;
    addedFacts.push(fact);
    merged.push({
      name: fact,
      type: 'fact',
      why: 'marked as a must-include fact for this article — non-negotiable',
    });
  }
  return merged;
}

function formatChecklistForWriter(checklist) {
  if (!checklist.length) return '(no specific checklist items — this topic did not match the existing graph; write from the topic alone)';
  return formatChecklistItems(checklist);
}

/** Rough word count of a draft body_text, for comparing against
 *  TARGET_BODY_WORD_COUNT_EN. Strips "## "-prefixed heading-marker lines'
 *  own "## " prefix (so the literal "##" characters don't get counted as an
 *  extra word) before splitting on whitespace — inline <strong>/<em>/<u>
 *  tags are left as-is since they never introduce extra whitespace-separated
 *  tokens. Deliberately simple (no locale-aware tokenization) — it only
 *  needs to be consistent enough to compare against a target, not exact to
 *  the word. */
export function countBodyWords(bodyText) {
  const stripped = bodyText.replace(/^##\s+/gm, '');
  return stripped.trim().split(/\s+/).filter(Boolean).length;
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
 * @param {Array} [args.candidateSourceArticles] - retrieval-layer.js's candidateSourceArticles
 *   (§4 Phase 2 — related UNPUBLISHED `source_articles` rows found by keyword/category/topic, e.g.
 *   via --source-keyword). Same "title/summary only, never full body" treatment as
 *   articleSummaries above and the same reasoning: keeps the prompt small and avoids inviting the
 *   writer to paraphrase a specific source column sentence-by-sentence, which Phase 3 forbids.
 */
export function buildWriterPrompt({ topic, checklist, mustIncludeFacts, articleSummaries, nearDuplicates, sourceText, candidateSourceArticles = [] }) {
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
    'check this afterward, so do not skip any. Each item\'s reason (after the dash) tells you HOW it ' +
    'relates to the topic: items marked "directly matches the topic" are core to this article; items ' +
    'marked "related to the topic via: ..." are only loosely/indirectly connected -- cover those in ' +
    'proportion to their actual relevance (a clarifying sentence, or a short paragraph distinguishing ' +
    'them from the main topic, folded into a section that IS about the main topic, is enough) and do ' +
    'NOT give a loosely-related item its own dedicated section -- specifically, never title a section ' +
    'heading after the loosely-related item itself or frame a heading as "distinguishing"/"comparing" ' +
    'the main topic against it, even briefly -- unless it is genuinely central to the specific angle ' +
    'the topic asks for. A tangential entity padded into its own section, or given a heading built ' +
    'around its name, reads as off-topic to readers even though it is technically "covered". Must-' +
    'include facts are non-negotiable and must appear accurately, exactly as given -- never alter a ' +
    'number, date, or credential.\n\n' +
    'This article should be a genuinely in-depth, 10-minute-plus read: treat 2,200 words of body_text ' +
    'as a MINIMUM, not a suggestion (well beyond this site\'s older short-form articles). Reach that ' +
    'length by explaining each CENTRAL sub-topic more deeply -- more real-world examples, more step-' +
    'by-step mechanics, more context on WHY something matters -- never by padding with repetition or ' +
    'filler, and never by adding a section about a loosely-related checklist item just to add length ' +
    '(see the loosely-related-item guidance above -- that failure mode gets WORSE, not better, the ' +
    'more length you need to fill). Give each section 3-4 substantial paragraphs with real ' +
    'explanation, concrete examples, and actionable detail; do not stop as soon as a checklist item ' +
    'has been technically mentioned once -- a short article that merely name-checks each item reads ' +
    'as thin and unfinished next to the depth this site now expects.\n\n' +
    'Structure body_text into logical sections: on its own line immediately before each section\'s ' +
    'first paragraph, write a short heading prefixed with "## " (two hash characters, one space, ' +
    'then the heading text -- e.g. "## Understanding Time Decay"). Include 6-8 such section headings, ' +
    'each covering a distinct sub-topic that is genuinely CENTRAL to the topic\'s specific angle, in ' +
    'real depth (3-4 paragraphs) -- this is what actually gets body_text to the 2,200+ word target ' +
    'above, far more reliably than trying to hit a word count directly. If you need more headings\' ' +
    'worth of material, go deeper on an existing central sub-topic instead of adding a heading for a ' +
    'loosely-related checklist item. Only real section-heading lines get the "## " prefix -- ' +
    'never an ordinary paragraph. Also use inline formatting to keep the article readable and break ' +
    'up long stretches of plain paragraphs: wrap a key term or important point in <strong>...</strong> ' +
    'for bold, <em>...</em> for italic, or <u>...</u> for underline -- sparingly (a handful of times ' +
    'across the whole article), never an entire paragraph or a heading, and never nest one inside ' +
    'another. Also identify SUGGESTED GRAPH STEPS: 2-5 short imperative-style ' +
    'labels (e.g. "Identify the setup", "Confirm the signal", "Manage the position") summarizing ' +
    'this article\'s own core process or sequence -- ground every label strictly in what your draft ' +
    'itself already says, never inventing a claim the article does not cover; these labels feed an ' +
    'auto-generated flow diagram, so keep each one short (a few words).\n\n' +
    (candidateSourceArticles.length
      ? 'You may be given TITLES of related, unpublished Nanyang Siang Pau columns by Warren Mak that ' +
        'have not yet become a site article. Treat them the same as the published-article summaries ' +
        'above -- background context and ideas only, never copy paragraphs or structure.\n\n'
      : '') +
    (sourceText
      ? 'You are also given ONE specific source text to draw ideas from -- extract ideas, reorganise ' +
        'concepts, explain differently; do not reproduce its wording or structure.\n\n'
      : '') +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"title":"...","summary":"<1-2 sentence summary>","body_text":"<the full article body as plain ' +
    'paragraphs separated by blank lines, with \\"## \\"-prefixed section-heading lines and occasional ' +
    'inline <strong>/<em>/<u> emphasis -- no other HTML/markdown>","suggestedGraphSteps":["<2-5 short ' +
    'imperative-style labels>"]}';

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
  if (candidateSourceArticles.length) {
    userParts.push(
      `\nRelated unpublished Warren Mak columns (background only -- do not copy):\n` +
        candidateSourceArticles
          .slice(0, 5)
          .map((c) => `- "${c.title}"${c.category ? ` (${c.category})` : ''}`)
          .join('\n')
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
export function buildRepairPrompt({ topic, checklist, draft, missing, partial, offTopicSections = [], expandTarget = null }) {
  const system =
    'You are revising a draft article to fix specific gaps a separate review pass flagged. ' +
    'Keep everything that already works in the draft -- do not rewrite the whole article from ' +
    'scratch, only extend or adjust it so every listed gap is fixed. Do not remove ' +
    'or contradict anything already correct in the draft.\n\n' +
    (offTopicSections.length
      ? 'Some gaps below are OFF-TOPIC SECTION flags, not missing coverage: a section heading was ' +
        'built around an entity that should be DISTINGUISHED FROM the main topic (not folded into ' +
        'it) -- for each one, remove that section heading and fold a brief distinguishing mention ' +
        '(a sentence, or part of an existing paragraph in a section that IS about the main topic) in ' +
        'its place instead. Do not simply rename the heading -- the entity must no longer have its ' +
        'own dedicated heading at all.\n\n'
      : '') +
    (expandTarget
      ? 'Another gap below is a LENGTH gap: the current draft is only about ' + expandTarget.currentWords + ' words, ' +
        'well under this site\'s ' + expandTarget.targetWords + '-word target for a genuinely in-depth, 10-minute-' +
        'plus read. Expand the draft substantially -- add more real explanation, more concrete examples, more ' +
        'step-by-step mechanics, and more context on WHY something matters to sections that are ALREADY central ' +
        'to the topic. Do NOT reach the target by padding with repetition or filler, and do NOT add a new ' +
        'section headlined around a loosely-related checklist item just to add length -- that reproduces a ' +
        'known failure mode this pipeline already guards against (see the off-topic-section instructions above, ' +
        'if any). A new section is fine ONLY if it covers a genuinely central sub-topic the current draft is ' +
        'missing.\n\n'
      : '') +
    'The draft\'s "## "-prefixed section-heading lines, its inline <strong>/<em>/<u> emphasis, and its ' +
    'suggestedGraphSteps (shown below) should be kept as-is unless the fix genuinely requires ' +
    'changing them -- re-emit the full body text (with its "## " headings and inline emphasis ' +
    'preserved) and a suggestedGraphSteps array (still 2-5 short imperative-style labels, still ' +
    'grounded only in what the revised draft itself says) either way.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"title":"...","summary":"...","body_text":"<the full REVISED article body, plain paragraphs ' +
    'with "## "-prefixed section-heading lines and occasional inline <strong>/<em>/<u> emphasis, no ' +
    'other HTML/markdown>","suggestedGraphSteps":["<2-5 short imperative-style labels>"]}';

  const gapLines = [
    ...missing.map((i) => `- MISSING entirely: "${i.name}"`),
    ...partial.map((i) => `- Only PARTIALLY covered: "${i.name}" (current evidence: "${i.evidence || '(none)'}")`),
    ...offTopicSections.map(
      (s) =>
        `- OFF-TOPIC SECTION: heading "${s.heading}" is built around "${s.entity}", which should be ` +
        `distinguished FROM the main topic, not headlined -- remove this heading and fold a brief ` +
        `distinguishing mention into a section about the main topic instead`
    ),
    ...(expandTarget
      ? [
          `- LENGTH: draft is only ~${expandTarget.currentWords} words; expand to at least ` +
            `${expandTarget.targetWords} words with genuine depth, not padding or a new tangential section`,
        ]
      : []),
  ];

  const user =
    `Topic: ${topic}\n\n` +
    `Current draft title: ${draft.title}\n` +
    `Current draft body text:\n${draft.body_text}\n\n` +
    `Current draft's suggested graph steps: ${JSON.stringify(draft.suggestedGraphSteps ?? [])}\n\n` +
    `Gaps to fix (from a separate review pass):\n${gapLines.join('\n')}\n\n` +
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

  const bodyText = parsed.body_text.trim();
  if (!SECTION_BREAK_PATTERN.test(bodyText)) {
    throw new Error(
      `Writer response body_text has no "## "-prefixed section-heading line -- the (future) HTML ` +
        `assembler needs at least one to build real heading structure: ${JSON.stringify(parsed.body_text)}`
    );
  }

  if (
    !Array.isArray(parsed.suggestedGraphSteps) ||
    parsed.suggestedGraphSteps.length < MIN_GRAPH_STEPS ||
    parsed.suggestedGraphSteps.length > MAX_GRAPH_STEPS ||
    !parsed.suggestedGraphSteps.every((s) => typeof s === 'string' && s.trim())
  ) {
    throw new Error(
      `Writer response missing a valid "suggestedGraphSteps" array (${MIN_GRAPH_STEPS}-${MAX_GRAPH_STEPS} ` +
        `non-empty strings): ${JSON.stringify(parsed.suggestedGraphSteps)}`
    );
  }

  return {
    title: parsed.title.trim(),
    summary: parsed.summary.trim(),
    body_text: bodyText,
    suggestedGraphSteps: parsed.suggestedGraphSteps.map((s) => s.trim()),
  };
}

// ---------------------------------------------------------------------------
// Off-topic section detection — a deterministic backstop for the
// "Distinguishing Call Warrants..." incident (admin-ai-article-creator-test-run
// memory, 2026-08-20 addendum). The writer prompt now ASKS the model not to
// headline a CONTRAST-relation checklist item (see CONTRAST_RELATIONS in
// retrieval-layer.js), but a real generation run reproduced the exact same
// defect ("The Role of Call Warrants" as its own "## " heading) even with
// that instruction in place — prose instructions alone are not reliable
// enough to promise this won't happen, since the writer is a stochastic LLM.
// This function is the code-level check that catches what the prompt missed,
// feeding a targeted fix back through the SAME <=1-retry repair loop
// generateArticleWithReview() already uses for missing/partial coverage
// gaps, rather than a new separate pass.
// ---------------------------------------------------------------------------

/** Word-boundary-safe, case-insensitive "does this heading contain this
 *  entity name" check — deliberately simple (no stemming/fuzzy match) so
 *  false negatives (an off-topic section this misses) are more likely than
 *  false positives (flagging a heading that merely shares a common word). */
function headingMentionsEntity(headingText, entityName) {
  const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Trailing "s" / "'s" is optional and NOT excluded by the lookahead -- a heading naturally
  // pluralizes/possessivizes an entity name ("Call Warrant" -> "...Call Warrants" or
  // "...Call Warrant's mechanics") far more often than not; a strict word boundary right after
  // the bare entity name misses that real-world form entirely (a real generation run produced
  // exactly "The Role of Call Warrants" -- caught this in this function's own validate-* tests).
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}('s|s)?(?![a-z0-9])`, 'i');
  return pattern.test(headingText);
}

/**
 * Scans `bodyText`'s "## "-prefixed section headings for ones built around a
 * checklist item whose graph relation is a CONTRAST relation
 * (`distinguished_from`/`contradicts` — see retrieval-layer.js) rather than a
 * composing one (`part_of`/`prerequisite_of`/`updates`). Those relations mean
 * "the topic is distinguished FROM this entity", so a section headlined
 * around the entity itself reads as a topic digression even though the
 * entity is a legitimate checklist item the article must still mention.
 *
 * Only checklist items carrying a `relation` field are considered (must-
 * include facts and hop-0 seed entities have `relation: null`/undefined and
 * are never flagged — the seed topic itself can obviously headline its own
 * article). Returns `[]` when nothing is flagged.
 *
 * @param {string} bodyText - the writer draft's plain-text body (with "## " heading lines)
 * @param {Array<{name: string, relation?: string|null}>} checklist
 * @returns {Array<{heading: string, entity: string, relation: string}>}
 */
export function detectOffTopicSections(bodyText, checklist) {
  const contrastItems = checklist.filter((c) => c.relation && CONTRAST_RELATIONS.has(c.relation));
  if (!contrastItems.length) return [];

  const headings = [...bodyText.matchAll(/^##\s+(\S.*)$/gm)].map((m) => m[1].trim());
  const flagged = [];
  for (const heading of headings) {
    for (const item of contrastItems) {
      if (headingMentionsEntity(heading, item.name)) {
        flagged.push({ heading, entity: item.name, relation: item.relation });
        break; // one flag per heading is enough for the repair prompt below
      }
    }
  }
  return flagged;
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
 * @param {string|null} [args.sourceKeyword] - §4 Phase 2 facet: narrows retrieval-layer.js's
 *   candidateSourceArticles to source_articles rows tagged with this keyword (substring,
 *   case-insensitive — see findCandidateSourceArticles' own doc comment)
 * @param {string|null} [args.sourceCategory] - same, but against the row's `category` bucket
 * @param {Function} args.writer - (promptObj, opts) => string|Promise<string>
 * @param {object} [args.writerOpts]
 * @param {Function} args.reviewer - (promptObj, opts) => string|Promise<string>
 * @param {object} [args.reviewerOpts]
 * @param {number} [args.maxRetries=1] - capped at MAX_RETRIES_ALLOWED (§5)
 * @param {number} [args.targetWordCount=TARGET_BODY_WORD_COUNT_EN] - extra-md-files/article-
 *   length-expansion.md's soft 10-minute-read floor; exposed as a param (not just the module
 *   constant) purely so validate-generate-article.js's pre-existing fixture scenarios — whose
 *   tiny placeholder bodies are far under any real target — can pass 0 to opt out and keep testing
 *   coverage/off-topic behavior in isolation, the way they did before this param existed.
 * @returns {Promise<object>} On a reviewer/repair-stage failure, `review`/`summary` come back
 *   `null` and `reviewCoverageFailed`/`reviewCoverageFailedMessage` are set instead of throwing —
 *   the draft (and internal-link insertion against it) is still returned rather than discarded.
 *   A failure on the initial writer call still throws uncaught (mirrors
 *   admin/index.html's generateArticleWithReviewBrowser()). Also returns `wordCount` (the final
 *   draft's countBodyWords()), `targetWordCount`, and `meetsLengthTarget` — informational only,
 *   same "never blocks" pattern as reviewCoverageFailed/offTopicSections (owner decision,
 *   2026-08-21: a soft target, not a publish-blocking gate).
 */
export async function generateArticleWithReview({
  db,
  topic,
  mustIncludeFacts = [],
  sourceText = null,
  sourceKeyword = null,
  sourceCategory = null,
  writer,
  writerOpts = {},
  reviewer,
  reviewerOpts = {},
  maxRetries = MAX_RETRIES_ALLOWED,
  targetWordCount = TARGET_BODY_WORD_COUNT_EN,
}) {
  if (maxRetries > MAX_RETRIES_ALLOWED) {
    throw new Error(`maxRetries cannot exceed ${MAX_RETRIES_ALLOWED} — §5 explicitly caps auto-repair at 1 retry.`);
  }

  // Step 2-3: retrieval-layer.js's one composed query, then merge in must-include facts.
  const retrievalContext = buildRetrievalContext(db, topic, { sourceKeyword, sourceCategory });
  const checklist = buildFullChecklist(retrievalContext.checklist, mustIncludeFacts);

  // Step 4: writer call (initial).
  const writerPrompt = buildWriterPrompt({
    topic,
    checklist,
    mustIncludeFacts,
    articleSummaries: retrievalContext.articleSummaries,
    nearDuplicates: retrievalContext.nearDuplicates,
    sourceText,
    candidateSourceArticles: retrievalContext.candidateSourceArticles,
  });
  let draft = parseWriterResponse(await writer(writerPrompt, { ...writerOpts, topic, attempt: 'initial' }));

  // Deterministic backstop alongside the reviewer's coverage check (see detectOffTopicSections'
  // own doc comment) — a pure text/checklist scan, independent of the reviewer LLM call below, so
  // it's computed here and recomputed after any repair rather than living inside the try/catch.
  let offTopicSections = detectOffTopicSections(draft.body_text, checklist);
  // Same treatment for the length target (article-length-expansion.md) — a pure word-count
  // check, independent of the reviewer LLM call, computed here and recomputed after any repair.
  let wordCount = countBodyWords(draft.body_text);

  // Step 5-6: reviewer call (a SEPARATE LLM call, never the writer self-checking) plus the
  // <=1 auto-repair retry. Wrapped in try/catch per admin/index.html's
  // generateArticleWithReviewBrowser() (the browser mirror of this function) — a failure here
  // no longer discards the writer's already-paid-for draft. Only the reviewer/repair calls are
  // wrapped: an outright failure on the (initial) writer call above still propagates uncaught,
  // since there's no draft yet at that point worth salvaging. On a caught failure, coverage
  // review is abandoned for this run (review/summary come back null, reviewCoverageFailed:
  // true) but link insertion below — which has no dependency on review succeeding — still runs
  // against whatever draft was last produced.
  let review = null;
  let summary = null;
  let retryCount = 0;
  let reviewCoverageFailed = false;
  let reviewCoverageFailedMessage = null;

  try {
    // Step 5: reviewer call — a SEPARATE LLM call, never the writer self-checking.
    review = parseReviewResponse(
      await reviewer(buildReviewPrompt({ checklist, draftText: draft.body_text }), { ...reviewerOpts, topic, attempt: 'initial' })
    );
    summary = summarizeReview(review);

    // Step 6: <=1 auto-repair retry. Fires on any of three independent gaps — missing/partial
    // coverage, an off-topic section, or a still-under-target word count (article-length-
    // expansion.md) — sharing the SAME single retry budget rather than adding a second one,
    // matching §5's explicit "cap auto-repair at 1 retry" (not a tunable-up-forever knob).
    // Coverage/off-topic gaps additionally require an actual checklist to have gaps against;
    // the length gap does not (it fires purely off wordCount, even for a topic that matched no
    // graph entities — a thin article is a real gap either way).
    const needsCoverageRepair = checklist.length > 0 && (!summary.allCovered || offTopicSections.length > 0);
    const needsLengthExpansion = wordCount < targetWordCount;
    if ((needsCoverageRepair || needsLengthExpansion) && retryCount < maxRetries) {
      const repairPrompt = buildRepairPrompt({
        topic,
        checklist,
        draft,
        missing: summary.missing,
        partial: summary.partial,
        offTopicSections,
        expandTarget: needsLengthExpansion ? { currentWords: wordCount, targetWords: targetWordCount } : null,
      });
      draft = parseWriterResponse(await writer(repairPrompt, { ...writerOpts, topic, attempt: 'repair' }));
      offTopicSections = detectOffTopicSections(draft.body_text, checklist);
      wordCount = countBodyWords(draft.body_text);
      review = parseReviewResponse(
        await reviewer(buildReviewPrompt({ checklist, draftText: draft.body_text }), { ...reviewerOpts, topic, attempt: 'repair' })
      );
      summary = summarizeReview(review);
      retryCount = 1;
    }
  } catch (err) {
    reviewCoverageFailed = true;
    reviewCoverageFailedMessage = err && err.message ? err.message : String(err);
    review = null;
    summary = null;
  }

  // Step 7 (§4 Phase 5): auto-insert internal links into the FINAL draft body
  // text, after review/repair is fully settled — the reviewer above always
  // judged the writer's own plain-text output, never text this step adds.
  const linkResult = insertSuggestedLinks(draft.body_text, retrievalContext.suggestedLinks);
  draft = { ...draft, body_text: linkResult.bodyText };
  const internalLinks = { inserted: linkResult.inserted, skipped: linkResult.skipped };
  // Recomputed against the FINAL (post-link-insertion) body text — link-wrapping an existing
  // mention in an <a> tag never adds a real word, but this keeps wordCount honestly describing
  // whatever body_text this function is actually about to return, not a pre-link snapshot.
  wordCount = countBodyWords(draft.body_text);

  // Step 8: hand off to Phase 8 with the coverage result + link report attached — this function does not publish.
  // `offTopicSections`: whatever detectOffTopicSections() still finds after the repair attempt
  // above (empty if none were ever found, or if the repair pass fixed them) — surfaced
  // uncollapsed, same "never auto-blocks, informational" pattern as everything else Phase 8's
  // human reviews, since a still-non-empty array here means the repair attempt didn't fully
  // resolve it and a human pass (per admin-ai-article-creator-test-run memory) is required.
  // `wordCount`/`targetWordCount`/`meetsLengthTarget`: same informational pattern, for the
  // article-length-expansion.md soft 10-minute-read target — a still-short body after the repair
  // attempt is surfaced, never auto-blocked or silently re-tried past the §5 retry cap.
  return {
    topic,
    retrievalContext,
    checklist,
    draft,
    review,
    summary,
    retryCount,
    internalLinks,
    offTopicSections,
    reviewCoverageFailed,
    reviewCoverageFailedMessage,
    wordCount,
    targetWordCount,
    meetsLengthTarget: wordCount >= targetWordCount,
  };
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
    sourceKeyword: null,
    sourceCategory: null,
    maxRetries: MAX_RETRIES_ALLOWED,
    targetWordCount: TARGET_BODY_WORD_COUNT_EN,
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
      case '--source-keyword':
        opts.sourceKeyword = nextArg(argv, ++i, '--source-keyword');
        break;
      case '--source-category':
        opts.sourceCategory = nextArg(argv, ++i, '--source-category');
        break;
      case '--max-retries': {
        const n = Number(nextArg(argv, ++i, '--max-retries'));
        if (!Number.isInteger(n) || n < 0) throw new Error('--max-retries must be a non-negative integer');
        if (n > MAX_RETRIES_ALLOWED) {
          throw new Error(`maxRetries cannot exceed ${MAX_RETRIES_ALLOWED} — §5 explicitly caps auto-repair at 1 retry.`);
        }
        opts.maxRetries = n;
        break;
      }
      case '--target-words': {
        // A soft target (article-length-expansion.md — never blocks), so unlike --max-retries
        // above this has no §5-style upper cap; 0 disables the length-expansion pass entirely
        // (useful for a quick/cheap test run).
        const n = Number(nextArg(argv, ++i, '--target-words'));
        if (!Number.isInteger(n) || n < 0) throw new Error('--target-words must be a non-negative integer');
        opts.targetWordCount = n;
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
  console.log(`Checklist: ${result.checklist.length} item(s)`);
  if (result.retrievalContext.candidateSourceArticles.length) {
    console.log(
      `Candidate source articles used as background (§4 Phase 2): ${result.retrievalContext.candidateSourceArticles.length}`
    );
  }
  console.log('');

  console.log(`--- Draft ---`);
  console.log(`Title: ${result.draft.title}`);
  console.log(`Summary: ${result.draft.summary}`);
  console.log(`Body (${result.draft.body_text.length} chars): ${result.draft.body_text.slice(0, 200)}${result.draft.body_text.length > 200 ? '…' : ''}`);
  console.log(`Suggested graph steps (${result.draft.suggestedGraphSteps.length}): ${result.draft.suggestedGraphSteps.join(' -> ')}`);
  console.log(
    `Length: ${result.wordCount} word(s) — ${result.meetsLengthTarget ? 'meets' : 'under'} the ${result.targetWordCount}-word ` +
      `10-minute-read target (soft target, informational only)\n`
  );

  if (result.reviewCoverageFailed) {
    console.log(`--- Coverage ---`);
    console.log(`! Coverage review failed and was abandoned for this run: ${result.reviewCoverageFailedMessage}`);
    console.log(`  The draft above is still the writer's real output — review it manually before publishing.`);
  } else {
    console.log(`--- Coverage (after ${result.retryCount} repair retr${result.retryCount === 1 ? 'y' : 'ies'}) ---`);
    console.log(`covered: ${result.summary.covered.length}, partial: ${result.summary.partial.length}, missing: ${result.summary.missing.length}`);
    for (const item of [...result.summary.partial, ...result.summary.missing]) {
      console.log(`  - [${item.status}] ${item.name}${item.evidence ? ` — "${item.evidence}"` : ''}`);
    }
    if (result.summary.missing.length || result.summary.partial.length) {
      console.log(`\n! Gaps remain after the retry cap — handing off to Phase 8 (human review) as-is, nothing auto-inserted.`);
    }
  }

  if (result.offTopicSections.length) {
    console.log(`\n--- Off-topic sections (still present after any repair attempt) ---`);
    for (const s of result.offTopicSections) {
      console.log(`  - heading "${s.heading}" is built around "${s.entity}" (${s.relation}) -- review manually before publishing`);
    }
  }

  console.log(`\n--- Internal links (Phase 5, auto-inserted into the final draft) ---`);
  console.log(`inserted: ${result.internalLinks.inserted.length}, skipped: ${result.internalLinks.skipped.length}`);
  for (const l of result.internalLinks.inserted) console.log(`  - "${l.mentionText}" -> ${l.targetSlug}.html`);
  for (const s of result.internalLinks.skipped) console.log(`  - [skipped] "${s.entity}" -> ${s.targetSlug}.html (${s.reason})`);
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
      sourceKeyword: opts.sourceKeyword,
      sourceCategory: opts.sourceCategory,
      writer,
      writerOpts: { model: opts.writerModel },
      reviewer,
      reviewerOpts: { model: opts.reviewerModel },
      maxRetries: opts.maxRetries,
      targetWordCount: opts.targetWordCount,
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
