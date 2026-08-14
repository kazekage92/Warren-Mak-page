#!/usr/bin/env node
/**
 * Validation harness for generate-article.js / coverage-reviewer.js — same
 * fixture-injection spirit as validate-extract-entities.js and
 * validate-fact-retention-checker.js (extra-md-files/ai-article-pipeline.md
 * §3's own note: no OPENAI_API_KEY/network needed).
 *
 * Reads checklists straight out of the real hand-authored sample db
 * (admin/knowledge-graph.db, read-only — this script never writes to it) via
 * buildRetrievalContext(), then hand-authors writer/reviewer fixtures against
 * that REAL checklist rather than a hardcoded guess at its contents, so the
 * assertions stay correct if the sample db's entities ever change.
 *
 * Proves, function-level and CLI-level:
 *   1. The reviewer is a genuinely SEPARATE call from the writer (distinct
 *      fixture files, independently countable invocations) — never the
 *      writer self-checking its own output.
 *   2. A missing checklist item triggers exactly one repair retry: the
 *      writer is called again with the gap, the reviewer is called again on
 *      the repaired draft.
 *   3. The retry cap is really 1: even if the repaired draft STILL has a gap
 *      (simulated: the repair fixture leaves one item "partial", not fully
 *      fixed), the pipeline does not attempt a third writer/reviewer call —
 *      it hands the remaining gap to the human as-is (§5's own explicit
 *      non-goal: "never silently dropped or silently force-inserted").
 *   4. A fully-covered FIRST draft never retries at all (no wasted call).
 *   5. generateArticleWithReview() rejects maxRetries > 1 outright (§5: "cap
 *      auto-repair at 1 retry" is not a tunable-up-forever knob).
 *   6. Must-include facts (§5's second checklist source) actually reach the
 *      checklist the writer/reviewer prompts are built from.
 *   7. At the CLI level: --json output round-trips the same shape, and the
 *      process exits 0 even when gaps remain after the retry cap — coverage
 *      gaps are informational (Phase 8's job to act on), never a pipeline
 *      failure the way a fact-retention regression is.
 *   8. §4 Phase 5 (retrieval-layer.js's insertSuggestedLinks(), consumed as
 *      generateArticleWithReview()'s final step): a verbatim entity mention
 *      gets wrapped in a real <a> tag pointing at the suggested article; a
 *      second occurrence of the same entity is left untouched (only the
 *      first mention is linked); an entity with no verbatim mention is
 *      reported in `skipped`, never force-inserted; and the final
 *      `result.draft.body_text` (the one Phase 8 actually sees) is the
 *      LINKED text, not the reviewer's pre-link copy.
 *   9. Review/repair failure-salvage: if the reviewer call throws (fixture
 *      missing, simulating a transient failure), the writer's already-paid-
 *      for draft is NOT discarded — generateArticleWithReview() returns
 *      normally with `reviewCoverageFailed: true`, `review`/`summary` both
 *      `null`, and the draft still carries internal-link insertion (step 7
 *      has no dependency on review succeeding). No repair call is attempted
 *      since there's no coverage summary to act on. Mirrored at the CLI
 *      level too (--json output, human-readable printHuman() output, exit
 *      code still 0 — a salvaged draft is not a pipeline failure).
 *
 * Usage: node validate-generate-article.js
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext, insertSuggestedLinks } from './retrieval-layer.js';
import { buildReviewPrompt } from './coverage-reviewer.js';
import {
  buildFullChecklist,
  buildWriterPrompt,
  buildRepairPrompt,
  parseWriterResponse,
  generateArticleWithReview,
  fixtureWriter,
  fixtureReviewerByTopic,
  slugifyTopic,
} from './generate-article.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const WRITER_FIXTURE_DIR = path.join(OUTPUT_DIR, 'generate-fixtures', 'writer');
const REVIEWER_FIXTURE_DIR = path.join(OUTPUT_DIR, 'generate-fixtures', 'reviewer');
const ORIGINAL_DB = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');

const TOPIC_GAP = 'Time Decay'; // scenario: initial draft has a gap, repair fixes it partially
const TOPIC_CLEAN = 'Bursa Malaysia'; // scenario: initial draft is already fully covered
const MUST_INCLUDE_FACTS = ['Warren Mak has 32 years of market experience'];

function countCalls(fn) {
  const wrapped = (...args) => {
    wrapped.calls++;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

// Default suggestedGraphSteps used by every scenario fixture below unless a
// test specifically needs to vary it (e.g. the parseWriterResponse() shape
// checks in Part 0.25) — 3 labels, within the 2-5 range parseWriterResponse()
// requires.
const DEFAULT_GRAPH_STEPS = ['Identify the setup', 'Confirm the signal', 'Manage the position'];

// Every real writer/repair response must now carry at least one "## "
// section-heading line (parseWriterResponse()'s SECTION_BREAK_PATTERN) —
// prefixing the fixture body with one heading keeps every scenario fixture
// below shaped like a real writer response, not a special case.
function draftJson(title, bodyText, graphSteps = DEFAULT_GRAPH_STEPS) {
  const bodyWithHeading = `## ${title} Overview\n\n${bodyText}`;
  return JSON.stringify({ title, summary: `Summary of ${title}`, body_text: bodyWithHeading, suggestedGraphSteps: graphSteps });
}

function reviewJson(items) {
  return JSON.stringify({ items });
}

/** Builds one fully-deterministic scenario's fixtures from the checklist
 *  buildRetrievalContext() actually returns for `topic` against the real
 *  sample db — no hardcoded assumption about entity names. */
function writeScenarioFixtures(db, topic, { omitFirstItem, repairStillPartial }) {
  const context = buildRetrievalContext(db, topic);
  const checklist = buildFullChecklist(context.checklist, MUST_INCLUDE_FACTS);
  if (!checklist.length) {
    throw new Error(`Topic "${topic}" matched no entities in the sample db — pick a different fixture topic.`);
  }
  const key = slugifyTopic(topic);
  const gapItem = omitFirstItem ? checklist[0] : null;

  const bodyMentioning = (items) => items.map((c) => `This section discusses ${c.name} in detail.`).join(' ');

  // Initial writer draft: mentions every checklist item except gapItem (if any).
  const initialItems = checklist.filter((c) => c !== gapItem);
  writeFileSync(path.join(WRITER_FIXTURE_DIR, `${key}.json`), draftJson(`Article about ${topic}`, bodyMentioning(initialItems)), 'utf-8');

  // Initial reviewer response: mirrors the initial draft exactly — everything
  // mentioned reads "covered", the omitted one (if any) reads "missing".
  const initialReview = checklist.map((c) => ({
    name: c.name,
    status: c === gapItem ? 'missing' : 'covered',
    evidence: c === gapItem ? '' : `This section discusses ${c.name} in detail.`,
  }));
  writeFileSync(path.join(REVIEWER_FIXTURE_DIR, `${key}.json`), reviewJson(initialReview), 'utf-8');

  if (!gapItem) return; // clean scenario — no repair fixtures needed, none should ever be read

  // Repair writer draft: now mentions gapItem too.
  writeFileSync(path.join(WRITER_FIXTURE_DIR, `${key}.repair.json`), draftJson(`Article about ${topic}`, bodyMentioning(checklist)), 'utf-8');

  // Repair reviewer response: everything covered UNLESS repairStillPartial,
  // in which case gapItem is upgraded to "partial" (still not fully fixed) —
  // proving the pipeline accepts that as final rather than retrying again.
  const repairReview = checklist.map((c) => ({
    name: c.name,
    status: c === gapItem && repairStillPartial ? 'partial' : 'covered',
    evidence: `This section discusses ${c.name} in detail.`,
  }));
  writeFileSync(path.join(REVIEWER_FIXTURE_DIR, `${key}.repair.json`), reviewJson(repairReview), 'utf-8');
}

// ---------------------------------------------------------------------------
// Part 0 — buildFullChecklist / buildReviewPrompt: must-include facts really
// reach the checklist and the prompt text (no db, no fixtures).
// ---------------------------------------------------------------------------

function runChecklistCheck() {
  console.log('=== Part 0: buildFullChecklist / buildReviewPrompt ===\n');
  const checks = [];

  const entityChecklist = [{ name: 'Time Decay (Theta)', type: 'concept', why: 'directly matches the topic' }];
  const full = buildFullChecklist(entityChecklist, MUST_INCLUDE_FACTS);
  checks.push(['merged checklist has entity item + fact item', full.length === 2]);
  checks.push(['fact item carries the exact fact text as its name', full.some((i) => i.name === MUST_INCLUDE_FACTS[0])]);
  checks.push(['fact item is typed "fact"', full.find((i) => i.name === MUST_INCLUDE_FACTS[0])?.type === 'fact']);

  const { user } = buildReviewPrompt({ checklist: full, draftText: 'draft body text' });
  checks.push(['review prompt user text includes the must-include fact', user.includes(MUST_INCLUDE_FACTS[0])]);
  checks.push(['review prompt user text includes the entity checklist item', user.includes('Time Decay (Theta)')]);

  // Dedup: a must-include fact is only skipped when it's a near-exact
  // restatement of an EARLIER FACT already in the list — never merely
  // because it shares a name with a plain entity checklist item. A fact
  // that contains (or is contained by) an entity name is still a distinct
  // claim from the entity itself, and both deserve independent reviewer
  // verification.
  const dupEntity = [{ name: 'Bursa Malaysia', type: 'organization', why: 'directly matches the topic' }];
  const exactDup = buildFullChecklist(dupEntity, ['bursa malaysia']); // case-insensitive exact match of the ENTITY name itself
  checks.push(['fact that exactly restates an entity name is still appended (entity vs. fact are different checklist rows)', exactDup.length === 2]);

  const substringDup = buildFullChecklist(dupEntity, ['Warren spent 32 years at Bursa Malaysia']); // fact contains the entity name, but is a different claim
  checks.push(['fact that merely contains an existing entity name is KEPT, not deduped', substringDup.length === 2]);

  const supersetEntityDup = buildFullChecklist(
    [{ name: 'Former Head of 5 departments at Bursa Malaysia', type: 'concept', why: 'x' }],
    ['Bursa Malaysia'] // fact is a substring of the entity name, but is still a different claim
  );
  checks.push(['fact that is a substring of an existing entity name is KEPT, not deduped', supersetEntityDup.length === 2]);

  const distinctFacts = buildFullChecklist(dupEntity, ['Warren Mak has 32 years of market experience']); // genuinely distinct
  checks.push(['a genuinely distinct fact is still appended', distinctFacts.length === 2]);

  const dupAmongFactsThemselves = buildFullChecklist([], ['Warren Mak has 32 years of market experience', 'warren mak has 32 years of market experience']);
  checks.push(['a fact that exactly restates an EARLIER fact (not just an entity) is skipped', dupAmongFactsThemselves.length === 1]);

  const nearRestatementFacts = buildFullChecklist([], [
    'Warren Mak has 32 years of market experience',
    'Warren Mak has 32 years of market trading experience', // near-identical restatement (one added filler word) of the fact above — 8/9 token overlap, above threshold
  ]);
  checks.push(['a fact that is a near-identical restatement of an EARLIER fact (not an exact string match) still collapses to one', nearRestatementFacts.length === 1]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0.25 — parseWriterResponse(): suggestedGraphSteps + "## " section-break
// validation (extra-md-files/automated-article-scheduler.md component 2).
// Pure function, no db/fixtures needed.
// ---------------------------------------------------------------------------

function runWriterResponseShapeCheck() {
  console.log('\n=== Part 0.25: parseWriterResponse() suggestedGraphSteps / section breaks ===\n');
  const checks = [];

  const valid = parseWriterResponse(draftJson('Time Decay', 'Some content about time decay.'));
  checks.push(['a well-formed response is accepted', valid.title === 'Time Decay']);
  checks.push(['suggestedGraphSteps round-trips (3 labels, within 2-5)', Array.isArray(valid.suggestedGraphSteps) && valid.suggestedGraphSteps.length === 3]);
  checks.push(['suggestedGraphSteps entries are trimmed', valid.suggestedGraphSteps.every((s) => s === s.trim())]);
  checks.push(['body_text carries the "## " section-heading line', /^## .+$/m.test(valid.body_text)]);

  const missingGraphSteps = JSON.stringify({ title: 'X', summary: 'Y', body_text: '## Heading\n\nBody.' });
  let threwMissingGraphSteps = false;
  try {
    parseWriterResponse(missingGraphSteps);
  } catch {
    threwMissingGraphSteps = true;
  }
  checks.push(['rejects a response with no suggestedGraphSteps field at all', threwMissingGraphSteps]);

  const tooFewGraphSteps = JSON.stringify({ title: 'X', summary: 'Y', body_text: '## Heading\n\nBody.', suggestedGraphSteps: ['Only one'] });
  let threwTooFew = false;
  try {
    parseWriterResponse(tooFewGraphSteps);
  } catch {
    threwTooFew = true;
  }
  checks.push(['rejects fewer than 2 graph steps', threwTooFew]);

  const tooManyGraphSteps = JSON.stringify({
    title: 'X',
    summary: 'Y',
    body_text: '## Heading\n\nBody.',
    suggestedGraphSteps: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
  });
  let threwTooMany = false;
  try {
    parseWriterResponse(tooManyGraphSteps);
  } catch {
    threwTooMany = true;
  }
  checks.push(['rejects more than 5 graph steps', threwTooMany]);

  const emptyGraphStep = JSON.stringify({ title: 'X', summary: 'Y', body_text: '## Heading\n\nBody.', suggestedGraphSteps: ['Real step', '   '] });
  let threwEmptyStep = false;
  try {
    parseWriterResponse(emptyGraphStep);
  } catch {
    threwEmptyStep = true;
  }
  checks.push(['rejects an empty/whitespace-only graph step entry', threwEmptyStep]);

  const noSectionBreak = JSON.stringify({ title: 'X', summary: 'Y', body_text: 'Just plain paragraphs, no heading anywhere.', suggestedGraphSteps: DEFAULT_GRAPH_STEPS });
  let threwNoSectionBreak = false;
  try {
    parseWriterResponse(noSectionBreak);
  } catch {
    threwNoSectionBreak = true;
  }
  checks.push(['rejects body_text with no "## " section-heading line at all', threwNoSectionBreak]);

  const midParagraphHash = JSON.stringify({ title: 'X', summary: 'Y', body_text: 'A paragraph that mentions ## in passing, not as a real heading line prefix.', suggestedGraphSteps: DEFAULT_GRAPH_STEPS });
  let threwMidParagraph = false;
  try {
    parseWriterResponse(midParagraphHash);
  } catch {
    threwMidParagraph = true;
  }
  checks.push(['a "##" that is not a real line-start heading prefix still counts as missing a section break', threwMidParagraph]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0.5 — insertSuggestedLinks() itself, pure function, no db/fixtures
// ---------------------------------------------------------------------------

function runLinkInsertionCheck() {
  console.log('\n=== Part 0.5: insertSuggestedLinks() (§4 Phase 5) ===\n');
  const checks = [];

  const body = 'Time Decay is a key risk. Leverage can amplify gains and losses. Leverage again here.';
  const suggestions = [
    { entity: 'Time Decay', targetSlug: 'structured-warrant-risks-time-decay-malaysia', targetTitle: 'Time Decay Risks' },
    { entity: 'Leverage', targetSlug: 'leverage-strategies-structured-warrants-malaysia', targetTitle: 'Leverage Strategies' },
    { entity: 'Nonexistent Topic', targetSlug: 'nowhere', targetTitle: 'Nowhere' },
  ];
  const result = insertSuggestedLinks(body, suggestions);

  checks.push(['inserts one <a> per matched entity (2 of 3 suggestions matched)', result.inserted.length === 2]);
  checks.push(['links the FIRST verbatim mention with the right target href', result.bodyText.includes('<a href="structured-warrant-risks-time-decay-malaysia.html">Time Decay</a>')]);
  checks.push(['only the first "Leverage" occurrence is linked...', result.bodyText.includes('<a href="leverage-strategies-structured-warrants-malaysia.html">Leverage</a> can amplify')]);
  checks.push(['...the second occurrence is left as plain text', result.bodyText.endsWith('Leverage again here.')]);
  checks.push(['an entity with no verbatim mention is reported as skipped, not inserted', result.skipped.length === 1 && result.skipped[0].entity === 'Nonexistent Topic']);
  checks.push(['skipped entries never appear as an <a> tag', !result.bodyText.includes('nowhere.html')]);

  checks.push(['empty suggestedLinks list returns the body text unchanged', insertSuggestedLinks(body, []).bodyText === body]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0.6 — buildWriterPrompt() / buildRepairPrompt() actually instruct for
// "## " section breaks + suggestedGraphSteps (extra-md-files/automated-
// article-scheduler.md component 2). Pure function, no db/fixtures needed.
// ---------------------------------------------------------------------------

function runGraphStepsPromptCheck() {
  console.log('\n=== Part 0.6: buildWriterPrompt() / buildRepairPrompt() section-break + suggestedGraphSteps instructions ===\n');
  const checks = [];

  const writerPrompt = buildWriterPrompt({
    topic: 'Time Decay',
    checklist: [],
    mustIncludeFacts: [],
    articleSummaries: [],
    nearDuplicates: [],
    sourceText: null,
  });
  checks.push(['writer system prompt instructs "## " section headings', writerPrompt.system.includes('"## "')]);
  checks.push(['writer system prompt asks for suggestedGraphSteps', writerPrompt.system.includes('SUGGESTED GRAPH STEPS')]);
  checks.push(['writer system prompt\'s JSON response shape includes suggestedGraphSteps', writerPrompt.system.trim().endsWith('"suggestedGraphSteps":["<2-5 short imperative-style labels>"]}')]);

  const draftWithGraphSteps = { title: 'Time Decay', body_text: '## Overview\n\nSome content.', suggestedGraphSteps: ['Step one', 'Step two'] };
  const repairPrompt = buildRepairPrompt({
    topic: 'Time Decay',
    checklist: [{ name: 'Time Decay (Theta)', type: 'concept', why: 'x' }],
    draft: draftWithGraphSteps,
    missing: [{ name: 'Time Decay (Theta)' }],
    partial: [],
  });
  checks.push(['repair system prompt instructs keeping "## " headings', repairPrompt.system.includes('"## "')]);
  checks.push(['repair system prompt asks for a (re-emitted) suggestedGraphSteps array', repairPrompt.system.includes('suggestedGraphSteps')]);
  checks.push(['repair user prompt shows the CURRENT draft\'s suggested graph steps', repairPrompt.user.includes('Step one') && repairPrompt.user.includes('Step two')]);

  // A draft with no suggestedGraphSteps yet (shouldn't happen in practice
  // post-parseWriterResponse, but buildRepairPrompt itself must not throw)
  // renders an empty array rather than crashing on `undefined`.
  const draftWithoutGraphSteps = { title: 'Time Decay', body_text: '## Overview\n\nSome content.' };
  let repairPromptWithoutSteps;
  let threwOnMissingSteps = false;
  try {
    repairPromptWithoutSteps = buildRepairPrompt({ topic: 'Time Decay', checklist: [], draft: draftWithoutGraphSteps, missing: [], partial: [] });
  } catch {
    threwOnMissingSteps = true;
  }
  checks.push(['buildRepairPrompt() does not throw when the draft carries no suggestedGraphSteps yet', !threwOnMissingSteps]);
  checks.push(['...and renders an empty array rather than the literal word "undefined"', Boolean(repairPromptWithoutSteps) && repairPromptWithoutSteps.user.includes('[]') && !repairPromptWithoutSteps.user.includes('undefined')]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 0.75 — buildWriterPrompt()'s candidateSourceArticles handling (§4
// Phase 2, retrieval-layer.js's findCandidateSourceArticles() consumed here).
// Pure function, no db/fixtures needed.
// ---------------------------------------------------------------------------

function runCandidateSourceArticlesPromptCheck() {
  console.log('\n=== Part 0.75: buildWriterPrompt() candidateSourceArticles (§4 Phase 2) ===\n');
  const checks = [];

  const basePromptArgs = {
    topic: 'IPO Investing',
    checklist: [],
    mustIncludeFacts: [],
    articleSummaries: [],
    nearDuplicates: [],
    sourceText: null,
  };

  const withoutCandidates = buildWriterPrompt(basePromptArgs);
  checks.push(['no candidateSourceArticles -> no "unpublished" mention in either prompt half', !withoutCandidates.system.includes('unpublished') && !withoutCandidates.user.includes('unpublished')]);

  const candidateSourceArticles = [
    { title: '如何投资非上市公司?', slug: 'topic-1063463', category: 'advanced trading and investing knowledge', score: 0.8, reason: 'shares a keyword tag with the topic' },
  ];
  const withCandidates = buildWriterPrompt({ ...basePromptArgs, candidateSourceArticles });
  checks.push(['candidateSourceArticles present -> system prompt flags them as background-only', withCandidates.system.includes('unpublished')]);
  checks.push(['candidateSourceArticles present -> user prompt lists the candidate title', withCandidates.user.includes('如何投资非上市公司?')]);
  checks.push(['candidateSourceArticles present -> user prompt includes its category', withCandidates.user.includes('advanced trading and investing knowledge')]);
  checks.push(['candidateSourceArticles never leak into the JSON response-shape instruction', withCandidates.system.trim().endsWith('"suggestedGraphSteps":["<2-5 short imperative-style labels>"]}')]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1 — function-level: generateArticleWithReview() against the real db,
// with call-counted fixture writer/reviewer.
// ---------------------------------------------------------------------------

async function runPart1() {
  console.log('\n=== Part 1: function-level (generateArticleWithReview) ===\n');
  const checks = [];

  const db = new DatabaseSync(ORIGINAL_DB, { readOnly: true });
  try {
    // --- Scenario A: gap on the first draft, repair fixes it fully. ---
    writeScenarioFixtures(db, TOPIC_GAP, { omitFirstItem: true, repairStillPartial: false });
    const writerA = countCalls((promptObj, opts) => fixtureWriter(promptObj, { fixtureDir: WRITER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const reviewerA = countCalls((promptObj, opts) => fixtureReviewerByTopic(promptObj, { fixtureDir: REVIEWER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const resultA = await generateArticleWithReview({
      db,
      topic: TOPIC_GAP,
      mustIncludeFacts: MUST_INCLUDE_FACTS,
      writer: writerA,
      reviewer: reviewerA,
      maxRetries: 1,
    });

    checks.push(['scenario A: writer called exactly twice (initial + repair)', writerA.calls === 2]);
    checks.push(['scenario A: reviewer called exactly twice (initial + repair) — a SEPARATE call each time', reviewerA.calls === 2]);
    checks.push(['scenario A: retryCount === 1', resultA.retryCount === 1]);
    checks.push(['scenario A: final coverage is fully covered (repair fixed the gap)', resultA.summary.allCovered === true]);
    checks.push(['scenario A: final missing count is 0', resultA.summary.missing.length === 0]);

    // Component 2 (extra-md-files/automated-article-scheduler.md): the
    // FINAL draft (post-repair) still carries a valid suggestedGraphSteps
    // array and a "## " section-break line — parseWriterResponse() ran on
    // the repair response too, not just the initial one.
    checks.push(['scenario A: final draft carries suggestedGraphSteps (2-5 labels)', Array.isArray(resultA.draft.suggestedGraphSteps) && resultA.draft.suggestedGraphSteps.length >= 2 && resultA.draft.suggestedGraphSteps.length <= 5]);
    checks.push(['scenario A: final draft body_text carries a "## " section-heading line', /^## .+$/m.test(resultA.draft.body_text)]);

    // §4 Phase 5: the topic's real suggestedLinks (from the real sample db)
    // must have been auto-linked into the FINAL draft body — the scenario's
    // fixture bodies mention every checklist item verbatim (bodyMentioning()
    // above), and every suggestedLinks entity name is itself a checklist
    // item (seed entities are a subset of relatedEntities), so a verbatim
    // mention is guaranteed to exist for this real topic.
    const realContext = buildRetrievalContext(db, TOPIC_GAP);
    checks.push(['scenario A topic has at least one real suggestedLinks entry to exercise', realContext.suggestedLinks.length > 0]);
    checks.push(['scenario A: result.internalLinks.inserted matches the number of real suggestedLinks', resultA.internalLinks.inserted.length === realContext.suggestedLinks.length]);
    for (const s of realContext.suggestedLinks) {
      checks.push([`scenario A: final draft body_text contains a real <a> link to ${s.targetSlug}`, resultA.draft.body_text.includes(`<a href="${s.targetSlug}.html">`)]);
    }

    // --- Scenario B: gap on the first draft, repair STILL leaves it partial. ---
    writeScenarioFixtures(db, TOPIC_GAP, { omitFirstItem: true, repairStillPartial: true });
    const writerB = countCalls((promptObj, opts) => fixtureWriter(promptObj, { fixtureDir: WRITER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const reviewerB = countCalls((promptObj, opts) => fixtureReviewerByTopic(promptObj, { fixtureDir: REVIEWER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const resultB = await generateArticleWithReview({
      db,
      topic: TOPIC_GAP,
      mustIncludeFacts: MUST_INCLUDE_FACTS,
      writer: writerB,
      reviewer: reviewerB,
      maxRetries: 1,
    });

    checks.push(['scenario B (retry cap): writer STILL called only twice, not a third time', writerB.calls === 2]);
    checks.push(['scenario B (retry cap): reviewer STILL called only twice, not a third time', reviewerB.calls === 2]);
    checks.push(['scenario B (retry cap): retryCount caps at 1', resultB.retryCount === 1]);
    checks.push(['scenario B (retry cap): remaining gap surfaces as "partial", not silently dropped', resultB.summary.partial.length === 1]);
    checks.push(['scenario B (retry cap): allCovered is false — hands off to human as-is', resultB.summary.allCovered === false]);

    // --- Scenario C: first draft is already fully covered — no wasted retry. ---
    writeScenarioFixtures(db, TOPIC_CLEAN, { omitFirstItem: false, repairStillPartial: false });
    const writerC = countCalls((promptObj, opts) => fixtureWriter(promptObj, { fixtureDir: WRITER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const reviewerC = countCalls((promptObj, opts) => fixtureReviewerByTopic(promptObj, { fixtureDir: REVIEWER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const resultC = await generateArticleWithReview({
      db,
      topic: TOPIC_CLEAN,
      mustIncludeFacts: [],
      writer: writerC,
      reviewer: reviewerC,
      maxRetries: 1,
    });

    checks.push(['scenario C (clean): writer called exactly once — no repair attempted', writerC.calls === 1]);
    checks.push(['scenario C (clean): reviewer called exactly once', reviewerC.calls === 1]);
    checks.push(['scenario C (clean): retryCount === 0', resultC.retryCount === 0]);
    checks.push(['scenario C (clean): allCovered is true from the first pass', resultC.summary.allCovered === true]);

    // --- Scenario D: maxRetries > 1 is rejected outright, before any call is made. ---
    let threwForCapViolation = false;
    let capErrorMentionsFive = false;
    try {
      await generateArticleWithReview({
        db,
        topic: TOPIC_CLEAN,
        writer: countCalls(() => draftJson('unused', 'unused')),
        reviewer: countCalls(() => reviewJson([])),
        maxRetries: 2,
      });
    } catch (err) {
      threwForCapViolation = true;
      capErrorMentionsFive = /§5|1 retry/i.test(err.message);
    }
    checks.push(['scenario D: maxRetries=2 throws before calling writer/reviewer', threwForCapViolation]);
    checks.push(['scenario D: error message cites the §5 cap', capErrorMentionsFive]);

    // --- Scenario E: reviewer call throws (fixture missing) — the writer's already-paid-for
    // draft must be salvaged, not discarded. Writes only a writer fixture, deliberately leaves
    // the initial reviewer fixture absent so fixtureReviewerByTopic's readFileSync throws.
    writeScenarioFixtures(db, TOPIC_GAP, { omitFirstItem: false, repairStillPartial: false });
    const reviewerFixturePath = path.join(REVIEWER_FIXTURE_DIR, `${slugifyTopic(TOPIC_GAP)}.json`);
    unlinkSync(reviewerFixturePath);
    const writerE = countCalls((promptObj, opts) => fixtureWriter(promptObj, { fixtureDir: WRITER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const reviewerE = countCalls((promptObj, opts) => fixtureReviewerByTopic(promptObj, { fixtureDir: REVIEWER_FIXTURE_DIR, topic: opts.topic, attempt: opts.attempt }));
    const resultE = await generateArticleWithReview({
      db,
      topic: TOPIC_GAP,
      mustIncludeFacts: MUST_INCLUDE_FACTS,
      writer: writerE,
      reviewer: reviewerE,
      maxRetries: 1,
    });

    checks.push(['scenario E (reviewer throws): does not reject — returns the salvaged result instead', resultE !== undefined]);
    checks.push(['scenario E (reviewer throws): writer called exactly once — no repair attempted (no coverage summary to act on)', writerE.calls === 1]);
    checks.push(['scenario E (reviewer throws): reviewer was attempted exactly once', reviewerE.calls === 1]);
    checks.push(['scenario E (reviewer throws): reviewCoverageFailed is true', resultE.reviewCoverageFailed === true]);
    checks.push(['scenario E (reviewer throws): reviewCoverageFailedMessage is a non-empty string', typeof resultE.reviewCoverageFailedMessage === 'string' && resultE.reviewCoverageFailedMessage.length > 0]);
    checks.push(['scenario E (reviewer throws): review comes back null', resultE.review === null]);
    checks.push(['scenario E (reviewer throws): summary comes back null', resultE.summary === null]);
    checks.push(['scenario E (reviewer throws): retryCount stays 0', resultE.retryCount === 0]);
    checks.push(['scenario E (reviewer throws): the writer draft itself is still returned, not discarded', resultE.draft.title === 'Article about Time Decay']);
    checks.push(['scenario E (reviewer throws): internal-link insertion still ran against the salvaged draft (step 7 has no dependency on review)', Array.isArray(resultE.internalLinks.inserted) && Array.isArray(resultE.internalLinks.skipped)]);
  } finally {
    db.close();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — CLI-level: generate-article.js subprocess, --json output.
// ---------------------------------------------------------------------------

function runCli(extraArgs) {
  try {
    const stdout = execFileSync(
      'node',
      ['--no-warnings', 'generate-article.js', '--db', ORIGINAL_DB, '--writer-fixture-dir', WRITER_FIXTURE_DIR, '--reviewer-fixture-dir', REVIEWER_FIXTURE_DIR, ...extraArgs],
      { cwd: __dirname, encoding: 'utf-8' }
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function runPart2(db) {
  console.log('\n=== Part 2: CLI-level (generate-article.js subprocess) ===\n');
  const checks = [];

  // Reuse scenario B's fixtures (gap remains "partial" after repair) — the
  // interesting CLI case: gaps remain, but this must NOT fail the process.
  writeScenarioFixtures(db, TOPIC_GAP, { omitFirstItem: true, repairStillPartial: true });
  const factsFile = path.join(OUTPUT_DIR, 'generate-fixtures', 'must-include-facts.json');
  writeFileSync(factsFile, JSON.stringify(MUST_INCLUDE_FACTS), 'utf-8');

  const run = runCli(['--topic', TOPIC_GAP, '--must-include-facts', factsFile, '--json']);
  console.log('--- CLI stdout ---\n' + run.stdout);
  checks.push(['CLI: exits 0 even though a gap remains after the retry cap (informational, not a failure)', run.exitCode === 0]);

  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // leave parsed null — the next assertion fails and reports it
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: --json output retryCount === 1', parsed?.retryCount === 1]);
  checks.push(['CLI: --json output still reports the remaining partial item', parsed?.summary?.partial?.length === 1]);
  checks.push(['CLI: --json output checklist includes the must-include fact', parsed?.checklist?.some((c) => c.name === MUST_INCLUDE_FACTS[0])]);
  checks.push(['CLI: --json output carries an internalLinks report (§4 Phase 5)', Array.isArray(parsed?.internalLinks?.inserted) && Array.isArray(parsed?.internalLinks?.skipped)]);
  checks.push(['CLI: --json output draft carries suggestedGraphSteps (2-5 labels)', Array.isArray(parsed?.draft?.suggestedGraphSteps) && parsed.draft.suggestedGraphSteps.length >= 2 && parsed.draft.suggestedGraphSteps.length <= 5]);
  checks.push(['CLI: --json output draft body_text carries a "## " section-heading line', /^## .+$/m.test(parsed?.draft?.body_text ?? '')]);

  // --max-retries above the §5 cap must fail loudly at the CLI too.
  const capRun = runCli(['--topic', TOPIC_CLEAN, '--max-retries', '2']);
  checks.push(['CLI: --max-retries 2 exits non-zero', capRun.exitCode !== 0]);

  // --source-keyword (§4 Phase 2 facet) must reach retrievalContext.candidateSourceArticles —
  // "ipo" is unrelated to TOPIC_GAP itself, so any hit here can only come from the facet filter,
  // not topic-text scoring (see findCandidateSourceArticles' score-0.5 "facet with no topic
  // relevance" branch in retrieval-layer.js).
  const keywordRun = runCli(['--topic', TOPIC_GAP, '--source-keyword', 'ipo', '--json']);
  let keywordParsed = null;
  try {
    keywordParsed = JSON.parse(keywordRun.stdout);
  } catch {
    // leave keywordParsed null — the next assertion fails and reports it
  }
  checks.push(['CLI: --source-keyword reaches retrievalContext.candidateSourceArticles', keywordRun.exitCode === 0 && Array.isArray(keywordParsed?.retrievalContext?.candidateSourceArticles) && keywordParsed.retrievalContext.candidateSourceArticles.length > 0]);
  checks.push(['CLI: --source-keyword candidates are all actually tagged with that keyword', (keywordParsed?.retrievalContext?.candidateSourceArticles ?? []).every((c) => (c.keywords ?? []).some((k) => k.toLowerCase().includes('ipo')))]);

  // Reviewer-failure salvage (Part 1 scenario E), exercised end-to-end through the CLI: writer
  // fixture present, initial reviewer fixture deliberately absent so the reviewer call throws.
  writeScenarioFixtures(db, TOPIC_GAP, { omitFirstItem: false, repairStillPartial: false });
  unlinkSync(path.join(REVIEWER_FIXTURE_DIR, `${slugifyTopic(TOPIC_GAP)}.json`));

  const failRunJson = runCli(['--topic', TOPIC_GAP, '--json']);
  console.log('--- CLI stdout (reviewer-failure, --json) ---\n' + failRunJson.stdout);
  checks.push(['CLI (reviewer fails): exits 0 — a salvaged draft is not a pipeline failure', failRunJson.exitCode === 0]);

  let failParsed = null;
  try {
    failParsed = JSON.parse(failRunJson.stdout);
  } catch {
    // leave failParsed null — the next assertion fails and reports it
  }
  checks.push(['CLI (reviewer fails): --json output parses as JSON', failParsed !== null]);
  checks.push(['CLI (reviewer fails): --json output reviewCoverageFailed is true', failParsed?.reviewCoverageFailed === true]);
  checks.push(['CLI (reviewer fails): --json output carries a non-empty reviewCoverageFailedMessage', typeof failParsed?.reviewCoverageFailedMessage === 'string' && failParsed.reviewCoverageFailedMessage.length > 0]);
  checks.push(['CLI (reviewer fails): --json output review is null', failParsed?.review === null]);
  checks.push(['CLI (reviewer fails): --json output summary is null', failParsed?.summary === null]);
  checks.push(['CLI (reviewer fails): --json output still returns the writer draft', failParsed?.draft?.title === 'Article about Time Decay']);

  const failRunHuman = runCli(['--topic', TOPIC_GAP]);
  console.log('--- CLI stdout (reviewer-failure, human-readable) ---\n' + failRunHuman.stdout);
  checks.push(['CLI (reviewer fails): exits 0 in human-readable mode too', failRunHuman.exitCode === 0]);
  checks.push(['CLI (reviewer fails): printHuman() reports the coverage failure instead of a summary crash', failRunHuman.stdout.includes('Coverage review failed and was abandoned for this run')]);
  checks.push(['CLI (human-readable): printHuman() reports the suggested graph steps', failRunHuman.stdout.includes('Suggested graph steps')]);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(WRITER_FIXTURE_DIR, { recursive: true });
  mkdirSync(REVIEWER_FIXTURE_DIR, { recursive: true });
  if (!existsSync(ORIGINAL_DB)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, ORIGINAL_DB)} — run \`npm run extract\` first.`);
  }

  const checks = [
    ...runChecklistCheck(),
    ...runWriterResponseShapeCheck(),
    ...runLinkInsertionCheck(),
    ...runGraphStepsPromptCheck(),
    ...runCandidateSourceArticlesPromptCheck(),
    ...(await runPart1()),
  ];

  const db = new DatabaseSync(ORIGINAL_DB, { readOnly: true });
  try {
    checks.push(...runPart2(db));
  } finally {
    db.close();
  }

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
