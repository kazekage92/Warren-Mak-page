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
 *   - Phase 2 / §2 Step 6.2      -> result.articleSummaries (published `articles`, via the entity
 *                                    graph) AND result.candidateSourceArticles (unpublished
 *                                    `source_articles` rows, via findCandidateSourceArticles() —
 *                                    the "search by keyword/topic/category" half of Phase 2's own
 *                                    wording that stayed unbuilt until scrape-enanyang-articles.js
 *                                    actually populated source_articles.keywords at scale; queried
 *                                    directly since those rows carry no entities/edges of their own)
 *   - Phase 5 / §2 Step 6.4      -> result.suggestedLinks (WHAT to link — this file's
 *                                    insertSuggestedLinks(), below suggestInternalLinks,
 *                                    is the separate step that actually links it: consumed
 *                                    by generate-article.js as the final step of
 *                                    generateArticleWithReview(), not part of this composed
 *                                    query itself since it needs a draft body text to insert into)
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
 *   node retrieval-layer.js --topic "IPO" --source-keyword ipo               # Phase 2: narrow candidateSourceArticles to a keyword facet
 *   node retrieval-layer.js --source-category "fundamental analysis"         # Phase 2: browse a facet with no free-text topic at all
 *   node retrieval-layer.js --topic "..." --max-source-candidates 10
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
// Phase 2 — candidate source-article selection ("Never rely on a single
// article — before generating, search for related source articles by
// keyword/topic similarity/category/tag" — extra-md-files/ai-article-
// pipeline.md's Phase 2). Distinct from getArticleSummariesForEntities()
// above, which covers already-PUBLISHED `articles` via the entity graph:
// this searches `source_articles` (imported-but-not-yet-turned-into-an-
// article eNanyang columns) directly, since those rows carry no
// entities/edges of their own. This is the piece of Phase 2 that stayed
// unbuilt until scrape-enanyang-articles.js actually populated
// source_articles.keywords at scale (see that column's own schema.sql
// comment — TradeWizard's own filter tags, distinct from `category`).
// ---------------------------------------------------------------------------

/**
 * Finds `source_articles` rows relevant to `topic`, scored cheapest-signal-
 * first (same "no NLP stack" stance as findSeedEntities above):
 *  1.0 — topic appears verbatim in the title (case-insensitive)
 *  0.8 — topic shares a keyword (this file's own tokenize(), >=4 chars,
 *        non-stopword) with one of the row's `keywords` tags
 *  0.6 — topic shares a keyword with the row's `category`
 *  0.4 — topic shares a keyword with `original_content` (body text — the
 *        weakest signal, only checked when nothing stronger matched, so a
 *        topic word's incidental mention deep in a column's body doesn't
 *        drown out real title/tag/category matches)
 *
 * `opts.keyword` and `opts.category` are FACETS, not just scoring inputs:
 * substring, case-insensitive (matching filterRowsByCategoryAndKeyword()'s
 * own semantics in scrape-enanyang-articles.js, so a value copied from one
 * flag to the other behaves the same way) — a row failing either given facet
 * is dropped entirely before scoring, never merely down-ranked. Any row that
 * PASSES a given facet is guaranteed a floor score of 0.5 (reason names
 * which facet matched) even when `topic` itself adds no extra text-match
 * signal on top of that — this is what makes the facet an actual filter, not
 * just a tie-breaker: "browse everything tagged IPO" (no topic at all) and
 * "articles about Warren's IPO topic, but only ones tagged IPO" (topic +
 * facet, topic text not necessarily present anywhere in the row) both return
 * every facet-matching row, the same "keyword facet" admin/index.html's
 * Knowledge Search screen exposes over the same column.
 *
 * Rows with `status = 'ignored'` are excluded — that status means an admin
 * already reviewed and deliberately excluded this source article from future
 * generation (schema.sql's status enum), so it should never resurface here
 * even if it'd otherwise score well.
 *
 * Returns `{id, title, slug, category, keywords, originalUrl, score, reason}`
 * sorted best-first, capped at `opts.limit` (default 5).
 */
export function findCandidateSourceArticles(db, topic, opts = {}) {
  const { limit = 5, keyword = null, category = null } = opts;
  const topicLower = (topic ?? '').trim().toLowerCase();
  const topicWords = tokenize(topicLower);
  const keywordLower = keyword ? keyword.trim().toLowerCase() : null;
  const categoryLower = category ? category.trim().toLowerCase() : null;

  const rows = db
    .prepare(
      `SELECT id, title, slug, category, keywords, original_content, original_url
       FROM source_articles WHERE status IS NULL OR status != 'ignored'`
    )
    .all();

  const scored = [];
  for (const row of rows) {
    let rowKeywords = [];
    try {
      const parsed = row.keywords ? JSON.parse(row.keywords) : [];
      if (Array.isArray(parsed)) rowKeywords = parsed.filter((k) => typeof k === 'string');
    } catch {
      // malformed keywords JSON on an older/hand-edited row — treat as no keywords rather than throw
    }
    const rowKeywordsLower = rowKeywords.map((k) => k.toLowerCase());
    const rowCategoryLower = (row.category ?? '').toLowerCase();

    if (keywordLower && !rowKeywordsLower.some((k) => k.includes(keywordLower))) continue;
    if (categoryLower && !rowCategoryLower.includes(categoryLower)) continue;

    let score = 0;
    let reason = null;
    const titleLower = (row.title ?? '').toLowerCase();
    if (topicLower && titleLower.includes(topicLower)) {
      score = 1;
      reason = 'topic appears in the title';
    } else if (topicWords.length && rowKeywordsLower.some((k) => topicWords.some((w) => k.includes(w)))) {
      score = 0.8;
      reason = 'shares a keyword tag with the topic';
    } else if (topicWords.length && rowCategoryLower && topicWords.some((w) => rowCategoryLower.includes(w))) {
      score = 0.6;
      reason = 'shares a keyword with the category';
    } else if (topicWords.length && topicWords.some((w) => (row.original_content ?? '').toLowerCase().includes(w))) {
      score = 0.4;
      reason = 'topic keyword appears in the body text';
    }
    // Facet floor: this row already passed the --keyword/--category filter above (or there was
    // no topic at all to score against) — surface it at a baseline score rather than dropping it,
    // even when the topic text itself adds no EXTRA relevance signal on top of the facet match.
    // Without this, a facet + an unrelated topic string would silently produce zero candidates,
    // which defeats the point of "browse/narrow by this keyword" as a real filter.
    if (score === 0 && (keywordLower || categoryLower)) {
      score = 0.5;
      reason = keywordLower ? `tagged with keyword "${keyword}"` : `in category "${category}"`;
    }
    if (score > 0) {
      scored.push({
        id: row.id,
        title: row.title,
        slug: row.slug,
        category: row.category,
        keywords: rowKeywords,
        originalUrl: row.original_url,
        score,
        reason,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Phase 5 (continued) — AUTO-INSERTING suggested links into a draft, not just
// suggesting them. `suggestInternalLinks` above answers "what should link to
// what"; this answers "make it actually link" — the piece Phase 5's own
// wording ("auto-recommend relevant internal links... e.g. mentions of Time
// Decay -> link to the Time Decay article") asks for and generate-article.js
// previously stopped short of, per that file's own header note ("nothing
// here auto-inserts <a> tags"). Pure text transform, no LLM — consistent
// with this file's own "no LLM call anywhere in this file" stance.
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * For each `suggestedLinks` entry (best-scored first, per
 * `suggestInternalLinks`'s own ordering), finds the FIRST verbatim mention of
 * `entity` in `bodyText` (case-insensitive, boundary-checked on both sides
 * via alphanumeric lookaround rather than `\b` — "Time Decay" matches "Time
 * Decay" but not "Time Decayed"; deliberately NOT plain `\b`, which breaks on
 * an entity ending in punctuation like "Time Decay (Theta)": `\b` needs a
 * word/non-word transition, and a trailing `)` immediately followed by a
 * space is non-word on both sides, so `\b` never matches there even though
 * the mention is a perfectly good word boundary in the everyday sense) and
 * wraps it in an ordinary
 * `<a href="<targetSlug>.html">` anchor, same relative-link convention every
 * hand-authored article's `.article-related` block already uses (root
 * `CLAUDE.md`). Anchor text is the mention exactly as it appears in the
 * draft, not the target article's title — this links the sentence the writer
 * already wrote rather than injecting a new suggested-title phrase into the
 * prose. `bodyText` is expected to be the plain-paragraph text
 * `generate-article.js`'s writer produces (§4 Phase 3) — this only adds
 * inline `<a>` markup at the matched span, it doesn't otherwise touch the
 * surrounding plain text.
 *
 * An entity with no verbatim mention in the draft (the writer discussed the
 * concept in different words, or skipped it) is reported in `skipped`, never
 * force-inserted as an unrelated sentence — matching §5's own "never
 * silently dropped or silently force-inserted" stance for coverage gaps.
 * Also skips a match that would land inside an anchor an earlier suggestion
 * in this same call already inserted (rare — only possible when two
 * suggested entities' names overlap as substrings), rather than risk nested
 * or broken markup.
 *
 * Returns `{bodyText, inserted, skipped}` — `bodyText` is the original string
 * unchanged if `suggestedLinks` is empty or nothing matched.
 */
export function insertSuggestedLinks(bodyText, suggestedLinks) {
  let result = bodyText;
  const inserted = [];
  const skipped = [];
  const anchoredRanges = []; // [start, end) spans already wrapped in <a>, in `result`'s current coordinates

  for (const link of suggestedLinks) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(link.entity)}(?![a-z0-9])`, 'i');
    const match = pattern.exec(result);
    if (!match) {
      skipped.push({ entity: link.entity, targetSlug: link.targetSlug, reason: 'entity name not found verbatim in the draft body text' });
      continue;
    }
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const overlapsExisting = anchoredRanges.some(([s, e]) => matchStart < e && matchEnd > s);
    if (overlapsExisting) {
      skipped.push({ entity: link.entity, targetSlug: link.targetSlug, reason: 'only verbatim mention found falls inside a link already inserted for another suggestion' });
      continue;
    }

    const mentionText = match[0];
    const anchor = `<a href="${link.targetSlug}.html">${mentionText}</a>`;
    result = result.slice(0, matchStart) + anchor + result.slice(matchEnd);

    const delta = anchor.length - mentionText.length;
    for (const range of anchoredRanges) {
      if (range[0] >= matchStart) {
        range[0] += delta;
        range[1] += delta;
      }
    }
    anchoredRanges.push([matchStart, matchStart + anchor.length]);

    inserted.push({ entity: link.entity, targetSlug: link.targetSlug, targetTitle: link.targetTitle, mentionText });
  }

  return { bodyText: result, inserted, skipped };
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
 * @param {number} [opts.maxSourceCandidates=5] - cap on candidateSourceArticles (Phase 2, below)
 * @param {string} [opts.sourceKeyword] / {string} [opts.sourceCategory] - Phase 2: optional facet filters
 *   narrowing `candidateSourceArticles` to `source_articles` rows matching this keyword tag / category
 *   bucket (substring, case-insensitive — see findCandidateSourceArticles' own doc comment). Either can
 *   be given with no `topic` at all, to just browse a facet.
 */
export function buildRetrievalContext(db, topic, opts = {}) {
  const {
    seedLimit = 8,
    maxHops = 1,
    maxSuggestedLinks = 3,
    highThreshold,
    mediumThreshold,
    candidateTitle,
    candidateSlug,
    maxSourceCandidates = 5,
    sourceKeyword,
    sourceCategory,
  } = opts;
  const hasCandidate = Boolean((candidateTitle ?? '').trim() || (candidateSlug ?? '').trim());

  // Phase 2 — independent of the entity graph (source_articles rows carry no
  // entities/edges of their own), so this runs regardless of whether any
  // seed entity matched below, and is attached to both early-return and
  // full result shapes.
  const candidateSourceArticles = findCandidateSourceArticles(db, topic, {
    limit: maxSourceCandidates,
    keyword: sourceKeyword,
    category: sourceCategory,
  });

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
      candidateSourceArticles,
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

  const result = {
    topic,
    seedEntities,
    relatedEntities,
    articleSummaries,
    nearDuplicates,
    suggestedLinks,
    checklist,
    contentHierarchy,
    candidateSourceArticles,
  };
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
    sourceKeyword: null,
    sourceCategory: null,
    maxSourceCandidates: 5,
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
      case '--source-keyword':
        opts.sourceKeyword = nextArg(argv, ++i, '--source-keyword');
        break;
      case '--source-category':
        opts.sourceCategory = nextArg(argv, ++i, '--source-category');
        break;
      case '--max-source-candidates': {
        const n = Number(nextArg(argv, ++i, '--max-source-candidates'));
        if (!Number.isInteger(n) || n < 0) throw new Error('--max-source-candidates must be a non-negative integer');
        opts.maxSourceCandidates = n;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  // --topic is normally required, EXCEPT when a --source-keyword/--source-category facet is
  // given on its own — that's a valid "browse everything tagged X" query with no free-text
  // topic at all (see findCandidateSourceArticles' own doc comment).
  if (!opts.topic && !opts.sourceKeyword && !opts.sourceCategory) {
    throw new Error('--topic is required (or pass --source-keyword/--source-category to browse source articles by facet alone)');
  }
  return opts;
}

function printCandidateSourceArticles(result) {
  console.log(`\nCandidate source articles (Phase 2, ${result.candidateSourceArticles.length}):`);
  for (const c of result.candidateSourceArticles) {
    console.log(`  - [score ${c.score}] "${c.title}" (${c.slug}) — ${c.reason}${c.category ? ` [category: ${c.category}]` : ''}`);
  }
}

function printHuman(result) {
  console.log(`Topic: "${result.topic}"\n`);
  if (result.note) {
    console.log(result.note);
    printCandidateSourceArticles(result);
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

  printCandidateSourceArticles(result);
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
      sourceKeyword: opts.sourceKeyword,
      sourceCategory: opts.sourceCategory,
      maxSourceCandidates: opts.maxSourceCandidates,
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
