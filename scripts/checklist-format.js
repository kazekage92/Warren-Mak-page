/**
 * Shared checklist line-formatting helper — factored out because
 * coverage-reviewer.js's formatChecklist() and generate-article.js's
 * formatChecklistForWriter() were byte-identical except for their
 * empty-checklist message. Both keep their own distinct empty-checklist
 * string and call this for the non-empty case.
 *
 * admin/index.html can't import this (no build step, no imports from this
 * dev-only scripts/ directory per root CLAUDE.md) — it carries its own
 * formatChecklistItemsBrowser() mirror instead, called by both
 * kcFormatChecklist and formatChecklistForWriterBrowser. Search
 * admin/index.html for "mirrors scripts/checklist-format.js" to find it.
 */
export function formatChecklistItems(checklist) {
  return checklist
    .map((c) => `- "${c.name}"${c.type ? ` (${c.type})` : ''}${c.why ? ` — ${c.why}` : ''}`)
    .join('\n');
}
