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
 * Deliberately STOPS SHORT of `entities`, `article_entities`, and `edges` —
 * those require the LLM call (§2 Step 4, blocked on nothing anymore per §6,
 * but not this script's job).
 *
 * It DOES now backfill the `links` table (§2 Step 5's "Populate
 * article_entities / links" — the `links` half only; `article_entities` is
 * still extract-entities.js's job since it needs the LLM-scored relevance).
 * Link data needs no LLM — it's read straight off each article's own
 * `.article-related` markup — so there was never a real reason to gate it
 * behind Step 4; §2 Step 5 only grouped it with `article_entities` because
 * both said "Populate" in the same sentence, not because of a real
 * dependency. Every run re-derives `links` from every successfully-parsed
 * article's current `internal_links` (DELETE-then-INSERT per source article,
 * inside the same transaction as the `articles` upsert) — idempotent and
 * self-healing: edit an article's `.article-related` block, re-run, and the
 * `links` table reflects the new HTML exactly, the same "safe to re-run"
 * contract `articles` already has. A link whose target slug has no matching
 * article (already warned about below, pre-existing behavior) is skipped,
 * not written as a dangling foreign key.
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

export function extractArticle(filePath) {
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

export function listArticleFiles(articlesDir) {
  return readdirSync(articlesDir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(articlesDir, f));
}

// ---------------------------------------------------------------------------
// DB population (articles table only — see file header)
// ---------------------------------------------------------------------------

export function upsertArticles(db, records) {
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

/** Rewrites the `links` table's rows for every article in `records` (i.e.
 *  every article that parsed successfully this run — a failed article's
 *  previously-written links are left untouched, same isolation as
 *  `upsertArticles`). For each source article: DELETE its existing outgoing
 *  links, then INSERT one fresh row per `internal_links` entry whose
 *  `target_slug` resolves to a real article. Requires `articles` to already
 *  be upserted (called after `upsertArticles` in the same transaction) so
 *  `idBySlug` reflects every id, including ones just inserted this run.
 *  Returns `{inserted, skippedDangling}` for the console summary. */
export function backfillLinks(db, records) {
  const idBySlug = new Map(db.prepare('SELECT id, slug FROM articles').all().map((a) => [a.slug, a.id]));
  const deleteStmt = db.prepare('DELETE FROM links WHERE source_article_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO links (source_article_id, target_article_id, link_text) VALUES (?, ?, ?)'
  );

  let inserted = 0;
  let skippedDangling = 0;
  for (const record of records) {
    const sourceId = idBySlug.get(record.slug);
    if (!sourceId) continue; // record was just upserted above — should always resolve
    deleteStmt.run(sourceId);
    for (const link of record.internal_links) {
      const targetId = idBySlug.get(link.target_slug);
      if (!targetId) {
        skippedDangling++; // already warned about in main()'s sanity check
        continue;
      }
      insertStmt.run(sourceId, targetId, link.link_text);
      inserted++;
    }
  }
  return { inserted, skippedDangling };
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
        'entities, article_entities, and edges are still populated by extract-entities.js ' +
        '(the LLM half, Step 4-5) -- this script does not touch them. links IS now populated ' +
        'by this script (backfilled from each article\'s .article-related markup, no LLM ' +
        'needed) -- rewritten every run from current HTML, not hand-authored sample data.',
    },
  ];
  for (const row of rows) stmt.run(row);
}

// ---------------------------------------------------------------------------
// admin/knowledge-graph.json mirror — regenerated from current DB state, with
// a fresh _meta block (description/schema_source/generated_at/generated_by/
// article_count) written below. entities/edges are read back verbatim (this
// script never writes them); links is read back too, but it's no longer
// someone else's data by the time this runs — backfillLinks() above just
// rewrote it from the same articles being mirrored here. source_articles is
// also read back verbatim — this script never writes it either, but it's
// mirrored for the same reason articles/entities/edges are: the .db is
// opaque in git diffs (schema.sql's own header comment) and isn't openable
// without a sqlite client, so this JSON export is the only practical way to
// manually eyeball what scrape-enanyang-articles.js/import-source-articles.js
// actually wrote — e.g. spot-checking a scraped Chinese article's title/
// original_content against its original_url. Exported (not just called
// locally) so those two scripts can call it themselves right after their own
// db writes, keeping the .json mirror from silently going stale relative to
// the .db between extract-articles.js runs — see this repo's CLAUDE.md rule
// that "no build step" means nothing else regenerates this file for you.
// ---------------------------------------------------------------------------

export function regenerateJsonMirror(db, mirrorPath) {
  const articles = db.prepare('SELECT * FROM articles ORDER BY id').all();
  const entities = db.prepare('SELECT * FROM entities ORDER BY id').all();
  const edgesRaw = db.prepare('SELECT * FROM edges').all();
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const articleById = new Map(articles.map((a) => [a.id, a]));

  const articleEntities = db.prepare('SELECT * FROM article_entities').all();
  const linksRaw = db.prepare('SELECT * FROM links').all();
  const sourceArticles = db.prepare('SELECT * FROM source_articles ORDER BY id').all();

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
      source_article_count: String(sourceArticles.length),
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
    // Phase 1 scrape/import staging area — see schema.sql's own comment on
    // this table. Full original_content is included (not just a length),
    // same "read-only export is worth more than a summary" precedent as
    // articles[].body_text above — the whole point is being able to read a
    // scraped article's actual text without opening the .db.
    source_articles: sourceArticles.map((s) => ({
      slug: s.slug,
      title: s.title,
      original_url: s.original_url,
      published_at: s.published_at,
      author: s.author,
      category: s.category,
      original_content: s.original_content,
      featured_image: s.featured_image,
      import_date: s.import_date,
      status: s.status,
      notes: s.notes,
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
    let linkStats;
    try {
      upsertArticles(db, records);
      linkStats = backfillLinks(db, records);
      upsertMeta(db, records);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`\nUpserted ${records.length} row(s) into ${path.relative(REPO_ROOT, opts.dbPath)} (articles + _meta).`);
    console.log(
      `Backfilled links: ${linkStats.inserted} row(s) written` +
        (linkStats.skippedDangling ? `, ${linkStats.skippedDangling} skipped (dangling target slug, see warnings above)` : '') +
        '.'
    );

    if (opts.mirror) {
      const mirrorPath = path.join(REPO_ROOT, 'admin', 'knowledge-graph.json');
      regenerateJsonMirror(db, mirrorPath);
      console.log(`Regenerated ${path.relative(REPO_ROOT, mirrorPath)}.`);
    }
  } finally {
    db.close();
  }

  console.log(
    '\nStopping here by design: entities/article_entities/edges are not touched — that half ' +
      'needs the LLM call (extract-entities.js). links, unlike those, needs no LLM and is ' +
      'fully backfilled above.'
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
