#!/usr/bin/env node
/**
 * Non-interactive chart generation — extra-md-files/automated-article-
 * scheduler.md component 2 ("Chart auto-generation").
 *
 * `buildFlowGraphHtml()` previously only existed inside admin/index.html as
 * browser JS, driven by a human typing step labels into the New Article
 * wizard's graph panel. This module is its Node counterpart, producing the
 * identical `.graph-*` markup (same `<!-- graph block: hand-authored, do not
 * edit via admin WYSIWYG -->` comment convention as the existing 12 articles
 * and the wizard) so an unattended pipeline can generate the same chart a
 * human would have typed by hand.
 *
 * MVP scope matches extra-md-files/done/admin-graph-insertion.md's own
 * precedent: Flow (Steps) only, not all 7 catalog types (fast-follow, not
 * built here).
 *
 * `buildFlowGraphHtml()` is a hand-kept mirror of admin/index.html's
 * function of the same name — search admin/index.html for "mirrors
 * scripts/graph-blocks.js" to find it, and keep the two in sync if either
 * changes. validate-admin-mirror-sync.js checks the two produce identical
 * output automatically (5th pair).
 *
 * `insertGraphIntoBody()` has no admin equivalent — the wizard only ever
 * supports a human clicking "insert at cursor" into a live Quill instance,
 * there is no non-interactive equivalent to mirror. It uses a simple,
 * explicitly not-layout-aware heuristic (see its own doc comment) matching
 * how casually the wizard's own placement already behaves.
 *
 * Usage:
 *   node graph-blocks.js --title "How to Manage Structured Warrant Risks" \
 *     --step "Set stop-losses" --step "Size the position" --step "Check IV" --json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { nextArg } from './cli-args.js';

export const MIN_GRAPH_STEPS = 2;
export const MAX_GRAPH_STEPS = 5;

// ---------------------------------------------------------------------------
// Shared HTML-escaping helper — mirrors admin/index.html's escapeHtml()
// (a dependency buildFlowGraphHtml calls; extracted alongside it by
// validate-admin-mirror-sync.js so the sandboxed mirror can resolve the call).
// ---------------------------------------------------------------------------

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Flow (Steps) chart — mirrors admin/index.html's buildFlowGraphHtml()
// ---------------------------------------------------------------------------

/**
 * @param {string} title
 * @param {string[]} steps
 * @returns {string} the `.graph-block--flow` figure markup, verbatim-matching
 *   what a human would produce via the wizard's "Insert Graph" button.
 */
export function buildFlowGraphHtml(title, steps) {
  const stepsHtml = steps.map((s) => '<li class="graph-flow__step">' + escapeHtml(s) + '</li>').join('');
  return (
    '<!-- graph block: hand-authored, do not edit via admin WYSIWYG -->' +
    '<figure class="graph-block graph-block--flow"><figcaption class="graph-block__title">' +
    escapeHtml(title) +
    '</figcaption>' +
    '<ol class="graph-flow graph-flow--steps">' +
    stepsHtml +
    '</ol></figure>'
  );
}

/** Same 2-5 non-empty-label rule the wizard's insertGraphAtCursor() enforces
 *  before it ever calls buildFlowGraphHtml — not part of that function's own
 *  mirror (it has no validation of its own), so kept as a separate exported
 *  helper the orchestrator calls first. Throws rather than returning a
 *  boolean, matching every other "reject a malformed shape" helper in this
 *  directory (parseWriterResponse, parseSeoResponse, ...). */
export function validateGraphSteps(steps) {
  if (
    !Array.isArray(steps) ||
    steps.length < MIN_GRAPH_STEPS ||
    steps.length > MAX_GRAPH_STEPS ||
    !steps.every((s) => typeof s === 'string' && s.trim())
  ) {
    throw new Error(
      `A Flow graph needs ${MIN_GRAPH_STEPS}-${MAX_GRAPH_STEPS} non-empty step labels, got: ${JSON.stringify(steps)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Placement — no admin mirror obligation (see header comment)
// ---------------------------------------------------------------------------

/** Sum of the plain-text length of every top-level node cheerio parsed from
 *  a body-HTML fragment — text nodes contribute their own text, element
 *  nodes their full descendant text (`.text()`), matching how a reader would
 *  perceive "how far into the article" a given node sits. */
function topLevelTextLength(node, $) {
  return node.type === 'text' ? (node.data ?? '').length : $(node).text().length;
}

/**
 * Inserts `graphHtml` into `bodyHtml` roughly mid-article: right after the
 * first `<h2>` boundary whose start position is at or past the midpoint of
 * the body's own plain-text length — extra-md-files/automated-article-
 * scheduler.md component 2's own stated heuristic ("simple, not layout-
 * aware, matching how casually the wizard's 'insert at cursor' already
 * behaves — a human just picks a spot").
 *
 * Assumes `bodyHtml` is a flat sequence of top-level block elements
 * (`<p>`/`<h2>`/`<h3>`/`<figure>`/`<ul>`/...), which is exactly the shape
 * build-article-document.js's bodyTextToHtml() produces and every existing
 * hand-authored article already uses — it does not search inside nested
 * containers for a heading.
 *
 * Falls back to the LAST `<h2>` in the body if none starts at or past the
 * midpoint (a long final section), and to appending at the very end if the
 * body has no `<h2>` at all or no measurable text (e.g. an empty body).
 *
 * @param {string} bodyHtml
 * @param {string} graphHtml - typically buildFlowGraphHtml()'s own output
 * @returns {string}
 */
export function insertGraphIntoBody(bodyHtml, graphHtml) {
  const $ = cheerio.load(bodyHtml, null, false);
  const topLevel = $.root().contents().toArray();

  const totalTextLength = topLevel.reduce((sum, node) => sum + topLevelTextLength(node, $), 0);
  if (!totalTextLength) return bodyHtml + graphHtml;

  const h2Nodes = topLevel.filter((node) => node.type === 'tag' && node.name === 'h2');
  if (!h2Nodes.length) return bodyHtml + graphHtml;

  const midpoint = totalTextLength / 2;
  let targetH2 = h2Nodes[h2Nodes.length - 1]; // fallback: last h2, if none starts past the midpoint
  let cumulative = 0;
  for (const node of topLevel) {
    if (node.type === 'tag' && node.name === 'h2' && cumulative >= midpoint) {
      targetH2 = node;
      break;
    }
    cumulative += topLevelTextLength(node, $);
  }

  $(targetH2).after(graphHtml);
  return $.root().html();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { title: null, steps: [], bodyFile: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--title':
        opts.title = nextArg(argv, ++i, '--title');
        break;
      case '--step':
        opts.steps.push(nextArg(argv, ++i, '--step'));
        break;
      case '--body-file':
        opts.bodyFile = path.resolve(nextArg(argv, ++i, '--body-file'));
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!opts.title) throw new Error('--title is required');
  validateGraphSteps(opts.steps);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const graphHtml = buildFlowGraphHtml(opts.title, opts.steps);

  if (opts.bodyFile) {
    const { readFileSync } = await import('node:fs');
    const bodyHtml = readFileSync(opts.bodyFile, 'utf-8');
    const merged = insertGraphIntoBody(bodyHtml, graphHtml);
    if (opts.json) console.log(JSON.stringify({ title: opts.title, steps: opts.steps, graphHtml, bodyHtml: merged }, null, 2));
    else console.log(merged);
    return;
  }

  if (opts.json) console.log(JSON.stringify({ title: opts.title, steps: opts.steps, graphHtml }, null, 2));
  else console.log(graphHtml);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
