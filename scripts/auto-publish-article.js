#!/usr/bin/env node
/**
 * Orchestrator — extra-md-files/automated-article-scheduler.md component 5 /
 * build-order step 5 ("Orchestrator (auto-publish-article.js), run locally
 * with --dry-run first"). Wires every component built in build-order steps
 * 1-4 (select-topic.js, retrieval-layer.js, generate-article.js,
 * seo-optimizer.js, graph-blocks.js, translate-article.js,
 * build-article-document.js, extract-articles.js, extract-entities.js) into
 * the single unattended run the doc's "Orchestration order" section
 * specifies, ending in a **draft PR on a fresh branch** — NOT a direct commit
 * to the default branch, per the doc's 2026-08-14 addendum amending decision
 * 1 (the owner does not consider zero human review before live
 * financial-education content publishes an acceptable starting risk, even
 * with every technical safety gate passing).
 *
 * Steps (matching the doc's own numbering):
 *   1. select-topic.js            -> topic (abort if none available, or a
 *                                     collision with an existing articles/*.html file)
 *   2. retrieval-layer.js         -> a fresh duplicate-risk re-check on the
 *                                     selected topic (abort if "high" — belt
 *                                     and suspenders on top of select-topic.js's
 *                                     own exclusion, since a caller can pass
 *                                     --topic to bypass selection entirely)
 *   3. generate-article.js        -> EN draft + coverage (writer -> reviewer -> <=1 repair)
 *      (abort if any checklist item is still "missing" after the repair retry,
 *       or if the reviewer/repair stage failed outright)
 *   4. seo-optimizer.js           -> EN SEO fields
 *   5. graph-blocks.js            -> EN chart HTML, inserted into the EN body
 *   6. translate-article.js       -> ZH title/subtitle/category/SEO/body
 *      (abort on a structural-sanity-check mismatch — translateArticleBodyHtml
 *       throws that itself)
 *   7. graph-blocks.js (again)    -> ZH chart HTML, from the translated steps,
 *                                     swapped into the translated ZH body (the
 *                                     EN figure survives translation untouched
 *                                     by design — translateArticleBodyHtml
 *                                     skips graph-block subtrees — so it has
 *                                     to be replaced explicitly here)
 *   8. build-article-document.js  -> full articles/<slug>.html (in memory)
 *      --dry-run stops here: everything above ran for real (including real
 *      LLM calls, unless fixture/stub options are given), nothing below ever
 *      touches disk or git.
 *   9. articles.html + sitemap.xml -> same shape admin/index.html's
 *                                     publishArticleAtomic() produces
 *                                     (buildUpdatedArticlesListing /
 *                                     buildUpdatedSitemap below), ported to
 *                                     plain Node fs edits
 *  10. extract-articles.js        -> upsert this one article into `articles` + backfill `links`
 *  11-12. extract-entities.js     -> entities/edges for the new article, then
 *                                     the §3 fact-retention checker against
 *                                     this article's own (empty) prior state —
 *                                     processArticle() already chains both.
 *      Any local write from steps 8-12 is rolled back (file contents restored
 *      byte-for-byte, the new articles/<slug>.html deleted) if this stage
 *      doesn't come back "ok".
 *  13. admin/auto-article-history.json -> record this cycle's pick (only
 *                                     once 10-12 have actually succeeded)
 *  14. git checkout -b auto-article/<slug> && commit && push && gh pr create --draft
 *      (main()/gitPublish() only — runPipeline() below never touches git;
 *      skipped entirely under --dry-run, and push+PR are skipped under
 *      --no-push, useful for a first local test on a disposable branch)
 *
 * Cadence gate: reads admin/auto-article-history.json's most recent
 * publishedAt and only proceeds past step 1 if today - lastPublishedAt is >=
 * a randomized 14-21 day target (rerolled every time this check runs) —
 * otherwise this is a "not due yet" no-op, exit 0. --force skips this gate
 * (manual/testing).
 *
 * Every LLM call site here is dependency-injected exactly like every sibling
 * script in this directory, so the whole pipeline is testable offline — see
 * validate-auto-publish-article.js, which drives runPipeline() directly with
 * fixture/stub functions and a fully isolated temp db/catalog/articles dir
 * (never the real repo files).
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node auto-publish-article.js --dry-run
 *   OPENAI_API_KEY=sk-... node auto-publish-article.js --dry-run --topic "..."   # skip auto-selection
 *   OPENAI_API_KEY=sk-... node auto-publish-article.js --force                   # real run, ignore the cadence gate
 *   OPENAI_API_KEY=sk-... node auto-publish-article.js --force --no-push         # write + commit locally, no push/PR
 *   node auto-publish-article.js --dry-run --stub-translate --writer-fixture-dir D --reviewer-fixture-dir D \
 *     --seo-fixture-dir D --extract-fixture-dir D --judge-fixture-dir D          # fully offline smoke test
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';

import { nextArg } from './cli-args.js';
import { selectTopic, loadHistory, appendHistoryEntry } from './select-topic.js';
import { buildRetrievalContext } from './retrieval-layer.js';
import { generateArticleWithReview, openAIWriter, fixtureWriter, fixtureReviewerByTopic, slugifyTopic } from './generate-article.js';
import { openAIReviewer } from './coverage-reviewer.js';
import { generateSeoMetadata, openAISeoWriter, fixtureSeoWriter } from './seo-optimizer.js';
import { buildFlowGraphHtml, validateGraphSteps, insertGraphIntoBody } from './graph-blocks.js';
import { translateFields, translateStringArray, translateArticleBodyHtml, openAIBatchTranslator, stubMarkerTranslator } from './translate-article.js';
import { buildArticleDocument, bodyTextToHtml, computeReadingTimeText, escapeHtml } from './build-article-document.js';
import { extractArticle, upsertArticles, backfillLinks, regenerateJsonMirror } from './extract-articles.js';
import { listArticles, processArticle, openAIExtractor, fixtureExtractor } from './extract-entities.js';
import { openAIJudge, fixtureJudge } from './fact-retention-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_SITE_BASE_URL = 'https://www.warrenmak.asia';
export const DEFAULT_MIN_CADENCE_DAYS = 14;
export const DEFAULT_MAX_CADENCE_DAYS = 21;

export const DEFAULT_PATHS = {
  catalogPath: path.join(REPO_ROOT, 'WARREN-MAK-NANYANG-ARTICLES.md'),
  historyPath: path.join(REPO_ROOT, 'admin', 'auto-article-history.json'),
  dbPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.db'),
  mirrorPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.json'),
  schemaPath: path.join(REPO_ROOT, 'admin', 'knowledge-graph.schema.sql'),
  articlesDir: path.join(REPO_ROOT, 'articles'),
  articlesHtmlPath: path.join(REPO_ROOT, 'articles.html'),
  sitemapPath: path.join(REPO_ROOT, 'sitemap.xml'),
};

/** Thrown for every "this is a normal, expected abort" outcome (a failed
 *  safety gate, an exhausted catalog, a slug collision, ...) — caught inside
 *  runPipeline() itself and turned into a `{status, reason}` return value, so
 *  callers never need a try/catch of their own for the expected cases.
 *  A genuinely unexpected error (a bug, a network failure with no fixture)
 *  still propagates as a normal thrown Error. */
class PipelineAbort extends Error {
  constructor(status, reason, extra = {}) {
    super(reason);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Cadence gate — "every 2-3 weeks", not a rigid fixed-interval cron (see the
// doc's own "Cadence" section for why this is a randomized range, rerolled
// per check, rather than one fixed number of days)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{publishedAt: string}>} history - loadHistory() output
 * @param {object} [opts]
 * @param {number} [opts.minDays=14] / {number} [opts.maxDays=21]
 * @param {Function} [opts.random=Math.random] - DI'd for deterministic tests
 * @param {Date} [opts.now=new Date()]
 */
export function isDueForNextCycle(history, { minDays = DEFAULT_MIN_CADENCE_DAYS, maxDays = DEFAULT_MAX_CADENCE_DAYS, random = Math.random, now = new Date() } = {}) {
  if (!history.length) {
    return { due: true, reason: 'No publish history yet — first cycle is always due.', lastPublishedAt: null, daysSince: null, targetDays: null };
  }
  const last = history.reduce((latest, h) => (!latest || h.publishedAt > latest.publishedAt ? h : latest), null);
  const lastDate = new Date(last.publishedAt);
  const daysSince = (now.getTime() - lastDate.getTime()) / 86400000;
  const targetDays = minDays + random() * (maxDays - minDays);
  return {
    due: daysSince >= targetDays,
    lastPublishedAt: last.publishedAt,
    daysSince: Number(daysSince.toFixed(1)),
    targetDays: Number(targetDays.toFixed(1)),
  };
}

// ---------------------------------------------------------------------------
// articles.html / sitemap.xml — plain-fs ports of admin/index.html's
// buildUpdatedArticlesListing() / buildUpdatedSitemap() (publishArticleAtomic
// section — search admin/index.html for "buildUpdatedArticlesListing" to find
// the browser original). NOT registered with validate-admin-mirror-sync.js:
// that validator only covers prompt-building functions plus the two
// deterministic HTML-assembly pairs the doc explicitly calls out
// (buildFlowGraphHtml, buildArticleDocument) — these two targeted string
// edits were never one of those pairs, and this port only needs to match the
// *shape* those functions produce (the doc's own framing), not be a
// byte-identical mirror kept in permanent lockstep.
// ---------------------------------------------------------------------------

/** @param {string} html - current articles.html contents
 *  @param {object} state - the same docState object passed to buildArticleDocument() */
export function buildUpdatedArticlesListing(html, state) {
  const anchor = '<div class="article-grid">';
  const anchorIdx = html.indexOf(anchor);
  if (anchorIdx === -1) throw new Error('Could not find .article-grid in articles.html');
  const insertAt = anchorIdx + anchor.length;

  const readingDigits = state.readingTimeText.replace(/[^0-9]/g, '') || '5';
  const card =
    '\n\n        <a href="articles/' + state.slug + '.html" class="article-card" data-animate>\n' +
    '          <div class="article-card__tag"><span data-lang="en">' + escapeHtml(state.categoryEn) + '</span><span data-lang="zh" style="display:none;">' + escapeHtml(state.categoryZh) + '</span></div>\n' +
    '          <h2 class="article-card__title"><span data-lang="en">' + escapeHtml(state.titleEn) + '</span><span data-lang="zh" style="display:none;">' + escapeHtml(state.titleZh) + '</span></h2>\n' +
    '          <p class="article-card__excerpt"><span data-lang="en">' + escapeHtml(state.subtitleEn) + '</span><span data-lang="zh" style="display:none;">' + escapeHtml(state.subtitleZh) + '</span></p>\n' +
    '          <div class="article-card__meta">\n' +
    '            <span data-lang="en">' + escapeHtml(state.authorEn) + '</span><span data-lang="zh" style="display:none;">' + escapeHtml(state.authorZh) + '</span>\n' +
    '            <span data-lang="en">' + escapeHtml(state.readingTimeText) + '</span><span data-lang="zh" style="display:none;">阅读时间：' + readingDigits + '分钟</span>\n' +
    '          </div>\n' +
    '        </a>';

  return html.slice(0, insertAt) + card + html.slice(insertAt);
}

/** @param {string} xml - current sitemap.xml contents
 *  @param {{canonicalUrl: string, publishDate: string}} state */
export function buildUpdatedSitemap(xml, state) {
  const entry =
    '  <url>\n    <loc>' + state.canonicalUrl + '</loc>\n    <lastmod>' + state.publishDate +
    '</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.9</priority>\n  </url>\n';
  const updatedXml = xml.replace('</urlset>', entry + '</urlset>');
  if (updatedXml === xml) throw new Error('Could not find </urlset> in sitemap.xml');
  return updatedXml;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Category isn't produced by any existing component (seo-optimizer.js has
 *  no "category" field, generate-article.js's draft doesn't either) — this
 *  derives a reasonable one from the Nanyang catalog entry's own section
 *  heading (select-topic.js's `section`, e.g. "Key Trading Strategy Articles
 *  > Time Decay"), falling back to a generic bucket for a --topic override
 *  (which has no catalog section) or an entry with none recorded. */
export function deriveCategory(candidate) {
  if (!candidate.section) return 'Trading Strategy';
  const parts = String(candidate.section).split('>').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || 'Trading Strategy';
}

/** Swaps the ONE `<figure class="graph-block ...">` in `html` for
 *  `newFigureHtml` — used to replace the EN graph figure that survives
 *  translate-article.js's translateArticleBodyHtml() untouched (by design —
 *  it skips graph-block subtrees) with the real ZH figure built from the
 *  translated steps. Throws rather than silently no-oping if the body
 *  doesn't contain exactly one graph figure, since that would mean step 5
 *  (or this function) is being called out of the order runPipeline() expects.
 *
 *  `newFigureHtml` is always graph-blocks.js's buildFlowGraphHtml() output,
 *  which carries its own leading `<!-- graph block: hand-authored... -->`
 *  marker comment ahead of the `<figure>` — and the STALE (untranslated) EN
 *  figure this function replaces was built the same way, so it has that same
 *  comment as its immediately preceding sibling. Without stripping it here,
 *  the swap leaves the old comment behind while inserting a second, fresh
 *  copy as part of `newFigureHtml`, so the translated body ends up carrying
 *  the marker comment twice back-to-back (found running a real test article
 *  through this pipeline — every ZH body this step ever touched has the same
 *  doubled comment). Removing it before the replace keeps exactly one copy. */
export function replaceGraphFigure(html, newFigureHtml) {
  const $ = cheerio.load(html, null, false);
  const figures = $('figure.graph-block');
  if (figures.length !== 1) {
    throw new Error(`replaceGraphFigure: expected exactly 1 graph-block figure in the body, found ${figures.length}.`);
  }
  const figureNode = figures.get(0);
  const prevSibling = figureNode.prev;
  if (prevSibling && prevSibling.type === 'comment' && prevSibling.data.trim() === 'graph block: hand-authored, do not edit via admin WYSIWYG') {
    $(prevSibling).remove();
  }
  figures.first().replaceWith(newFigureHtml);
  return $.root().html();
}

/** Byte-snapshot of a file for the steps-8-12 rollback (see runPipeline's
 *  header comment / the doc's "Failure handling" section). `existed: false`
 *  means restoreSnapshot() should DELETE the file on rollback, not write
 *  empty content back — that's the "brand new file this run created" case
 *  (articles/<slug>.html). */
export function snapshotFile(filePath) {
  return existsSync(filePath) ? { path: filePath, existed: true, buf: readFileSync(filePath) } : { path: filePath, existed: false, buf: null };
}

export function restoreSnapshot(snap) {
  if (snap.existed) writeFileSync(snap.path, snap.buf);
  else if (existsSync(snap.path)) rmSync(snap.path);
}

// ---------------------------------------------------------------------------
// runPipeline — steps 1-13 (cadence gate through the history-ledger write).
// Never touches git; see gitPublish()/main() below for step 14.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.catalogPath] [opts.historyPath] [opts.dbPath] [opts.mirrorPath]
 *   [opts.schemaPath] [opts.articlesDir] [opts.articlesHtmlPath] [opts.sitemapPath] - see DEFAULT_PATHS
 * @param {string} [opts.siteBaseUrl=DEFAULT_SITE_BASE_URL]
 * @param {boolean} [opts.dryRun=false] - stop after step 8 (the assembled document), write nothing, touch nothing
 * @param {boolean} [opts.force=false] - skip the cadence gate
 * @param {number} [opts.minDays] [opts.maxDays] - cadence gate bounds
 * @param {Function} [opts.random] - DI'd for the cadence gate's reroll (tests only)
 * @param {string} [opts.topicOverride] - skip auto-selection, use this exact topic string (still runs
 *   the step-2 duplicate-risk gate for real)
 * @param {'warrants'|'shortterm'} [opts.ctaPreset='warrants']
 * @param {Function} [opts.writer=openAIWriter] [opts.writerOpts]
 * @param {Function} [opts.reviewer=openAIReviewer] [opts.reviewerOpts]
 * @param {Function} [opts.seoWriter=openAISeoWriter] [opts.seoWriterOpts]
 * @param {Function} [opts.translator=openAIBatchTranslator] [opts.translatorOpts]
 * @param {Function} [opts.extract=openAIExtractor] [opts.extractModel]
 * @param {Function} [opts.judge=openAIJudge]
 * @returns {Promise<object>} `{status, ...}` — status is one of:
 *   'not-due' | 'no-topic' | 'slug-collision' | 'duplicate-risk-high' |
 *   'coverage-review-failed' | 'coverage-gap' | 'translation-failed' |
 *   'graph-extraction-failed' | 'ok'
 */
export async function runPipeline(opts) {
  const paths = { ...DEFAULT_PATHS, ...opts };
  const siteBaseUrl = opts.siteBaseUrl || DEFAULT_SITE_BASE_URL;
  const ctaPreset = opts.ctaPreset || 'warrants';

  const writer = opts.writer || openAIWriter;
  const writerOpts = opts.writerOpts || {};
  const reviewer = opts.reviewer || openAIReviewer;
  const reviewerOpts = opts.reviewerOpts || {};
  const seoWriter = opts.seoWriter || openAISeoWriter;
  const seoWriterOpts = opts.seoWriterOpts || {};
  const translator = opts.translator || openAIBatchTranslator;
  const translatorOpts = opts.translatorOpts || {};
  const extract = opts.extract || openAIExtractor;
  const judge = opts.judge || openAIJudge;

  try {
    // -------------------------------------------------------------------
    // Cadence gate
    // -------------------------------------------------------------------
    const history = loadHistory(paths.historyPath);
    let cadence = null;
    if (!opts.force) {
      cadence = isDueForNextCycle(history, { minDays: opts.minDays, maxDays: opts.maxDays, random: opts.random });
      if (!cadence.due) throw new PipelineAbort('not-due', 'Not due yet this cycle.', { cadence });
    }

    // -------------------------------------------------------------------
    // Step 1: topic selection
    // -------------------------------------------------------------------
    let candidate;
    if (opts.topicOverride) {
      candidate = {
        title: opts.topicOverride,
        date: new Date().toISOString().slice(0, 10),
        inferred: false,
        url: null,
        section: null,
        source: 'override',
        candidateSlug: slugifyTopic(opts.topicOverride),
      };
    } else {
      if (!existsSync(paths.catalogPath)) throw new PipelineAbort('no-topic', `Catalog file not found: ${paths.catalogPath}`);
      const catalogText = readFileSync(paths.catalogPath, 'utf-8');
      const selectDb = new DatabaseSync(paths.dbPath, { readOnly: true });
      let selection;
      try {
        selection = selectTopic(selectDb, { catalogText, history });
      } finally {
        selectDb.close();
      }
      if (!selection.selected) throw new PipelineAbort('no-topic', selection.reason, { candidates: selection.candidates });
      candidate = selection.selected;
    }
    const topic = candidate.title;
    const slug = candidate.candidateSlug;
    const newArticlePath = path.join(paths.articlesDir, `${slug}.html`);
    if (existsSync(newArticlePath)) {
      throw new PipelineAbort('slug-collision', `articles/${slug}.html already exists — refusing to overwrite.`, { slug });
    }

    // -------------------------------------------------------------------
    // Step 2: duplicate-risk re-check (belt-and-suspenders on top of
    // select-topic.js's own exclusion — matters when --topic bypasses selection)
    // -------------------------------------------------------------------
    const readDb = new DatabaseSync(paths.dbPath, { readOnly: true });
    let retrievalDupCheck, generated, seoResult;
    try {
      retrievalDupCheck = buildRetrievalContext(readDb, topic, { candidateTitle: topic, candidateSlug: slug });
      if (retrievalDupCheck.duplicateRisk?.verdict === 'high') {
        throw new PipelineAbort('duplicate-risk-high', `"${topic}" scores duplicateRisk: "high" against an existing article.`, { retrievalDupCheck });
      }

      // -----------------------------------------------------------------
      // Step 3: writer -> reviewer -> <=1 repair retry, plus internal-link insertion
      // -----------------------------------------------------------------
      generated = await generateArticleWithReview({ db: readDb, topic, writer, writerOpts, reviewer, reviewerOpts });
      if (generated.reviewCoverageFailed) {
        throw new PipelineAbort('coverage-review-failed', `Coverage review failed: ${generated.reviewCoverageFailedMessage}`, { generated });
      }
      if (generated.summary.missing.length) {
        throw new PipelineAbort(
          'coverage-gap',
          `${generated.summary.missing.length} checklist item(s) still "missing" after the repair retry: ` +
            generated.summary.missing.map((i) => i.name).join(', '),
          { generated }
        );
      }

      // -----------------------------------------------------------------
      // Step 4: SEO metadata
      // -----------------------------------------------------------------
      seoResult = await generateSeoMetadata({ db: readDb, topic, title: generated.draft.title, bodyText: generated.draft.body_text, seoWriter, seoWriterOpts });
    } finally {
      readDb.close();
    }
    const draft = generated.draft;
    const seo = seoResult.metadata;

    // -------------------------------------------------------------------
    // Step 5: EN chart HTML, inserted into the EN body
    // -------------------------------------------------------------------
    validateGraphSteps(draft.suggestedGraphSteps);
    const bodyEnHtmlNoGraph = bodyTextToHtml(draft.body_text);
    const enGraphHtml = buildFlowGraphHtml(draft.title, draft.suggestedGraphSteps);
    const bodyEnHtml = insertGraphIntoBody(bodyEnHtmlNoGraph, enGraphHtml);

    // -------------------------------------------------------------------
    // Step 6: translate title/subtitle/category/SEO fields + the EN body
    // (graph-block text is skipped by translateArticleBodyHtml by design —
    // its structural-sanity check throws on any mismatch, aborting the run)
    // -------------------------------------------------------------------
    const categoryEn = deriveCategory(candidate);
    let zhFields, zhSteps, bodyZhHtmlWithStaleEnGraph;
    try {
      zhFields = await translateFields(
        {
          title: draft.title,
          subtitle: draft.summary,
          category: categoryEn,
          seoTitle: seo.seoTitle,
          metaDescription: seo.metaDescription,
          ogTitle: seo.ogTitle,
          ogDescription: seo.ogDescription,
        },
        { translator, translatorOpts, contextLabel: 'title/subtitle/category/SEO fields' }
      );
      zhSteps = await translateStringArray(draft.suggestedGraphSteps, { translator, translatorOpts, contextLabel: 'graph-block step labels' });
      bodyZhHtmlWithStaleEnGraph = await translateArticleBodyHtml(bodyEnHtml, { translator, translatorOpts, contextLabel: 'article body HTML' });
    } catch (err) {
      throw new PipelineAbort('translation-failed', err.message, { draft });
    }

    // -------------------------------------------------------------------
    // Step 7: ZH chart HTML from the translated steps, swapped into the
    // translated body in place of the untranslated EN figure
    // -------------------------------------------------------------------
    const zhGraphHtml = buildFlowGraphHtml(zhFields.title, zhSteps);
    const bodyZhHtml = replaceGraphFigure(bodyZhHtmlWithStaleEnGraph, zhGraphHtml);

    // -------------------------------------------------------------------
    // Step 8: assemble the full page (in memory)
    // -------------------------------------------------------------------
    const publishDate = new Date().toISOString().slice(0, 10);
    const canonicalUrl = `${siteBaseUrl}/articles/${slug}.html`;
    const tags = [...(seo.primaryKeywords || []), ...(seo.secondaryKeywords || [])].join(', ');
    const readingTimeText = computeReadingTimeText({ bodyTextEn: draft.body_text });

    const docState = {
      titleEn: draft.title,
      titleZh: zhFields.title,
      subtitleEn: draft.summary,
      subtitleZh: zhFields.subtitle,
      categoryEn,
      categoryZh: zhFields.category,
      authorEn: 'Warren Mak',
      authorZh: '麦传球 Warren Mak',
      publishDate,
      tags,
      ctaPreset,
      slug,
      metaTitle: seo.seoTitle,
      metaDescription: seo.metaDescription,
      canonicalUrl,
      bodyEnHtml,
      bodyZhHtml,
      readingTimeText,
      ogImageUrl: `${siteBaseUrl}/assets/images/og-image.jpg`,
    };
    const fullHtml = buildArticleDocument(docState);

    const report = {
      candidate,
      topic,
      slug,
      draft,
      coverage: generated.summary,
      internalLinks: generated.internalLinks,
      retrievalDupCheck,
      seo,
      docState,
      fullHtmlLength: fullHtml.length,
    };

    if (opts.dryRun) {
      return { status: 'ok', dryRun: true, ...report };
    }

    // ===================================================================
    // Everything below writes to disk for real. Steps 8-12 are rolled back
    // wholesale (file contents restored, the new article file deleted) if
    // step 11-12's fact-retention check doesn't come back "ok" — see the
    // doc's "Failure handling" section.
    // ===================================================================
    const snapshots = {
      articlesHtml: snapshotFile(paths.articlesHtmlPath),
      sitemap: snapshotFile(paths.sitemapPath),
      db: snapshotFile(paths.dbPath),
      mirror: snapshotFile(paths.mirrorPath),
    };
    let wroteNewArticleFile = false;

    try {
      // Step 8 (write): articles/<slug>.html
      writeFileSync(newArticlePath, fullHtml, 'utf-8');
      wroteNewArticleFile = true;

      // Step 9: articles.html + sitemap.xml
      writeFileSync(paths.articlesHtmlPath, buildUpdatedArticlesListing(readFileSync(paths.articlesHtmlPath, 'utf-8'), docState), 'utf-8');
      writeFileSync(paths.sitemapPath, buildUpdatedSitemap(readFileSync(paths.sitemapPath, 'utf-8'), docState), 'utf-8');

      // Steps 10-12: extract-articles.js (articles + links) then
      // extract-entities.js's processArticle (entities/edges + the §3
      // fact-retention checker, chained together already).
      const schemaSql = readFileSync(paths.schemaPath, 'utf-8');
      const db = new DatabaseSync(paths.dbPath);
      let entityResult;
      try {
        db.exec(schemaSql);
        const record = extractArticle(newArticlePath);
        db.exec('BEGIN');
        try {
          upsertArticles(db, [record]);
          backfillLinks(db, [record]);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        const [article] = listArticles(db, { onlySlug: slug });
        entityResult = await processArticle(db, article, {
          dbPath: paths.dbPath,
          model: opts.extractModel || undefined,
          dryRun: false,
          skipChecker: false,
          extract,
          extractOpts: {},
          judge,
          judgeOpts: {},
        });

        if (entityResult.status === 'ok') {
          regenerateJsonMirror(db, paths.mirrorPath);
        }
      } finally {
        db.close();
      }

      if (entityResult.status !== 'ok') {
        const details = [
          entityResult.dropped?.length ? `dropped: ${entityResult.dropped.map((i) => i.name).join(', ')}` : null,
          entityResult.altered?.length ? `altered: ${entityResult.altered.map((i) => i.name).join(', ')}` : null,
          entityResult.error ? entityResult.error : null,
        ].filter(Boolean).join('; ');
        throw new PipelineAbort(
          'graph-extraction-failed',
          `Knowledge-graph extraction/fact-retention check for "${slug}" came back "${entityResult.status}"${details ? ` (${details})` : ''}.`,
          { entityResult }
        );
      }

      // Step 13: history ledger — only once 10-12 have actually succeeded.
      appendHistoryEntry(paths.historyPath, { nanyangTitle: candidate.title, slug, publishedAt: new Date().toISOString() });

      return {
        status: 'ok',
        dryRun: false,
        ...report,
        filesWritten: [newArticlePath, paths.articlesHtmlPath, paths.sitemapPath, paths.dbPath, paths.mirrorPath, paths.historyPath],
      };
    } catch (err) {
      if (wroteNewArticleFile && existsSync(newArticlePath)) rmSync(newArticlePath);
      restoreSnapshot(snapshots.articlesHtml);
      restoreSnapshot(snapshots.sitemap);
      restoreSnapshot(snapshots.db);
      restoreSnapshot(snapshots.mirror);
      if (err instanceof PipelineAbort) throw err;
      throw new PipelineAbort('graph-extraction-failed', err.message, {});
    }
  } catch (err) {
    if (err instanceof PipelineAbort) return { status: err.status, reason: err.message, ...err.extra };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 14: git checkout -b / commit / push / gh pr create --draft.
// Never called by runPipeline() itself — only from main() below, and only
// after a real (non-dry-run) "ok" result.
// ---------------------------------------------------------------------------

export function getDefaultBaseBranch(explicitOverride, { cwd = REPO_ROOT } = {}) {
  if (explicitOverride) return explicitOverride;
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf-8' }).trim();
    return ref.split('/').pop() || 'main';
  } catch {
    return 'main';
  }
}

export function buildCommitMessage(result) {
  const { candidate, draft, coverage, slug } = result;
  // No "Co-Authored-By: Claude" trailer here — this repo's own standing rule
  // (see the project memory on the subject) applies to every commit this
  // script produces, automated or not.
  return (
    `Auto-publish: ${draft.title}\n\n` +
    `Generated by scripts/auto-publish-article.js from the Nanyang column "${candidate.title}"` +
    `${candidate.date ? ` (${candidate.date})` : ''}.\n` +
    `Coverage: ${coverage.covered.length} covered, ${coverage.partial.length} partial, ${coverage.missing.length} missing.\n` +
    `Slug: ${slug}\n\n` +
    `This branch was opened automatically and needs human review before merging — see ` +
    `extra-md-files/automated-article-scheduler.md's 2026-08-14 addendum (draft-PR mode, not a ` +
    `direct commit to the default branch).`
  );
}

export function buildPrBody(result) {
  const { candidate, draft, coverage, seo, internalLinks, slug, docState } = result;
  return (
    `## Auto-generated article — needs human review before merging\n\n` +
    `**Topic:** ${candidate.title}${candidate.date ? ` (Nanyang column, ${candidate.date})` : ''}\n` +
    `**Slug:** \`${slug}\`\n` +
    `**Title:** ${draft.title}\n` +
    `**Category:** ${docState.categoryEn}\n\n` +
    `### Coverage checklist\n` +
    `- Covered: ${coverage.covered.length}\n` +
    `- Partial: ${coverage.partial.length}\n` +
    `- Missing: ${coverage.missing.length}\n\n` +
    `### Internal links auto-inserted\n` +
    `- Inserted: ${internalLinks.inserted.length}\n` +
    `- Skipped: ${internalLinks.skipped.length}\n\n` +
    `### SEO\n` +
    `- SEO title: ${seo.seoTitle}\n` +
    `- Meta description: ${seo.metaDescription}\n\n` +
    `### Before merging\n` +
    `- [ ] Read the EN and ZH bodies for factual/tone/compliance issues (the reviewer/fact-retention ` +
    `gates check fidelity to the knowledge graph, not regulatory appropriateness).\n` +
    `- [ ] Spot-check the auto-inserted internal links and the auto-generated flow chart.\n` +
    `- [ ] Confirm the ZH translation reads naturally, not just structurally intact.\n\n` +
    `This PR was opened by \`scripts/auto-publish-article.js\` (extra-md-files/automated-article-scheduler.md).`
  );
}

export function gitPublish(result, opts) {
  const { slug } = result;
  const cwd = REPO_ROOT;
  const baseBranch = getDefaultBaseBranch(opts.baseBranch, { cwd });
  const branchName = `auto-article/${slug}`;

  let branchExists = true;
  try {
    execFileSync('git', ['rev-parse', '--verify', branchName], { cwd, stdio: 'ignore' });
  } catch {
    branchExists = false; // rev-parse --verify failing is the EXPECTED case — branch doesn't exist yet
  }
  if (branchExists) {
    throw new Error(`Branch "${branchName}" already exists — delete it first (git branch -D ${branchName}) or pick a different slug.`);
  }

  console.log(`\nCreating branch ${branchName} (base: ${baseBranch})...`);
  execFileSync('git', ['checkout', '-b', branchName], { cwd, stdio: 'inherit' });
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', buildCommitMessage(result)], { cwd, stdio: 'inherit' });
  console.log(`Committed locally on ${branchName}.`);

  if (opts.noPush) {
    console.log('--no-push set — stopping before push/PR. Inspect the commit, then push/open the PR manually if it looks right.');
    return { branchName, baseBranch, pushed: false };
  }

  execFileSync('git', ['push', '-u', 'origin', branchName], { cwd, stdio: 'inherit' });
  try {
    execFileSync(
      'gh',
      ['pr', 'create', '--draft', '--base', baseBranch, '--head', branchName, '--title', `Auto-publish: ${result.draft.title}`, '--body', buildPrBody(result)],
      { cwd, stdio: 'inherit' }
    );
  } catch (err) {
    throw new Error(`Pushed ${branchName} but "gh pr create" failed — is the gh CLI installed and authenticated? (${err.message})`);
  }
  console.log('Opened draft PR.');
  return { branchName, baseBranch, pushed: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    noPush: false,
    topicOverride: null,
    baseBranch: null,
    ctaPreset: 'warrants',
    siteBaseUrl: DEFAULT_SITE_BASE_URL,
    minDays: DEFAULT_MIN_CADENCE_DAYS,
    maxDays: DEFAULT_MAX_CADENCE_DAYS,
    writerModel: null,
    reviewerModel: null,
    seoModel: null,
    translateModel: null,
    extractModel: null,
    writerFixtureDir: null,
    reviewerFixtureDir: null,
    seoFixtureDir: null,
    extractFixtureDir: null,
    judgeFixtureDir: null,
    stubTranslate: false,
    json: false,
    ...DEFAULT_PATHS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--no-push': opts.noPush = true; break;
      case '--topic': opts.topicOverride = nextArg(argv, ++i, '--topic'); break;
      case '--base-branch': opts.baseBranch = nextArg(argv, ++i, '--base-branch'); break;
      case '--cta-preset': opts.ctaPreset = nextArg(argv, ++i, '--cta-preset'); break;
      case '--site-base-url': opts.siteBaseUrl = nextArg(argv, ++i, '--site-base-url'); break;
      case '--min-days': opts.minDays = Number(nextArg(argv, ++i, '--min-days')); break;
      case '--max-days': opts.maxDays = Number(nextArg(argv, ++i, '--max-days')); break;
      case '--catalog': opts.catalogPath = path.resolve(nextArg(argv, ++i, '--catalog')); break;
      case '--history': opts.historyPath = path.resolve(nextArg(argv, ++i, '--history')); break;
      case '--db': opts.dbPath = path.resolve(nextArg(argv, ++i, '--db')); break;
      case '--mirror': opts.mirrorPath = path.resolve(nextArg(argv, ++i, '--mirror')); break;
      case '--schema': opts.schemaPath = path.resolve(nextArg(argv, ++i, '--schema')); break;
      case '--articles-dir': opts.articlesDir = path.resolve(nextArg(argv, ++i, '--articles-dir')); break;
      case '--articles-html': opts.articlesHtmlPath = path.resolve(nextArg(argv, ++i, '--articles-html')); break;
      case '--sitemap': opts.sitemapPath = path.resolve(nextArg(argv, ++i, '--sitemap')); break;
      case '--writer-model': opts.writerModel = nextArg(argv, ++i, '--writer-model'); break;
      case '--reviewer-model': opts.reviewerModel = nextArg(argv, ++i, '--reviewer-model'); break;
      case '--seo-model': opts.seoModel = nextArg(argv, ++i, '--seo-model'); break;
      case '--translate-model': opts.translateModel = nextArg(argv, ++i, '--translate-model'); break;
      case '--extract-model': opts.extractModel = nextArg(argv, ++i, '--extract-model'); break;
      case '--writer-fixture-dir': opts.writerFixtureDir = path.resolve(nextArg(argv, ++i, '--writer-fixture-dir')); break;
      case '--reviewer-fixture-dir': opts.reviewerFixtureDir = path.resolve(nextArg(argv, ++i, '--reviewer-fixture-dir')); break;
      case '--seo-fixture-dir': opts.seoFixtureDir = path.resolve(nextArg(argv, ++i, '--seo-fixture-dir')); break;
      case '--extract-fixture-dir': opts.extractFixtureDir = path.resolve(nextArg(argv, ++i, '--extract-fixture-dir')); break;
      case '--judge-fixture-dir': opts.judgeFixtureDir = path.resolve(nextArg(argv, ++i, '--judge-fixture-dir')); break;
      case '--stub-translate': opts.stubTranslate = true; break;
      case '--json': opts.json = true; break;
      default: throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

function printReport(result) {
  console.log(`\nTopic: "${result.topic}" (slug: ${result.slug})`);
  console.log(`  Nanyang column: ${result.candidate.date ?? '(override)'}${result.candidate.url ? ` — ${result.candidate.url}` : ''}`);
  console.log(`  Duplicate risk: ${result.retrievalDupCheck.duplicateRisk?.verdict ?? 'none'}`);
  console.log(`\nDraft title: ${result.draft.title}`);
  console.log(`Coverage: ${result.coverage.covered.length} covered, ${result.coverage.partial.length} partial, ${result.coverage.missing.length} missing`);
  console.log(`Internal links: ${result.internalLinks.inserted.length} inserted, ${result.internalLinks.skipped.length} skipped`);
  console.log(`Graph steps: ${result.draft.suggestedGraphSteps.join(' -> ')}`);
  console.log(`SEO title: ${result.seo.seoTitle}`);
  console.log(`Assembled document: ${result.fullHtmlLength} chars`);
  if (result.filesWritten) {
    console.log(`\nFiles written:`);
    for (const f of result.filesWritten) console.log(`  - ${path.relative(REPO_ROOT, f)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // --json means "stdout is machine-readable JSON, nothing else" — every
  // other console.log below this point in main() is skipped under --json,
  // matching every sibling script's own --json convention.
  if (!opts.json) {
    console.log('=== auto-publish-article.js ===');
    if (opts.dryRun) console.log('(--dry-run: no files will be written, no git commands will run)');
  }

  const writer = opts.writerFixtureDir
    ? (promptObj, wOpts) => fixtureWriter(promptObj, { fixtureDir: opts.writerFixtureDir, topic: wOpts.topic, attempt: wOpts.attempt })
    : openAIWriter;
  const reviewer = opts.reviewerFixtureDir
    ? (promptObj, rOpts) => fixtureReviewerByTopic(promptObj, { fixtureDir: opts.reviewerFixtureDir, topic: rOpts.topic, attempt: rOpts.attempt })
    : openAIReviewer;
  const seoWriter = opts.seoFixtureDir
    ? (promptObj, sOpts) => fixtureSeoWriter(promptObj, { fixtureDir: opts.seoFixtureDir, topic: sOpts.topic })
    : openAISeoWriter;
  const translator = opts.stubTranslate ? stubMarkerTranslator : openAIBatchTranslator;
  const extract = opts.extractFixtureDir
    ? (promptObj, eOpts) => fixtureExtractor(promptObj, { fixtureDir: opts.extractFixtureDir, slug: eOpts.slug })
    : openAIExtractor;
  const judge = opts.judgeFixtureDir
    ? (promptObj, jOpts) => fixtureJudge(promptObj, { fixturePath: path.join(opts.judgeFixtureDir, `${jOpts.slug}.json`) })
    : openAIJudge;

  const result = await runPipeline({
    ...opts,
    writer, writerOpts: { model: opts.writerModel || undefined },
    reviewer, reviewerOpts: { model: opts.reviewerModel || undefined },
    seoWriter, seoWriterOpts: { model: opts.seoModel || undefined },
    translator, translatorOpts: { model: opts.translateModel || undefined },
    extract, judge,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    switch (result.status) {
      case 'not-due':
        console.log(`\nNot due yet — last published ${result.cadence.lastPublishedAt} (${result.cadence.daysSince}d ago, target was ${result.cadence.targetDays}d). Exiting 0 (no-op).`);
        break;
      case 'no-topic':
        console.log(`\nNo topic selected: ${result.reason}`);
        break;
      case 'slug-collision':
      case 'duplicate-risk-high':
      case 'coverage-review-failed':
      case 'coverage-gap':
      case 'translation-failed':
      case 'graph-extraction-failed':
        console.log(`\nABORTED (${result.status}): ${result.reason}`);
        break;
      case 'ok':
        printReport(result);
        break;
      default:
        console.log(`\nUnexpected status: ${result.status}`);
    }
  }

  if (result.status === 'ok' && !result.dryRun) {
    try {
      const gitResult = gitPublish(result, opts);
      if (!opts.json) {
        console.log(gitResult.pushed ? `\nDraft PR opened: ${gitResult.branchName} -> ${gitResult.baseBranch}` : `\nLocal commit only (--no-push): ${gitResult.branchName}`);
      }
    } catch (err) {
      console.error(`\ngit/PR step failed: ${err.message}`);
      process.exitCode = 1;
    }
  }

  process.exitCode = process.exitCode ?? (result.status === 'ok' || result.status === 'not-due' ? 0 : 1);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}
