#!/usr/bin/env node
/**
 * Entity/relationship extraction — extra-md-files/ai-article-pipeline.md §2
 * Step 4-5, and build-order steps 3-4 ("Batch extraction script" +
 * "Raise batch size / parallelism > 2").
 *
 * This is the LLM half extract-articles.js deliberately stops short of: for
 * every article already in the `articles` table (populated by
 * extract-articles.js), calls the LLM on that article's English body_text to
 * extract entities + relations, upserts them into `entities`/
 * `article_entities`/`edges`, then runs the §3 fact-retention checker
 * (fact-retention-checker.js) comparing that article's pre/post induced
 * subgraph.
 *
 * Two modes, controlled by --batch-size (default 1):
 *  - batch-size 1 (default): ONE article per LLM call, processed
 *    SEQUENTIALLY — build-order step 3's original scope. Checker runs
 *    immediately after each write, before the next article starts.
 *  - batch-size > 1: build-order step 4 ("raise batch size / parallelism
 *    beyond 2"), implemented as MULTI-ARTICLE BATCHING, not concurrency —
 *    up to N articles are sent in ONE LLM call (buildBatchExtractionPrompt),
 *    so the model dedupes entity names across those articles itself, within
 *    a single response, before any of them are written. This is the design
 *    choice made over running several single-article calls concurrently:
 *    concurrent calls would each hold a stale snapshot of "existing entity
 *    names" w.r.t. sibling in-flight calls, recreating the exact dedup race
 *    this section originally flagged as unsafe to bolt on casually. Batches
 *    are still processed sequentially (no two LLM calls in flight at once),
 *    and each article within a batch is written then checked individually,
 *    same as single-article mode — only the LLM call itself is now shared
 *    across several articles.
 *
 * Both the extractor and the checker's judge are dependency-injected (same
 * pattern as fact-retention-checker.js) so this is testable without spending
 * API calls or needing OPENAI_API_KEY present — see validate-extract-
 * entities.js, validate-extract-entities-batch.js, and scripts/README.md.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node extract-entities.js
 *   node extract-entities.js --slug <slug>                    # one article only
 *   node extract-entities.js --batch-size 5                   # up to 5 articles per LLM call
 *   node extract-entities.js --dry-run                        # extract + print, no db write, no checker
 *   node extract-entities.js --skip-checker                   # write without the retention gate (unsafe — testing only)
 *   node extract-entities.js --stop-on-regression              # halt the whole run at the first dropped/altered item
 *   node extract-entities.js --extract-fixture-dir DIR --judge-fixture-dir DIR  # fully offline, see README
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getArticleEntityEdgeState, checkFactRetention, openAIJudge, fixtureJudge } from './fact-retention-checker.js';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_MODEL = 'gpt-4o-mini'; // extraction from ~12 short article bodies — cheapest tier is fine (§6)

// Budget per article's {entities,edges} JSON block. In batch mode
// (processArticleBatch) one LLM call covers several articles at once, so the
// ceiling scales with how many articles are actually in that call rather than
// being a single flat constant — a --batch-size 5 run needs roughly 5x the
// headroom a single-article call does. Capped at MAX_TOKENS_CAP (gpt-4o-mini's
// max output) so a very large --batch-size can't request more than the model
// can return.
const MAX_TOKENS_PER_ARTICLE = 1500;
const MAX_TOKENS_CAP = 16000;

// Observed/declared vocabulary — the `entities.type`/`edges.relation` values seen in the
// hand-authored sample plus the relation set named in the schema comment (§2). Not a hard
// enum in SQLite; used to steer the prompt and to flag (not reject) anything unexpected.
const KNOWN_ENTITY_TYPES = ['topic', 'product', 'organization', 'concept', 'strategy', 'person'];
const KNOWN_RELATIONS = ['related_to', 'prerequisite_of', 'part_of', 'contradicts', 'updates', 'distinguished_from'];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    slug: null,
    model: DEFAULT_MODEL,
    batchSize: 1,
    dryRun: false,
    skipChecker: false,
    stopOnRegression: false,
    extractFixtureDir: null,
    judgeFixtureDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--slug':
        opts.slug = nextArg(argv, ++i, '--slug');
        break;
      case '--model':
        opts.model = nextArg(argv, ++i, '--model');
        break;
      case '--batch-size': {
        const n = Number(nextArg(argv, ++i, '--batch-size'));
        if (!Number.isInteger(n) || n < 1) throw new Error('--batch-size must be a positive integer');
        opts.batchSize = n;
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--skip-checker':
        opts.skipChecker = true;
        break;
      case '--stop-on-regression':
        opts.stopOnRegression = true;
        break;
      case '--extract-fixture-dir':
        opts.extractFixtureDir = path.resolve(nextArg(argv, ++i, '--extract-fixture-dir'));
        break;
      case '--judge-fixture-dir':
        opts.judgeFixtureDir = path.resolve(nextArg(argv, ++i, '--judge-fixture-dir'));
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Splits `items` into consecutive chunks of at most `size`, preserving
 *  order. size <= 1 yields one chunk per item (equivalent to no batching). */
export function chunkArray(items, size) {
  if (size <= 1) return items.map((item) => [item]);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Prompt construction
//
// admin/index.html's incremental knowledge-graph extraction (publish-time,
// see its "INCREMENTAL KNOWLEDGE-GRAPH EXTRACTION" section) carries a
// hand-kept mirror of this function as kgBuildExtractionPrompt — search
// admin/index.html for "mirrors scripts/extract-entities.js" to find it, and
// keep the two in sync if either changes (including KNOWN_ENTITY_TYPES/
// KNOWN_RELATIONS above, mirrored there as KG_ENTITY_TYPES/KG_RELATIONS).
// validate-admin-mirror-sync.js checks the two produce identical output
// automatically.
// ---------------------------------------------------------------------------

export function buildExtractionPrompt({ article, existingEntities }) {
  const system =
    'You are an entity/relationship extractor populating a knowledge graph behind an article-' +
    'generation pipeline for a Malaysian structured-warrants trading education site. Given one ' +
    "article's English body text, extract the entities (topics, products, concepts, strategies, " +
    'organizations, people) it substantively discusses, and the relations between them.\n\n' +
    `Entity "type" should normally be one of: ${KNOWN_ENTITY_TYPES.join(', ')}.\n` +
    `Edge "relation" should normally be one of: ${KNOWN_RELATIONS.join(', ')}.\n\n` +
    'You will be given a list of entities that already exist in the graph (from other articles). ' +
    'If this article discusses the same real-world concept, REUSE that exact existing name — do ' +
    'not create a near-duplicate node (e.g. "warrant trading" vs "trading warrants" must stay one ' +
    'entity, not two). Only invent a new entity name when the concept genuinely is not in that list.\n\n' +
    'relevance_score is 0.0-1.0: how central the entity is to THIS article (a passing mention is ' +
    'low, e.g. 0.2-0.4; the main subject is high, e.g. 0.8-1.0).\n\n' +
    'For edges, prefer the most specific supported relation. Use "related_to" only when the article ' +
    'explicitly explains a meaningful connection between the two entities but none of the specific ' +
    'relations fits. Do NOT use "related_to" as a fallback for loose co-occurrence, same-section ' +
    'mentions, or low confidence. If the relationship is not clearly supported by the article text, ' +
    'omit the edge.\n\n' +
    'Every edge\'s "source" and "target" MUST each be a name that also appears in your own ' +
    '"entities" list in this response — do not reference an entity you did not include.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"entities":[{"name":"...","type":"...","relevance_score":0.0}],' +
    '"edges":[{"source":"...","relation":"...","target":"..."}]}';

  const existingList = existingEntities.length
    ? existingEntities.map((e) => `- "${e.name}" (${e.type})`).join('\n')
    : '(none yet)';

  const user =
    `Article slug: ${article.slug}\n` +
    `Title: ${article.title}\n\n` +
    `Existing entities already in the graph (reuse these exact names when the same concept ` +
    `appears):\n${existingList}\n\n` +
    `Article body text:\n${article.body_text}`;

  return { system, user };
}

/** Batched counterpart to buildExtractionPrompt — one LLM call covering
 *  `articles.length` articles at once. This is build-order step 4's chosen
 *  design (see file header): the prompt explicitly tells the model to keep
 *  entity naming consistent ACROSS the articles in this one batch, which is
 *  what makes it safe to raise batch size without racing concurrent calls
 *  against each other — there is only ever one in-flight call, covering
 *  several articles instead of one. */
export function buildBatchExtractionPrompt({ articles, existingEntities }) {
  const system =
    'You are an entity/relationship extractor populating a knowledge graph behind an article-' +
    'generation pipeline for a Malaysian structured-warrants trading education site. You will be ' +
    `given ${articles.length} articles' English body text in a single batch. For EACH article, ` +
    'extract the entities (topics, products, concepts, strategies, organizations, people) it ' +
    'substantively discusses, and the relations between them — scoped to that one article, exactly ' +
    'as if you were extracting it alone.\n\n' +
    `Entity "type" should normally be one of: ${KNOWN_ENTITY_TYPES.join(', ')}.\n` +
    `Edge "relation" should normally be one of: ${KNOWN_RELATIONS.join(', ')}.\n\n` +
    'You will be given a list of entities that already exist in the graph (from articles processed ' +
    'in prior batches). If any article in THIS batch discusses the same real-world concept, REUSE ' +
    'that exact existing name — do not create a near-duplicate node.\n\n' +
    'Additionally — and this is the reason these articles are sent together rather than one at a ' +
    'time — if the SAME real-world concept appears in more than one article within this batch, use ' +
    'the exact same entity name in every article\'s block where it appears (e.g. if one article ' +
    'calls it "warrant trading" and another article in this batch discusses the identical concept, ' +
    'that article\'s block must also say "warrant trading", not "trading warrants"). Only invent a ' +
    'new entity name when the concept genuinely is not in the existing-entities list AND has not ' +
    'already appeared in an earlier article\'s block in this same batch.\n\n' +
    'relevance_score is 0.0-1.0: how central the entity is to THAT SPECIFIC article (a passing ' +
    'mention is low, e.g. 0.2-0.4; the main subject is high, e.g. 0.8-1.0) — the same entity name ' +
    'can have a different relevance_score in different articles\' blocks.\n\n' +
    'For edges, prefer the most specific supported relation. Use "related_to" only when that article ' +
    'explicitly explains a meaningful connection between the two entities but none of the specific ' +
    'relations fits. Do NOT use "related_to" as a fallback for loose co-occurrence, same-section ' +
    'mentions, or low confidence. If the relationship is not clearly supported by that article text, ' +
    'omit the edge.\n\n' +
    'Every edge\'s "source" and "target" MUST each be a name that also appears in that SAME ' +
    'article\'s own "entities" list in this response — do not reference an entity from a different ' +
    'article\'s block, or one you did not include.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"articles":[{"slug":"...","entities":[{"name":"...","type":"...","relevance_score":0.0}],' +
    '"edges":[{"source":"...","relation":"...","target":"..."}]}]}\n' +
    'The "articles" array must contain exactly one entry per article given below, in the same ' +
    'order, each with its correct "slug".';

  const existingList = existingEntities.length
    ? existingEntities.map((e) => `- "${e.name}" (${e.type})`).join('\n')
    : '(none yet)';

  const articleBlocks = articles
    .map(
      (article, i) =>
        `--- Article ${i + 1} ---\nSlug: ${article.slug}\nTitle: ${article.title}\n\nBody text:\n${article.body_text}`
    )
    .join('\n\n');

  const user =
    `Existing entities already in the graph (reuse these exact names when the same concept ` +
    `appears):\n${existingList}\n\n${articleBlocks}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing / validation
// ---------------------------------------------------------------------------

/** Shared validation/dedup core for one article's {entities, edges} block —
 *  used both by the single-article response (parseExtractionResponse) and,
 *  once-per-block, by the batch response (parseBatchExtractionResponse).
 *  `context` (e.g. a slug) is prefixed onto warnings/errors when validating
 *  one block out of a larger batch response, so a problem is traceable back
 *  to the article that caused it. */
function validateAndDedupeExtraction(parsed, { context = '' } = {}) {
  const prefix = context ? `[${context}] ` : '';

  const entities = parsed.entities.map((e) => {
    if (!e || typeof e.name !== 'string' || !e.name.trim() || typeof e.type !== 'string' || !e.type.trim()) {
      throw new Error(`${prefix}Malformed entity (needs non-empty string "name" + "type"): ${JSON.stringify(e)}`);
    }
    if (!KNOWN_ENTITY_TYPES.includes(e.type)) {
      console.warn(`  ! ${prefix}unfamiliar entity type "${e.type}" on "${e.name}" — kept as-is`);
    }
    let relevance_score = Number(e.relevance_score);
    if (!Number.isFinite(relevance_score) || relevance_score < 0 || relevance_score > 1) {
      console.warn(`  ! ${prefix}invalid relevance_score on "${e.name}" (${e.relevance_score}) — defaulting to 0.5`);
      relevance_score = 0.5;
    }
    return { name: e.name.trim(), type: e.type.trim(), relevance_score };
  });

  // Dedup by case-insensitive name — keep first occurrence, warn on drop.
  // Same spirit as the (source,relation,target) triple-dedup writeExtractionResult
  // already does for edges (its `seenEdges` set) — here it's a single LLM response
  // (or, in batch mode, a single article's block within one) occasionally emitting
  // the same real-world entity twice under different casing (e.g. "Bursa Malaysia"
  // and "bursa malaysia").
  const seenEntityNames = new Set();
  const dedupedEntities = [];
  for (const entity of entities) {
    const key = entity.name.toLowerCase();
    if (seenEntityNames.has(key)) {
      console.warn(`  ! ${prefix}duplicate entity "${entity.name}" (case-insensitive) — dropping, keeping first occurrence`);
      continue;
    }
    seenEntityNames.add(key);
    dedupedEntities.push(entity);
  }

  // Case-insensitive lookup so an edge that names a dropped duplicate (different
  // casing than the kept occurrence) still resolves — normalized to the kept
  // entity's exact casing so entities/edges stay consistent.
  const canonicalNameByLower = new Map(dedupedEntities.map((e) => [e.name.toLowerCase(), e.name]));
  const edges = [];
  for (const edge of parsed.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.relation !== 'string' || typeof edge.target !== 'string') {
      throw new Error(`${prefix}Malformed edge (needs string "source"/"relation"/"target"): ${JSON.stringify(edge)}`);
    }
    if (!KNOWN_RELATIONS.includes(edge.relation)) {
      console.warn(`  ! ${prefix}unfamiliar relation "${edge.relation}" on "${edge.source}" -> "${edge.target}" — kept as-is`);
    }
    const canonicalSource = canonicalNameByLower.get(edge.source.toLowerCase());
    const canonicalTarget = canonicalNameByLower.get(edge.target.toLowerCase());
    if (!canonicalSource || !canonicalTarget) {
      console.warn(
        `  ! ${prefix}skipping edge "${edge.source}" -[${edge.relation}]-> "${edge.target}": ` +
          `endpoint not in this response's own entities list`
      );
      continue;
    }
    edges.push({ source: canonicalSource, relation: edge.relation, target: canonicalTarget });
  }

  return { entities: dedupedEntities, edges };
}

export function parseExtractionResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Extractor response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || !Array.isArray(parsed.entities) || !Array.isArray(parsed.edges)) {
    throw new Error(`Extractor response is missing "entities"/"edges" arrays.\nRaw response:\n${rawText}`);
  }
  return validateAndDedupeExtraction(parsed);
}

/** Batched counterpart to parseExtractionResponse. Expects
 *  {"articles":[{"slug","entities","edges"}, ...]} and returns a
 *  Map<slug, {entities, edges}> with the same per-block validation/dedup
 *  parseExtractionResponse applies to a single-article response. Throws if
 *  the response is malformed, has a duplicate/missing slug block, or lacks
 *  an entry for any slug in `expectedSlugs` — a batch response is trusted
 *  as a whole or not at all, since one LLM call produced it together. */
export function parseBatchExtractionResponse(rawText, expectedSlugs) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Batch extractor response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || !Array.isArray(parsed.articles)) {
    throw new Error(`Batch extractor response is missing an "articles" array.\nRaw response:\n${rawText}`);
  }

  const bySlug = new Map();
  for (const entry of parsed.articles) {
    if (!entry || typeof entry.slug !== 'string' || !entry.slug.trim()) {
      throw new Error(`Batch extractor response has an article block with no valid "slug": ${JSON.stringify(entry)}`);
    }
    if (!Array.isArray(entry.entities) || !Array.isArray(entry.edges)) {
      throw new Error(`Batch extractor response's block for slug "${entry.slug}" is missing "entities"/"edges" arrays.`);
    }
    if (bySlug.has(entry.slug)) {
      throw new Error(`Batch extractor response has more than one block for slug "${entry.slug}".`);
    }
    bySlug.set(entry.slug, validateAndDedupeExtraction(entry, { context: entry.slug }));
  }

  const missing = expectedSlugs.filter((slug) => !bySlug.has(slug));
  if (missing.length) {
    throw new Error(`Batch extractor response is missing block(s) for: ${missing.join(', ')}`);
  }

  return bySlug;
}

// ---------------------------------------------------------------------------
// Extractors (pluggable — see file header)
// ---------------------------------------------------------------------------

/** Production extractor: a real OpenAI call. Same shape as fact-retention-
 *  checker.js's openAIJudge, kept as its own small function rather than a
 *  shared helper — the two scripts stay independently readable. */
export async function openAIExtractor(
  { system, user },
  { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_MODEL, slug, articleCount = 1 } = {}
) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this ' +
        'script for real, or pass --extract-fixture-dir to validate offline (see scripts/README.md).'
    );
  }
  return callOpenAIChat({
    apiKey,
    model,
    system,
    user,
    maxTokens: Math.min(MAX_TOKENS_CAP, MAX_TOKENS_PER_ARTICLE * Math.max(1, articleCount)),
    temperature: 0,
    callerLabel: `extract-entities.js openAIExtractor${slug ? ` (${slug})` : ''}`,
  });
}

/** Offline extractor: reads a pre-recorded raw JSON response from
 *  <fixtureDir>/<slug>.json instead of calling out to OpenAI. */
export function fixtureExtractor(_promptObj, { fixtureDir, slug }) {
  const fixturePath = path.join(fixtureDir, `${slug}.json`);
  if (!existsSync(fixturePath)) {
    throw new Error(`No extraction fixture at ${path.relative(REPO_ROOT, fixturePath)} for slug "${slug}"`);
  }
  return readFileSync(fixturePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// DB read/write
// ---------------------------------------------------------------------------

export function listArticles(db, { onlySlug }) {
  if (onlySlug) {
    const row = db.prepare('SELECT id, slug, title, body_text FROM articles WHERE slug = ?').get(onlySlug);
    if (!row) throw new Error(`No article with slug "${onlySlug}" in the db.`);
    return [row];
  }
  return db.prepare('SELECT id, slug, title, body_text FROM articles ORDER BY id').all();
}

export function getExistingEntities(db) {
  return db.prepare('SELECT name, type FROM entities ORDER BY name').all();
}

/** Upserts one article's extraction result: replaces this article's own
 *  article_entities rows and the induced-subgraph edges between them (entity
 *  rows themselves are never deleted — they may be shared with other
 *  articles; §2 Step 8's maintenance pass owns dedup/orphan cleanup, not this
 *  script). Runs fully synchronously inside one transaction — no `await`
 *  between BEGIN and COMMIT — so this is safe to call from concurrently-
 *  scheduled article pipelines without corrupting interleaved writes, even
 *  though nothing in this script schedules concurrency today (see header).
 *
 *  KNOWN LIMITATION (see admin/knowledge-graph.schema.sql's comment on
 *  `edges` for the full writeup): the DELETE below removes every edge whose
 *  source AND target are both in this article's OWN entity set — but `edges`
 *  has no article_id, so if two of those entities are ALSO shared with a
 *  different article that has an edge between them, that edge gets deleted
 *  here too. It only comes back if this article's own extraction happens to
 *  re-emit it; otherwise it silently vanishes from the graph even though
 *  nothing about the OTHER article changed. Not fixed here — fixing it needs
 *  a schema change (an `edges.article_id` column plus a display-time
 *  dedup/merge pass), which is a bigger structural change than this pass. */
export function writeExtractionResult(db, { articleId, extraction }) {
  db.exec('BEGIN');
  try {
    const oldEntityIds = db
      .prepare('SELECT entity_id FROM article_entities WHERE article_id = ?')
      .all(articleId)
      .map((r) => r.entity_id);

    if (oldEntityIds.length) {
      const placeholders = oldEntityIds.map(() => '?').join(',');
      // See this function's doc comment: this can delete a DIFFERENT article's edge
      // if it happens to connect two entities this article also uses.
      db.prepare(
        `DELETE FROM edges WHERE source_entity_id IN (${placeholders}) AND target_entity_id IN (${placeholders})`
      ).run(...oldEntityIds, ...oldEntityIds);
    }
    db.prepare('DELETE FROM article_entities WHERE article_id = ?').run(articleId);

    const findEntity = db.prepare('SELECT id, type FROM entities WHERE name = ? COLLATE NOCASE');
    const insertEntity = db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)');
    const updateEntityType = db.prepare('UPDATE entities SET type = ? WHERE id = ?');
    // ON CONFLICT rather than a plain INSERT: defense in depth against this response's
    // own entities list containing a same-name-different-casing duplicate that slipped
    // past parseExtractionResponse's own dedup — schema's UNIQUE(article_id, entity_id)
    // is what makes this fire instead of silently double-inserting.
    const insertArticleEntity = db.prepare(
      'INSERT INTO article_entities (article_id, entity_id, relevance_score) VALUES (?, ?, ?) ' +
        'ON CONFLICT(article_id, entity_id) DO UPDATE SET relevance_score = excluded.relevance_score'
    );

    const idByName = new Map(); // this response's entity name -> resolved id
    for (const entity of extraction.entities) {
      const existing = findEntity.get(entity.name);
      let entityId;
      if (existing) {
        entityId = existing.id;
        if (existing.type !== entity.type) updateEntityType.run(entity.type, entityId);
      } else {
        entityId = Number(insertEntity.run(entity.name, entity.type).lastInsertRowid);
      }
      idByName.set(entity.name, entityId);
      insertArticleEntity.run(articleId, entityId, entity.relevance_score);
    }

    const insertEdge = db.prepare('INSERT INTO edges (source_entity_id, relation, target_entity_id) VALUES (?, ?, ?)');
    const seenEdges = new Set(); // dedup exact (source,relation,target) triples within this one response
    for (const edge of extraction.edges) {
      const key = `${edge.source}|${edge.relation}|${edge.target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      insertEdge.run(idByName.get(edge.source), edge.relation, idByName.get(edge.target));
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-article pipeline: extract -> write -> checker, in that order
// ---------------------------------------------------------------------------

export async function processArticle(db, article, opts) {
  const { dbPath, model, dryRun, skipChecker, extract, extractOpts, judge, judgeOpts } = opts;

  const oldState = getArticleEntityEdgeState(dbPath, article.slug);

  const existingEntities = getExistingEntities(db); // re-read every call — sees this run's own prior writes too
  const promptObj = buildExtractionPrompt({ article, existingEntities });
  const rawResponse = await extract(promptObj, { ...extractOpts, model, slug: article.slug, articleCount: 1 });
  const extraction = parseExtractionResponse(rawResponse);

  console.log(
    `  ${article.slug}: extracted ${extraction.entities.length} entit${extraction.entities.length === 1 ? 'y' : 'ies'}, ` +
      `${extraction.edges.length} edge(s)`
  );

  if (dryRun) {
    console.log('    (dry-run — not writing to the db, not running the checker)');
    return { slug: article.slug, status: 'dry-run' };
  }

  writeExtractionResult(db, { articleId: article.id, extraction });

  if (skipChecker) {
    console.log('    ! --skip-checker set — wrote without the fact-retention gate.');
    return { slug: article.slug, status: 'written-unchecked' };
  }

  const newState = getArticleEntityEdgeState(dbPath, article.slug);
  const result = await checkFactRetention({
    slug: article.slug,
    oldState,
    newState,
    judge,
    judgeOpts: { ...judgeOpts, slug: article.slug },
  });

  const dropped = result.items.filter((i) => i.status === 'dropped');
  const altered = result.items.filter((i) => i.status === 'altered');
  if (dropped.length || altered.length) {
    console.log(`    ! fact-retention regression(s) on ${article.slug}:`);
    for (const item of [...dropped, ...altered]) {
      console.log(`      - [${item.status}] ${item.name}: ${item.note ?? ''}`);
    }
    return { slug: article.slug, status: 'regression', dropped, altered };
  }

  console.log(`    checker: ${result.items.length} prior item(s), all retained.`);
  return { slug: article.slug, status: 'ok' };
}

/** Batched counterpart to processArticle: extracts `articles` in ONE LLM
 *  call (buildBatchExtractionPrompt), then writes and checks each article
 *  individually — same write/checker semantics as the single-article path,
 *  just sharing one extraction call across the batch. Returns an array of
 *  per-article results in the same shape processArticle returns a single
 *  one of, so callers can treat batch-size-1 and batch-size-N runs
 *  identically when aggregating outcomes.
 *
 *  Pre-batch state for every article is captured up front, before any
 *  article in the batch is written — comparing each article's checker state
 *  against its state before the WHOLE batch ran (not mid-batch) is what
 *  keeps the comparison meaningful when articles in the same batch share
 *  entities with each other.
 *
 *  A failure extracting/parsing the batch response fails every article in
 *  the batch together (there is only one LLM call to blame); a failure
 *  writing one article's result is isolated to that article, same as the
 *  per-article try/catch in main() isolates a single-article failure. */
export async function processArticleBatch(db, articles, opts) {
  const { dbPath, model, dryRun, skipChecker, extract, extractOpts, judge, judgeOpts } = opts;
  const slugs = articles.map((a) => a.slug);
  const batchKey = slugs.join('+'); // used as the fixture/log key for this whole batch

  const oldStates = new Map(slugs.map((slug) => [slug, getArticleEntityEdgeState(dbPath, slug)]));

  const existingEntities = getExistingEntities(db); // one snapshot shared by every article in this batch
  const promptObj = buildBatchExtractionPrompt({ articles, existingEntities });

  let extractionBySlug;
  try {
    const rawResponse = await extract(promptObj, { ...extractOpts, model, slug: batchKey, articleCount: articles.length });
    extractionBySlug = parseBatchExtractionResponse(rawResponse, slugs);
  } catch (err) {
    console.error(`  ! batch [${slugs.join(', ')}]: extraction failed — ${err.message}`);
    return articles.map((a) => ({ slug: a.slug, status: 'error', error: err.message }));
  }

  const totalEntities = [...extractionBySlug.values()].reduce((n, e) => n + e.entities.length, 0);
  const totalEdges = [...extractionBySlug.values()].reduce((n, e) => n + e.edges.length, 0);
  console.log(`  batch [${slugs.join(', ')}]: extracted ${totalEntities} total entit(ies), ${totalEdges} total edge(s)`);

  if (dryRun) {
    console.log('    (dry-run — not writing to the db, not running the checker)');
    return articles.map((a) => ({ slug: a.slug, status: 'dry-run' }));
  }

  const writeErrors = new Map();
  for (const article of articles) {
    try {
      writeExtractionResult(db, { articleId: article.id, extraction: extractionBySlug.get(article.slug) });
    } catch (err) {
      console.error(`  ! ${article.slug}: write failed — ${err.message}`);
      writeErrors.set(article.slug, err.message);
    }
  }

  if (skipChecker) {
    console.log('    ! --skip-checker set — wrote without the fact-retention gate.');
    return articles.map((a) =>
      writeErrors.has(a.slug) ? { slug: a.slug, status: 'error', error: writeErrors.get(a.slug) } : { slug: a.slug, status: 'written-unchecked' }
    );
  }

  const results = [];
  for (const article of articles) {
    if (writeErrors.has(article.slug)) {
      results.push({ slug: article.slug, status: 'error', error: writeErrors.get(article.slug) });
      continue;
    }

    const newState = getArticleEntityEdgeState(dbPath, article.slug);
    const result = await checkFactRetention({
      slug: article.slug,
      oldState: oldStates.get(article.slug),
      newState,
      judge,
      judgeOpts: { ...judgeOpts, slug: article.slug },
    });

    const dropped = result.items.filter((i) => i.status === 'dropped');
    const altered = result.items.filter((i) => i.status === 'altered');
    if (dropped.length || altered.length) {
      console.log(`    ! fact-retention regression(s) on ${article.slug}:`);
      for (const item of [...dropped, ...altered]) {
        console.log(`      - [${item.status}] ${item.name}: ${item.note ?? ''}`);
      }
      results.push({ slug: article.slug, status: 'regression', dropped, altered });
    } else {
      console.log(`    checker: ${article.slug}: ${result.items.length} prior item(s), all retained.`);
      results.push({ slug: article.slug, status: 'ok' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const extract = opts.extractFixtureDir
    ? (promptObj, extractOpts) => fixtureExtractor(promptObj, { fixtureDir: opts.extractFixtureDir, slug: extractOpts.slug })
    : openAIExtractor;
  const judge = opts.judgeFixtureDir
    ? (promptObj, judgeOpts) =>
        fixtureJudge(promptObj, { fixturePath: path.join(opts.judgeFixtureDir, `${judgeOpts.slug}.json`) })
    : openAIJudge;

  const db = new DatabaseSync(opts.dbPath);
  let results;
  try {
    const articles = listArticles(db, { onlySlug: opts.slug });
    const chunks = chunkArray(articles, opts.batchSize);
    const modeDescription =
      opts.batchSize === 1
        ? 'sequential, one LLM call per article'
        : `sequential batches of up to ${opts.batchSize} article(s) per LLM call (${chunks.length} call(s) total)`;
    console.log(
      `Extracting entities for ${articles.length} article(s) from ${path.relative(REPO_ROOT, opts.dbPath)} ` +
        `(${modeDescription}, checker ${opts.skipChecker ? 'SKIPPED' : 'after every write'})\n`
    );

    const processOpts = {
      dbPath: opts.dbPath,
      model: opts.model,
      dryRun: opts.dryRun,
      skipChecker: opts.skipChecker,
      extract,
      extractOpts: {},
      judge,
      judgeOpts: {},
    };

    results = [];
    for (const chunk of chunks) {
      let chunkResults;
      try {
        chunkResults =
          chunk.length === 1 ? [await processArticle(db, chunk[0], processOpts)] : await processArticleBatch(db, chunk, processOpts);
      } catch (err) {
        console.error(`  ! [${chunk.map((a) => a.slug).join(', ')}]: failed — ${err.message}`);
        chunkResults = chunk.map((a) => ({ slug: a.slug, status: 'error', error: err.message }));
      }
      results.push(...chunkResults);

      if (opts.stopOnRegression && chunkResults.some((r) => r.status === 'regression')) {
        console.log('\n--stop-on-regression set — halting before the next batch.');
        break;
      }
    }
  } finally {
    db.close();
  }

  console.log('\nSummary:');
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const [status, count] of Object.entries(counts)) console.log(`  ${status}: ${count}`);

  const failed = results.filter((r) => r.status === 'error' || r.status === 'regression');
  if (failed.length) {
    console.log(`\n${failed.length} article(s) need attention: ${failed.map((r) => r.slug).join(', ')}`);
    process.exitCode = 1;
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
