#!/usr/bin/env node
/**
 * Topic picker — extra-md-files/automated-article-scheduler.md, "What's
 * new" component 1.
 *
 * Answers the question the (not-yet-built) orchestrator's step 1 needs
 * before anything else can run: "which Nanyang Siang Pau column, out of
 * Warren's 400+ published articles, should the auto-pipeline turn into a
 * new site article this cycle?"
 *
 * Three pieces, per the doc:
 *   1. Parse WARREN-MAK-NANYANG-ARTICLES.md's title list (parseNanyangCatalog).
 *      NOTE: that file is a curated reference/highlights index, not a literal
 *      400-row machine-readable catalog — see its own header ("used as
 *      source material... not published content itself"). It documents ~23
 *      individually-titled columns (the 11-part Structured Warrants series
 *      plus 12 "Key Trading Strategy" category highlights); the "Recent
 *      Articles" table's non-placeholder rows all turn out to duplicate
 *      those same 23 by date (see dedup below). Titles wrapped in [] are the
 *      file's own inferred/guessed placeholders (no confirmed real title
 *      known, only date + URL) — parsed and usable as topics, but flagged
 *      `inferred: true` and lightly deprioritized in scoring, below.
 *   2. Filter out anything already used by this pipeline before, per a new
 *      ledger file (admin/auto-article-history.json) — loadHistory() /
 *      appendHistoryEntry(). Never touched automatically by this script's
 *      own selection run; appendHistoryEntry() exists for the future
 *      orchestrator (component 5, not built in this pass) to call ONLY
 *      after a successful publish, matching the doc's own "updated... never
 *      on an aborted run" rule. `--mark-used` is a manual/testing shortcut
 *      that calls it immediately after selection — NOT what a real
 *      publish-gated call looks like.
 *   3. Score the remainder for "gap-ness" using retrieval-layer.js's
 *      EXISTING exports rather than inventing new scoring logic, per the
 *      doc's own instruction: scoreTitleSlugSimilarity() / entity-overlap
 *      nearDuplicates (both already composed into buildRetrievalContext()'s
 *      `duplicateRisk`/`nearDuplicates` when a candidateTitle/candidateSlug
 *      is passed) and assessContentHierarchy() (also already composed in,
 *      as `contentHierarchy`) — computeGapScore() below just reads those
 *      fields back out; it runs no query of its own. A candidate whose
 *      duplicateRisk verdict is "high" (an existing article already covers
 *      most of its core entities/title/slug) is excluded from selection
 *      entirely, not merely down-ranked — matching Phase 7's own "reconsider
 *      generating at all" guidance for that verdict level.
 *
 * If every catalog title is either already-used or scores "high" duplicate
 * risk, selectTopic() returns `{selected: null, reason: "..."}` rather than
 * forcing a pick — the doc's own "abort the run... rather than picking a bad
 * topic just to have one."
 *
 * No LLM call anywhere in this file — same "cheap, explainable, deterministic
 * first" stance retrieval-layer.js itself takes; this script is pure text
 * parsing + reuse of that file's already-LLM-free scoring.
 *
 * Usage:
 *   node select-topic.js
 *   node select-topic.js --json
 *   node select-topic.js --top 10                          # show more of the ranked candidate list
 *   node select-topic.js --include-high-risk                # debugging: don't exclude "high" duplicateRisk candidates
 *   node select-topic.js --catalog ../WARREN-MAK-NANYANG-ARTICLES.md   # (default shown)
 *   node select-topic.js --history ../admin/auto-article-history.json  # (default shown)
 *   node select-topic.js --db ../admin/knowledge-graph.db              # (default shown)
 *   node select-topic.js --mark-used                        # ALSO records the selection into the history ledger --
 *                                                              manual/testing convenience only, see appendHistoryEntry() below
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext } from './retrieval-layer.js';
import { slugifyTopic } from './generate-article.js';
import { nextArg } from './cli-args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_CATALOG_PATH = path.join(REPO_ROOT, 'WARREN-MAK-NANYANG-ARTICLES.md');
const DEFAULT_HISTORY_PATH = path.join(REPO_ROOT, 'admin', 'auto-article-history.json');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'admin', 'knowledge-graph.db');

// A bracket-titled entry (e.g. "[Warrant Pricing Dynamics]") is the file's own
// guess at what a column covered, based only on its date/URL, not a confirmed
// published title — nudged down relative to a confirmed-title candidate with
// the same underlying gap score, rather than excluded outright (it's still a
// perfectly usable English topic phrase for retrieval/generation purposes).
const INFERRED_TITLE_PENALTY = 0.8;

// ---------------------------------------------------------------------------
// Catalog parsing — pure function over WARREN-MAK-NANYANG-ARTICLES.md's text
// ---------------------------------------------------------------------------

// Matches both numbered ("1. **2018-07-11 — Title**") and bulleted
// ("- **2022-03-23 — Title**") entry lines the file uses for its two list
// styles (the "Article List (Chronological)" series and the "Key Trading
// Strategy Articles" category highlights, respectively) — anchored at both
// ends (`\*\*\s*$`) so a bold span elsewhere on the same line (e.g. "...
// price matrices: **Macquarie** and **Kenanga**", a plain sub-bullet, not an
// entry) never false-matches.
const ENTRY_LINE_PATTERN = /^\s*(?:\d+\.|-)\s+\*\*(\d{4}-\d{2}-\d{2})\s*(?:—|--)\s*(.+?)\*\*\s*$/;
const SUB_BULLET_URL_PATTERN = /^\s*-\s*URL:\s*(\S+)/i;
const H2_PATTERN = /^##\s+(.+)$/;
const H3_PATTERN = /^###\s+(.+)$/;
// The "Recent Articles" markdown table's rows — anchored on a leading date
// column so the header row ("| Date | Title (Chinese) | Topic |") and the
// `|---|---|---|` separator row never match (neither has a date there).
const TABLE_ROW_PATTERN = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

/**
 * Parses WARREN-MAK-NANYANG-ARTICLES.md's markdown text into candidate topic
 * entries: `{date, title, inferred, url, section, source}`.
 *
 * `inferred` is true only for the numbered list's `[Bracketed]` placeholder
 * titles (see module doc comment above). Table rows whose title column is a
 * generic placeholder like "(Testimonia Column)" (no real title available)
 * are skipped entirely rather than guessed at.
 *
 * Dedup: the same real column sometimes appears twice — once under a "Key
 * Trading Strategy Articles" category section, once as a row in the "Recent
 * Articles" table restating just its Chinese title. Entries are deduped by
 * `date` (the one field both representations always agree on), keeping the
 * FIRST occurrence encountered — list-section entries appear earlier in the
 * file than the table and carry richer data (URL, English translation), so
 * this naturally prefers them over the table's terser restatement.
 */
export function parseNanyangCatalog(markdownText) {
  const lines = markdownText.split(/\r?\n/);
  const entries = [];
  let currentH2 = null;
  let currentH3 = null;
  let pendingEntry = null;

  const flushPending = () => {
    if (pendingEntry) entries.push(pendingEntry);
    pendingEntry = null;
  };

  for (const line of lines) {
    const h2Match = H2_PATTERN.exec(line);
    if (h2Match) {
      flushPending();
      currentH2 = h2Match[1].trim();
      currentH3 = null;
      continue;
    }
    const h3Match = H3_PATTERN.exec(line);
    if (h3Match) {
      flushPending();
      currentH3 = h3Match[1].trim();
      continue;
    }

    const entryMatch = ENTRY_LINE_PATTERN.exec(line);
    if (entryMatch) {
      flushPending();
      const [, date, rawTitle] = entryMatch;
      const bracketMatch = /^\[(.+)\]$/.exec(rawTitle.trim());
      pendingEntry = {
        date,
        title: (bracketMatch ? bracketMatch[1] : rawTitle).trim(),
        inferred: Boolean(bracketMatch),
        url: null,
        section: currentH3 ? `${currentH2} > ${currentH3}` : currentH2,
        source: 'list',
      };
      continue;
    }

    if (pendingEntry) {
      if (line.trim() === '') {
        flushPending();
        continue;
      }
      const urlMatch = SUB_BULLET_URL_PATTERN.exec(line);
      if (urlMatch && !pendingEntry.url) {
        pendingEntry.url = urlMatch[1];
        continue;
      }
      if (/^\s*-\s/.test(line)) continue; // other sub-bullet (Topic:/Key:/etc.) — ignore, entry stays pending
      flushPending(); // a non-bullet, non-blank line ends the entry's block
    }

    const tableMatch = TABLE_ROW_PATTERN.exec(line);
    if (tableMatch) {
      const [, date, rawTitle, topicHint] = tableMatch;
      const cleanTitle = rawTitle.trim();
      if (/^\(.*\)$/.test(cleanTitle)) continue; // generic placeholder row ("(Testimonia Column)") — no real title, skip
      entries.push({
        date,
        title: cleanTitle,
        inferred: false,
        url: null,
        section: currentH2,
        source: 'table',
        topicHint: topicHint.trim(),
      });
    }
  }
  flushPending();

  const seenDates = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (seenDates.has(entry.date)) continue;
    seenDates.add(entry.date);
    deduped.push(entry);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// History ledger — admin/auto-article-history.json
// ---------------------------------------------------------------------------

function normalizeTitleForMatch(title) {
  return title.trim().toLowerCase();
}

/** Reads/validates the ledger. Missing file reads as `[]` (a brand-new
 *  pipeline with no publish history yet is the normal starting state, not an
 *  error) — but a PRESENT file that's malformed (bad JSON, not an array, or
 *  an entry missing one of its three required string fields) throws loudly
 *  rather than silently treating corrupted history as "nothing used yet",
 *  which would risk regenerating an already-published topic. */
export function loadHistory(historyPath) {
  if (!existsSync(historyPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(historyPath, 'utf-8'));
  } catch (err) {
    throw new Error(`History ledger is not valid JSON (${historyPath}): ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`History ledger must be a JSON array (${historyPath})`);
  }
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry.nanyangTitle !== 'string' || !entry.nanyangTitle.trim() ||
      typeof entry.slug !== 'string' || !entry.slug.trim() ||
      typeof entry.publishedAt !== 'string' || !entry.publishedAt.trim()
    ) {
      throw new Error(
        `History ledger has a malformed entry (needs non-empty nanyangTitle/slug/publishedAt strings): ${JSON.stringify(entry)}`
      );
    }
  }
  return parsed;
}

/**
 * Appends one `{nanyangTitle, slug, publishedAt}` row and rewrites the
 * ledger file. Per the doc: this is meant to be called by the future
 * orchestrator (component 5, not built in this pass) ONLY after a real
 * publish succeeds, never on an aborted run — this script's own `main()`
 * only calls it behind the explicit `--mark-used` testing flag, not on every
 * selection.
 */
export function appendHistoryEntry(historyPath, entry) {
  if (!entry || typeof entry.nanyangTitle !== 'string' || !entry.nanyangTitle.trim()) {
    throw new Error('appendHistoryEntry: entry.nanyangTitle must be a non-empty string');
  }
  if (typeof entry.slug !== 'string' || !entry.slug.trim()) {
    throw new Error('appendHistoryEntry: entry.slug must be a non-empty string');
  }
  if (typeof entry.publishedAt !== 'string' || !entry.publishedAt.trim()) {
    throw new Error('appendHistoryEntry: entry.publishedAt must be a non-empty string');
  }
  const history = loadHistory(historyPath);
  history.push({ nanyangTitle: entry.nanyangTitle.trim(), slug: entry.slug.trim(), publishedAt: entry.publishedAt.trim() });
  writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf-8');
  return history;
}

// ---------------------------------------------------------------------------
// Scoring — reads buildRetrievalContext()'s ALREADY-composed fields, no new query
// ---------------------------------------------------------------------------

/**
 * Gap-ness score: 1 - (the strongest similarity signal buildRetrievalContext
 * already computed for this candidateTitle/candidateSlug) — 1.0 means
 * nothing in the existing graph resembles this topic at all (a genuinely new
 * subject), 0.0 means an existing article is essentially the same thing.
 * Reads `duplicateRisk.titleSlugMatches` (Phase 7 title/slug similarity) and
 * `nearDuplicates` (Phase 6/7 entity-overlap) — both already produced by
 * `buildRetrievalContext`'s own composed query when a candidateTitle/
 * candidateSlug is passed; this function computes nothing new, it only
 * reduces those two lists to one number.
 */
export function computeGapScore(retrievalContext) {
  const titleSlugMax = (retrievalContext.duplicateRisk?.titleSlugMatches ?? []).reduce(
    (max, m) => Math.max(max, m.titleSimilarityScore, m.slugSimilarityScore),
    0
  );
  const entityOverlapMax = (retrievalContext.nearDuplicates ?? []).reduce((max, d) => Math.max(max, d.overlapRatio), 0);
  const similarity = Math.max(titleSlugMax, entityOverlapMax);
  return Number((1 - similarity).toFixed(3));
}

/**
 * @param {object} db - anything retrieval-layer.js's buildRetrievalContext accepts
 * @param {object} opts
 * @param {string} opts.catalogText - WARREN-MAK-NANYANG-ARTICLES.md's raw text
 * @param {Array} [opts.history] - loadHistory() output
 * @param {number} [opts.inferredTitlePenalty]
 * @param {boolean} [opts.excludeHighDuplicateRisk=true] - Phase 7: drop candidates whose
 *   duplicateRisk verdict is "high" instead of merely down-ranking them
 * @returns {{selected: object|null, candidates: object[], reason: string|null,
 *   totalCatalogSize: number, usedFilteredCount: number}}
 */
export function selectTopic(db, { catalogText, history = [], inferredTitlePenalty = INFERRED_TITLE_PENALTY, excludeHighDuplicateRisk = true }) {
  const catalog = parseNanyangCatalog(catalogText);
  const usedTitles = new Set(history.map((h) => normalizeTitleForMatch(h.nanyangTitle)));
  const unused = catalog.filter((entry) => !usedTitles.has(normalizeTitleForMatch(entry.title)));

  const scored = unused.map((entry) => {
    const candidateSlug = slugifyTopic(entry.title);
    const retrievalContext = buildRetrievalContext(db, entry.title, { candidateTitle: entry.title, candidateSlug });
    const rawGapScore = computeGapScore(retrievalContext);
    const gapScore = Number((entry.inferred ? rawGapScore * inferredTitlePenalty : rawGapScore).toFixed(3));
    return {
      ...entry,
      candidateSlug,
      gapScore,
      duplicateRiskVerdict: retrievalContext.duplicateRisk?.verdict ?? 'none',
      contentHierarchy: retrievalContext.contentHierarchy,
      nearDuplicates: retrievalContext.nearDuplicates,
    };
  });

  // Gap score descending; ties broken by more-recent column first (no
  // stronger signal to prefer one over the other, and a more recent column
  // is more likely to reflect current market conditions/products).
  scored.sort((a, b) => b.gapScore - a.gapScore || (a.date < b.date ? 1 : -1));

  const eligible = excludeHighDuplicateRisk ? scored.filter((c) => c.duplicateRiskVerdict !== 'high') : scored;
  const usedFilteredCount = catalog.length - unused.length;

  if (!eligible.length) {
    let reason;
    if (catalog.length === 0) {
      reason = 'WARREN-MAK-NANYANG-ARTICLES.md yielded no parseable candidate titles at all.';
    } else if (unused.length === 0) {
      reason = 'Every catalog title has already been used by this pipeline (per the history ledger).';
    } else {
      reason = 'Every remaining candidate title scores as already well-covered (duplicateRisk: "high") — nothing left to safely pick.';
    }
    return { selected: null, candidates: scored, reason, totalCatalogSize: catalog.length, usedFilteredCount };
  }

  return { selected: eligible[0], candidates: scored, reason: null, totalCatalogSize: catalog.length, usedFilteredCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    catalogPath: DEFAULT_CATALOG_PATH,
    historyPath: DEFAULT_HISTORY_PATH,
    dbPath: DEFAULT_DB_PATH,
    top: 5,
    includeHighRisk: false,
    markUsed: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--catalog':
        opts.catalogPath = path.resolve(nextArg(argv, ++i, '--catalog'));
        break;
      case '--history':
        opts.historyPath = path.resolve(nextArg(argv, ++i, '--history'));
        break;
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--top': {
        const n = Number(nextArg(argv, ++i, '--top'));
        if (!Number.isInteger(n) || n < 1) throw new Error('--top must be a positive integer');
        opts.top = n;
        break;
      }
      case '--include-high-risk':
        opts.includeHighRisk = true;
        break;
      case '--mark-used':
        opts.markUsed = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

function printHuman(result, topN) {
  if (!result.selected) {
    console.log(`No topic selected: ${result.reason}`);
  } else {
    const s = result.selected;
    console.log(`Selected topic: "${s.title}"`);
    console.log(
      `  Nanyang date: ${s.date}${s.url ? ` (${s.url})` : ''}${s.inferred ? ' [inferred title — not the article\'s confirmed published title]' : ''}`
    );
    console.log(`  Section: ${s.section ?? '(unknown)'}`);
    console.log(`  Candidate slug: ${s.candidateSlug}`);
    console.log(`  Gap score: ${s.gapScore} (duplicate risk: ${s.duplicateRiskVerdict})`);
    console.log(`  ${s.contentHierarchy.recommendation}`);
  }
  console.log(`\n(${result.usedFilteredCount}/${result.totalCatalogSize} catalog titles already used per the history ledger)`);
  console.log(`Top ${Math.min(topN, result.candidates.length)} candidate(s) by gap score:`);
  for (const c of result.candidates.slice(0, topN)) {
    console.log(`  - [gap ${c.gapScore}, risk ${c.duplicateRiskVerdict}] "${c.title}" (${c.date})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.catalogPath)) {
    throw new Error(`Catalog file not found: ${opts.catalogPath}`);
  }
  const catalogText = readFileSync(opts.catalogPath, 'utf-8');
  const history = loadHistory(opts.historyPath);

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  let result;
  try {
    result = selectTopic(db, { catalogText, history, excludeHighDuplicateRisk: !opts.includeHighRisk });
  } finally {
    db.close();
  }

  if (opts.markUsed) {
    if (!result.selected) throw new Error('--mark-used given but no topic was selected — nothing to record.');
    appendHistoryEntry(opts.historyPath, {
      nanyangTitle: result.selected.title,
      slug: result.selected.candidateSlug,
      publishedAt: new Date().toISOString(),
    });
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result, opts.top);

  // No eligible topic is a real "nothing to do, abort" outcome per the doc's
  // own "abort the run" framing for this case — non-zero so a future
  // orchestrator's shell/CI step can detect it via exit code.
  process.exitCode = result.selected ? 0 : 1;
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
