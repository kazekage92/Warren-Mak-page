#!/usr/bin/env node
/**
 * Validation harness for auto-publish-article.js.
 *
 * Every LLM call site in the pipeline it wires together is dependency-
 * injected — same pattern every sibling script in this directory already
 * follows — so this drives runPipeline() (the git-free steps 1-13 core;
 * step 14/gitPublish() is intentionally never exercised here, matching
 * "never touch real git state from a validator") directly with fixture/stub
 * functions, against a FULLY ISOLATED temp copy of everything runPipeline()
 * would otherwise touch: a schema-only (empty) db, a synthetic catalog, an
 * empty articles/ dir, and throwaway articles.html/sitemap.xml/history-ledger
 * files, all under scripts/output/ (gitignored) — the real repo files are
 * never read or written by this run. Matches
 * validate-extract-articles.js's/validate-import-source-articles.js's own
 * "temp copy of the schema, never the real db" precedent.
 *
 * Usage: node validate-auto-publish-article.js
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  runPipeline,
  isDueForNextCycle,
  buildUpdatedArticlesListing,
  buildUpdatedSitemap,
  replaceGraphFigure,
  deriveCategory,
  snapshotFile,
  restoreSnapshot,
} from './auto-publish-article.js';
import { slugifyTopic } from './generate-article.js';
import { stubMarkerTranslator } from './translate-article.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const WORK_DIR = path.join(OUTPUT_DIR, 'auto-publish-fixtures');
const FIXTURES_DIR = path.join(WORK_DIR, 'llm-fixtures');
const WRITER_DIR = path.join(FIXTURES_DIR, 'writer');
const REVIEWER_DIR = path.join(FIXTURES_DIR, 'reviewer');
const SEO_DIR = path.join(FIXTURES_DIR, 'seo');
const EXTRACT_DIR = path.join(FIXTURES_DIR, 'extract');
const JUDGE_DIR = path.join(FIXTURES_DIR, 'judge');

const REAL_SCHEMA_PATH = path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql');

// ---------------------------------------------------------------------------
// Isolated workspace — schema-only db, synthetic catalog, empty articles dir,
// throwaway articles.html/sitemap.xml/history — never the real repo files.
// ---------------------------------------------------------------------------

function freshWorkspace() {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(WRITER_DIR, { recursive: true });
  mkdirSync(REVIEWER_DIR, { recursive: true });
  mkdirSync(SEO_DIR, { recursive: true });
  mkdirSync(EXTRACT_DIR, { recursive: true });
  mkdirSync(JUDGE_DIR, { recursive: true });

  const paths = {
    catalogPath: path.join(WORK_DIR, 'catalog.md'),
    historyPath: path.join(WORK_DIR, 'auto-article-history.json'),
    dbPath: path.join(WORK_DIR, 'knowledge-graph.db'),
    mirrorPath: path.join(WORK_DIR, 'knowledge-graph.json'),
    schemaPath: REAL_SCHEMA_PATH, // read-only reference data — fine to share, same as every sibling validator
    articlesDir: path.join(WORK_DIR, 'articles'),
    articlesHtmlPath: path.join(WORK_DIR, 'articles.html'),
    sitemapPath: path.join(WORK_DIR, 'sitemap.xml'),
  };
  mkdirSync(paths.articlesDir, { recursive: true });

  writeFileSync(
    paths.catalogPath,
    `## Test Section\n- **2020-01-01 — A Genuinely New Trading Concept For Testing (Test English Title)**\n` +
      `- **2020-02-02 — Another Fresh Testing Topic Nobody Has Covered**\n`,
    'utf-8'
  );
  writeFileSync(paths.historyPath, '[]', 'utf-8');
  writeFileSync(
    paths.articlesHtmlPath,
    '<!DOCTYPE html><html><body>\n<div class="article-grid">\n<!-- cards go here -->\n</div>\n</body></html>',
    'utf-8'
  );
  writeFileSync(
    paths.sitemapPath,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>',
    'utf-8'
  );

  const db = new DatabaseSync(paths.dbPath);
  db.exec(readFileSync(REAL_SCHEMA_PATH, 'utf-8'));
  db.close();

  return paths;
}

// ---------------------------------------------------------------------------
// Fixture authoring — one topic/slug per scenario, matching the fixture-dir
// naming convention every sibling script here already uses
// (<fixtureDir>/<slugifyTopic(topic)>.json).
// ---------------------------------------------------------------------------

function writeWriterFixture(topic, { suggestedGraphSteps } = {}) {
  const key = slugifyTopic(topic);
  writeFileSync(
    path.join(WRITER_DIR, `${key}.json`),
    JSON.stringify({
      title: topic,
      summary: `A short teaser summary of "${topic}" for testing purposes.`,
      body_text:
        `This is the opening paragraph introducing "${topic}" for the fixture test.\n\n` +
        `## Understanding The Concept\n\n` +
        `This section explains the concept in more depth, with enough words to exercise the reading-time and paragraph-splitting logic.\n\n` +
        `## Applying It In Practice\n\n` +
        `This final section explains how a trader would apply the concept, wrapping up the test fixture article.`,
      suggestedGraphSteps: suggestedGraphSteps || ['Identify the setup', 'Confirm the signal', 'Manage the position', 'Review the outcome'],
    }),
    'utf-8'
  );
}

function writeReviewerFixture(topic, { items } = {}) {
  const key = slugifyTopic(topic);
  writeFileSync(path.join(REVIEWER_DIR, `${key}.json`), JSON.stringify({ items: items || [] }), 'utf-8');
}

function writeSeoFixture(topic) {
  const key = slugifyTopic(topic);
  writeFileSync(
    path.join(SEO_DIR, `${key}.json`),
    JSON.stringify({
      seoTitle: `${topic} | Trade Wizard`,
      metaDescription: `Learn about ${topic.toLowerCase()} in this test fixture article.`,
      urlSlug: key,
      ogTitle: topic,
      ogDescription: `A test fixture description for ${topic}.`,
      primaryKeywords: ['testing', 'trading'],
      secondaryKeywords: ['fixture'],
      longTailKeywords: [`what is ${topic.toLowerCase()}`],
      headings: [{ level: 2, text: 'Understanding The Concept' }],
      faq: [{ question: 'What is this?', answer: 'A test fixture answer.' }],
    }),
    'utf-8'
  );
}

function writeExtractFixture(slug, { entities, edges } = {}) {
  writeFileSync(
    path.join(EXTRACT_DIR, `${slug}.json`),
    JSON.stringify({
      entities: entities || [{ name: 'Test Entity', type: 'concept', relevance_score: 0.8 }],
      edges: edges || [],
    }),
    'utf-8'
  );
}

function writeJudgeFixture(slug, { items } = {}) {
  // A brand-new article's oldState is always empty, so the "correct" judge
  // response is trivially {"items": []} -- but fixtureJudge just returns
  // whatever's on disk regardless of the prompt, so a test can also plant a
  // fake regression here (see the rollback scenario below) to prove
  // runPipeline()'s rollback path actually fires.
  writeFileSync(path.join(JUDGE_DIR, `${slug}.json`), JSON.stringify({ items: items || [] }), 'utf-8');
}

/** Wires up the exact same fixture-dir -> DI-function adapters main() builds,
 *  reused here so the validator exercises the real fixture-loading code paths
 *  (fixtureWriter/fixtureReviewerByTopic/fixtureSeoWriter/fixtureExtractor/
 *  fixtureJudge) rather than reimplementing them. */
async function buildFixtureOpts(paths) {
  const mod = await import('./generate-article.js');
  const reviewerMod = await import('./coverage-reviewer.js');
  const seoMod = await import('./seo-optimizer.js');
  const extractMod = await import('./extract-entities.js');
  const judgeMod = await import('./fact-retention-checker.js');

  return {
    ...paths,
    writer: (promptObj, wOpts) => mod.fixtureWriter(promptObj, { fixtureDir: WRITER_DIR, topic: wOpts.topic, attempt: wOpts.attempt }),
    reviewer: (promptObj, rOpts) => mod.fixtureReviewerByTopic(promptObj, { fixtureDir: REVIEWER_DIR, topic: rOpts.topic, attempt: rOpts.attempt }),
    seoWriter: (promptObj, sOpts) => seoMod.fixtureSeoWriter(promptObj, { fixtureDir: SEO_DIR, topic: sOpts.topic }),
    translator: stubMarkerTranslator,
    extract: (promptObj, eOpts) => extractMod.fixtureExtractor(promptObj, { fixtureDir: EXTRACT_DIR, slug: eOpts.slug }),
    judge: (promptObj, jOpts) => judgeMod.fixtureJudge(promptObj, { fixturePath: path.join(JUDGE_DIR, `${jOpts.slug}.json`) }),
  };
}

// ---------------------------------------------------------------------------
// Part 0 — pure helpers, no db/LLM
// ---------------------------------------------------------------------------

function runPart0() {
  console.log('=== Part 0: pure helpers ===\n');
  const checks = [];

  // isDueForNextCycle
  checks.push(['isDueForNextCycle(): empty history is always due', isDueForNextCycle([]).due === true]);
  const dueResult = isDueForNextCycle([{ publishedAt: '2020-01-01T00:00:00.000Z' }], { now: new Date('2020-02-01T00:00:00.000Z') });
  checks.push(['isDueForNextCycle(): 31 days since a history entry is due (> 21-day max target)', dueResult.due === true]);
  const notDueResult = isDueForNextCycle([{ publishedAt: '2020-01-01T00:00:00.000Z' }], { now: new Date('2020-01-05T00:00:00.000Z') });
  checks.push(['isDueForNextCycle(): 4 days since a history entry is never due (< 14-day min target)', notDueResult.due === false]);
  const rerolled1 = isDueForNextCycle([{ publishedAt: '2020-01-01T00:00:00.000Z' }], { now: new Date('2020-01-15T00:00:00.000Z'), random: () => 0 });
  const rerolled2 = isDueForNextCycle([{ publishedAt: '2020-01-01T00:00:00.000Z' }], { now: new Date('2020-01-15T00:00:00.000Z'), random: () => 1 });
  checks.push(['isDueForNextCycle(): target reroll actually varies with random() (14d vs 21d target)', rerolled1.targetDays === 14 && rerolled2.targetDays === 21]);
  checks.push(['isDueForNextCycle(): most-recent entry wins when history has several', isDueForNextCycle(
    [{ publishedAt: '2019-01-01T00:00:00.000Z' }, { publishedAt: '2020-01-01T00:00:00.000Z' }],
    { now: new Date('2020-01-02T00:00:00.000Z') }
  ).lastPublishedAt === '2020-01-01T00:00:00.000Z']);

  // buildUpdatedArticlesListing / buildUpdatedSitemap
  const listingState = {
    slug: 'test-slug', categoryEn: 'Cat <EN>', categoryZh: '分类', titleEn: 'Title & Co', titleZh: '标题',
    subtitleEn: 'Sub', subtitleZh: '副标题', authorEn: 'Warren Mak', authorZh: '麦传球', readingTimeText: '7 min read',
  };
  const listingHtml = buildUpdatedArticlesListing('<div class="article-grid">\n</div>', listingState);
  checks.push(['buildUpdatedArticlesListing(): inserts a card linking to articles/<slug>.html', listingHtml.includes('href="articles/test-slug.html"')]);
  checks.push(['buildUpdatedArticlesListing(): HTML-escapes an "&" in the title', listingHtml.includes('Title &amp; Co')]);
  let threwOnMissingGrid = false;
  try { buildUpdatedArticlesListing('<div>no grid here</div>', listingState); } catch { threwOnMissingGrid = true; }
  checks.push(['buildUpdatedArticlesListing(): throws when .article-grid is missing', threwOnMissingGrid]);

  const sitemapXml = buildUpdatedSitemap('<urlset>\n</urlset>', { canonicalUrl: 'https://example.com/articles/test-slug.html', publishDate: '2026-01-01' });
  checks.push(['buildUpdatedSitemap(): inserts a <loc> entry before </urlset>', sitemapXml.includes('<loc>https://example.com/articles/test-slug.html</loc>') && sitemapXml.indexOf('<loc>') < sitemapXml.indexOf('</urlset>')]);
  let threwOnMissingUrlset = false;
  try { buildUpdatedSitemap('<nope></nope>', { canonicalUrl: 'x', publishDate: 'y' }); } catch { threwOnMissingUrlset = true; }
  checks.push(['buildUpdatedSitemap(): throws when </urlset> is missing', threwOnMissingUrlset]);

  // replaceGraphFigure
  const bodyWithOneFigure = '<p>a</p><figure class="graph-block graph-block--flow">OLD</figure><p>b</p>';
  const replaced = replaceGraphFigure(bodyWithOneFigure, '<figure class="graph-block graph-block--flow">NEW</figure>');
  checks.push(['replaceGraphFigure(): swaps the figure content, leaves surrounding paragraphs alone', replaced.includes('NEW') && !replaced.includes('OLD') && replaced.includes('<p>a</p>') && replaced.includes('<p>b</p>')]);
  let threwOnZeroFigures = false;
  try { replaceGraphFigure('<p>no figure</p>', '<figure>NEW</figure>'); } catch { threwOnZeroFigures = true; }
  checks.push(['replaceGraphFigure(): throws when the body has zero graph figures', threwOnZeroFigures]);
  let threwOnTwoFigures = false;
  try { replaceGraphFigure('<figure class="graph-block">A</figure><figure class="graph-block">B</figure>', '<figure>NEW</figure>'); } catch { threwOnTwoFigures = true; }
  checks.push(['replaceGraphFigure(): throws when the body has more than one graph figure', threwOnTwoFigures]);

  // deriveCategory
  checks.push(['deriveCategory(): falls back to "Trading Strategy" with no section', deriveCategory({ section: null }) === 'Trading Strategy']);
  checks.push(['deriveCategory(): takes the last ">"-separated segment of a real section', deriveCategory({ section: 'Key Trading Strategy Articles > Time Decay' }) === 'Time Decay']);
  checks.push(['deriveCategory(): a plain (no ">") section is used as-is', deriveCategory({ section: 'IPO Analysis' }) === 'IPO Analysis']);

  // snapshotFile / restoreSnapshot
  const snapTestPath = path.join(WORK_DIR, 'snap-test.txt');
  writeFileSync(snapTestPath, 'original content', 'utf-8');
  const existingSnap = snapshotFile(snapTestPath);
  writeFileSync(snapTestPath, 'mutated content', 'utf-8');
  restoreSnapshot(existingSnap);
  checks.push(['snapshotFile()/restoreSnapshot(): restores an existing file\'s original bytes', readFileSync(snapTestPath, 'utf-8') === 'original content']);

  const neverExistedPath = path.join(WORK_DIR, 'never-existed.txt');
  const missingSnap = snapshotFile(neverExistedPath);
  writeFileSync(neverExistedPath, 'created during the run', 'utf-8');
  restoreSnapshot(missingSnap);
  checks.push(['snapshotFile()/restoreSnapshot(): deletes a file that did not exist at snapshot time', !existsSync(neverExistedPath)]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 1 — runPipeline() dry-run happy path: real steps 1-8, zero disk writes
// ---------------------------------------------------------------------------

async function runPart1(paths, fixtureOpts) {
  console.log('\n=== Part 1: runPipeline() --dry-run happy path ===\n');
  const checks = [];
  const topic = 'A Genuinely New Trading Concept For Testing';
  writeWriterFixture(topic);
  writeReviewerFixture(topic);
  writeSeoFixture(topic);

  const before = { articlesHtml: readFileSync(paths.articlesHtmlPath, 'utf-8'), sitemap: readFileSync(paths.sitemapPath, 'utf-8'), history: readFileSync(paths.historyPath, 'utf-8') };

  const result = await runPipeline({ ...fixtureOpts, dryRun: true, force: true, topicOverride: topic });
  console.log(`Result status: ${result.status}`);

  checks.push(['dry-run: status is "ok"', result.status === 'ok']);
  checks.push(['dry-run: result.dryRun is true', result.dryRun === true]);
  checks.push(['dry-run: slug matches slugifyTopic(topic)', result.slug === slugifyTopic(topic)]);
  checks.push(['dry-run: coverage has zero missing items (empty checklist -> trivially covered)', result.coverage?.missing.length === 0]);
  checks.push(['dry-run: ZH title carries the stub-translator marker', String(result.docState?.titleZh).includes('【ZH-STUB】')]);
  checks.push(['dry-run: ZH body carries the stub-translator marker', String(result.docState?.bodyZhHtml).includes('【ZH-STUB】')]);
  checks.push(['dry-run: EN body contains exactly one graph figure (step 5 inserted it)', (result.docState?.bodyEnHtml.match(/<figure class="graph-block/g) || []).length === 1]);
  checks.push(['dry-run: ZH body contains exactly one graph figure (step 7 swapped in the ZH one)', (result.docState?.bodyZhHtml.match(/<figure class="graph-block/g) || []).length === 1]);
  checks.push(['dry-run: ZH graph figure carries the stub marker (built from translated steps, not the stale EN one)', /<figure class="graph-block[^"]*"><figcaption[^>]*>【ZH-STUB】/.test(result.docState?.bodyZhHtml || '')]);
  checks.push(['dry-run: assembled document is a full HTML page', result.fullHtmlLength > 1000]);

  // Nothing should have been written to disk at all.
  checks.push(['dry-run: no new articles/*.html file was created', !existsSync(path.join(paths.articlesDir, `${result.slug}.html`))]);
  checks.push(['dry-run: articles.html is byte-identical to before the run', readFileSync(paths.articlesHtmlPath, 'utf-8') === before.articlesHtml]);
  checks.push(['dry-run: sitemap.xml is byte-identical to before the run', readFileSync(paths.sitemapPath, 'utf-8') === before.sitemap]);
  checks.push(['dry-run: the history ledger is untouched', readFileSync(paths.historyPath, 'utf-8') === before.history]);
  checks.push(['dry-run: the db file was never created/touched (still schema-only, 0 articles)', new DatabaseSync(paths.dbPath, { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM articles').get().n === 0]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 2 — abort gates that must fire BEFORE any disk write (slug-collision
// checked before Part 3 creates the file; duplicate-risk-high; coverage-gap;
// translation-failed) — every one of these must leave the workspace untouched.
// ---------------------------------------------------------------------------

async function runPart2(paths, fixtureOpts) {
  console.log('\n=== Part 2: abort gates (all before any disk write) ===\n');
  const checks = [];
  const snapshotAll = () => ({
    articlesHtml: readFileSync(paths.articlesHtmlPath, 'utf-8'),
    sitemap: readFileSync(paths.sitemapPath, 'utf-8'),
    history: readFileSync(paths.historyPath, 'utf-8'),
    articleFiles: existsSync(paths.articlesDir) ? readFileSync(paths.articlesHtmlPath, 'utf-8') : '',
  });
  const assertUntouched = (label, before) => {
    checks.push([`${label}: articles.html untouched`, readFileSync(paths.articlesHtmlPath, 'utf-8') === before.articlesHtml]);
    checks.push([`${label}: sitemap.xml untouched`, readFileSync(paths.sitemapPath, 'utf-8') === before.sitemap]);
    checks.push([`${label}: history ledger untouched`, readFileSync(paths.historyPath, 'utf-8') === before.history]);
  };

  // --- duplicate-risk-high: seed the temp db with an article whose title is
  // near-identical to the candidate topic, via the same "hand-edit the copy
  // via raw SQL" approach validate-fact-retention-checker.js uses.
  {
    const topic = 'Duplicate Risk Test Topic For Structured Warrants';
    const before = snapshotAll();
    const db = new DatabaseSync(paths.dbPath);
    db.prepare(
      `INSERT INTO articles (slug, filepath, title, summary, body_text, published_at, last_updated, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'published')`
    ).run(slugifyTopic(topic), `articles/${slugifyTopic(topic)}.html`, topic, 'An existing article with the same title.', 'Existing body text.', '2020-01-01', '2020-01-01');
    db.close();

    const result = await runPipeline({ ...fixtureOpts, dryRun: false, force: true, topicOverride: topic });
    console.log(`  duplicate-risk-high -> status: ${result.status}`);
    checks.push(['duplicate-risk-high: gate actually fires on a near-identical title/slug', result.status === 'duplicate-risk-high']);
    assertUntouched('duplicate-risk-high', before);

    // Clean the seeded row back out so it doesn't affect later parts.
    const db2 = new DatabaseSync(paths.dbPath);
    db2.prepare('DELETE FROM articles WHERE slug = ?').run(slugifyTopic(topic));
    db2.close();
  }

  // --- coverage-gap: reviewer fixture reports a real "missing" item.
  {
    const topic = 'Coverage Gap Test Topic';
    writeWriterFixture(topic);
    writeReviewerFixture(topic, { items: [{ name: 'Some Required Fact', status: 'missing', evidence: '' }] });
    writeSeoFixture(topic);
    const before = snapshotAll();

    const result = await runPipeline({ ...fixtureOpts, dryRun: false, force: true, topicOverride: topic });
    console.log(`  coverage-gap -> status: ${result.status}`);
    checks.push(['coverage-gap: gate fires when the reviewer reports a missing item', result.status === 'coverage-gap']);
    checks.push(['coverage-gap: no new article file was created', !existsSync(path.join(paths.articlesDir, `${slugifyTopic(topic)}.html`))]);
    assertUntouched('coverage-gap', before);
  }

  // --- translation-failed: inject a translator that throws.
  {
    const topic = 'Translation Failure Test Topic';
    writeWriterFixture(topic);
    writeReviewerFixture(topic);
    writeSeoFixture(topic);
    const before = snapshotAll();

    const brokenTranslator = () => { throw new Error('simulated translator failure'); };
    const result = await runPipeline({ ...fixtureOpts, translator: brokenTranslator, dryRun: false, force: true, topicOverride: topic });
    console.log(`  translation-failed -> status: ${result.status}`);
    checks.push(['translation-failed: gate fires when the translator throws', result.status === 'translation-failed']);
    checks.push(['translation-failed: no new article file was created', !existsSync(path.join(paths.articlesDir, `${slugifyTopic(topic)}.html`))]);
    assertUntouched('translation-failed', before);
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Part 3 — a real (non-dry-run) successful publish: every file effect, plus
// the graph-extraction-failed rollback path on a SECOND, deliberately-forced
// regression.
// ---------------------------------------------------------------------------

async function runPart3(paths, fixtureOpts) {
  console.log('\n=== Part 3: real publish + rollback-on-regression ===\n');
  const checks = [];

  const topic = 'Real Publish Test Topic For Fixtures';
  const slug = slugifyTopic(topic);
  writeWriterFixture(topic);
  writeReviewerFixture(topic);
  writeSeoFixture(topic);
  // Entity name deliberately shares no >=4-char token with ANY other test
  // topic title in this file (retrieval-layer.js's findSeedEntities() would
  // otherwise match a shared generic word like "test"/"topic" and drag this
  // article into a later test's near-duplicate scoring, tripping the
  // duplicate-risk-high gate for the WRONG reason).
  writeExtractFixture(slug, { entities: [{ name: 'Quixotic Nightjar Metric', type: 'concept', relevance_score: 0.8 }] });
  writeJudgeFixture(slug); // {"items": []} -- oldState is empty, nothing to drop

  const result = await runPipeline({ ...fixtureOpts, dryRun: false, force: true, topicOverride: topic });
  console.log(`  real publish -> status: ${result.status}`);
  checks.push(['real publish: status is "ok"', result.status === 'ok']);
  checks.push(['real publish: result.dryRun is false', result.dryRun === false]);

  const articlePath = path.join(paths.articlesDir, `${slug}.html`);
  checks.push(['real publish: articles/<slug>.html was written', existsSync(articlePath)]);
  const articleHtml = existsSync(articlePath) ? readFileSync(articlePath, 'utf-8') : '';
  checks.push(['real publish: the written file has the .course-hero EN structure extract-articles.js expects', /class="course-hero"/.test(articleHtml) && /data-lang="en"/.test(articleHtml)]);
  checks.push(['real publish: the written file has a ZH stub-translated title', articleHtml.includes('【ZH-STUB】')]);

  checks.push(['real publish: articles.html now links the new slug', readFileSync(paths.articlesHtmlPath, 'utf-8').includes(`href="articles/${slug}.html"`)]);
  checks.push(['real publish: sitemap.xml now has a <loc> for the new slug', readFileSync(paths.sitemapPath, 'utf-8').includes(`/articles/${slug}.html`)]);

  const history = JSON.parse(readFileSync(paths.historyPath, 'utf-8'));
  checks.push(['real publish: the history ledger gained exactly one entry', history.length === 1]);
  checks.push(['real publish: the history entry records the right slug/title', history[0]?.slug === slug && history[0]?.nanyangTitle === topic]);

  const db = new DatabaseSync(paths.dbPath, { readOnly: true });
  const articleRow = db.prepare('SELECT * FROM articles WHERE slug = ?').get(slug);
  const entityCount = db.prepare(
    `SELECT COUNT(*) AS n FROM article_entities ae JOIN articles a ON a.id = ae.article_id WHERE a.slug = ?`
  ).get(slug).n;
  db.close();
  checks.push(['real publish: the articles table has a row for the new slug', Boolean(articleRow)]);
  checks.push(['real publish: extract-entities.js wrote at least one entity for the new article', entityCount > 0]);

  const mirror = JSON.parse(readFileSync(paths.mirrorPath, 'utf-8'));
  checks.push(['real publish: knowledge-graph.json mirror was regenerated and includes the new article', mirror.articles?.some((a) => a.slug === slug)]);

  // Publishing the SAME slug again must be refused, not silently overwritten.
  const collisionResult = await runPipeline({ ...fixtureOpts, dryRun: false, force: true, topicOverride: topic });
  checks.push(['re-running with the same topic: refuses with slug-collision, does not overwrite', collisionResult.status === 'slug-collision']);

  // Without --force, the cadence gate should now report "not due" (we just published moments ago).
  const cadenceResult = await runPipeline({ ...fixtureOpts, dryRun: false, force: false, topicOverride: 'Some Other Topic Entirely' });
  checks.push(['without --force right after a publish: cadence gate reports not-due', cadenceResult.status === 'not-due']);

  // --- Rollback on a forced graph-extraction regression: a fresh topic whose
  // judge fixture claims a (fabricated) dropped item, proving the rollback
  // path actually restores everything steps 8-12 touched.
  const regressionTopic = 'Forced Regression Test Topic For Rollback';
  const regressionSlug = slugifyTopic(regressionTopic);
  writeWriterFixture(regressionTopic);
  writeReviewerFixture(regressionTopic);
  writeSeoFixture(regressionTopic);
  writeExtractFixture(regressionSlug, { entities: [{ name: 'Umbrella Lattice Signal', type: 'concept', relevance_score: 0.8 }] });
  writeJudgeFixture(regressionSlug, { items: [{ name: 'Fabricated Old Fact', status: 'dropped', note: 'forced for testing' }] });

  const beforeRegression = {
    articlesHtml: readFileSync(paths.articlesHtmlPath, 'utf-8'),
    sitemap: readFileSync(paths.sitemapPath, 'utf-8'),
    history: readFileSync(paths.historyPath, 'utf-8'),
    db: readFileSync(paths.dbPath),
    mirror: readFileSync(paths.mirrorPath, 'utf-8'),
  };

  const regressionResult = await runPipeline({ ...fixtureOpts, dryRun: false, force: true, topicOverride: regressionTopic });
  console.log(`  forced regression -> status: ${regressionResult.status}`);
  checks.push(['forced regression: status is "graph-extraction-failed"', regressionResult.status === 'graph-extraction-failed']);

  const regressionArticlePath = path.join(paths.articlesDir, `${regressionSlug}.html`);
  checks.push(['forced regression: the new article file was deleted (rolled back)', !existsSync(regressionArticlePath)]);
  checks.push(['forced regression: articles.html was restored byte-for-byte', readFileSync(paths.articlesHtmlPath, 'utf-8') === beforeRegression.articlesHtml]);
  checks.push(['forced regression: sitemap.xml was restored byte-for-byte', readFileSync(paths.sitemapPath, 'utf-8') === beforeRegression.sitemap]);
  checks.push(['forced regression: the history ledger was NOT updated', readFileSync(paths.historyPath, 'utf-8') === beforeRegression.history]);
  checks.push(['forced regression: the db was restored byte-for-byte (the regressed entity write was undone)', Buffer.compare(readFileSync(paths.dbPath), beforeRegression.db) === 0]);
  checks.push(['forced regression: the JSON mirror was restored byte-for-byte', readFileSync(paths.mirrorPath, 'utf-8') === beforeRegression.mirror]);

  const dbAfterRollback = new DatabaseSync(paths.dbPath, { readOnly: true });
  const regressedRow = dbAfterRollback.prepare('SELECT * FROM articles WHERE slug = ?').get(regressionSlug);
  dbAfterRollback.close();
  checks.push(['forced regression: the regressed article never ends up in the articles table', !regressedRow]);

  return checks;
}

// ---------------------------------------------------------------------------
// Part 4 — CLI-level smoke test: --dry-run --json against the same isolated
// workspace, proving the flag-parsing/fixture-wiring path main() builds.
// ---------------------------------------------------------------------------

function runPart4(paths) {
  console.log('\n=== Part 4: CLI-level smoke test (--dry-run --json) ===\n');
  const checks = [];
  const topic = 'CLI Smoke Test Topic For Fixtures';
  writeWriterFixture(topic);
  writeReviewerFixture(topic);
  writeSeoFixture(topic);

  const args = [
    '--no-warnings', 'auto-publish-article.js', '--dry-run', '--force', '--json',
    '--topic', topic,
    '--db', paths.dbPath, '--catalog', paths.catalogPath, '--history', paths.historyPath,
    '--mirror', paths.mirrorPath, '--articles-dir', paths.articlesDir,
    '--articles-html', paths.articlesHtmlPath, '--sitemap', paths.sitemapPath,
    '--writer-fixture-dir', WRITER_DIR, '--reviewer-fixture-dir', REVIEWER_DIR, '--seo-fixture-dir', SEO_DIR,
    '--stub-translate',
  ];
  let stdout = '', exitCode = 0;
  try {
    stdout = execFileSync('node', args, { cwd: __dirname, encoding: 'utf-8' });
  } catch (err) {
    stdout = err.stdout ?? '';
    exitCode = err.status;
    console.log('  (CLI stderr) ' + (err.stderr ?? '').split('\n').join('\n  (CLI stderr) '));
  }
  checks.push(['CLI: --dry-run --json exits 0', exitCode === 0]);

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // leave null — next assertion reports it
  }
  checks.push(['CLI: --json output parses as JSON', parsed !== null]);
  checks.push(['CLI: --json output has status "ok"', parsed?.status === 'ok']);
  checks.push(['CLI: --json output is a dry run (dryRun: true)', parsed?.dryRun === true]);
  checks.push(['CLI: --dry-run never wrote a new article file', !existsSync(path.join(paths.articlesDir, `${slugifyTopic(topic)}.html`))]);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const paths = freshWorkspace();
  const fixtureOpts = await buildFixtureOpts(paths);

  const checks = [
    ...runPart0(),
    ...(await runPart1(paths, fixtureOpts)),
    ...(await runPart2(paths, fixtureOpts)),
    ...(await runPart3(paths, fixtureOpts)),
    ...runPart4(paths),
  ];

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
