#!/usr/bin/env node
/**
 * Knowledge-graph extraction script — NON-LLM HALF ONLY.
 *
 * See extra-md-files/ai-article-pipeline.md §2 Steps 1-3. This script:
 *   1. Parses every articles/*.html file with cheerio.
 *   2. Strips nav/footer/CTA/JSON-LD boilerplate and .graph-* visual diagram
 *      blocks (decorative summaries of surrounding prose — extracting from
 *      them risks double-counting facts already in the adjacent paragraph).
 *   3. Outputs, per article: slug, title, summary, English body_text, dates,
 *      and existing internal links (from .article-related).
 *   4. Populates the `articles` table in admin/knowledge-graph.db via
 *      INSERT ... ON CONFLICT(slug) DO UPDATE — idempotent, safe to re-run.
 *
 * Deliberately STOPS THERE. It does not touch `entities`, `article_entities`,
 * or `edges` — those require the LLM call (§2 Step 4, blocked on nothing
 * anymore per §6, but not this script's job). It also does not write to the
 * `links` table: §2 groups "Populate article_entities / links" as Step 5,
 * downstream of Step 4's entity extraction, so link persistence is left for
 * that pass even though the link data itself needs no LLM. The internal
 * links this script finds are still surfaced — via --json-out and the
 * console summary — so Step 5 doesn't have to re-parse the HTML.
 *
 * Usage (from scripts/):
 *   npm install
 *   npm run extract              # writes admin/knowledge-graph.db + admin/knowledge-graph.json
 *   node extract-articles.js --dry-run
 *   node extract-articles.js --json-out output/extracted-articles.json
 *
 * Flags:
 *   --dry-run        Parse and print a summary; touch neither the .db nor the .json mirror.
 *   --json-out PATH  Also write the full extracted records (incl. internal_links) to PATH.
 *   --no-mirror      Skip regenerating admin/knowledge-graph.json after the .db write.
 *   --db PATH        Override the SQLite db path (default admin/knowledge-graph.db).
 *   --articles-dir PATH  Override the articles/ directory to scan.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import { nextArg } from './cli-args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Schema lives in admin/knowledge-graph.schema.sql — that file is the single
// source of truth for the DDL (see its own header comment); read it directly
// rather than duplicating the CREATE TABLE/INDEX statements here.
const SCHEMA_SQL = readFileSync(
  path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql'),
  'utf-8'
);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    jsonOut: null,
    mirror: true,
    dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
    articlesDir: path.join(REPO_ROOT, 'articles'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--json-out':
        opts.jsonOut = nextArg(argv, ++i, '--json-out');
        break;
      case '--no-mirror':
        opts.mirror = false;
        break;
      case '--db':
        opts.dbPath = path.resolve(nextArg(argv, ++i, '--db'));
        break;
      case '--articles-dir':
        opts.articlesDir = path.resolve(nextArg(argv, ++i, '--articles-dir'));
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Reads datePublished/dateModified from the page's Article JSON-LD block,
 *  before that block (and every other <script>) gets stripped. */
function extractDatesFromLdJson($) {
  let published_at = null;
  let last_updated = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return; // malformed/unexpected block — skip rather than fail the whole article
    }
    for (const item of Array.isArray(data) ? data : [data]) {
      if (item && item['@type'] === 'Article') {
        published_at = item.datePublished ?? published_at;
        last_updated = item.dateModified ?? last_updated;
      }
    }
  });
  return { published_at, last_updated };
}

/** Mutates $ in place, removing shared chrome and decorative diagram blocks
 *  that are not article content: nav, footer, CTA section, sticky CTA bar,
 *  all <script>/<style> tags (GA snippet, anti-flash bootstrap, JSON-LD,
 *  main.js), and .graph-* visual diagram blocks. */
function stripBoilerplate($) {
  $('nav.navbar').remove();
  $('footer.footer').remove();
  $('.cta-section').remove();
  $('.sticky-cta-bar').remove();
  $('script').remove();
  $('style').remove();
  $('.graph-block').remove(); // decorative diagram — summarizes adjacent prose, not a new fact
}

/** Flattens an article-body container to plain text, one block (heading /
 *  paragraph / blockquote / list item) per line, in document order. Drops
 *  .article-meta (byline/read-time/updated line) — it's page furniture, not
 *  article content, and the dates it restates are already captured from
 *  JSON-LD. */
function extractBodyText($, container) {
  const clone = container.clone();
  clone.find('.article-meta').remove();
  const parts = [];
  clone.find('h2, h3, h4, p, blockquote, li').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });
  return parts.join('\n\n');
}

/** Existing internal links from the .article-related block — same-directory
 *  article-page hrefs only (skips the "back to course" link and the
 *  external academy link, neither of which point at another article). */
function extractInternalLinks($) {
  const seen = new Set();
  const links = [];
  $('.article-related ul li a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/^[a-z0-9][a-z0-9-]*\.html$/i.test(href)) return;
    const targetSlug = href.replace(/\.html$/i, '');
    if (seen.has(targetSlug)) return;
    seen.add(targetSlug);
    const enSpan = $(el).find('[data-lang="en"]').first();
    const linkText = (enSpan.length ? enSpan.text() : $(el).text())
      .replace(/\s+/g, ' ')
      .trim();
    links.push({ target_slug: targetSlug, link_text: linkText });
  });
  return links;
}

function extractArticle(filePath) {
  const html = readFileSync(filePath, 'utf-8');
  const $ = cheerio.load(html);
  const slug = path.basename(filePath, '.html');

  // Dates must be read before stripBoilerplate() removes the JSON-LD blocks.
  const { published_at, last_updated } = extractDatesFromLdJson($);

  stripBoilerplate($);

  const title = $('.course-hero [data-lang="en"] h1')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const summary = ($('meta[name="description"]').attr('content') || '').trim();

  const bodyContainer = $('.article-body > [data-lang="en"]').first();
  if (bodyContainer.length === 0) {
    throw new Error(
      `${filePath}: no ".article-body > [data-lang=\\"en\\"]" found — article page ` +
        `structure may have drifted from the contract in CLAUDE.md / admin/index.html.`
    );
  }
  const body_text = extractBodyText($, bodyContainer);
  const internal_links = extractInternalLinks($);

  if (!title) console.warn(`  ! ${slug}: empty title`);
  if (!summary) console.warn(`  ! ${slug}: empty summary (missing <meta name="description">)`);
  if (!published_at) console.warn(`  ! ${slug}: no datePublished found in Article JSON-LD`);
  if (!body_text) console.warn(`  ! ${slug}: empty body_text`);

  return {
    slug,
    filepath: `articles/${slug}.html`,
    title,
    summary,
    body_text,
    published_at,
    last_updated,
    status: 'published',
    internal_links,
  };
}

function listArticleFiles(articlesDir) {
  return readdirSync(articlesDir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(articlesDir, f));
}

// ---------------------------------------------------------------------------
// DB population (articles table only — see file header)
// ---------------------------------------------------------------------------

function upsertArticles(db, records) {
  const stmt = db.prepare(`
    INSERT INTO articles (slug, filepath, title, summary, body_text, published_at, last_updated, status)
    VALUES (@slug, @filepath, @title, @summary, @body_text, @published_at, @last_updated, @status)
    ON CONFLICT(slug) DO UPDATE SET
      filepath      = excluded.filepath,
      title         = excluded.title,
      summary       = excluded.summary,
      body_text     = excluded.body_text,
      published_at  = excluded.published_at,
      last_updated  = excluded.last_updated,
      status        = excluded.status
  `);
  for (const record of records) {
    stmt.run({
      slug: record.slug,
      filepath: record.filepath,
      title: record.title,
      summary: record.summary,
      body_text: record.body_text,
      published_at: record.published_at,
      last_updated: record.last_updated,
      status: record.status,
    });
  }
}

/** Upserts the db's own `_meta` table so it stops describing itself as
 *  hand-authored sample data once a real extraction run has actually
 *  populated `articles`. Drops the old note_on_body_text row (its
 *  "excerpts only" claim is false post-run) and replaces it with a note
 *  about the half of the pipeline this script still doesn't touch. */
function upsertMeta(db, records) {
  db.exec(`DELETE FROM _meta WHERE key = 'note_on_body_text'`);
  const stmt = db.prepare(`
    INSERT INTO _meta (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const rows = [
    {
      key: 'description',
      value:
        'Populated by a real Step 1-3 extraction run (scripts/extract-articles.js) over the ' +
        'current articles/*.html files -- the articles table reflects actual parsed title, ' +
        'summary, body_text, and dates, not hand-authored sample data.',
    },
    { key: 'schema_source', value: 'extra-md-files/ai-article-pipeline.md#2-knowledge-graph-store' },
    { key: 'generated_at', value: new Date().toISOString().slice(0, 10) },
    { key: 'generated_by', value: 'scripts/extract-articles.js' },
    { key: 'article_count', value: String(records.length) },
    {
      key: 'note_on_entities_edges',
      value:
        'entities, article_entities, edges, and links are still hand-authored sample data -- ' +
        'this script only populates the articles table (Steps 1-3). They stay stale until a ' +
        'real extract-entities.js run (Step 4-5, LLM-backed) replaces them.',
    },
  ];
  for (const row of rows) stmt.run(row);
}

// ---------------------------------------------------------------------------
// admin/knowledge-graph.json mirror — regenerated from current DB state, with
// a fresh _meta block (description/schema_source/generated_at/generated_by/
// article_count) written below. Entities/edges/links are read back verbatim
// (this script never writes them), so the only thing that actually changes
// here is real body_text/title/summary/dates replacing the hand-authored
// sample values.
// ---------------------------------------------------------------------------

function regenerateJsonMirror(db, mirrorPath) {
  const articles = db.prepare('SELECT * FROM articles ORDER BY id').all();
  const entities = db.prepare('SELECT * FROM entities ORDER BY id').all();
  const edgesRaw = db.prepare('SELECT * FROM edges').all();
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const articleById = new Map(articles.map((a) => [a.id, a]));

  const articleEntities = db.prepare('SELECT * FROM article_entities').all();
  const linksRaw = db.prepare('SELECT * FROM links').all();

  const out = {
    _meta: {
      description:
        'Human/LLM-readable JSON mirror of admin/knowledge-graph.db. Regenerated by ' +
        'scripts/extract-articles.js — this is a read-only export, not a second source ' +
        'of truth. The .db remains authoritative; edit it (or re-run the extraction/' +
        'entity pipeline), then re-export.',
      schema_source: 'extra-md-files/ai-article-pipeline.md#2-knowledge-graph-store',
      generated_at: new Date().toISOString().slice(0, 10),
      generated_by: 'scripts/extract-articles.js',
      article_count: String(articles.length),
    },
    articles: articles.map((a) => ({
      slug: a.slug,
      filepath: a.filepath,
      title: a.title,
      summary: a.summary,
      body_text: a.body_text,
      published_at: a.published_at,
      last_updated: a.last_updated,
      status: a.status,
      entities: articleEntities
        .filter((ae) => ae.article_id === a.id)
        .map((ae) => {
          const e = entityById.get(ae.entity_id);
          return { name: e?.name, type: e?.type, relevance_score: ae.relevance_score };
        }),
      internal_links: linksRaw
        .filter((l) => l.source_article_id === a.id)
        .map((l) => {
          const target = articleById.get(l.target_article_id);
          return {
            target_slug: target?.slug,
            target_title: target?.title,
            link_text: l.link_text,
          };
        }),
    })),
    entities: entities.map((e) => ({ name: e.name, type: e.type })),
    edges: edgesRaw.map((edge) => ({
      source: entityById.get(edge.source_entity_id)?.name,
      relation: edge.relation,
      target: entityById.get(edge.target_entity_id)?.name,
    })),
  };

  writeFileSync(mirrorPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const files = listArticleFiles(opts.articlesDir);
  console.log(`Found ${files.length} article file(s) in ${path.relative(REPO_ROOT, opts.articlesDir)}`);

  // Per-file isolation (same pattern as extract-entities.js/import-source-articles.js):
  // one malformed article (e.g. drifted .article-body structure, see extractArticle's
  // own error) shouldn't abort the whole run — collect the failure and keep going.
  const records = [];
  const failures = [];
  for (const f of files) {
    const slug = path.basename(f, '.html');
    try {
      records.push(extractArticle(f));
    } catch (err) {
      failures.push({ slug, error: err.message });
      console.error(`  ! ${slug}: extraction failed — ${err.message}`);
    }
  }

  // Sanity check: flag internal links pointing at a slug with no article file.
  const knownSlugs = new Set(records.map((r) => r.slug));
  for (const record of records) {
    for (const link of record.internal_links) {
      if (!knownSlugs.has(link.target_slug)) {
        console.warn(`  ! ${record.slug}: internal link -> unknown slug "${link.target_slug}"`);
      }
    }
  }

  console.log('\nExtracted:');
  for (const r of records) {
    console.log(
      `  - ${r.slug}  (${r.body_text.length} chars body, ${r.internal_links.length} internal links, ` +
        `published ${r.published_at ?? '?'}, updated ${r.last_updated ?? '?'})`
    );
  }

  if (failures.length) {
    console.log(`\n${failures.length} file(s) failed extraction:`);
    for (const f of failures) console.log(`  - ${f.slug}: ${f.error}`);
    process.exitCode = 1; // set now so it survives the --dry-run early return below
  }

  if (opts.jsonOut) {
    const outPath = path.resolve(opts.jsonOut);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ articles: records }, null, 2) + '\n', 'utf-8');
    console.log(`\nWrote raw extraction (incl. internal_links) to ${path.relative(REPO_ROOT, outPath)}`);
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: not touching the .db or the .json mirror.');
    return;
  }

  const db = new DatabaseSync(opts.dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN');
    try {
      upsertArticles(db, records);
      upsertMeta(db, records);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`\nUpserted ${records.length} row(s) into ${path.relative(REPO_ROOT, opts.dbPath)} (articles + _meta).`);

    if (opts.mirror) {
      const mirrorPath = path.join(REPO_ROOT, 'admin', 'knowledge-graph.json');
      regenerateJsonMirror(db, mirrorPath);
      console.log(`Regenerated ${path.relative(REPO_ROOT, mirrorPath)}.`);
    }
  } finally {
    db.close();
  }

  console.log(
    '\nStopping here by design: entities/article_entities/edges (and the links table, ' +
      'grouped with them in §2 Step 5) are not touched — that half needs the LLM call.'
  );
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
