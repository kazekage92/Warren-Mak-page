#!/usr/bin/env node
/**
 * Retrieval layer — extra-md-files/ai-article-pipeline.md §2 Step 6.
 *
 * Given a candidate topic and an already-populated knowledge-graph.db (see
 * extract-articles.js for `articles`, extract-entities.js for `entities`/
 * `article_entities`/`edges`), answers the one question every later pipeline
 * phase needs before generating or reviewing an article:
 *
 *   "What does the graph already know about this topic, and what should a
 *    new article do about it?"
 *
 * This is deliberately ONE composed query (`buildRetrievalContext`), not five
 * independent ones — §2 Step 6 lists five sub-steps (6.1-6.5) plus 6.6, but
 * the doc is explicit that Phase 2 (knowledge base search), Phase 5 (internal
 * linking), Phase 6 (content-hierarchy overlap check), and Phase 7 (duplicate
 * prevention) all consume the SAME underlying lookup — so it's built once
 * here and each caller reads the slice of the result it needs:
 *
 *   - Phase 2 / §2 Step 6.2      -> result.articleSummaries
 *   - Phase 5 / §2 Step 6.4      -> result.suggestedLinks
 *   - Phase 6 (content hierarchy) -> result.nearDuplicates (medium/high — angle differently)
 *   - Phase 7 (duplicate prevention) -> result.nearDuplicates (high — reconsider generating at all)
 *   - §5 coverage-reviewer checklist / §2 Step 6.6 -> result.checklist
 *
 * No LLM call anywhere in this file. Topic-to-entity matching is plain
 * case-insensitive substring/keyword matching over `entities.name` — the
 * same "don't build a separate NER/embedding/fuzzy-match system" stance §5's
 * non-goals and extract-entities.js's prompt-driven dedup already take. This
 * is intentionally the cheap, explainable half; an LLM only enters the
 * pipeline later, at the writer/reviewer calls (§4-5), once this layer has
 * narrowed down what's relevant.
 *
 * `scoreTitleSlugSimilarity`/`assessContentHierarchy` below complete Phase 6
 * (content-hierarchy enforcement) and Phase 7 (duplicate prevention) —
 * see extra-md-files/pipeline-phase-4-6-7-1-mvp.md §1. Entity-overlap
 * duplicate detection (`flagNearDuplicateCoverage` above) already covered
 * part of Phase 7; title/slug string similarity is the piece that was still
 * missing (two articles can share almost no graph entities yet still be a
 * near-duplicate by title, e.g. a rephrased "What Is A Structured Warrant?").
 *
 * `db` is accepted as anything exposing `.prepare(sql).all(...params)` /
 * `.get(...params)` — the subset of node:sqlite's DatabaseSync this module
 * actually uses. That's a deliberate narrow surface: §2's "Where extraction
 * runs" option (b) (in-browser, via sql.js) needs the same queries against a
 * WASM-loaded db, and sql.js's own `Database#prepare()` can be wrapped to
 * expose that same `.all()/.get()` shape — no rewrite of this file, just a
 * thin adapter, when §2 Step 7's in-browser incremental path is built.
 *
 * Usage:
 *   node retrieval-layer.js --topic "Time Decay"
 *   node retrieval-layer.js --topic "Leverage and Risk Management" --max-hops 2 --json
 *   node retrieval-layer.js --topic "..." --db ../admin/knowledge-graph.db   # (default shown)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { nextArg } from './cli-args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Generic English stopwords only — deliberately NOT filtering domain terms
// like "malaysia"/"warrant" even though they're common across this site's
// articles; narrowing the keyword-match fallback is what keeps topic
// matching honest without a real NLP stack.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are',
  'how', 'what', 'into', 'about', 'when', 'why', 'can', 'a', 'an', 'to', 'of',
  'in', 'on', 'is', 'it', 'as', 'or', 'be', 'by', 'not',
]);

function tokenize(text) {
  return (text.match(/[a-z0-9]+/gi) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// ---------------------------------------------------------------------------
// §2 Step 6.1 — related entities for a topic
// ---------------------------------------------------------------------------

/**
 * Matches `topic` against `entities.name`, cheapest signal first:
 *  1.0 — exact match (case-insensitive)
 *  0.9 — one string contains the other (either direction) — catches both
 *        "Time Decay" -> "Time Decay (Theta)" and the reverse
 *  0.6 — shares a non-stopword keyword (>= 4 chars) with the entity name
 * Returns entities actually found, sorted best-first, capped at `limit`.
 */
export function findSeedEntities(db, topic, opts = {}) {
  const { limit = 8 } = opts;
  const topicLower = (topic ?? '').trim().toLowerCase();
  if (!topicLower) return [];
  const topicWords = tokenize(topicLower);

  const scored = [];
  for (const entity of db.prepare('SELECT id, name, type FROM entities').all()) {
    const nameLower = entity.name.toLowerCase();
    let score = 0;
    let reason = null;
    if (nameLower === topicLower) {
      score = 1;
      reason = 'exact match with topic';
    } else if (topicLower.includes(nameLower) || nameLower.includes(topicLower)) {
      score = 0.9;
      reason = `entity name "${entity.name}" overlaps with the topic text`;
    } else if (topicWords.some((w) => nameLower.includes(w))) {
      score = 0.6;
      reason = `entity name "${entity.name}" shares a keyword with the topic`;
    }
    if (score > 0) scored.push({ id: entity.id, name: entity.name, type: entity.type, score, reason });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Expands `seedEntities` outward along `edges`, up to `maxHops` hops
 * (default 1 — one degree of relationship, matching §2 Step 6.1's "related
 * entities", not a full graph traversal). Returns the seed entities plus
 * everything reached, each tagged with `hop` (0 for seeds) and `via` (why it
 * was pulled in — the seed's own match reason at hop 0, or the edge phrase
 * that reached it at hop >= 1). Order is seeds first, then hop 1, hop 2, ...
 */
export function expandRelatedEntities(db, seedEntities, opts = {}) {
  const { maxHops = 1 } = opts;
  const byId = new Map(
    seedEntities.map((e) => [e.id, { id: e.id, name: e.name, type: e.type, hop: 0, via: e.reason ?? 'topic match' }])
  );
  let frontierIds = seedEntities.map((e) => e.id);

  for (let hop = 1; hop <= maxHops && frontierIds.length; hop++) {
    const placeholders = frontierIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT edg.relation, s.id AS sId, s.name AS sName, t.id AS tId, t.name AS tName, t.type AS tType, s.type AS sType
         FROM edges edg
         JOIN entities s ON s.id = edg.source_entity_id
         JOIN entities t ON t.id = edg.target_entity_id
         WHERE edg.source_entity_id IN (${placeholders}) OR edg.target_entity_id IN (${placeholders})`
      )
      .all(...frontierIds, ...frontierIds);

    const frontierSet = new Set(frontierIds);
    const nextFrontier = [];
    for (const row of rows) {
      const phrase = `${row.sName} --[${row.relation}]--> ${row.tName}`;
      const candidates = [
        { from: row.sId, to: row.tId, toName: row.tName, toType: row.tType },
        { from: row.tId, to: row.sId, toName: row.sName, toType: row.sType },
      ];
      for (const c of candidates) {
        if (frontierSet.has(c.from) && !byId.has(c.to)) {
          byId.set(c.to, { id: c.to, name: c.toName, type: c.toType, hop, via: phrase });
          nextFrontier.push(c.to);
        }
      }
    }
    frontierIds = nextFrontier;
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// §2 Step 6.2 — existing-article summaries for those entities
// ---------------------------------------------------------------------------

/**
 * For `entities` (any array of {id, name, ...} — seed or hop-expanded),
 * returns one entry per existing article that covers at least one of them:
 * {articleId, slug, filepath, title, summary, matchedEntities: [{name,
 * relevance_score}], maxRelevance, coverageRatio}. Sorted best-first by
 * maxRelevance (how central its single strongest matching entity is), then
 * by coverageRatio (how much of the given entity set it touches).
 */
export function getArticleSummariesForEntities(db, entities) {
  if (!entities.length) return [];
  const ids = entities.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT a.id AS articleId, a.slug, a.filepath, a.title, a.summary,
              e.name AS entityName, ae.relevance_score AS relevanceScore
       FROM article_entities ae
       JOIN articles a ON a.id = ae.article_id
       JOIN entities e ON e.id = ae.entity_id
       WHERE ae.entity_id IN (${placeholders})
       ORDER BY a.id, ae.relevance_score DESC`
    )
    .all(...ids);

  const byArticle = new Map();
  for (const row of rows) {
    if (!byArticle.has(row.articleId)) {
      byArticle.set(row.articleId, {
        articleId: row.articleId,
        slug: row.slug,
        filepath: row.filepath,
        title: row.title,
        summary: row.summary,
        matchedEntities: [],
      });
    }
    byArticle.get(row.articleId).matchedEntities.push({ name: row.entityName, relevance_score: row.relevanceScore });
  }

  const summaries = [...byArticle.values()];
  for (const s of summaries) {
    s.maxRelevance = Math.max(...s.matchedEntities.map((m) => m.relevance_score));
    s.coverageRatio = Number((s.matchedEntities.length / entities.length).toFixed(2));
  }
  summaries.sort((a, b) => b.maxRelevance - a.maxRelevance || b.coverageRatio - a.coverageRatio);
  return summaries;
}

// ---------------------------------------------------------------------------
// §2 Step 6.3 / Phase 6-7 — near-duplicate coverage flags
// ---------------------------------------------------------------------------

/**
 * Flags existing articles whose coverage of `seedEntities` (the topic's OWN
 * direct matches — NOT the hop-expanded set; a new article is a near-
 * duplicate of one that already covers the same core subject, not of one
 * that merely shares a related concept) is high enough to be a real overlap
 * risk. `level` is "high" (>= highThreshold — Phase 7: reconsider generating
 * a new article at all, or extend the existing one instead) or "medium"
 * (>= mediumThreshold — Phase 6: fine to proceed, but angle it differently).
 */
export function flagNearDuplicateCoverage(articleSummaries, seedEntities, opts = {}) {
  const { highThreshold = 0.6, mediumThreshold = 0.3 } = opts;
  if (!seedEntities.length) return [];
  const seedNames = new Set(seedEntities.map((e) => e.name));

  const flags = [];
  for (const article of articleSummaries) {
    const overlapping = article.matchedEntities.filter((m) => seedNames.has(m.name));
    if (!overlapping.length) continue;
    const ratio = overlapping.length / seedNames.size;
    const level = ratio >= highThreshold ? 'high' : ratio >= mediumThreshold ? 'medium' : null;
    if (!level) continue;
    flags.push({
      slug: article.slug,
      title: article.title,
      level,
      overlapRatio: Number(ratio.toFixed(2)),
      overlappingEntities: overlapping.map((m) => m.name),
      note:
        level === 'high'
          ? `"${article.title}" already covers ${overlapping.length}/${seedNames.size} of this topic's core ` +
            `entities — consider extending that article instead of generating a new, competing one.`
          : `"${article.title}" partially overlaps (${overlapping.length}/${seedNames.size} core entities) — ` +
            `fine to proceed, but angle the new article differently to avoid redundant coverage.`,
    });
  }
  flags.sort((a, b) => b.overlapRatio - a.overlapRatio);
  return flags;
}

// ---------------------------------------------------------------------------
// Phase 7 — title/slug string similarity (entity-overlap alone doesn't catch
// a rephrased title/slug that shares few or no graph entities)
// ---------------------------------------------------------------------------

/**
 * For every row in `articles`, scores how similar `candidateTitle`/
 * `candidateSlug` are to that article's own title/slug:
 *  - titleSimilarityScore: Jaccard token overlap (reuses this file's own
 *    `tokenize()` — case-insensitive, stopword-light, >=4 chars) between the
 *    two titles. 1.0 = identical token sets, 0 = no shared tokens.
 *  - slugSimilarityScore: 1.0 exact match, 0.7 one contains the other
 *    (either direction — catches a suffix/prefix variant of the same slug),
 *    else 0.
 * Returns only rows where either score clears its threshold
 * (`titleThreshold` default 0.3, `slugThreshold` default > 0), sorted
 * descending by the stronger of the two scores — the piece of Phase 7
 * ("title similarity, slug similarity... avoid generating articles that
 * directly compete") entity-overlap detection alone doesn't cover.
 */
export function scoreTitleSlugSimilarity(db, { candidateTitle, candidateSlug } = {}, opts = {}) {
  const { titleThreshold = 0.3, slugThreshold = 0 } = opts;
  const titleTokens = new Set(tokenize(candidateTitle ?? ''));
  const slugLower = (candidateSlug ?? '').trim().toLowerCase();

  const scored = [];
  for (const article of db.prepare('SELECT slug, title FROM articles').all()) {
    let titleSimilarityScore = 0;
    if (titleTokens.size && article.title) {
      const otherTokens = new Set(tokenize(article.title));
      if (otherTokens.size) {
        const intersectionSize = [...titleTokens].filter((t) => otherTokens.has(t)).length;
        const unionSize = new Set([...titleTokens, ...otherTokens]).size;
        titleSimilarityScore = unionSize ? Number((intersectionSize / unionSize).toFixed(2)) : 0;
      }
    }

    let slugSimilarityScore = 0;
    const otherSlug = (article.slug ?? '').toLowerCase();
    if (slugLower && otherSlug) {
      if (slugLower === otherSlug) slugSimilarityScore = 1;
      else if (slugLower.includes(otherSlug) || otherSlug.includes(slugLower)) slugSimilarityScore = 0.7;
    }

    if (titleSimilarityScore >= titleThreshold || slugSimilarityScore > slugThreshold) {
      scored.push({ slug: article.slug, title: article.title, titleSimilarityScore, slugSimilarityScore });
    }
  }

  scored.sort((a, b) => Math.max(b.titleSimilarityScore, b.slugSimilarityScore) - Math.max(a.titleSimilarityScore, a.slugSimilarityScore));
  return scored;
}

// ---------------------------------------------------------------------------
// Phase 6 — content-hierarchy check ("introduce briefly, then link" vs "safe
// to write a full article")
// ---------------------------------------------------------------------------

/**
 * Pure function over pieces `buildRetrievalContext` already computes — no
 * new query. If any `nearDuplicates` entry crosses the "high" overlap level
 * (an existing article already covers most of this topic's core entities),
 * flags this as an already-specialised topic: Phase 6's guidance is to
 * introduce it briefly in the new article, then link to the dedicated one,
 * rather than writing a second full treatment. Otherwise it's safe to write
 * a full article. `articleSummaries` isn't currently needed beyond what
 * `nearDuplicates` entries already carry (slug/title) — accepted as a
 * parameter anyway so this stays a stable, self-contained slice of the
 * composed retrieval context, matching every other function in this section.
 */
export function assessContentHierarchy(articleSummaries, nearDuplicates) {
  const highOverlap = nearDuplicates
    .filter((d) => d.level === 'high')
    .sort((a, b) => b.overlapRatio - a.overlapRatio)[0];

  if (!highOverlap) {
    return { overlapsSpecialisedArticle: false, article: null, recommendation: 'safe to write a full article' };
  }

  return {
    overlapsSpecialisedArticle: true,
    article: { slug: highOverlap.slug, title: highOverlap.title },
    recommendation:
      `"${highOverlap.title}" is already the specialised article on this topic (${highOverlap.overlapRatio * 100}% core-entity ` +
      `overlap) — introduce it briefly here, then link to the dedicated article, rather than writing a second full treatment.`,
  };
}

// ---------------------------------------------------------------------------
// §2 Step 6.4 / Phase 5 — suggested internal links
// ---------------------------------------------------------------------------

/**
 * For each of `seedEntities` (best-scored first), suggests linking to the
 * single existing article that covers it most strongly (highest
 * relevance_score), skipping articles already used for an earlier seed
 * entity so the same target isn't suggested twice. Matches §4 Phase 5's own
 * example almost exactly: "mentions of Time Decay -> link to the Time Decay
 * article; Risk Management -> link to the Why 90% article." Ordinary <a>
 * links in prose/`.article-related` per site convention — NOT the `.graph-*`
 * visual system (see doc §2 Step 6.4's own caveat). Capped at `max` (2-3 per
 * the doc); naturally returns fewer if fewer seed entities were found.
 */
export function suggestInternalLinks(articleSummaries, seedEntities, opts = {}) {
  const { max = 3 } = opts;
  const suggestions = [];
  const usedArticleIds = new Set();

  for (const seed of seedEntities) {
    if (suggestions.length >= max) break;
    let best = null;
    for (const article of articleSummaries) {
      if (usedArticleIds.has(article.articleId)) continue;
      const match = article.matchedEntities.find((m) => m.name === seed.name);
      if (match && (!best || match.relevance_score > best.relevance_score)) {
        best = { article, relevance_score: match.relevance_score };
      }
    }
    if (best) {
      usedArticleIds.add(best.article.articleId);
      suggestions.push({
        entity: seed.name,
        targetSlug: best.article.slug,
        targetTitle: best.article.title,
        suggestedLinkText: best.article.title,
        relevance_score: best.relevance_score,
      });
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// §2 Step 6.6 / §5 checklist — same entity list, reused not rebuilt
// ---------------------------------------------------------------------------

/**
 * Turns `relatedEntities` (seed + hop-expanded, from expandRelatedEntities)
 * into §5's checklist shape: {name, type, why}. This is the literal reuse
 * §2 Step 6.6 calls for — the coverage reviewer's checklist is this same
 * list, not a second query against the graph.
 */
export function buildChecklist(relatedEntities) {
  return relatedEntities.map((e) => ({
    name: e.name,
    type: e.type,
    why: e.hop === 0 ? (e.via ?? 'directly matches the topic') : `related to the topic via: ${e.via}`,
  }));
}

// ---------------------------------------------------------------------------
// The one composed query — build it once, every phase reads its own slice
// ---------------------------------------------------------------------------

/**
 * Combines title/slug string similarity (`scoreTitleSlugSimilarity`) with the
 * entity-based `nearDuplicates` flags into one Phase 7 verdict: "high" if
 * either signal strongly suggests the same article already exists (exact/
 * near-exact slug, high title token overlap, or a high-level entity-overlap
 * flag), "medium" if either signal is present but weaker, "none" otherwise.
 */
function assessDuplicateRisk(titleSlugMatches, nearDuplicates) {
  const strongTitleSlug = titleSlugMatches.some((m) => m.slugSimilarityScore >= 1 || m.titleSimilarityScore >= 0.6);
  const highEntityOverlap = nearDuplicates.some((d) => d.level === 'high');
  const verdict = strongTitleSlug || highEntityOverlap ? 'high' : titleSlugMatches.length || nearDuplicates.length ? 'medium' : 'none';
  return { verdict, titleSlugMatches, entityOverlap: nearDuplicates };
}

/**
 * @param {object} db - anything exposing `.prepare(sql).all(...)/.get(...)`
 * @param {string} topic - free-text candidate topic for a new article
 * @param {object} [opts]
 * @param {number} [opts.seedLimit=8] - max directly-matched entities to seed from
 * @param {number} [opts.maxHops=1] - edge-traversal depth for "related entities"
 * @param {number} [opts.maxSuggestedLinks=3] - cap on suggestedLinks (§2 Step 6.4: "2-3")
 * @param {number} [opts.highThreshold=0.6] / {number} [opts.mediumThreshold=0.3] - near-duplicate thresholds
 * @param {string} [opts.candidateTitle] / {string} [opts.candidateSlug] - Phase 7: when either is given,
 *   the result gains a `duplicateRisk` field (title/slug similarity across ALL articles, combined with
 *   the entity-based nearDuplicates flags into one verdict) — see scoreTitleSlugSimilarity/assessDuplicateRisk.
 */
export function buildRetrievalContext(db, topic, opts = {}) {
  const { seedLimit = 8, maxHops = 1, maxSuggestedLinks = 3, highThreshold, mediumThreshold, candidateTitle, candidateSlug } = opts;
  const hasCandidate = Boolean((candidateTitle ?? '').trim() || (candidateSlug ?? '').trim());

  const seedEntities = findSeedEntities(db, topic, { limit: seedLimit });
  if (!seedEntities.length) {
    const result = {
      topic,
      seedEntities: [],
      relatedEntities: [],
      articleSummaries: [],
      nearDuplicates: [],
      suggestedLinks: [],
      checklist: [],
      contentHierarchy: assessContentHierarchy([], []),
      note: 'No entity in the graph matched this topic — treat it as a genuinely new subject; nothing to flag or link yet.',
    };
    if (hasCandidate) {
      result.duplicateRisk = assessDuplicateRisk(scoreTitleSlugSimilarity(db, { candidateTitle, candidateSlug }), []);
    }
    return result;
  }

  const relatedEntities = expandRelatedEntities(db, seedEntities, { maxHops });
  const articleSummaries = getArticleSummariesForEntities(db, relatedEntities);
  const nearDuplicates = flagNearDuplicateCoverage(articleSummaries, seedEntities, { highThreshold, mediumThreshold });
  const suggestedLinks = suggestInternalLinks(articleSummaries, seedEntities, { max: maxSuggestedLinks });
  const checklist = buildChecklist(relatedEntities);
  const contentHierarchy = assessContentHierarchy(articleSummaries, nearDuplicates);

  const result = { topic, seedEntities, relatedEntities, articleSummaries, nearDuplicates, suggestedLinks, checklist, contentHierarchy };
  if (hasCandidate) {
    result.duplicateRisk = assessDuplicateRisk(scoreTitleSlugSimilarity(db, { candidateTitle, candidateSlug }), nearDuplicates);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    topic: null,
    maxHops: 1,
    maxLinks: 3,
    candidateTitle: null,
    candidateSlug: null,
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
      case '--max-hops': {
        const n = Number(nextArg(argv, ++i, '--max-hops'));
        if (!Number.isFinite(n) || n < 0) throw new Error('--max-hops must be a non-negative number');
        opts.maxHops = n;
        break;
      }
      case '--max-links': {
        const n = Number(nextArg(argv, ++i, '--max-links'));
        if (!Number.isFinite(n) || n < 0) throw new Error('--max-links must be a non-negative number');
        opts.maxLinks = n;
        break;
      }
      case '--candidate-title':
        opts.candidateTitle = nextArg(argv, ++i, '--candidate-title');
        break;
      case '--candidate-slug':
        opts.candidateSlug = nextArg(argv, ++i, '--candidate-slug');
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
  console.log(`Topic: "${result.topic}"\n`);
  if (result.note) {
    console.log(result.note);
    return;
  }

  console.log(`Seed entities (${result.seedEntities.length}):`);
  for (const e of result.seedEntities) console.log(`  - ${e.name} (${e.type}) [score ${e.score}] — ${e.reason}`);

  console.log(`\nRelated entities incl. seeds (${result.relatedEntities.length}):`);
  for (const e of result.relatedEntities) console.log(`  - ${e.name} (${e.type}) [hop ${e.hop}]`);

  console.log(`\nExisting article coverage (${result.articleSummaries.length}):`);
  for (const a of result.articleSummaries.slice(0, 10)) {
    console.log(`  - ${a.slug} (max relevance ${a.maxRelevance}, ${a.matchedEntities.length} matched entit${a.matchedEntities.length === 1 ? 'y' : 'ies'})`);
  }

  console.log(`\nNear-duplicate flags (${result.nearDuplicates.length}):`);
  for (const f of result.nearDuplicates) console.log(`  - [${f.level}] ${f.slug} (overlap ${f.overlapRatio})`);

  console.log(`\nSuggested internal links (${result.suggestedLinks.length}):`);
  for (const s of result.suggestedLinks) console.log(`  - "${s.entity}" -> ${s.targetSlug}`);

  console.log(`\nCoverage checklist (${result.checklist.length}) — reused verbatim by §5's reviewer:`);
  for (const c of result.checklist) console.log(`  - ${c.name}: ${c.why}`);

  console.log(`\nContent hierarchy (Phase 6): ${result.contentHierarchy.recommendation}`);
  if (result.contentHierarchy.overlapsSpecialisedArticle) {
    console.log(`  -> specialised article: ${result.contentHierarchy.article.slug}`);
  }

  if (result.duplicateRisk) {
    console.log(`\nDuplicate risk (Phase 7): ${result.duplicateRisk.verdict}`);
    for (const m of result.duplicateRisk.titleSlugMatches) {
      console.log(`  - ${m.slug} (title similarity ${m.titleSimilarityScore}, slug similarity ${m.slugSimilarityScore})`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  try {
    const result = buildRetrievalContext(db, opts.topic, {
      maxHops: opts.maxHops,
      maxSuggestedLinks: opts.maxLinks,
      candidateTitle: opts.candidateTitle,
      candidateSlug: opts.candidateSlug,
    });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } finally {
    db.close();
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
