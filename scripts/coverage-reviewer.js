/**
 * Coverage reviewer core — extra-md-files/ai-article-pipeline.md §5.
 *
 * Different question from fact-retention-checker.js's §3 judge: this checks
 * whether a DRAFT ARTICLE (AI-generated or manually authored) covers a
 * checklist pulled from the graph — it assumes the graph itself is already
 * trustworthy (that's §3's job). Input: {checklist, draft body text}. Output:
 * strict JSON, one item per checklist entry —
 *   {"items":[{"name":"...", "status":"covered|partial|missing", "evidence":"..."}]}
 *
 * This is a SEPARATE LLM call from whatever produced the draft — never the
 * writer re-checking its own output in the same turn (§5: "shares the same
 * blind spots that caused the omission"). generate-article.js is the only
 * caller that also calls a writer; this file never calls one.
 *
 * Deliberately framework-agnostic: no `node:*` imports anywhere below
 * buildReviewPrompt/parseReviewResponse/summarizeReview — those three run
 * unmodified in Node (generate-article.js, the AI-generation path) or in a
 * browser (admin/index.html's wizard, the manual-authoring path — §5 "Also
 * applies to manually-authored content"). admin/index.html is a standalone,
 * self-contained page per root CLAUDE.md (no build step, no imports from
 * scripts/, which is dev-only tooling not part of the deployed site) — so its
 * copy is a hand-kept mirror of those three functions, not a live import.
 * Keep them in sync if either changes; search admin/index.html for
 * "mirrors scripts/coverage-reviewer.js" to find its copy.
 *
 * The `openAIReviewer`/`fixtureReviewer` pair below (the actual network call)
 * DOES use `fetch`/`node:fs`-adjacent globals and is Node-only by convention,
 * matching fact-retention-checker.js's openAIJudge/fixtureJudge split — the
 * browser path supplies its own reviewer function that calls OpenAI directly
 * with the decrypted client-side key instead of reading OPENAI_API_KEY.
 *
 * Usage (as a library — see generate-article.js for the orchestration CLI):
 *   import { buildReviewPrompt, parseReviewResponse, summarizeReview,
 *            openAIReviewer, fixtureReviewer } from './coverage-reviewer.js';
 */

import { readFileSync } from 'node:fs';

export const VALID_REVIEW_STATUSES = new Set(['covered', 'partial', 'missing']);
const DEFAULT_REVIEWER_MODEL = 'gpt-4o-mini'; // judgment task, not generation — cheapest tier is fine (§5)

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function formatChecklist(checklist) {
  if (!checklist.length) return '(empty — nothing was selected as required coverage for this article)';
  return checklist
    .map((c) => `- "${c.name}"${c.type ? ` (${c.type})` : ''}${c.why ? ` — ${c.why}` : ''}`)
    .join('\n');
}

/**
 * @param {object} args
 * @param {Array<{name:string, type?:string, why?:string}>} args.checklist - entities
 *   selected for this article (§2 Step 6.6 / retrieval-layer.js's buildChecklist) plus
 *   any manually-curated must-include facts, already merged into one list by the caller.
 * @param {string} args.draftText - the draft article's English body text (plain text or
 *   HTML — the reviewer is told it may contain markup and to judge substance, not markup).
 */
export function buildReviewPrompt({ checklist, draftText }) {
  const system =
    'You are a knowledge-coverage auditor for an article publishing pipeline (a trading education ' +
    'site). You are given a CHECKLIST of entities/facts an article is supposed to cover, and the ' +
    'DRAFT article\'s body text (which may contain HTML markup -- judge the substance, ignore markup). ' +
    'Your only job: for every checklist item, judge how well the draft covers it.\n\n' +
    'Statuses:\n' +
    '- "covered": the draft clearly discusses this entity/fact, correctly and substantively.\n' +
    '- "partial": the draft mentions it only in passing, vaguely, or incompletely.\n' +
    '- "missing": the draft does not mention it at all, or mentions something unrelated with a ' +
    'similar name.\n\n' +
    'When status is "covered" or "partial", quote a short (<=1 sentence) piece of evidence from the ' +
    'draft in "evidence". When status is "missing", leave "evidence" as an empty string.\n\n' +
    'Judge every checklist item individually. Do not invent items that are not on the checklist, and ' +
    'do not skip any that are.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"items":[{"name":"<the checklist item name, verbatim>","status":"covered|partial|missing",' +
    '"evidence":"<short quote, or empty string for missing>"}]}';

  const user = `Checklist (${checklist.length} item(s)):\n${formatChecklist(checklist)}\n\nDraft article body text:\n${draftText}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing / validation
// ---------------------------------------------------------------------------

export function parseReviewResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Reviewer response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error(`Reviewer response is missing an "items" array.\nRaw response:\n${rawText}`);
  }
  for (const item of parsed.items) {
    if (!item || typeof item.name !== 'string' || !VALID_REVIEW_STATUSES.has(item.status)) {
      throw new Error(
        `Malformed reviewer item (needs string "name" + status in covered|partial|missing): ` +
          `${JSON.stringify(item)}`
      );
    }
  }
  return parsed;
}

/** Buckets a parsed review result into covered/partial/missing arrays plus a
 *  single `allCovered` flag — the thing both generate-article.js's retry
 *  logic and admin/index.html's Knowledge Coverage panel actually need,
 *  rather than each re-deriving it from `items` themselves. */
export function summarizeReview(result) {
  const covered = result.items.filter((i) => i.status === 'covered');
  const partial = result.items.filter((i) => i.status === 'partial');
  const missing = result.items.filter((i) => i.status === 'missing');
  return { covered, partial, missing, allCovered: partial.length === 0 && missing.length === 0 };
}

// ---------------------------------------------------------------------------
// Reviewers (pluggable — Node-only network call, see file header)
// ---------------------------------------------------------------------------

/** Production reviewer: a real OpenAI call. Reads OPENAI_API_KEY from the
 *  environment — the "(a) local/developer-run Node script" path from §2
 *  "Where extraction runs", same split fact-retention-checker.js's
 *  openAIJudge documents. */
export async function openAIReviewer({ system, user }, { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_REVIEWER_MODEL } = {}) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this ' +
        'script for real, or pass --reviewer-fixture-dir to validate offline (see scripts/README.md).'
    );
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/** Offline reviewer: reads a pre-recorded raw JSON response from disk
 *  instead of calling out to OpenAI. Used for validation — see
 *  validate-generate-article.js and scripts/README.md. */
export function fixtureReviewer(_promptObj, { fixturePath }) {
  return readFileSync(fixturePath, 'utf-8');
}
