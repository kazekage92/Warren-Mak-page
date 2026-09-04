#!/usr/bin/env node
/**
 * Non-interactive article page assembly — extra-md-files/automated-article-
 * scheduler.md component 4 ("Document assembly").
 *
 * `buildArticleDocument()` (the full-page template: head/nav/footer/JSON-LD/
 * `.course-hero`/`.article-body`/`.author-box`/`.sticky-cta-bar`) previously
 * only existed inside admin/index.html, browser-only, and needs a real Quill
 * editor instance/DOM to run. This module is its Node counterpart, producing
 * byte-identical structure from plain data in (slug, EN/ZH title/subtitle/
 * body-html/summary, SEO fields, category, dates) — no featured image
 * required, same as the admin wizard's own `computeValidation()` (an 8-item
 * checklist that already treats the featured image as optional).
 *
 * `buildArticleDocument(state)` is a hand-kept mirror of admin/index.html's
 * function of the same name — search admin/index.html for "mirrors
 * scripts/build-article-document.js" to find it, and keep the two in sync if
 * either changes. validate-admin-mirror-sync.js checks the two produce
 * identical output automatically (6th pair). One deliberate simplification
 * versus the admin version: admin's buildArticleDocument() takes
 * state.bodyEnHtml/state.bodyZhHtml still carrying [[GRAPH:id]] placeholders
 * (Quill inserts those; buildArticleDocument substitutes them via the
 * module-scoped naGraphBlocks the wizard's UI maintains) — this pipeline has
 * no Quill/human step, so bodyTextToHtml() + graph-blocks.js's
 * insertGraphIntoBody() already produce FINAL body HTML upstream, and this
 * function's state.bodyEnHtml/bodyZhHtml are expected to be final too (no
 * placeholder substitution happens here). The validator's fixtures account
 * for this by exercising the admin side with an empty graph-blocks list,
 * where its substitution step is a documented no-op either way.
 *
 * `bodyTextToHtml()` has no admin mirror obligation — admin's closest
 * equivalent, plainTextWithAnchorsToParagraphHtml() (search admin/index.html
 * for it), does NOT convert "## "-prefixed section-heading lines into real
 * `<h2>` markup (a pre-existing gap left over from wiring up generate-
 * article.js's suggestedGraphSteps/"## " prompt change — see that function's
 * own comment). This is a genuine functional difference, not drift to chase:
 * this pipeline has no human editor to notice a stray "## " sitting in a
 * published paragraph, so bodyTextToHtml() implements the heading conversion
 * correctly rather than reproducing the gap.
 *
 * Usage:
 *   node build-article-document.js --state-file state.json > articles/slug.html
 *   node build-article-document.js --state-file state.json --json   # {html, bodyEnHtml, bodyZhHtml}
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextArg } from './cli-args.js';

// ---------------------------------------------------------------------------
// Small helpers — verbatim mirrors of admin/index.html's "NEW ARTICLE: SMALL
// HELPERS" section. Not independently registered with validate-admin-mirror-
// sync.js (they're dependencies of buildArticleDocument, extracted alongside
// it the same way graph-blocks.js's escapeHtml is extracted alongside
// buildFlowGraphHtml) rather than pairs in their own right.
// ---------------------------------------------------------------------------

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Defensive: JSON-LD is embedded in a script[type="application/ld+json"] block,
// so any "<" in a text field (e.g. a title containing a closing script tag)
// must not be able to close that tag early.
export function jsonLdScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function truncateWords(str, n) {
  const words = String(str || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ') + '…';
}

export function truncateChars(str, n) {
  str = String(str || '').trim();
  return str.length <= n ? str : str.slice(0, n) + '…';
}

export function formatMonthYear(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return months[d.getMonth()] + ' ' + d.getFullYear();
}

export function formatMonthYearZh(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
}

export function readingTimeTextZh(readingTimeText) {
  const digits = String(readingTimeText || '').replace(/[^0-9]/g, '') || '5';
  return '阅读时间：' + digits + '分钟';
}

// Not an admin mirror -- the wizard computes this client-side off a live
// Quill instance's word/char count (recalcReadingTime(), DOM-driven). Same
// formula (200 wpm EN / 300 cpm ZH, minimum 1 minute, "N min read" text),
// reimplemented here so an unattended caller can derive readingTimeText from
// plain body text instead of needing a browser.
export function computeReadingTimeText({ bodyTextEn, bodyTextZh }) {
  let minutes;
  const enText = (bodyTextEn || '').trim();
  if (enText) {
    const words = enText.split(/\s+/).filter(Boolean).length;
    minutes = Math.max(1, Math.round(words / 200));
  } else {
    const chars = (bodyTextZh || '').replace(/\s+/g, '').length;
    minutes = Math.max(1, Math.round(chars / 300));
  }
  return minutes + ' min read';
}

// ---------------------------------------------------------------------------
// Static page chrome — verbatim copies of admin/index.html's NAV_HTML/
// FOOTER_HTML/CTA_PRESETS module-scoped constants (dependencies of
// buildArticleDocument, extracted alongside it for the mirror check the same
// way KG_ENTITY_TYPES/KG_RELATIONS are extracted alongside
// kgBuildExtractionPrompt above).
// ---------------------------------------------------------------------------

export const NAV_HTML = [
  '  <!-- Navigation -->',
  '  <nav class="navbar">',
  '    <div class="container">',
  '      <a href="../" class="navbar__logo"><img src="../assets/images/logo/favicon.png" alt="Warren Mak" width="84" height="46"> Warren <span>Mak</span></a>',
  '      <ul class="navbar__menu" id="navMenu">',
  '        <li class="navbar__dropdown">',
  '          <button type="button" class="navbar__dropdown-trigger" aria-haspopup="true" aria-expanded="false">',
  '            <span data-lang="en">About</span><span data-lang="zh" style="display:none;">关于</span>',
  '            <span class="navbar__dropdown-caret" aria-hidden="true"></span>',
  '          </button>',
  '          <ul class="navbar__dropdown-menu">',
  '            <li><a href="../about.html"><span data-lang="en">Warren Mak</span><span data-lang="zh" style="display:none;">Warren Mak</span></a></li>',
  '            <li><a href="../ted-optimus.html"><span data-lang="en">TED Optimus</span><span data-lang="zh" style="display:none;">TED Optimus</span></a></li>',
  '            <li><a href="../media.html"><span data-lang="en">Media</span><span data-lang="zh" style="display:none;">媒体报道</span></a></li>',
  '          </ul>',
  '        </li>',
  '        <li class="navbar__dropdown">',
  '          <button type="button" class="navbar__dropdown-trigger" aria-haspopup="true" aria-expanded="false">',
  '            <span data-lang="en">Courses</span><span data-lang="zh" style="display:none;">课程</span>',
  '            <span class="navbar__dropdown-caret" aria-hidden="true"></span>',
  '          </button>',
  '          <ul class="navbar__dropdown-menu">',
  '            <li><a href="../short-term-trading.html"><span data-lang="en">Short-Term Trading</span><span data-lang="zh" style="display:none;">短线交易</span></a></li>',
  '            <li><a href="../structured-warrants.html"><span data-lang="en">Structured Warrants</span><span data-lang="zh" style="display:none;">结构性凭单</span></a></li>',
  '          </ul>',
  '        </li>',
  '        <li class="navbar__dropdown">',
  '          <button type="button" class="navbar__dropdown-trigger active" aria-haspopup="true" aria-expanded="false">',
  '            <span data-lang="en">Learn</span><span data-lang="zh" style="display:none;">学习资源</span>',
  '            <span class="navbar__dropdown-caret" aria-hidden="true"></span>',
  '          </button>',
  '          <ul class="navbar__dropdown-menu">',
  '            <li><a href="../articles.html" class="active"><span data-lang="en">Articles</span><span data-lang="zh" style="display:none;">文章</span></a></li>',
  '            <li><a href="../testimonials.html"><span data-lang="en">Testimonials</span><span data-lang="zh" style="display:none;">学员评价</span></a></li>',
  '          </ul>',
  '        </li>',
  '        <li><a href="https://www.thetradewizard.com/" target="_blank" class="navbar__cta navbar__cta--tool">Trade Wizard</a></li>',
  '        <li><a href="https://academy.thetradewizard.com/" target="_blank" class="navbar__cta"><span data-lang="en">Free Webinar</span><span data-lang="zh" style="display:none;">免费网络研讨会</span></a></li>',
  '      </ul>',
  '      <div class="navbar__actions">',
  '        <button class="lang-toggle" id="langToggle" title="Switch to Chinese">中文</button>',
  '        <button class="navbar__toggle" id="navToggle" aria-label="Toggle navigation">&#9776;</button>',
  '      </div>',
  '    </div>',
  '  </nav>',
].join('\n');

export const FOOTER_HTML = [
  '  <!-- Footer -->',
  '  <footer class="footer">',
  '    <div class="container">',
  '      <div class="footer__grid">',
  '        <div class="footer__brand">',
  '          <div class="footer__logo"><img src="../assets/images/logo/logo.png" alt="Warren Mak"></div>',
  '          <h3>Warren Mak (麦传球)</h3>',
  "          <p><span data-lang=\"en\">Malaysia's #1 Structured Warrants &amp; Short-Term Trading Coach.</span><span data-lang=\"zh\" style=\"display:none;\">马来西亚第一结构性凭单与短线交易教练。</span></p>",
  '          <p class="mt-16" style="font-size:0.85rem;">Email: warrenmak@tedoptimus.com</p>',
  '        </div>',
  '        <div>',
  '          <h4><span data-lang="en">Pages</span><span data-lang="zh" style="display:none;">页面</span></h4>',
  '          <ul class="footer__links">',
  '            <li><a href="../"><span data-lang="en">Home</span><span data-lang="zh" style="display:none;">首页</span></a></li>',
  '            <li><a href="../about.html"><span data-lang="en">About Warren</span><span data-lang="zh" style="display:none;">关于Warren</span></a></li>',
  '            <li><a href="../articles.html"><span data-lang="en">Articles</span><span data-lang="zh" style="display:none;">文章</span></a></li>',
  '            <li><a href="../testimonials.html"><span data-lang="en">Testimonials</span><span data-lang="zh" style="display:none;">学员评价</span></a></li>',
  '          </ul>',
  '        </div>',
  '        <div>',
  '          <h4><span data-lang="en">Programmes</span><span data-lang="zh" style="display:none;">课程</span></h4>',
  '          <ul class="footer__links">',
  '            <li><a href="../short-term-trading.html"><span data-lang="en">Short-Term Trading</span><span data-lang="zh" style="display:none;">短线交易</span></a></li>',
  '            <li><a href="../structured-warrants.html"><span data-lang="en">Structured Warrants</span><span data-lang="zh" style="display:none;">结构性凭单</span></a></li>',
  '            <li><a href="https://academy.thetradewizard.com/" target="_blank">Trade Wizard Academy</a></li>',
  '            <li><a href="https://www.thetradewizard.com/" target="_blank">Trade Wizard Platform</a></li>',
  '          </ul>',
  '        </div>',
  '        <div>',
  '          <h4><span data-lang="en">Connect</span><span data-lang="zh" style="display:none;">联系我们</span></h4>',
  '          <ul class="footer__links">',
  '            <li><a href="https://t.me/tradewizardglobal" target="_blank">Telegram</a></li>',
  '            <li><a href="https://www.facebook.com/TradeWizardGlobal" target="_blank">Facebook</a></li>',
  '            <li><a href="https://www.youtube.com/@TradeWizardGlobal" target="_blank">YouTube</a></li>',
  '            <li><a href="https://www.linkedin.com/company/ted-optimus/" target="_blank">LinkedIn</a></li>',
  '          </ul>',
  '        </div>',
  '      </div>',
  '      <div class="footer__bottom">',
  '        <p>© 2026 TED Optimus Sdn Bhd. <span data-lang="en">All rights reserved.</span><span data-lang="zh" style="display:none;">版权所有。</span></p>',
  '      </div>',
  '    </div>',
  '  </footer>',
].join('\n');

export const CTA_PRESETS = {
  warrants: [
    '  <section class="cta-section">',
    '    <div class="container">',
    '      <div data-lang="en">',
    '        <h2>Want to Master Structured Warrants?</h2>',
    "        <p>Join Warren Mak's free live webinar and learn to trade structured warrants profitably with 32+ years of real market experience.</p>",
    '        <div class="cta-buttons">',
    '          <a href="https://academy.thetradewizard.com/" target="_blank" class="btn btn--primary btn--lg">Join Free Webinar</a>',
    '          <a href="../structured-warrants.html" class="btn btn--outline">Structured Warrants Course</a>',
    '        </div>',
    '      </div>',
    '      <div data-lang="zh" style="display:none;" aria-hidden="true">',
    '        <h2>想要精通结构性凭单？</h2>',
    '        <p>加入麦传球的免费直播网络研讨会，学习如何凭借32年以上实战市场经验，实现结构性凭单盈利交易。</p>',
    '        <div class="cta-buttons">',
    '          <a href="https://academy.thetradewizard.com/" target="_blank" class="btn btn--primary btn--lg">参加免费网络研讨会</a>',
    '          <a href="../structured-warrants.html" class="btn btn--outline">结构性凭单课程</a>',
    '        </div>',
    '      </div>',
    '    </div>',
    '  </section>',
  ].join('\n'),
  shortterm: [
    '  <section class="cta-section">',
    '    <div class="container">',
    '      <div data-lang="en">',
    '        <h2>Ready to Master Short-Term Trading on Bursa Malaysia?</h2>',
    "        <p>Join Warren Mak's free live webinar and learn the exact strategies that his students use to trade profitably every week.</p>",
    '        <div class="cta-buttons">',
    '          <a href="https://academy.thetradewizard.com/" target="_blank" class="btn btn--primary btn--lg">Join Free Webinar</a>',
    '          <a href="../short-term-trading.html" class="btn btn--outline">View Course Details</a>',
    '        </div>',
    '      </div>',
    '      <div data-lang="zh" style="display:none;" aria-hidden="true">',
    '        <h2>准备在马来西亚交易所掌握短线交易？</h2>',
    '        <p>参加Warren Mak的免费直播网络研讨会，学习他的学员每周用于盈利交易的精确策略。</p>',
    '        <div class="cta-buttons">',
    '          <a href="https://academy.thetradewizard.com/" target="_blank" class="btn btn--primary btn--lg">参加免费网络研讨会</a>',
    '          <a href="../short-term-trading.html" class="btn btn--outline">查看课程详情</a>',
    '        </div>',
    '      </div>',
    '    </div>',
    '  </section>',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// draft.body_text -> HTML — see header comment for why this is NOT an admin
// mirror. Handles blank-line-separated paragraphs, inline <a href="...">
// links generate-article.js's insertSuggestedLinksBrowser()/
// insertSuggestedLinks() already wove into the text, and "## "-prefixed
// section-heading lines (generate-article.js's SECTION_BREAK_PATTERN).
// ---------------------------------------------------------------------------

// Same anchor shape generate-article.js's link-insertion step produces:
// `<a href="some-slug.html">anchor text</a>`, always a same-site relative
// article link (never target="_blank"/external), matching admin's own
// AI_ANCHOR_RE (search admin/index.html for it). Alongside it, the individual
// open/close tags for the inline emphasis markup generate-article.js's writer
// prompt now allows (`<strong>`/`<em>`/`<u>`) are recognized as their own
// bare tokens rather than whole matched elements -- unlike the anchor, which
// is always self-contained with plain-text content, an emphasis span can end
// up wrapping (or being wrapped by) an anchor §4 Phase 5's
// insertSuggestedLinks() inserted INSIDE it, e.g.
// `<strong><a href="...">Time Decay</a></strong>`. Tokenizing each piece
// (open tag, anchor element, close tag) independently means any combination/
// nesting of the two still passes through untouched instead of being
// HTML-escaped.
const SAFE_INLINE_RE = /<a href="[a-z0-9-]+\.html">[^<]*<\/a>|<\/?(?:strong|em|u)>/gi;
const HEADING_LINE_RE = /^##\s+(.+)$/;

/**
 * @param {string} text - draft.body_text: blank-line-separated paragraphs,
 *   optionally containing inline `<a href="...">...</a>` markup (left
 *   untouched, same as admin's plainTextWithAnchorsToParagraphHtml),
 *   inline `<strong>`/`<em>`/`<u>` emphasis (also left untouched -- Quill
 *   recognizes the same tags natively when admin pastes AI-drafted content,
 *   so this keeps the two paths producing equivalent formatting), and
 *   "## "-prefixed section-heading lines (converted to `<h2>...</h2>`,
 *   escaped like any other text -- headings never carry inline markup).
 * @returns {string}
 */
export function bodyTextToHtml(text) {
  const blocks = (text || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const headingMatch = HEADING_LINE_RE.exec(block);
      if (headingMatch) {
        return '<h2>' + escapeHtml(headingMatch[1].trim()) + '</h2>';
      }

      let lastIndex = 0;
      let out = '';
      let m;
      SAFE_INLINE_RE.lastIndex = 0;
      while ((m = SAFE_INLINE_RE.exec(block))) {
        out += escapeHtml(block.slice(lastIndex, m.index)).replace(/\n/g, '<br>');
        out += m[0]; // the anchor/emphasis tag itself -- already-safe markup, left untouched
        lastIndex = m.index + m[0].length;
      }
      out += escapeHtml(block.slice(lastIndex)).replace(/\n/g, '<br>');
      return '<p>' + out + '</p>';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Full-page assembly — mirrors admin/index.html's buildArticleDocument()
// ---------------------------------------------------------------------------

/**
 * @param {object} state
 * @param {string} state.titleEn
 * @param {string} state.titleZh
 * @param {string} state.subtitleEn
 * @param {string} state.subtitleZh
 * @param {string} state.categoryEn
 * @param {string} state.categoryZh
 * @param {string} state.authorEn - NOT defaulted here (admin's buildArticleDocument()
 *   doesn't default it either -- that happens one layer up, in getFormState()/
 *   assembleFromDraftState() below); pass 'Warren Mak' explicitly if unset.
 * @param {string} state.authorZh - same caveat, default '麦传球 Warren Mak'
 * @param {string} state.publishDate - YYYY-MM-DD
 * @param {string} state.tags - comma-separated keywords
 * @param {'warrants'|'shortterm'} [state.ctaPreset='warrants']
 * @param {string} state.slug
 * @param {string} [state.metaTitle] - falls back to state.titleEn
 * @param {string} state.metaDescription
 * @param {string} state.canonicalUrl
 * @param {string} state.bodyEnHtml - FINAL HTML (see header comment -- no
 *   [[GRAPH:id]] placeholders expected here, unlike admin's own state)
 * @param {string} state.bodyZhHtml - FINAL HTML, same caveat
 * @param {string} state.readingTimeText - e.g. "5 min read" (see
 *   computeReadingTimeText() above)
 * @param {string} state.ogImageUrl
 * @returns {string} the full HTML document, ready to write to articles/<slug>.html
 */
export function buildArticleDocument(state) {
  const bodyEnHtml = state.bodyEnHtml;
  const bodyZhHtml = state.bodyZhHtml;
  const metaTitleFull = state.metaTitle || state.titleEn;
  const pageTitle = metaTitleFull + ' | Warren Mak';
  const breadcrumbEn = truncateWords(state.titleEn, 6);
  const breadcrumbZh = truncateChars(state.titleZh, 12);
  const ctaHtml = CTA_PRESETS[state.ctaPreset] || CTA_PRESETS.warrants;

  const articleLd = jsonLdScript({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: state.titleEn,
    description: state.metaDescription,
    image: state.ogImageUrl,
    author: { '@type': 'Person', name: 'Warren Mak', url: 'https://www.warrenmak.asia/about.html' },
    publisher: { '@type': 'Organization', name: 'TED Optimus Sdn Bhd', logo: { '@type': 'ImageObject', url: 'https://www.warrenmak.asia/assets/images/logo/favicon.png' } },
    datePublished: state.publishDate,
    dateModified: state.publishDate,
    mainEntityOfPage: state.canonicalUrl,
  });

  const breadcrumbLd = jsonLdScript({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.warrenmak.asia/' },
      { '@type': 'ListItem', position: 2, name: 'Articles', item: 'https://www.warrenmak.asia/articles.html' },
      { '@type': 'ListItem', position: 3, name: metaTitleFull },
    ],
  });

  const viewsSpanEn = '<span class="article-views" hidden>👁 <span class="article-views__count">0</span> views</span>';
  const viewsSpanZh = '<span class="article-views" hidden>👁 <span class="article-views__count">0</span> 次浏览</span>';
  const bylineEn = '<div class="article-meta"><span>By <strong><a href="../about.html">' + escapeHtml(state.authorEn) + '</a></strong></span><span>' + escapeHtml(state.readingTimeText) + '</span><span>Published: ' + formatMonthYear(state.publishDate) + '</span>' + viewsSpanEn + '</div>';
  const bylineZh = '<div class="article-meta"><span>作者：<strong><a href="../about.html">' + escapeHtml(state.authorZh) + '</a></strong></span><span>' + readingTimeTextZh(state.readingTimeText) + '</span><span>发布：' + formatMonthYearZh(state.publishDate) + '</span>' + viewsSpanZh + '</div>';

  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head>',
    '  <!-- Google tag (gtag.js) -->',
    '  <script>',
    '    (function(){',
    "      if (location.hostname !== 'www.warrenmak.asia') return;",
    '',
    "      var script = document.createElement('script');",
    '      script.async = true;',
    "      script.src = 'https://www.googletagmanager.com/gtag/js?id=G-9H2NEZCD20';",
    '      document.head.appendChild(script);',
    '',
    '      window.dataLayer = window.dataLayer || [];',
    '      function gtag(){dataLayer.push(arguments);}',
    '      window.gtag = gtag;',
    "      gtag('js', new Date());",
    "      gtag('config', 'G-9H2NEZCD20');",
    '    })();',
    '  </script>',
    '  <meta charset="UTF-8">',
    '  <script>',
    '    /* Anti-flash: for returning zh-preference visitors, hide body until',
    '       main.js applies the stored language (avoids a flash of English before',
    '       the bottom-of-body script runs). No-op for default/English visitors. */',
    '    (function(){',
    '      try {',
    "        if (localStorage.getItem('wm_lang') === 'zh') {",
    "          document.documentElement.setAttribute('data-lang-pending', '1');",
    '          document.write(\'<style id="wm-lang-hide">body{visibility:hidden}</style>\');',
    '        }',
    '      } catch (e) {}',
    '    })();',
    '  </script>',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>' + escapeHtml(pageTitle) + '</title>',
    '  <meta name="description" content="' + escapeAttr(state.metaDescription) + '">',
    '  <meta name="keywords" content="' + escapeAttr(state.tags) + '">',
    '  <link rel="canonical" href="' + state.canonicalUrl + '">',
    '  <link rel="icon" type="image/png" href="../assets/images/logo/favicon-square.png">',
    '  <link rel="apple-touch-icon" href="../assets/images/logo/favicon-square.png">',
    '  <link rel="stylesheet" href="../assets/css/style.css">',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">',
    '  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;display=swap" onload="this.onload=null;this.rel=\'stylesheet\'">',
    '  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;display=swap"></noscript>',
    '',
    '  <meta property="og:title" content="' + escapeAttr(metaTitleFull) + '">',
    '  <meta property="og:description" content="' + escapeAttr(state.metaDescription) + '">',
    '  <meta property="og:type" content="article">',
    '  <meta property="og:url" content="' + state.canonicalUrl + '">',
    '',
    '  <script type="application/ld+json">',
    '  ' + articleLd,
    '  </script>',
    '  <meta property="og:image" content="' + state.ogImageUrl + '">',
    '  <meta property="og:site_name" content="Warren Mak - Trade Wizard">',
    '  <meta property="og:locale" content="en_MY">',
    '  <meta name="twitter:card" content="summary_large_image">',
    '  <meta name="twitter:title" content="' + escapeAttr(metaTitleFull) + '">',
    '  <meta name="twitter:description" content="' + escapeAttr(state.metaDescription) + '">',
    '  <meta name="twitter:image" content="' + state.ogImageUrl + '">',
    '  <link rel="alternate" hreflang="en" href="' + state.canonicalUrl + '">',
    '  <link rel="alternate" hreflang="zh" href="' + state.canonicalUrl + '">',
    '  <link rel="alternate" hreflang="x-default" href="' + state.canonicalUrl + '">',
    '  <script type="application/ld+json">',
    '  ' + breadcrumbLd,
    '  </script>',
    '</head>',
    '<body>',
    '',
    NAV_HTML,
    '',
    '  <!-- Article Hero -->',
    '  <section class="course-hero">',
    '    <div class="container">',
    '      <div data-lang="en"><div class="article-breadcrumb"><a href="../" rel="noopener noreferrer" target="_blank">Home</a> <span>›</span> <a href="../articles.html" rel="noopener noreferrer" target="_blank">Articles</a> <span>›</span> ' + escapeHtml(breadcrumbEn) + '</div><span class="tag">' + escapeHtml(state.categoryEn) + '</span><h1>' + escapeHtml(state.titleEn) + '</h1><p>' + escapeHtml(state.subtitleEn) + '</p></div>',
    '      <div data-lang="zh" style="display:none;" aria-hidden="true"><div class="article-breadcrumb"><a href="../" rel="noopener noreferrer" target="_blank">首页</a> <span>›</span> <a href="../articles.html" rel="noopener noreferrer" target="_blank">文章</a> <span>›</span> ' + escapeHtml(breadcrumbZh) + '</div><span class="tag">' + escapeHtml(state.categoryZh) + '</span><h2>' + escapeHtml(state.titleZh) + '</h2><p>' + escapeHtml(state.subtitleZh) + '</p></div>',
    '    </div>',
    '  </section>',
    '',
    '  <!-- Article Content -->',
    '  <section class="section">',
    '    <div class="container">',
    '      <div class="article-body">',
    '',
    '        <div data-lang="en">' + bylineEn + bodyEnHtml + '</div>',
    '',
    '        <div data-lang="zh" style="display:none;" aria-hidden="true">' + bylineZh + bodyZhHtml + '</div>',
    '',
    '        <!-- Related Articles -->',
    '        <div class="article-related">',
    '          <h3><span data-lang="en">Continue Learning</span><span data-lang="zh" style="display:none;">继续学习</span></h3>',
    '          <ul>',
    '            <li><a href="../articles.html"><span data-lang="en">&larr; Back to All Articles</span><span data-lang="zh" style="display:none;">&larr; 返回所有文章</span></a></li>',
    '          </ul>',
    '        </div>',
    '',
    '        <!-- Author Credibility Box -->',
    '        <div class="author-box">',
    '          <picture>',
    '            <source srcset="../assets/images/warren-mak-profile.webp" type="image/webp">',
    '            <img src="../assets/images/warren-mak-profile.jpg" alt="Warren Mak" class="author-box__photo" loading="lazy" width="72" height="72">',
    '          </picture>',
    '          <div class="author-box__body">',
    '            <div data-lang="en">',
    '              <div class="author-box__name">Warren Mak (麦传球)</div>',
    '              <div class="author-box__title">Former Head of Investor Education &amp; 4 Departments, Bursa Malaysia &middot; Ex-Structured Products Trader, OCBC Bank</div>',
    '              <ul class="author-box__credentials">',
    '                <li>30+ years in securities &amp; derivatives markets</li>',
    '                <li>15 years at Bursa Malaysia, headed 5 departments</li>',
    '                <li>Weekly columnist, Nanyang Siang Pau, since 2018</li>',
    '                <li>Featured in The Edge Malaysia, BFM 89.9, TEDx</li>',
    '              </ul>',
    '              <div class="author-box__links">',
    '                <a href="../about.html">Full Bio &amp; Credentials &rarr;</a>',
    '                <a href="https://academy.thetradewizard.com/" target="_blank">Join Free Webinar &rarr;</a>',
    '              </div>',
    '            </div>',
    '            <div data-lang="zh" style="display:none;">',
    '              <div class="author-box__name">麦传球 Warren Mak</div>',
    '              <div class="author-box__title">前马来西亚交易所投资教育及4个部门主管 &middot; 前华侨银行（OCBC）结构性产品交易员</div>',
    '              <ul class="author-box__credentials">',
    '                <li>30多年证券与衍生品市场经验</li>',
    '                <li>在Bursa Malaysia任职15年，领导5个部门</li>',
    '                <li>自2018年起南洋商报每周专栏作家</li>',
    '                <li>曾受The Edge Malaysia、BFM 89.9、TEDx专访</li>',
    '              </ul>',
    '              <div class="author-box__links">',
    '                <a href="../about.html">查看完整简历 &rarr;</a>',
    '                <a href="https://academy.thetradewizard.com/" target="_blank">参加免费网络研讨会 &rarr;</a>',
    '              </div>',
    '            </div>',
    '          </div>',
    '        </div>',
    '',
    '      </div>',
    '    </div>',
    '  </section>',
    '',
    ctaHtml,
    '',
    FOOTER_HTML,
    '',
    '  <div class="sticky-cta-bar" aria-label="Primary call to action">',
    '    <a href="https://academy.thetradewizard.com/" target="_blank" class="btn btn--primary"><span data-lang="en">Join Free Webinar</span><span data-lang="zh" style="display:none;">参加免费网络研讨会</span></a>',
    '  </div>',
    '',
    '  <script src="../assets/js/main.js"></script>',
    '',
    '',
    '</body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { stateFile: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--state-file':
        opts.stateFile = path.resolve(nextArg(argv, ++i, '--state-file'));
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.stateFile) throw new Error('--state-file is required');
  return opts;
}

/**
 * Convenience entry point: reads a JSON state file whose bodyEnHtml/
 * bodyZhHtml are RAW body_text (not yet HTML) plus everything
 * buildArticleDocument() needs, runs bodyTextToHtml() on both bodies, fills
 * in readingTimeText via computeReadingTimeText() if not already set, and
 * returns the assembled document. The CLI's --state-file is expected in this
 * "raw body_text" shape; callers that already have final HTML (e.g. after
 * graph-blocks.js's insertGraphIntoBody() has run) should call
 * buildArticleDocument() directly instead.
 */
export function assembleFromDraftState(rawState) {
  const bodyEnHtml = bodyTextToHtml(rawState.bodyTextEn);
  const bodyZhHtml = bodyTextToHtml(rawState.bodyTextZh);
  const readingTimeText = rawState.readingTimeText || computeReadingTimeText({ bodyTextEn: rawState.bodyTextEn, bodyTextZh: rawState.bodyTextZh });
  // Same default-author fallback admin's getFormState() applies before ever calling
  // buildArticleDocument() -- buildArticleDocument() itself intentionally does not default these.
  const authorEn = rawState.authorEn || 'Warren Mak';
  const authorZh = rawState.authorZh || '麦传球 Warren Mak';
  const html = buildArticleDocument({ ...rawState, bodyEnHtml, bodyZhHtml, readingTimeText, authorEn, authorZh });
  return { html, bodyEnHtml, bodyZhHtml };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawState = JSON.parse(readFileSync(opts.stateFile, 'utf-8'));
  const result = assembleFromDraftState(rawState);

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.html);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
