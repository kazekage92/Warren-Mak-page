# scripts/

Dev-only Node tooling. Not part of the deployed static site (no build step runs
this — see root `CLAUDE.md`). Requires Node 22.5+ (uses the built-in
`node:sqlite` module, still experimental as of Node 22 — hence `--no-warnings`
in the npm script).

## cli-args.js

Shared one-function CLI-arg helper: `nextArg(argv, i, flagName)`. Every script below hand-rolls its
own `parseArgs(argv)` loop reading a flag's value with the pre-increment idiom `argv[++i]`, which
silently evaluates to `undefined` when the flag is the last argv element (e.g. a trailing `--slug`
with nothing after it) — that `undefined` then flows into `path.resolve()`/`Number()`/`opts.*`
uncaught until something far downstream breaks confusingly. `nextArg` wraps that same read with an
immediate, clearly-worded error naming the offending flag. Used by every script here that has a CLI
(`extract-entities.js`, `fact-retention-checker.js`, `generate-article.js`, `seo-optimizer.js`,
`import-source-articles.js`, `encrypt-secret.js`; `coverage-reviewer.js` has no CLI of its own). No
tests of its own — it's exercised indirectly by every `validate-*.js` harness that hits a script's CLI
argument parsing.

## openai-client.js

Shared `callOpenAIChat()` — one implementation of the `chat/completions` fetch call every LLM-backed
script below (`extract-entities.js`, `fact-retention-checker.js`, `generate-article.js`,
`coverage-reviewer.js`, `seo-optimizer.js`) used to reimplement individually as a near-identical
single-attempt `fetch()` block. Centralizes: retry-with-backoff (2-3 attempts by default) on network
errors, HTTP 429 (honoring a numeric `Retry-After` header), and 5xx — never retrying other 4xx, since
those fail the same way every time; a `finish_reason !== 'stop'` check that raises a clear "response
truncated, consider raising max_tokens or reducing batch size" error instead of a bare `JSON.parse`
failure three lines later; and a named error when `data.choices?.[0]?.message?.content` is missing,
instead of a raw "Cannot read properties of undefined". Each caller still owns its own model choice,
prompt, temperature, and `maxTokens` sizing (no baked-in default — the right size genuinely differs
per use case, see each script's own `MAX_TOKENS` constant).

All five scripts above call this helper now (migrated 2026-08-11) — none has its own inline `fetch()`
block anymore. Each script's `MAX_TOKENS` constant reflects its call shape: `generate-article.js`'s
writer is the largest single-call budget (a full article body); `extract-entities.js` scales its budget
by article count (`MAX_TOKENS_PER_ARTICLE * articleCount`, capped) since `--batch-size > 1` sends several
articles in one call; `seo-optimizer.js` sits in between (structured metadata, not a full article); and
`fact-retention-checker.js`/`coverage-reviewer.js` — pure judgment calls, one short verdict per checklist
item — carry the smallest budgets.

## extract-articles.js

The non-LLM half of the knowledge-graph extraction pipeline described in
`extra-md-files/ai-article-pipeline.md` (§2 Steps 1-3). Parses every
`articles/*.html`, strips boilerplate (nav/footer/CTA/JSON-LD) and the
decorative `.graph-*` diagram blocks, and upserts the real title/summary/
English body_text/dates into the `articles` table of
`admin/knowledge-graph.db` (idempotent — safe to re-run after every article
edit or publish). Also regenerates `admin/knowledge-graph.json`, the
human/LLM-readable mirror of that db, per its own stated contract.

It deliberately stops there: `entities`, `article_entities`, and `edges`
(plus the `links` table, grouped with them as the doc's Step 5) are left
untouched — that half needs an LLM call and isn't built yet. Internal links
this script finds are still surfaced (console summary, `--json-out`) so that
next pass doesn't have to re-parse the HTML.

```bash
cd scripts
npm install
npm run extract              # writes admin/knowledge-graph.db + admin/knowledge-graph.json

node extract-articles.js --dry-run                              # parse + print only, no writes
node extract-articles.js --json-out output/extracted-articles.json  # also dump raw records
node extract-articles.js --db ../admin/knowledge-graph.db        # (default shown)
```

Run it again any time `articles/*.html` changes — re-running is safe (upsert
keyed on `slug`, article ids stay stable so it never disturbs rows in
`entities`/`article_entities`/`edges`/`links` that reference them).

## extract-entities.js

The LLM half `extract-articles.js` deliberately stops short of (§2 Steps 4-5),
covering build-order steps 3 and 4: "Batch extraction script" and "Raise
batch size / parallelism > 2." For every article already in the `articles`
table (populate that first with `extract-articles.js`), calls the LLM to
extract entities + relations from English `body_text`, upserts them into
`entities`/`article_entities`/`edges` (entity rows are matched
case-insensitively and reused across articles — never duplicated; existing
entity names are fed back into the prompt so the LLM prefers reusing them
over minting a near-duplicate), then runs `fact-retention-checker.js` on each
article's before/after state right after it's written.

Two modes, via `--batch-size` (default `1`):

- **`--batch-size 1` (default):** ONE article per LLM call, run
  **sequentially** — build-order step 3's original scope. Checker runs
  immediately after each write, before the next article starts.
- **`--batch-size N` (N > 1):** build-order step 4, implemented as
  **multi-article batching, not concurrency** — up to N articles are sent in
  ONE LLM call, and the prompt explicitly instructs the model to keep entity
  naming consistent *across* the articles in that one response. This is the
  design chosen over running several single-article calls concurrently:
  concurrent calls would each hold a stale snapshot of "existing entity
  names" relative to sibling in-flight calls, recreating the exact dedup race
  this section originally flagged as unsafe to bolt on casually (an in-flight
  call has no way to know a sibling call just minted a differently-worded
  name for the same concept). Batches still run one after another — never two
  LLM calls in flight at once — and each article within a batch is written
  and checked individually, same as single-article mode; only the extraction
  call itself is now shared across several articles at a time.

```bash
cd scripts
OPENAI_API_KEY=sk-... node extract-entities.js               # all articles, sequential
node extract-entities.js --slug <slug>                       # one article only
node extract-entities.js --batch-size 5                      # up to 5 articles per LLM call
node extract-entities.js --dry-run                           # extract + print, no db write, no checker
node extract-entities.js --stop-on-regression                # halt the whole run at the first dropped/altered item
node extract-entities.js --skip-checker                      # write without the retention gate (unsafe — testing only)

node extract-entities.js --extract-fixture-dir DIR --judge-fixture-dir DIR   # fully offline, see below
```

Per-article outcome is one of `ok` (checker found no regressions),
`regression` (checker found `dropped`/`altered` items — logged, run continues
to the next article/batch by default), `written-unchecked` (only with
`--skip-checker`), `dry-run`, or `error` (extraction/parsing/write threw).
In single-article mode a failure is isolated to that one article; in batch
mode, a failure *extracting or parsing* the shared response fails every
article in that batch together (there is only one LLM call to blame — see
"Validating without an API key" below), while a failure *writing* one
article's already-parsed result is still isolated to that article. Exits
non-zero if any article ended `regression` or `error`.

Both the extractor and the checker's judge are dependency-injected (same
pattern as `fact-retention-checker.js`), via `--extract-fixture-dir`/
`--judge-fixture-dir` on the CLI. In single-article mode each expects one
`<slug>.json` file per article; in batch mode, the extractor fixture is keyed
by the whole batch instead — one `<slug1>+<slug2>+....json` file (slugs
joined with `+`, in the order that batch's articles were queried in) — while
the judge fixture stays per-slug either way, since the checker always
compares one article's before/after state regardless of how it was written.

### Validating without an API key

`validate-extract-entities.js` covers `--batch-size 1` (the default):
hand-authors extractor + checker fixtures for two real articles that already
share entities in the hand-authored sample (`Put Warrant`,
`Structured Warrants`) and runs the real pipeline against them, both by
calling `processArticle()` directly and by shelling out to the actual CLI:

```bash
node validate-extract-entities.js
```

It asserts: a harmless rename (`Company Warrants` -> `Structured Product
Warrants`) reads as `retained`, not `dropped`; a fact the extractor fixture
simply omits (`Risk Management`) reads as `dropped` AND is actually missing
from the written db afterward; shared entity names collapse to one row
across both articles instead of duplicating; the default CLI run continues
past a regression and still exits non-zero; and `--stop-on-regression` halts
before the next article ever runs. No `OPENAI_API_KEY`/network needed — see
`fact-retention-checker.js`'s own "Validating without an API key" note above
for why this dependency-injection pattern exists.

`validate-extract-entities-batch.js` covers `--batch-size > 1` specifically —
same fixture-injection approach, same two articles, but ONE fixture response
covering both of them at once:

```bash
node validate-extract-entities-batch.js
```

It asserts the behavior specific to batching (not re-tested by the
non-batch harness above): an entity named identically in both articles'
blocks *within the same batch response* collapses to a single `entities` row
(the actual dedup race build-order step 4 exists to close — proving the
model kept naming consistent across articles in one response, rather than
two separate calls each guessing independently); a per-article regression
inside a batch is still caught and scoped to that one article while its
batch-mate reads `ok`; a malformed batch response missing a requested
article's block fails every article in that batch together, with nothing
written for any of them (not a silent partial write); and the CLI's
`--batch-size 2` run produces exactly one LLM call for two articles.

## fact-retention-checker.js

The LLM-judge from `extra-md-files/ai-article-pipeline.md` §3. Given an
article's OLD and NEW entity/edge state (the induced subgraph over that
article's own entities — `article_entities` plus every `edges` row where both
endpoints belong to the article), asks an LLM to judge, per OLD item, whether
it's `retained` (same fact, possibly reworded), `altered` (relation/meaning
changed), or `dropped` (no equivalent in NEW at all). This is a **semantic**
diff — the point is telling "Time Decay (Theta)" → "Theta Decay" (harmless
rename) apart from an actual loss, which `git diff`/JSON-diff can't do since
the graph itself is opaque SQLite, not version-controlled text.

```bash
cd scripts
OPENAI_API_KEY=sk-... node fact-retention-checker.js \
  --slug <slug> --old-db <path-to-old-snapshot.db> --new-db <path-to-new-snapshot.db>

node fact-retention-checker.js --slug <slug> --old-db <old.db> --new-db <new.db> \
  --judge-fixture <path-to-raw-json-response>   # no network/key needed — see below
```

Exits non-zero if any item comes back `altered` or `dropped`, so this can gate
a batch/incremental extraction run once one exists (§2 build order step 2/3) —
it doesn't need the real extraction pipeline to be useful today; it only needs
two entity/edge snapshots for the same article slug.

The judge is dependency-injected (`checkFactRetention({ judge, judgeOpts })`
in code, `--judge-fixture` on the CLI) specifically so this is testable
without spending API calls or needing a key present.

### Validating without an API key

`validate-fact-retention-checker.js` is §3's own suggested validation: copy
the hand-authored sample `admin/knowledge-graph.db`, hand-edit the copy via
raw SQL to plant a regression on one article, then confirm the checker
catches it.

```bash
node validate-fact-retention-checker.js
```

It plants three cases at once on `structured-warrant-risks-time-decay-malaysia`:
a harmless rename (`Time Decay (Theta)` → `Theta Decay`, must read as
`retained`, not `dropped`), a fully-dropped entity + its edges (`Leverage`,
must read as `dropped`), and one edge whose relation changes
(`related_to` → `contradicts`, must read as `altered`). Same fixture-injection
approach as every other LLM-backed validator here: since the script itself is
the one that planted the regression, it can compute the correct judge
response for every OLD entity/edge in-process (`buildSyntheticFixture()`) and
write it to `scripts/output/fact-retention-fixture.json` (gitignored, kept
only for inspection) — no hand-authored file to produce first, and nothing to
silently skip if one is missing. The script then runs the checker against
that fixture via the same `--judge-fixture` code path the CLI uses
(`fixtureJudge`), and asserts the three planted cases land on the expected
status, exiting non-zero if any assertion fails or the checker throws. Swap
in a real OpenAI call (drop `--judge-fixture`, set `OPENAI_API_KEY`) once the
spend cap from §6/§8 is in place; the prompt and parsing logic don't change
either way.

## retrieval-layer.js

§2 Step 6 of `extra-md-files/ai-article-pipeline.md`: given a candidate topic
and the already-populated `admin/knowledge-graph.db` (run
`extract-articles.js` then `extract-entities.js` first), answers "what does
the graph already know about this topic, and what should a new article do
about it?" as ONE composed query (`buildRetrievalContext`), not five separate
ones — the doc is explicit that Phase 2 (knowledge base search), Phase 5
(internal linking), Phase 6 (content-hierarchy overlap), and Phase 7
(duplicate prevention) all read a slice of the same lookup. No LLM call
anywhere in this file — topic-to-entity matching is plain case-insensitive
substring/keyword matching, then a bounded edge traversal (`--max-hops`,
default 1) outward from whatever matched. An LLM only enters the pipeline
later, at the writer/reviewer calls (§4-5), once this layer has narrowed down
what's relevant.

```bash
cd scripts
node retrieval-layer.js --topic "Time Decay"
node retrieval-layer.js --topic "Leverage and Risk Management" --max-hops 2 --json
node retrieval-layer.js --topic "..." --db ../admin/knowledge-graph.db   # (default shown)
```

Returns `{ seedEntities, relatedEntities, articleSummaries, nearDuplicates,
suggestedLinks, checklist, contentHierarchy, duplicateRisk? }`. A topic that
matches no entity at all comes back with everything empty plus a `note`
explaining it's genuinely new — that's a normal result, not an error.
Exported functions (`findSeedEntities`, `expandRelatedEntities`,
`getArticleSummariesForEntities`, `flagNearDuplicateCoverage`,
`suggestInternalLinks`, `buildChecklist`, `scoreTitleSlugSimilarity`,
`assessContentHierarchy`, `buildRetrievalContext`) accept any `db` object
exposing `.prepare(sql).all(...)/.get(...)` — that narrow surface is
deliberate so §2's in-browser incremental path (option (b), via `sql.js`/
WASM) can reuse this file unchanged behind a thin adapter, once that path is
built. **Update 2026-08-11:** the `sql.js`/WASM path itself is now built (see
`admin/index.html`'s "INCREMENTAL KNOWLEDGE-GRAPH EXTRACTION" section, §2 Step
7) — but for the extraction/checker pipeline (`extract-entities.js`/
`fact-retention-checker.js`), not this file. This file's own reuse via a thin
adapter is still a future step, whenever the generation pipeline's retrieval
step moves in-browser too; the Knowledge Coverage/SEO panels still run their
own hand-kept JSON-mirror reimplementation of a slice of this file's logic,
unchanged by this update.

**Phase 6 (content hierarchy) / Phase 7 (duplicate prevention)**, completed
per `extra-md-files/pipeline-phase-4-6-7-1-mvp.md` §1 — entity-overlap
duplicate detection (`flagNearDuplicateCoverage`) already covered part of
Phase 7; the piece that was still missing is title/slug string similarity,
which catches a rephrased title/slug sharing few or no graph entities:

- `contentHierarchy` — always present, no candidate needed. `assessContentHierarchy()`
  over the existing `nearDuplicates`: if any entry is `level: "high"`, flags
  `{overlapsSpecialisedArticle: true, article: {slug, title}, recommendation}`
  ("introduce briefly, then link to the dedicated article"); otherwise
  `{overlapsSpecialisedArticle: false, article: null, recommendation: "safe to write a full article"}`.
- `duplicateRisk` — only present when `opts.candidateTitle`/`opts.candidateSlug`
  is passed. `scoreTitleSlugSimilarity()` scans every row in `articles`,
  scoring Jaccard token overlap on title (`titleSimilarityScore`) and exact/
  substring overlap on slug (`slugSimilarityScore`); `buildRetrievalContext`
  combines that with the entity-based `nearDuplicates` into one
  `{verdict: "high"|"medium"|"none", titleSlugMatches, entityOverlap}` result —
  "high" if either signal strongly suggests the same article already exists.

```bash
node retrieval-layer.js --topic "Time Decay" \
  --candidate-title "What Is A Structured Warrant" --candidate-slug "what-is-a-structured-warrant"
```

No `validate-*.js` harness — unlike the LLM-backed scripts above, this file
makes no external calls to fixture-inject around; it was instead run directly
against the real (hand-authored sample) `admin/knowledge-graph.db` across
several topics (`Time Decay`, `Leverage and Risk Management` at `--max-hops
2`, a no-match topic, and a deliberately-similar `--candidate-title`/
`--candidate-slug` pair) to confirm seed matching, hop expansion, near-
duplicate flagging, link suggestions, content-hierarchy flags, and duplicate-
risk verdicts all come back sane end-to-end.

## coverage-reviewer.js

The reviewer core from `extra-md-files/ai-article-pipeline.md` §5 — a
library, not a CLI (no `main()`, nothing to run directly). Given a checklist
(entities from `retrieval-layer.js`'s `buildChecklist`, plus any manually-
curated must-include facts) and a draft article's English body text, asks an
LLM to judge, per checklist item, whether it's `covered`, `partial`, or
`missing`, with a short evidence quote when covered/partial. This is a
**separate LLM call** from whatever produced the draft — §5 is explicit that
the writer must never grade its own output, since it shares the blind spots
that caused the omission in the first place.

Different question from `fact-retention-checker.js`'s §3 judge: that one asks
whether the *graph's own records* survived a re-extraction; this one asks
whether a *draft article* covers what the graph (plus the admin) says it
should. Neither replaces the other.

`buildReviewPrompt`/`parseReviewResponse`/`summarizeReview` are deliberately
framework-agnostic (no `node:*` imports) so the exact same logic can run
client-side too — see "Manual-authoring path" under `generate-article.js`
below. `openAIReviewer`/`fixtureReviewer` (the actual network call) are
Node-only, same split as `fact-retention-checker.js`'s `openAIJudge`/
`fixtureJudge`.

Consumed by `generate-article.js` (below) rather than run standalone; see
that file's own validation harness for how this module is exercised without
an API key.

## generate-article.js

Build-order step 5, the two pieces the doc says must land together: §4
Phase 3 (AI Content Generation) and §5's coverage reviewer, "in the SAME pass
... not retrofitted later." Given `--topic`, runs the full §5 "AI path":

```
1. Query knowledge-graph.db for candidate entities  -- retrieval-layer.js's
   buildRetrievalContext() (reused, not re-queried -- that file's own contract)
2. Build the checklist  -- retrieval context's checklist + any
   --must-include-facts, merged by buildFullChecklist()
3. Generate a draft      -- writer LLM call (buildWriterPrompt), checklist in the prompt
4. Review the draft      -- reviewer LLM call (coverage-reviewer.js), a SEPARATE call
5. <=1 repair retry      -- only if step 4 found a gap: feed missing/partial items
                              back to the writer (buildRepairPrompt), regenerate, re-review once
6. Return                -- draft + coverage result together, for Phase 8 (the human) to act on
```

The retry cap is enforced in code, not just documented: passing
`--max-retries` (or `maxRetries` when calling `generateArticleWithReview()`
directly) above `1` throws immediately, before any writer/reviewer call is
made. Whatever is still `missing`/`partial` after the one retry is returned
as-is — this script never force-inserts a fact or silently drops a gap; it's
informational for Phase 8, not a pipeline gate. Consequently the CLI exits
`0` even when coverage gaps remain after the retry cap; it only exits
non-zero on a genuine error (malformed writer/reviewer JSON, a rejected
`--max-retries`, etc.).

The writer's prompt deliberately sends related articles as `{title, slug,
summary}` only (retrieval-layer.js's `articleSummaries`), never their full
`body_text` — keeps the prompt small and reduces the temptation to paraphrase
an existing page sentence-by-sentence, which §4 Phase 3 explicitly forbids.
An optional `--source-file` supplies one extra reference text (e.g. a
manually-pasted Nanyang column — §4 Phase 1's fallback for paywalled content;
Phase 1's own import pipeline is not built, this is just an ad hoc input).

Phase 3's fuller scope — SEO optimisation (§4 Phase 4, now `seo-optimizer.js`
above), auto-inserted internal links (Phase 5, still not built — out of scope
per `extra-md-files/pipeline-phase-4-6-7-1-mvp.md`), content-hierarchy
enforcement (Phase 6, now `retrieval-layer.js`'s `contentHierarchy` field) —
is **not** built in THIS file; those are separate, standalone pieces that
happen to consume the same retrieval context. The writer prompt still
receives `nearDuplicates`/`suggestedLinks` from the retrieval context so it
can steer away from duplicate coverage, but nothing here auto-generates meta
tags or inserts `<a>` tags — call `seo-optimizer.js` separately for metadata.

```bash
cd scripts
OPENAI_API_KEY=sk-... node generate-article.js --topic "Time Decay"
node generate-article.js --topic "..." --must-include-facts facts.json   # facts.json: JSON array of strings
node generate-article.js --topic "..." --source-file column.txt          # optional single reference text
node generate-article.js --topic "..." --json                           # machine-readable output (Phase 8 consumes this shape)
node generate-article.js --topic "..." --writer-model gpt-4o --reviewer-model gpt-4o-mini

node generate-article.js --topic "..." --writer-fixture-dir DIR --reviewer-fixture-dir DIR   # fully offline, see below
```

### Manual-authoring path (§5 "Also applies to manually-authored content")

§5 is explicit that the reviewer step isn't gated behind "was this
AI-generated" — it also attaches to `admin/index.html`'s New Article wizard,
at Step 5 (Preview), for articles written by hand, pasted, or imported from a
DOCX/PDF. That flow has no writer call and no auto-repair loop (there's no
LLM draft to feed corrections back into) — it's checklist -> reviewer call ->
a purely informational Knowledge Coverage panel, same prompt/parse logic as
`buildReviewPrompt`/`parseReviewResponse` above. Since `admin/index.html` is a
standalone, self-contained page (root `CLAUDE.md`: no build step, no imports
from this dev-only `scripts/` directory), its copy is a hand-kept mirror of
those two functions plus a small vanilla-JS checklist builder against
`admin/knowledge-graph.json` (the JSON mirror `extract-articles.js` already
regenerates) rather than a live import — search `admin/index.html` for
"mirrors scripts/coverage-reviewer.js" to find it. Keep the two in sync if
either changes.

### Validating without an API key

`validate-generate-article.js` reads the checklist straight out of the real
hand-authored sample db (`buildRetrievalContext()` against
`admin/knowledge-graph.db`, read-only — this script never writes to it) so
its fixtures are built from whatever the checklist actually contains, not a
hardcoded guess:

```bash
node validate-generate-article.js
```

It asserts: the reviewer is called as a genuinely separate, independently-
countable invocation from the writer; a missing checklist item triggers
exactly one repair retry (writer + reviewer each called a second time); the
retry cap really is 1 — even when the repaired draft still leaves an item
"partial", nothing attempts a third round, and the leftover gap surfaces in
the result rather than being dropped; a first draft that's already fully
covered never retries at all (no wasted call); `maxRetries > 1` is rejected
before any call is made; must-include facts actually reach the checklist and
the reviewer prompt text; and at the CLI level, `--json` output round-trips
the same shape and the process exits `0` even with a remaining gap (gaps are
Phase 8's job, not a pipeline failure), while `--max-retries 2` exits
non-zero. No `OPENAI_API_KEY`/network needed — same dependency-injection
pattern as every LLM-backed script above.

## seo-optimizer.js

§4 Phase 4 (SEO Optimisation), completed per `extra-md-files/pipeline-phase-4-6-7-1-mvp.md`
§2. Same shape as `generate-article.js` but simpler — Phase 4 has no reviewer/
retry step in the doc, so this is ONE writer-style LLM call turning an
already-written (or about-to-be-written) article's topic/title/body into full
on-page SEO metadata: SEO title, meta description, URL slug, OG title/
description, primary/secondary/long-tail keywords, an H1-H4 heading outline,
and a schema-friendly FAQ section — the doc's own Phase 4 field list,
verbatim. Reuses `retrieval-layer.js`'s `buildRetrievalContext()` for the
checklist rather than re-querying the db, same "one composed query, every
phase reads its own slice" contract every other consumer here follows.

```bash
cd scripts
OPENAI_API_KEY=sk-... node seo-optimizer.js --topic "Time Decay" --title "..." --body-file body.txt
node seo-optimizer.js --topic "..." --title "..." --body-file body.txt --json
node seo-optimizer.js --topic "..." --title "..." --body-file body.txt --model gpt-4o-mini   # (default shown)

node seo-optimizer.js --topic "..." --title "..." --body-file body.txt --seo-fixture-dir DIR   # fully offline, see below
```

Dependency-injected the same way as every other LLM-backed script here
(`openAISeoWriter` + `fixtureSeoWriter`, selected once in `main()`) — the
fixture writer reuses `generate-article.js`'s `slugifyTopic` for its
`<fixtureDir>/<slug>.json` naming convention, matching every other writer-
shaped fixture in this directory.

Also wired into `admin/index.html`'s New Article wizard (Step 3/SEO) as a
"Generate SEO Suggestions" button — a hand-kept browser mirror of
`buildSeoPrompt`/`parseSeoResponse`, same pattern as the Knowledge Coverage
panel below it. Suggestions are shown with a per-field "Apply" action (SEO
title, meta description, keywords); the admin reviews before anything is
used, nothing auto-fills silently.

### Validating without an API key

`validate-seo-optimizer.js` hand-authors one well-formed SEO response fixture
and asserts: `parseSeoResponse` accepts it and every required field is
present/correctly typed; it rejects a response missing a required string or
array field, an empty required field, a malformed heading (bad level or
empty text), a malformed FAQ entry, and non-JSON input; `generateSeoMetadata()`
round-trips through the fixture against the real sample db (checklist reused
from `buildRetrievalContext`, not re-queried); and at the CLI level, `--json`
output round-trips the same shape and exits `0`, while a missing required
flag (`--title`) exits non-zero.

```bash
node validate-seo-optimizer.js
```

No `OPENAI_API_KEY`/network needed — same dependency-injection pattern as
every LLM-backed script above.

## import-source-articles.js

Phase 1 (Source Article Collection), MVP-scoped per
`extra-md-files/pipeline-phase-4-6-7-1-mvp.md` §5 — **manual-paste import
only**, no live scanning of any external domain (owner decision recorded in
that doc). Mirrors `extract-articles.js`'s role: a local/developer-run Node
script, no LLM, that syncs data staged by the browser into the db.

`admin/index.html`'s "Import Source Article" form (list screen, next to
"+ New Article") stages one JSON file per import at
`admin/source-articles-pending/<slug>.json` via a single-file GitHub Contents
API commit — `{title, originalUrl, publishedAt, author, category,
originalContent, featuredImage, notes}`. This script reads every file in that
directory and upserts it into the `source_articles` table
(`admin/knowledge-graph.schema.sql`), generating a `slug` from `title` (via
`generate-article.js`'s `slugifyTopic`, reused not reimplemented) if the file
doesn't already carry one, same idempotent
`INSERT ... ON CONFLICT(slug) DO UPDATE` pattern `extract-articles.js` uses
for `articles`. Always sets `status = 'imported'` and a fresh `import_date` —
the rest of the doc's status lifecycle (`reviewed`/`ready`/`generated`/
`published`/`ignored`) is out of this script's scope for now.

```bash
cd scripts
node import-source-articles.js                                   # sync every pending file
node import-source-articles.js --dry-run                         # parse + print only, no db write
node import-source-articles.js --slug <slug>                     # sync one staged file only
node import-source-articles.js --pending-dir ../admin/source-articles-pending  # (default shown)
node import-source-articles.js --db ../admin/knowledge-graph.db  # (default shown)
```

A pending file missing `title` or `originalContent` is reported as a
per-file `error` and skipped rather than aborting the whole run (matches
`extract-entities.js`'s per-item outcome pattern); the script exits non-zero
if any file errored. Re-running over the same pending files is safe and a
no-op re-upsert — never a duplicate row.

### Validating without an API key

`validate-import-source-articles.js` — no LLM involved, so (matching
`retrieval-layer.js`'s own no-fixture-needed precedent for pure-data scripts)
this validates directly against a temp copy of the schema and a temp pending
directory under `scripts/output/` (gitignored), never touching the real
`admin/knowledge-graph.db`. Asserts: missing-field / malformed-JSON pending
files are rejected with a clear per-file error, not a thrown exception; a
missing `slug` is auto-generated from `title`; `upsertSourceArticle()` is
idempotent (same slug twice = one row, second call's values win); `--dry-run`
writes nothing; a real CLI run writes the expected rows and a SECOND run over
the same pending files is a no-op re-upsert, not a duplicate; `--slug` filters
to only the matching file; and a malformed pending file makes the CLI exit
non-zero while still writing the valid files in the same run.

```bash
node validate-import-source-articles.js
```

## encrypt-secret.js

Produces the `CONFIG.ENCRYPTED_OPENAI_KEY` blob `admin/index.html` needs to
enable the Knowledge Coverage panel described above — same AES-256-GCM /
SHA-256(password) / `base64(iv[12]+tag[16]+ciphertext)` scheme already used
for `CONFIG.ENCRYPTED_TOKEN` (the GitHub PAT), so the same login password
decrypts both. Round-trip-verified against the exact WebCrypto decrypt code
`admin/index.html` runs (Node's `crypto.subtle` implements the same
WebCrypto API a browser does).

```bash
cd scripts
node encrypt-secret.js --secret "sk-..." --password "<the admin login password>"
node encrypt-secret.js --secret-file path/to/key.txt --password "..."
```

Paste the printed blob into `CONFIG.ENCRYPTED_OPENAI_KEY` in
`admin/index.html`. Do this only after setting a hard spend cap/usage alert
on the OpenAI account (§6/§8's required precondition) — until that blob is
set, `CONFIG.ENCRYPTED_OPENAI_KEY` stays `''` and the Knowledge Coverage
panel just shows "OpenAI key not configured", exactly like every Node script
above stayed fixture-only pending the same precondition.

## validate-admin-mirror-sync.js

Several files above document a "Keep in sync if either changes" contract
with a hand-kept browser mirror in `admin/index.html` (since that page can't
`import` from this dev-only directory — see `coverage-reviewer.js`'s file
header for the fullest explanation of why). Nothing enforced that contract
mechanically until now: it was easy to edit one side, forget the other, and
not notice until the two silently produced different prompts.

This script closes that gap for the **prompt-building** functions
specifically — the ones that return a literal string or `{system, user}`
object baked straight into an LLM call, plus the small formatting helpers
spliced directly into those prompts. It imports the real functions from
`coverage-reviewer.js`/`seo-optimizer.js`/`extract-entities.js`/
`fact-retention-checker.js`, slices the matching mirror function's source text
straight out of `admin/index.html` (brace-matched, comment/string-aware) and
evals it in a `vm` sandbox, then calls both sides with identical fixtures and
asserts the output strings are byte-for-byte equal:

```bash
cd scripts
node validate-admin-mirror-sync.js
```

Deliberately out of scope: the response-PARSING mirrors
(`parseReviewResponseBrowser`/`parseSeoResponseBrowser`/
`kgParseExtractionResponse`/`kgParseJudgeResponse`) already diverge slightly
by necessity from their originals (the browser versions also do the
DOM-render-safe work their panels need), and the checklist-retrieval mirrors
(`kcTokenize`/`kcFindSeedEntities`/`kcExpandRelatedEntities`/
`kcBuildChecklist`) run against a materially different data source — the
JSON graph mirror vs. a live SQLite `db` handle via `.prepare().all()`, per
`retrieval-layer.js`'s own note above on that split — so a literal string
diff isn't the right tool for either. Exits non-zero (with a first-diff
excerpt for each failing pair) if any prompt-building function has drifted
from its mirror; safe to run any time either side changes, and worth adding
to a pre-push check alongside the other `validate-*.js` scripts above.
