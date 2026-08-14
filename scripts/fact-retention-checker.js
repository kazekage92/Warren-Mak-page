#!/usr/bin/env node
/**
 * Fact-retention checker — extra-md-files/ai-article-pipeline.md §3.
 *
 * Different question from the coverage reviewer (§5): this checks whether the
 * knowledge graph's OWN entity/edge records for one article survive being
 * re-extracted or incrementally patched — not whether a generated article
 * covers what the graph says. Meant to run after every write to `entities`/
 * `edges` (§2 Step 3), before batch size or parallelism grows, and before the
 * incremental per-publish path (§2 Step 7) exists.
 *
 * Input: an article slug's OLD and NEW entity/edge state — each state is the
 * induced subgraph over that article's own entities (§2 `article_entities`)
 * plus every `edges` row where BOTH endpoints are one of those entities.
 * Output: strict JSON, one item per OLD entity/edge —
 *   {"items":[{"name":"...", "status":"retained|altered|dropped", "note":"..."}]}
 *
 * The judge call is injectable (`judge` param on checkFactRetention(), or
 * `--judge-fixture` on the CLI) precisely so this can be validated against a
 * hand-edited copy of the sample db without a live OpenAI key — see
 * validate-fact-retention-checker.js and scripts/README.md.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node fact-retention-checker.js \
 *     --slug <slug> --old-db <path> --new-db <path> [--model gpt-4o-mini]
 *
 *   node fact-retention-checker.js --slug <slug> --old-db <path> --new-db <path> \
 *     --judge-fixture <path-to-raw-json-response>   # no network/key needed
 *
 * Exit code is non-zero if any item comes back "altered" or "dropped" — so
 * this can gate a batch/incremental run (§2 build order step 2) once wired in.
 *
 * KNOWN BLIND SPOT: this only compares the OLD/NEW state of the article that
 * was just (re-)extracted — it never runs for any OTHER article. `edges` has
 * no article_id (see admin/knowledge-graph.schema.sql's comment on that
 * table and writeExtractionResult() in extract-entities.js), so re-extracting
 * article X can delete an edge that also "belonged" to article Y, purely
 * because X and Y share both of that edge's endpoint entities. Nothing here
 * catches that: Y's own old/new state is never compared, since Y itself
 * wasn't re-extracted. The edge just quietly disappears from Y's induced
 * subgraph until something re-extracts Y too. This checker guards against
 * regressions to the article you just wrote, not against side effects on
 * OTHER articles from that same write.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { nextArg } from './cli-args.js';
import { callOpenAIChat } from './openai-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const VALID_STATUSES = new Set(['retained', 'altered', 'dropped']);
const DEFAULT_MODEL = 'gpt-4o-mini'; // judgment task, not generation — cheapest tier is fine (§5)
const MAX_TOKENS = 1500; // one {status,note} judgment per OLD entity/edge — judgment-only, smallest budget in this directory

// ---------------------------------------------------------------------------
// State extraction — the induced subgraph over one article's own entities
// ---------------------------------------------------------------------------

/**
 * Reads {entities, edges} for one article slug out of a knowledge-graph.db.
 * entities = everything attached to the article via `article_entities`.
 * edges = `edges` rows where BOTH endpoints are one of this article's own
 * entities. Entities are deduplicated/global across articles (§2 Step 4), so
 * an edge with only one endpoint here typically belongs to a different
 * article's subgraph and would be noise, not this article's fact.
 */
export function getArticleEntityEdgeState(dbPath, slug) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const article = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug);
    if (!article) {
      throw new Error(`No article with slug "${slug}" in ${path.relative(REPO_ROOT, dbPath)}`);
    }

    const entityRows = db
      .prepare(
        `SELECT e.name AS name, e.type AS type
         FROM article_entities ae JOIN entities e ON e.id = ae.entity_id
         WHERE ae.article_id = ?
         ORDER BY e.name`
      )
      .all(article.id);

    const edgeRows = db
      .prepare(
        `SELECT s.name AS source, edg.relation AS relation, t.name AS target
         FROM edges edg
         JOIN entities s ON s.id = edg.source_entity_id
         JOIN entities t ON t.id = edg.target_entity_id
         WHERE edg.source_entity_id IN (SELECT entity_id FROM article_entities WHERE article_id = ?)
           AND edg.target_entity_id IN (SELECT entity_id FROM article_entities WHERE article_id = ?)
         ORDER BY s.name, t.name`
      )
      .all(article.id, article.id);

    return {
      entities: entityRows.map((r) => ({ name: r.name, type: r.type })),
      edges: edgeRows.map((r) => ({ source: r.source, relation: r.relation, target: r.target })),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
//
// admin/index.html's incremental knowledge-graph extraction carries a
// hand-kept mirror of formatState/buildJudgePrompt as kgFormatState/
// kgBuildJudgePrompt — search admin/index.html for "mirrors
// scripts/fact-retention-checker.js" to find it, and keep the two in sync if
// either changes. validate-admin-mirror-sync.js checks the two produce
// identical output automatically.
// ---------------------------------------------------------------------------

// Exported (in addition to being used internally by buildJudgePrompt below)
// so validate-admin-mirror-sync.js can call it directly against
// admin/index.html's kgFormatState() mirror without re-deriving it from
// buildJudgePrompt's combined output.
export function formatState(state) {
  const entityLines = state.entities.map((e) => `- entity: "${e.name}" (type: ${e.type})`);
  const edgeLines = state.edges.map(
    (e) => `- edge: "${e.source}" --[${e.relation}]--> "${e.target}"`
  );
  const lines = [...entityLines, ...edgeLines];
  return lines.length ? lines.join('\n') : '(empty)';
}

export function buildJudgePrompt({ slug, oldState, newState }) {
  const system =
    'You are a fact-retention auditor for a knowledge graph that backs an article generation ' +
    'pipeline. You are given the OLD and NEW entity/edge records extracted for one article. Your ' +
    'only job: for every item in the OLD list, judge whether the same real-world fact still ' +
    'exists in the NEW list.\n\n' +
    'Statuses:\n' +
    '- "retained": the same fact is present in NEW, even if reworded (e.g. an entity renamed from ' +
    '"Time Decay (Theta)" to "Theta Decay" is the same concept -- retained, not altered).\n' +
    '- "altered": a related item exists in NEW but the fact itself changed meaning, direction, or ' +
    'relation (e.g. an edge\'s relation changed from "prerequisite_of" to "contradicts", or a ' +
    'numeric/factual claim changed).\n' +
    '- "dropped": no equivalent item exists in NEW at all.\n\n' +
    'Judge every OLD entity and every OLD edge individually. Do not report NEW items that have no ' +
    'OLD counterpart -- this check is about retention of OLD facts, not about what is new.\n\n' +
    'Respond with ONLY strict JSON, no prose, no markdown fences, matching exactly this shape:\n' +
    '{"items":[{"name":"<the OLD entity name, or \\"source -> target\\" for an OLD edge>",' +
    '"status":"retained|altered|dropped","note":"<one short sentence>"}]}';

  const user =
    `Article slug: ${slug}\n\n` +
    `OLD state:\n${formatState(oldState)}\n\n` +
    `NEW state:\n${formatState(newState)}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing / validation
// ---------------------------------------------------------------------------

export function parseJudgeResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Judge response was not valid JSON: ${err.message}\nRaw response:\n${rawText}`);
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error(`Judge response is missing an "items" array.\nRaw response:\n${rawText}`);
  }
  for (const item of parsed.items) {
    if (!item || typeof item.name !== 'string' || !VALID_STATUSES.has(item.status)) {
      throw new Error(
        `Malformed judge item (needs string "name" + status in retained|altered|dropped): ` +
          `${JSON.stringify(item)}`
      );
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Judges (pluggable — see file header)
// ---------------------------------------------------------------------------

/** Production judge: a real OpenAI call. Reads OPENAI_API_KEY from the
 *  environment — this is the "(a) local/developer-run Node script" path from
 *  §2 "Where extraction runs", a separate concern from the client-side
 *  AES-256-GCM key plumbing §6 still has to build for admin/index.html's
 *  in-browser incremental path. */
export async function openAIJudge(
  { system, user },
  { apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_MODEL, slug } = {}
) {
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set OPENAI_API_KEY in the environment before running this ' +
        'script for real, or pass --judge-fixture to validate offline (see scripts/README.md).'
    );
  }
  return callOpenAIChat({
    apiKey,
    model,
    system,
    user,
    maxTokens: MAX_TOKENS,
    temperature: 0,
    callerLabel: `fact-retention-checker.js openAIJudge${slug ? ` (${slug})` : ''}`,
  });
}

/** Offline judge: reads a pre-recorded raw JSON response from disk instead of
 *  calling out to OpenAI. Used for CI / no-key validation — see
 *  validate-fact-retention-checker.js. */
export function fixtureJudge(_promptObj, { fixturePath }) {
  return readFileSync(fixturePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.slug
 * @param {{entities:Array,edges:Array}} args.oldState
 * @param {{entities:Array,edges:Array}} args.newState
 * @param {(promptObj:{system:string,user:string}, judgeOpts:object) => (string|Promise<string>)} [args.judge]
 * @param {object} [args.judgeOpts]
 */
export async function checkFactRetention({ slug, oldState, newState, judge = openAIJudge, judgeOpts = {} }) {
  const promptObj = buildJudgePrompt({ slug, oldState, newState });
  const rawResponse = await judge(promptObj, judgeOpts);
  return parseJudgeResponse(rawResponse);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    slug: null,
    oldSlug: null,
    newSlug: null,
    oldDb: null,
    newDb: null,
    model: DEFAULT_MODEL,
    judgeFixture: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--slug':
        opts.slug = nextArg(argv, ++i, '--slug');
        break;
      case '--old-slug':
        opts.oldSlug = nextArg(argv, ++i, '--old-slug');
        break;
      case '--new-slug':
        opts.newSlug = nextArg(argv, ++i, '--new-slug');
        break;
      case '--old-db':
        opts.oldDb = path.resolve(nextArg(argv, ++i, '--old-db'));
        break;
      case '--new-db':
        opts.newDb = path.resolve(nextArg(argv, ++i, '--new-db'));
        break;
      case '--model':
        opts.model = nextArg(argv, ++i, '--model');
        break;
      case '--judge-fixture':
        opts.judgeFixture = path.resolve(nextArg(argv, ++i, '--judge-fixture'));
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.slug) throw new Error('--slug is required');
  if (!opts.oldDb || !opts.newDb) throw new Error('--old-db and --new-db are required');
  opts.oldSlug ??= opts.slug;
  opts.newSlug ??= opts.slug;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const oldState = getArticleEntityEdgeState(opts.oldDb, opts.oldSlug);
  const newState = getArticleEntityEdgeState(opts.newDb, opts.newSlug);

  const judge = opts.judgeFixture ? fixtureJudge : openAIJudge;
  const judgeOpts = opts.judgeFixture ? { fixturePath: opts.judgeFixture } : { model: opts.model, slug: opts.slug };

  const result = await checkFactRetention({ slug: opts.slug, oldState, newState, judge, judgeOpts });

  const dropped = result.items.filter((i) => i.status === 'dropped');
  const altered = result.items.filter((i) => i.status === 'altered');
  const retained = result.items.length - dropped.length - altered.length;

  console.log(JSON.stringify(result, null, 2));
  console.log(
    `\n${result.items.length} item(s) judged: ${retained} retained, ${altered.length} altered, ` +
      `${dropped.length} dropped.`
  );

  if (dropped.length || altered.length) {
    console.log('\n! Regression(s) found:');
    for (const item of [...dropped, ...altered]) {
      console.log(`  - [${item.status}] ${item.name}: ${item.note}`);
    }
    process.exitCode = 1;
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
