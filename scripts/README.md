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
`extra-md-files/ai-article-pipeline.md` (§2 Steps 1-3, plus the `links` half
of Step 5). Parses every `articles/*.html`, strips boilerplate (nav/footer/
CTA/JSON-LD) and the decorative `.graph-*` diagram blocks, and upserts the
real title/summary/English body_text/dates into the `articles` table of
`admin/knowledge-graph.db` (idempotent — safe to re-run after every article
edit or publish). Also regenerates `admin/knowledge-graph.json`, the
human/LLM-readable mirror of that db, per its own stated contract.

`regenerateJsonMirror(db, mirrorPath)` (exported) mirrors every table in the
db, not just `articles`/`entities`/`edges`/`links` — including
`source_articles`, with its full `original_content` — since the `.db` is
opaque in git diffs and isn't openable without a sqlite client. That's the
practical way to manually verify a scraper run (see
`scrape-enanyang-articles.js`/`import-source-articles.js` below, both of
which call this same function after their own db writes): open
`admin/knowledge-graph.json`, find the row by slug/title, and read its
`original_content` against the source URL.

It deliberately stops short of `entities`, `article_entities`, and `edges` —
that half needs an LLM call (`extract-entities.js`).

It DOES backfill the `links` table — every successfully-parsed article's
`.article-related` internal links (already found during parsing, previously
only surfaced via console/`--json-out`) are now written: DELETE that
article's existing outgoing `links` rows, then INSERT one fresh row per link
whose target slug resolves to a known article, all inside the same
transaction as the `articles` upsert. Link data needs no LLM, so despite §2
Step 5 grouping "Populate article_entities / links" as one step downstream of
Step 4's entity extraction, there was never a real dependency — this backfill
runs every time, independent of whether `extract-entities.js` has ever run. A
link whose target slug has no matching article is skipped (counted, warned
about), never written as a dangling foreign key.

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
`entities`/`article_entities`/`edges` that reference them; `links` is fully
re-derived from current HTML every run, so an edited `.article-related` block
is reflected exactly, not merely appended to).

### Validating without an API key

`validate-extract-articles.js` — no LLM involved (matching
`retrieval-layer.js`'s/`import-source-articles.js`'s own no-fixture-needed
precedent for pure-data scripts), so this validates the `links` backfill
against a temp copy of the schema under `scripts/output/` (gitignored),
running the REAL parser over the real `articles/*.html` but never touching
the real `admin/knowledge-graph.db`:

```bash
node validate-extract-articles.js
```

It asserts: real extraction finds a nonzero number of internal links per
article; `backfillLinks()` writes exactly one row per resolvable link, with
the right `target_article_id`/`link_text`; a link whose target slug has no
matching article is skipped, not written; a synthetic source slug with no
`articles` row is silently ignored; re-running with identical records leaves
the row count unchanged (idempotent); re-running with a shrunk link set for
one article actually removes the now-stale rows (re-derivation, not an
append-only log); and at the CLI level, two consecutive real runs over
`articles/` produce the same row count both times.

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
suggestedLinks, checklist, contentHierarchy, candidateSourceArticles,
duplicateRisk? }`. A topic that matches no entity at all comes back with the
entity-graph fields empty plus a `note` explaining it's genuinely new —
that's a normal result, not an error; `candidateSourceArticles` is still
computed even then, since it queries `source_articles` directly rather than
via the entity graph (see below).

**Phase 2 — candidate source-article selection**, completed once
`scrape-enanyang-articles.js` actually populated `source_articles.keywords`
at scale: `extra-md-files/ai-article-pipeline.md`'s Phase 2 asks to "search
for related source articles by keyword/topic similarity/category/tag" before
generating — `getArticleSummariesForEntities` above only ever covered
already-*published* `articles` (via the entity graph); `source_articles` rows
(imported eNanyang columns not yet turned into a site article) carry no
entities/edges of their own, so `findCandidateSourceArticles(db, topic, opts)`
queries that table directly instead:

- Scored cheapest-signal-first: 1.0 topic verbatim in the title, 0.8 shares a
  keyword with the row's `keywords` tags, 0.6 with its `category`, 0.4 with
  its `original_content` body text (checked last, weakest signal).
- `opts.keyword`/`opts.category` are **facets**, not just scoring inputs —
  substring, case-insensitive (matching `scrape-enanyang-articles.js`'s own
  `--category`/`--keyword` filter semantics), and any row passing a given
  facet is guaranteed a floor score of 0.5 even when the topic text itself
  adds no extra match on top of it — so a facet is a real filter, not merely
  a tie-breaker. A facet with no `topic` at all is a valid "browse everything
  tagged IPO" query on its own.
- Excludes rows with `status = 'ignored'` (an admin already reviewed and
  deliberately excluded that source article from future generation).
- Wired into `buildRetrievalContext` as `result.candidateSourceArticles`
  (`opts.maxSourceCandidates` default 5, `opts.sourceKeyword`/
  `opts.sourceCategory` pass through to the facets above) and, from there,
  into `generate-article.js`'s writer prompt as background-only titles (see
  that section below).

```bash
node retrieval-layer.js --topic "IPO" --source-keyword ipo               # narrow candidateSourceArticles to a keyword facet
node retrieval-layer.js --source-category "fundamental analysis"         # browse a facet with no free-text topic at all
node retrieval-layer.js --topic "..." --max-source-candidates 10
```

This file also exports `insertSuggestedLinks(bodyText, suggestedLinks)` — §4
Phase 5's auto-INSERT step, not just the suggest-what-to-link-to piece above.
For each suggestion (best-scored first), wraps the first verbatim mention of
its entity name in `bodyText` with an ordinary `<a href="<slug>.html">`
anchor (relative link, same convention every article's `.article-related`
block already uses); an entity with no verbatim mention is reported in
`skipped`, never force-inserted. Pure text transform, no LLM, no db access —
kept in this file next to `suggestInternalLinks` since it's the natural
second half of the same phase, even though it operates on a draft body text
rather than the graph. Consumed by `generate-article.js` as the final step of
`generateArticleWithReview()` (see below) — not part of `buildRetrievalContext`
itself, since it needs a draft to insert into.

Exported functions that touch the graph (`findSeedEntities`,
`expandRelatedEntities`, `getArticleSummariesForEntities`,
`flagNearDuplicateCoverage`, `suggestInternalLinks`, `buildChecklist`,
`scoreTitleSlugSimilarity`, `assessContentHierarchy`, `buildRetrievalContext`)
accept any `db` object
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
risk verdicts all come back sane end-to-end. `findCandidateSourceArticles`/the
`--source-keyword`/`--source-category` facets were verified the same way
(against the real, ~423-row scraped `source_articles` table) plus indirectly
through `validate-generate-article.js`'s Part 0.75 (`buildWriterPrompt`'s
`candidateSourceArticles` rendering) and its CLI-level `--source-keyword`
checks (see `generate-article.js`'s section below) — this file itself stays
without a dedicated harness.

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
6. Auto-insert internal   -- §4 Phase 5, on the FINAL draft body text (after any repair):
   links                     retrieval-layer.js's insertSuggestedLinks() wraps the first
                              verbatim mention of each suggestedLinks entity in a real <a> tag
7. Return                -- linked draft + coverage result + link-insertion report together,
                              for Phase 8 (the human) to act on
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

The writer prompt also receives retrieval-layer.js's `candidateSourceArticles`
(§4 Phase 2 — related, unpublished `source_articles` rows found by keyword/
category/topic) the same title-only way, labeled "unpublished Nanyang Siang
Pau columns" so the writer treats them as background, never a copy source.
`--source-keyword`/`--source-category` narrow that set to a specific
`source_articles.keywords`/`category` facet (pass through to
`buildRetrievalContext`'s `sourceKeyword`/`sourceCategory` opts — see
`retrieval-layer.js`'s section above for the scoring/facet rules).

Phase 3's fuller scope — SEO optimisation (§4 Phase 4, now `seo-optimizer.js`
above), content-hierarchy enforcement (Phase 6, now `retrieval-layer.js`'s
`contentHierarchy` field) — is **not** built in THIS file; those are separate,
standalone pieces that happen to consume the same retrieval context. Phase 5
(auto-inserted internal links) **is** built here, as the pipeline's own final
step (step 6 above) — the one piece of "Phase 3's fuller scope" that needed
the already-finished draft body text to insert into, so it fit naturally at
the end of this file rather than standing alone. The writer prompt still
receives `nearDuplicates`/`suggestedLinks` from the retrieval context so it
can steer away from duplicate coverage and mention related articles naturally
in its own words; the auto-insert step turns those mentions into real `<a>`
links afterward, on the FINAL draft (after any repair retry) — the reviewer
always judges the writer's own plain-text output, never text this step added.
Nothing here auto-generates meta tags — call `seo-optimizer.js` separately
for that.

`result.internalLinks` (both at the function-call and `--json` CLI level) is
`{inserted: [{entity, targetSlug, targetTitle, mentionText}], skipped:
[{entity, targetSlug, reason}]}` — `skipped` covers an entity with no
verbatim mention in the draft (the writer discussed it in different words) or
whose only mention overlapped a link already inserted for an earlier
suggestion; neither case force-inserts a link, matching §5's own "never
silently dropped or silently force-inserted" stance for coverage gaps.

**`suggestedGraphSteps` + `body_text` section breaks** — added for
`extra-md-files/automated-article-scheduler.md` component 2 ("Chart
auto-generation"), even though that component's own consumer
(`graph-blocks.js`) is **not built in this pass** — these are additive to the
existing writer/repair response shape, not a new pipeline phase. The writer
(and the repair retry, if one runs) must also return `suggestedGraphSteps`,
a 2-5 item array of short imperative-style labels (e.g. `"Identify the
setup"`, `"Confirm the signal"`) summarizing the article's own core
process/sequence, grounded strictly in what the draft itself already says —
these will feed an auto-generated flow diagram once that consumer exists.
`body_text` must also carry at least one `"## "`-prefixed section-heading
line (its own line, e.g. `"## Understanding Time Decay"`) so a future HTML
assembler has real heading structure to build `<h2>`s from, instead of one
undifferentiated block of paragraphs. `parseWriterResponse()` validates both
with the same strictness as every other required field here — a response
missing `suggestedGraphSteps`, with fewer than 2 or more than 5 entries, with
an empty entry, or with no `"## "` line anywhere in `body_text` throws, same
as a missing `title`/`summary`/`body_text`. `admin/index.html`'s
`buildWriterPromptBrowser`/`buildRepairPromptBrowser` mirrors carry the same
instructions (kept in sync via `validate-admin-mirror-sync.js`); its
`parseWriterResponseBrowser` does not yet extract/validate the field (the
response-parsing mirrors are documented as out of that validator's scope) —
harmless today since nothing browser-side consumes it yet either, pending
`graph-blocks.js`'s browser-side counterpart.

```bash
cd scripts
OPENAI_API_KEY=sk-... node generate-article.js --topic "Time Decay"
node generate-article.js --topic "..." --must-include-facts facts.json   # facts.json: JSON array of strings
node generate-article.js --topic "..." --source-file column.txt          # optional single reference text
node generate-article.js --topic "..." --source-keyword ipo              # §4 Phase 2 facet: narrow candidateSourceArticles
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

It asserts: `parseWriterResponse()` accepts a well-formed `suggestedGraphSteps`
(2-5 non-empty, trimmed labels) plus a `"## "` section-heading line, and
rejects a response missing `suggestedGraphSteps` entirely, with too few, too
many, or an empty entry, or with no `"## "` line anywhere in `body_text`
(including a `"##"` that appears mid-paragraph rather than as a real
line-start prefix); `buildWriterPrompt()`/`buildRepairPrompt()` both actually
instruct for the `"## "` convention and `suggestedGraphSteps`, with the
correct JSON response shape at the end of each system prompt, and the repair
prompt's user text surfaces the CURRENT draft's suggested graph steps (never
crashing on a draft that doesn't have any yet); the reviewer is called as a
genuinely separate, independently-countable invocation from the writer; a missing checklist item triggers
exactly one repair retry (writer + reviewer each called a second time); the
retry cap really is 1 — even when the repaired draft still leaves an item
"partial", nothing attempts a third round, and the leftover gap surfaces in
the result rather than being dropped; a first draft that's already fully
covered never retries at all (no wasted call); `maxRetries > 1` is rejected
before any call is made; must-include facts actually reach the checklist and
the reviewer prompt text; §4 Phase 5's `insertSuggestedLinks()` links a
verbatim entity mention, leaves a second occurrence of the same entity
untouched, and reports (never force-inserts) an entity with no verbatim
mention — proven both as a standalone pure-function check and end-to-end
against the real sample db's own `suggestedLinks` for a real topic, asserting
the FINAL `result.draft.body_text` (not the reviewer's pre-link copy) carries
the real `<a>` tags; the FINAL draft (post-repair too, not just the initial
attempt) still carries a valid `suggestedGraphSteps` array and a `"## "`
section-heading line; `buildWriterPrompt`'s `candidateSourceArticles` handling
(§4 Phase 2) — present only flags the writer prompt as background-only and
lists candidate titles/categories, absent leaves both prompt halves
untouched; and at the CLI level, `--json` output round-trips the same shape
(including the new `internalLinks` and `suggestedGraphSteps` fields) and the
process exits `0` even with a remaining coverage gap (gaps are Phase 8's job,
not a pipeline failure), while `--max-retries 2` exits non-zero and `--source-keyword`
reaches `retrievalContext.candidateSourceArticles` with every returned row
actually carrying that keyword tag. No `OPENAI_API_KEY`/network needed —
same dependency-injection pattern as every LLM-backed script above.

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
node import-source-articles.js --no-mirror                       # skip regenerating admin/knowledge-graph.json after the db write
node import-source-articles.js --pending-dir ../admin/source-articles-pending  # (default shown)
node import-source-articles.js --db ../admin/knowledge-graph.db  # (default shown)
```

A pending file missing `title` or `originalContent` is reported as a
per-file `error` and skipped rather than aborting the whole run (matches
`extract-entities.js`'s per-item outcome pattern); the script exits non-zero
if any file errored. Re-running over the same pending files is safe and a
no-op re-upsert — never a duplicate row.

A real (non-`--dry-run`) run also regenerates `admin/knowledge-graph.json` —
reuses `extract-articles.js`'s `regenerateJsonMirror()`, not reimplemented —
so the synced `source_articles` rows are readable (title, `original_url`,
full `original_content`, `status`, ...) without a sqlite client. That's how
to manually verify this script (or `scrape-enanyang-articles.js` below)
actually wrote what you expect: open the `.json`, not the `.db`.

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
`admin/index.html`. Until that blob is set, `CONFIG.ENCRYPTED_OPENAI_KEY`
stays `''` and the Knowledge Coverage panel just shows "OpenAI key not
configured" — it never blocks publishing either way.

## scrape-tradewizard-index.js

Script 1 of 2 from `extra-md-files/nanyang-scraper.md` ("Nanyang / TradeWizard
Article Scraper — Build Plan") — builds the URL/metadata index of the
~400+ TradeWizard/Warren Mak eNanyang columns, distinct from the 12
hand-authored site articles `extract-articles.js` covers. No LLM, no db
write — this only produces a JSON list; turning it into `source_articles`
rows is `scrape-enanyang-articles.js`'s job (script 2, documented below).

`https://www.thetradewizard.com/articles` renders in-browser as a Next.js
client-side sortable grid, but a plain unauthenticated GET already returns
the full dataset server-side, embedded in one `self.__next_f.push([1,
"...escaped JSON..."])` React Server Component payload whose unescaped
string contains `"data":[{"id":...,"date":...,"title":...,"category":...,
"keywords":[...],"link":"https://www.enanyang.my/news/..."}, ...]`. This
script finds that chunk, unescapes it, bracket-matches the `"data":[...]`
array out of it, and `JSON.parse`s just that slice — verified against the
live page to parse cleanly into exactly the site's own reported row count
(432 as of 2026-08-12), so no Playwright/headless-browser render is needed.

```bash
cd scripts
node scrape-tradewizard-index.js --dry-run                 # fetch + parse + print, no write
npm run scrape-tradewizard-index                            # writes output/tradewizard-index.json
node scrape-tradewizard-index.js --out output/custom.json  # override output path
node scrape-tradewizard-index.js --html-file page.html     # parse a saved HTML file instead of fetching (offline testing)
node scrape-tradewizard-index.js --source-url <url>        # override the fetch URL (default the live TradeWizard page)
```

Each written row is `{id, title, url, publishedAt, category, keywords}` —
`id` is TradeWizard's own stable numeric id, kept for script 2's future
dedupe/checkpointing even though the build plan's minimum contract doesn't
require it. The extraction (`extractTradeWizardRows`) is a pure function
over an HTML string, no network/fs involved, so it's directly testable
against a saved fixture via `--html-file` — no `validate-*.js` harness
exists for this script yet (the build plan's build order only calls one out
for script 2); add one the same way if this script grows more parsing edge
cases to guard.

**Dedup:** TradeWizard's own index has been observed to list the same
`enanyang.my` URL more than once (e.g. a re-tagged repost of the same
column under a different `id`/title). `dedupeRowsByUrl()` (exported, also
reused by `scrape-enanyang-articles.js` — see below) drops every row after
the first occurrence of a given `url` before the index is written, so a
duplicate URL never reaches script 2 in the first place. A row with a
falsy `url` is never deduped against another. The console log reports how
many duplicate rows were dropped when this runs.

Throws a clear error (not a silent empty array) if the page's flight-payload
shape ever changes and no chunk contains the expected `"data":[{"id"` marker.

## scrape-enanyang-articles.js

Script 2 of 2 — reads `output/tradewizard-index.json` (script 1's output),
or a single `--url`, fetches each eNanyang article page, parses its
`NewsArticle` `application/ld+json` block for the full `articleBody`, and
upserts into `source_articles` via `import-source-articles.js`'s
`upsertSourceArticle()` (imported, not reimplemented). No login/cookies/
session needed — live-verified 2026-08-12 that the anonymous HTTP response
already carries the full article text via that JSON-LD block, confirmed
across both a 2026 article and two 2018 articles (not a recent-articles-only
quirk). See this file's own header comment and
`extra-md-files/nanyang-scraper.md`'s "Key discovery" for the fuller
writeup, including the ToS/business-call flag around reading full content
through the SEO channel rather than the reader-facing unlock flow.

```bash
cd scripts
node scrape-enanyang-articles.js --url <enanyang-url> --dry-run   # parse + print one article, no db write
node scrape-enanyang-articles.js --dry-run                       # parse + print every row in the index, no db write
node scrape-enanyang-articles.js --limit 3                       # real run, first 3 index rows only
node scrape-enanyang-articles.js --url <enanyang-url>             # real run, one article
node scrape-enanyang-articles.js --slug <slug>                    # real run, one row matching a computed slug
node scrape-enanyang-articles.js --start-after <slug>             # resume after a given slug (checkpointing)
node scrape-enanyang-articles.js --category "fundamental analysis" # only index rows whose TradeWizard category contains this (substring, case-insensitive)
node scrape-enanyang-articles.js --keyword ipo                    # only index rows whose keywords tags contain this (substring, case-insensitive)
node scrape-enanyang-articles.js --category ipo --keyword warrant # combine — AND, not OR
node scrape-enanyang-articles.js --delay-ms 1500                  # between-request delay (default 1200ms)
node scrape-enanyang-articles.js --no-mirror                      # skip regenerating admin/knowledge-graph.json after the db write
npm run validate-scrape-enanyang-articles                         # offline fixture-based validation, no network
```

**`--category`/`--keyword`** filter the TradeWizard *index* rows (title/url/
category/keywords — before any eNanyang page is fetched, so they cost no
extra requests), per the "Execution gate" small-test-batch need below. Both
are substring, case-insensitive (`filterRowsByCategoryAndKeyword()`,
exported) — `"ipo"` also matches a tag like `"IPO Analysis"` — and combine
with AND when both are given. Neither can be combined with `--url` (a single
article has no index row to filter). This is also the facet vocabulary
`retrieval-layer.js`'s `findCandidateSourceArticles()` and `admin/index.html`'s
Knowledge Search screen's keyword-facet dropdown both read against the same
`source_articles.keywords`/`category` columns once scraped.

**Manually verifying a run:** a real (non-`--dry-run`) run regenerates
`admin/knowledge-graph.json` after its db writes (same
`regenerateJsonMirror()` `import-source-articles.js` calls — see that
script's section above), so the way to check what actually got scraped is
to open `admin/knowledge-graph.json` and read its `source_articles` array —
not the `.db`, which is a binary sqlite file with no viewer in this repo.
Each entry carries the full `original_content` next to `title`/
`original_url`/`published_at`, so a spot-check is: pick a row, open its
`original_url` in a browser, and confirm the title and body text actually
match (Chinese encoding intact, no leftover HTML/boilerplate, body isn't
truncated). The console output from the run itself (`[ok] <slug> —
title="..." bodyLength=N`) is a faster first pass — a `bodyLength` far
shorter than the other rows, or a `no-articleBody-found`/`fetch-error`
outcome, is worth checking in the `.json` first.

**Slug fix vs. the build plan's literal wording:** the plan said to reuse
`generate-article.js`'s `slugifyTopic(title)` as-is, but that strips every
non-`[a-z0-9]` character — and eNanyang titles are Chinese, so plain
`slugifyTopic` collapses almost every title to the same `"topic"` fallback,
which would silently overwrite one row per run given `source_articles.slug`'s
UNIQUE index. `buildSourceSlug()` fixes this by suffixing eNanyang's own
permanent numeric article id (the trailing path segment of every article
URL) onto the slugified title.

**Duplicate prevention:** the `source_articles.slug` UNIQUE index alone
isn't enough to guarantee no duplicate rows, because `buildSourceSlug()` is
derived from the article's TITLE, not its URL — two rows can legitimately
carry the same underlying `enanyang.my` article under different slugs (a
title edited between two scraper runs, or a URL already imported one-off
via the admin "Import Source Article" form, whose slug never carries
eNanyang's article-id suffix). Three layers guard against this:

1. `scrape-tradewizard-index.js`'s own `dedupeRowsByUrl()` drops repeated
   URLs before its index file is even written (see that script's section
   above).
2. This script's `main()` calls the same `dedupeRowsByUrl()` again on
   whatever index it reads, as a belt-and-suspenders pass for an older
   cached index file or a hand-edited `--index-file`.
3. `processRow()` calls `findExistingSlugByUrl(db, originalUrl)` before
   deciding what slug to upsert under — if a `source_articles` row already
   carries this `original_url` (URL-canonicalized: query string/hash/
   trailing slash ignored) under a *different* slug, that existing slug is
   reused so the upsert updates the same row instead of inserting a new
   one. The outcome's `detail` string flags when this happened. This layer
   is the one that actually closes the title-changed-between-runs and
   manual-import-overlap cases — 1 and 2 only catch literal duplicate URLs
   within a single index.

Per-article outcomes are logged as `ok` / `dry-run` / `no-articleBody-found`
/ `fetch-error` / `parse-error` — one bad page never aborts the run. A
429/403 response is the one exception: it throws `StopRunError` and stops
the whole run instead of being logged and skipped, per
`nanyang-scraper.md`'s open question 3 (treat that as a block/rate-limit
signal, not an ordinary failure). `--start-after <slug>` lets a partial run
resume without redoing already-processed rows.

**Execution gate, updated 2026-08-13:** the supervisor has signed off on this
extraction approach (it was their own suggestion) — the business/ToS
question is resolved, and there is no technical/auth blocker either. The
full ~400+ row run is no longer blocked on permission, only on the user
actually requesting it. Before that, the user wants one small real test
batch first — either the ~10 most recent articles or an IPO-related subset
— see `extra-md-files/nanyang-scraper.md`'s "Execution gate" section. The
category/keyword-filtering gap it flagged as unbuilt is now closed (the
`--category`/`--keyword` flags above); the index's confirmed-date-sort gap is
still open for the "10 most recent" variant of that test run.

## backfill-source-article-keywords.js

One-off backfill for `source_articles.keywords` on rows that were
scraped/imported before `scrape-enanyang-articles.js` started writing that
column, or whose keywords drifted out of sync with
`output/tradewizard-index.json`. Does not re-fetch anything and does not
touch any other column — for each index row it looks up the matching
`source_articles` row and runs a single-column `UPDATE ... SET keywords = ?`.
It also self-migrates a pre-`keywords`-column db (`ALTER TABLE ... ADD COLUMN
keywords TEXT`, no-op if the column already exists) since `CREATE TABLE IF
NOT EXISTS` alone doesn't retrofit columns onto an already-existing table.

```bash
cd scripts
node backfill-source-article-keywords.js                          # real run
node backfill-source-article-keywords.js --dry-run                # print planned updates only, no db write
node backfill-source-article-keywords.js --no-mirror              # skip regenerating admin/knowledge-graph.json after the db write
node backfill-source-article-keywords.js --index-file output/custom.json  # (default shown)
node backfill-source-article-keywords.js --db ../admin/knowledge-graph.db # (default shown)
```

**Fallback match:** `findExistingSlugByUrl()`'s exact `original_url` match
(imported from `scrape-enanyang-articles.js`, reused not reimplemented) only
matched 117/423 rows in the real corpus — not because the rest are
unscraped, but because `processRow()` stores the article's own JSON-LD
canonical URL (e.g. `.../NYPLUS/674146`) in preference to the index's URL
(e.g. `.../Testimonia-Column/674146`) when they disagree, and
`canonicalizeUrl()` only strips query/hash/trailing-slash, not a differing
path segment. Since eNanyang's trailing numeric article id is stable across
both, any row the exact match misses falls back to matching on that id
(`extractArticleIdFromUrl()`, same helper `buildSourceSlug()` uses) — this
raised the match rate to 422/423 (the one remaining row is a genuinely
unscraped URL). Index rows with no match after both attempts are logged and
skipped, not treated as an error. Already run once against the live db — all
423 `source_articles` rows carry non-empty `keywords` as of this writing.

## select-topic.js

Component 1 of `extra-md-files/automated-article-scheduler.md`'s (PLAN ONLY — nothing
else in that doc is built yet) "five new components": the topic picker a future
orchestrator's step 1 needs before `generate-article.js` can run at all. Answers "which
Nanyang Siang Pau column should become the next auto-generated site article?" as three
pieces, per the doc:

1. **Parse `WARREN-MAK-NANYANG-ARTICLES.md`'s title list** (`parseNanyangCatalog`) — that
   file turns out to be a curated reference/highlights index (its own header: "used as
   source material... not published content itself"), not a literal 400-row machine list,
   so this parses the ~23 individually-titled columns it actually documents (the 11-part
   Structured Warrants series + 12 "Key Trading Strategy" category highlights). The
   "Recent Articles" table's non-placeholder rows all turn out to duplicate those same 23
   by date — deduped by keeping the richer list-section entry (URL + English title) over
   the table's terser Chinese-only restatement. A `[Bracketed]` title is the file's own
   inferred guess (date/URL only, no confirmed real title) — parsed and still usable as a
   topic, flagged `inferred: true`, lightly deprioritized in scoring (see below).
2. **Filter out anything already used**, per a new ledger file
   (`admin/auto-article-history.json`, `[{nanyangTitle, slug, publishedAt}]`, checked into
   the repo empty `[]`) — `loadHistory()`/`appendHistoryEntry()`. Never written by a normal
   selection run; `appendHistoryEntry()` exists for the future orchestrator (component 5,
   **not built in this pass**) to call only after a real publish succeeds, matching the
   doc's "updated... never on an aborted run" rule.
3. **Score the remainder for "gap-ness"** using `retrieval-layer.js`'s EXISTING exports,
   not new scoring logic, per the doc's own instruction: `computeGapScore()` just reads
   `buildRetrievalContext()`'s already-composed `duplicateRisk`/`nearDuplicates`/
   `contentHierarchy` fields back out (passing `candidateTitle`/`candidateSlug` for every
   candidate) — `1 - ` the strongest similarity signal found. A candidate whose
   `duplicateRisk` verdict is `"high"` is **excluded from selection entirely**, not merely
   down-ranked, matching Phase 7's "reconsider generating at all" guidance for that level.

```bash
cd scripts
node select-topic.js
node select-topic.js --json
node select-topic.js --top 10                                       # show more of the ranked candidate list
node select-topic.js --include-high-risk                            # debugging: don't exclude "high" duplicateRisk candidates
node select-topic.js --catalog ../WARREN-MAK-NANYANG-ARTICLES.md    # (default shown)
node select-topic.js --history ../admin/auto-article-history.json   # (default shown)
node select-topic.js --db ../admin/knowledge-graph.db               # (default shown)
node select-topic.js --mark-used                                    # ALSO records the pick into the ledger — manual/testing only, see below
```

If every catalog title is either already-used or scores `"high"` duplicate risk,
`selectTopic()` returns `{selected: null, reason: "..."}` instead of forcing a bad pick —
the doc's own "abort the run... rather than picking a bad topic just to have one." The CLI
exits non-zero in that case (and on `--mark-used` with nothing selected, or a missing
`--catalog` file) so a future orchestrator's shell/CI step can detect it via exit code.

Run against the real 12-article sample db, this currently selects "8 Factors Why Traders
Lose Despite Having a Plan" (2024-10-09) or "12 Volume-Price Traps" (2021-07-21) — the only
two catalog entries with zero graph overlap; every warrants/hedging/leverage-flavored entry
(the vast majority, since the site's 12 published articles are themselves warrants-focused)
scores `"high"` duplicate risk and is excluded, which is the intended behavior, not a bug.

`--mark-used` is a **manual/testing convenience**, not what a real publish-gated call looks
like — it appends to the ledger immediately after selection, with no actual article having
been published. The orchestrator this doc describes (component 5) is not built in this
pass; when it is, it should call `appendHistoryEntry()` directly, after its own publish step
succeeds, not through this flag.

No LLM call anywhere in this file — same "cheap, explainable, deterministic first" stance
`retrieval-layer.js` itself takes.

### Validating without an API key

`validate-select-topic.js` — no LLM involved, so (matching `retrieval-layer.js`'s own
no-fixture-needed precedent for pure-data scripts) this runs the REAL parser against the
REAL `WARREN-MAK-NANYANG-ARTICLES.md` and the REAL hand-authored sample
`admin/knowledge-graph.db` (read-only), plus a temp history ledger under `scripts/output/`
(gitignored) — the real `admin/auto-article-history.json` is never touched by this run:

```bash
node validate-select-topic.js
```

It asserts: the parser finds the real catalog's known entries with correct `inferred`
flags and URL extraction, a title duplicated between a category section and the "Recent
Articles" table collapses to exactly one candidate (keeping the richer version), and no two
parsed entries share a date; `loadHistory()`/`appendHistoryEntry()` round-trip correctly and
reject malformed ledgers/entries; `selectTopic()` against the real sample db finds a known
near-duplicate candidate ("Bottom-Fishing with Structured Warrants," which the real
`bottom-fishing-structured-warrants-malaysia` article already essentially covers) scoring
`duplicateRisk: "high"` with a strictly lower gap score than a genuinely novel candidate,
and never selects it; the inferred-title penalty measurably lowers an otherwise-identical
candidate's score; ledger filtering actually removes a used title from the candidate list
(case/whitespace-insensitively); and at the CLI level, `--json` output round-trips the same
shape, `--mark-used` really writes the ledger and changes the next run's pick, an exhausted
catalog exits non-zero with `selected: null` and a clear `reason`, and a missing `--catalog`
file / `--mark-used` with nothing selected both fail loudly rather than silently.

## graph-blocks.js

Component 2 of `extra-md-files/automated-article-scheduler.md`'s five new components: non-
interactive chart generation. `buildFlowGraphHtml()` previously only existed inside
`admin/index.html` as browser JS, driven by a human typing step labels into the New Article
wizard's graph panel (`extra-md-files/done/admin-graph-insertion.md`) — this is its Node
counterpart, producing byte-identical `.graph-block--flow` markup (same
`<!-- graph block: hand-authored, do not edit via admin WYSIWYG -->` comment convention as the
existing 12 articles and the wizard) from plain data, so an unattended pipeline can generate the
same chart a human would have typed by hand. MVP scope matches that doc's own precedent: **Flow
(Steps) only**, not all 7 catalog types (fast-follow, not built here).

`buildFlowGraphHtml()` is a hand-kept mirror of `admin/index.html`'s function of the same name —
search `admin/index.html` for "mirrors scripts/graph-blocks.js" to find it, and keep the two in
sync if either changes. `validate-admin-mirror-sync.js` checks the two produce identical output
automatically (5th pair, see that script's section below).

`validateGraphSteps(steps)` enforces the same 2-5 non-empty-label rule the wizard's
`insertGraphAtCursor()` applies before ever calling `buildFlowGraphHtml` — a separate exported
helper (not part of `buildFlowGraphHtml`'s own mirror contract) so a caller can reject a malformed
`suggestedGraphSteps` array (see `generate-article.js`'s section above) before ever building HTML
from it.

`insertGraphIntoBody(bodyHtml, graphHtml)` has **no admin mirror obligation** — the wizard only
ever supports a human clicking "insert at cursor" into a live Quill instance, there's no
non-interactive equivalent to reproduce. It's a simple, explicitly not-layout-aware heuristic:
insert right after the first `<h2>` boundary whose start position is at or past the midpoint of
the body's own plain-text length (falls back to the LAST `<h2>` if none starts past the midpoint,
and to appending at the very end if the body has no `<h2>` at all or no measurable text) —
matching how casually the wizard's own "insert at cursor" already behaves (a human just picks a
spot). Assumes `bodyHtml` is a flat sequence of top-level block elements, exactly the shape
`build-article-document.js`'s `bodyTextToHtml()` (below) produces and every existing
hand-authored article already uses.

```bash
cd scripts
node graph-blocks.js --title "How to Manage Structured Warrant Risks" \
  --step "Set stop-losses" --step "Size the position" --step "Check IV"
node graph-blocks.js --title "..." --step "..." --step "..." --json          # {title, steps, graphHtml}
node graph-blocks.js --title "..." --step "..." --step "..." --body-file body.html   # also merges into a body, --json adds bodyHtml
```

### Validating without an API key

`validate-graph-blocks.js` — no LLM involved (pure string/DOM transform), matching
`extract-articles.js`'s own no-fixture-needed precedent for pure-data scripts:

```bash
node validate-graph-blocks.js
```

It asserts: `buildFlowGraphHtml()` produces the expected shape (hand-authored comment, figure/
figcaption/ordered-list classes, one `<li>` per step, HTML-escaped title/labels, an empty step
array producing an empty `<ol>` rather than throwing); `validateGraphSteps()` accepts 2-5
non-empty labels and rejects too few, too many, a non-array, and a blank/non-string entry;
`insertGraphIntoBody()` picks the first `<h2>` at or past the body's text midpoint (proven with
four headings sized so the midpoint falls exactly on the third, not the last), falls back to the
last `<h2>` when none qualifies, and falls back to appending at the end when there's no `<h2>` at
all or no measurable text; and at the CLI level, `--title`/`--step` round-trip through `--json`
output, a missing `--title` or fewer than 2 steps exits non-zero, and `--body-file` actually
merges the graph into the given body.

## build-article-document.js

Component 4 ("Document assembly") of `extra-md-files/automated-article-scheduler.md`'s five new
components. `buildArticleDocument()` (the full-page template: head/nav/footer/JSON-LD/
`.course-hero`/`.article-body`/`.author-box`/`.sticky-cta-bar`) previously only existed inside
`admin/index.html`, browser-only, and needs a real Quill editor instance/DOM to run — this module
is its Node counterpart, producing byte-identical structure from plain data in (slug, EN/ZH
title/subtitle/body-html/summary, SEO fields, category, dates) — no featured image required, same
as the admin wizard's own `computeValidation()` (an 8-item checklist that already treats the
featured image as optional).

`buildArticleDocument(state)` is a hand-kept mirror of `admin/index.html`'s function of the same
name — search `admin/index.html` for "mirrors scripts/build-article-document.js" to find it, and
keep the two in sync if either changes; `validate-admin-mirror-sync.js` checks the two produce
identical output automatically (6th pair). One deliberate difference from the admin version:
admin's `buildArticleDocument()` takes `state.bodyEnHtml`/`state.bodyZhHtml` still carrying
`[[GRAPH:id]]` placeholders (Quill inserts those; admin substitutes them via the module-scoped
graph-block list the wizard's UI maintains) — this pipeline has no Quill/human step, so
`bodyTextToHtml()` + `graph-blocks.js`'s `insertGraphIntoBody()` already produce FINAL body HTML
upstream, and this function's `state.bodyEnHtml`/`bodyZhHtml` are expected to be final too (no
placeholder substitution happens here).

`bodyTextToHtml(text)` has no admin mirror obligation — admin's closest equivalent,
`plainTextWithAnchorsToParagraphHtml()`, does NOT convert `"## "`-prefixed section-heading lines
(see `generate-article.js`'s `suggestedGraphSteps`/`"## "` section above) into real `<h2>` markup,
a pre-existing gap in the admin/human path. This pipeline has no human editor to notice a stray
`"## "` sitting in a published paragraph, so `bodyTextToHtml()` implements the heading conversion
correctly rather than reproducing the gap — blank-line-separated paragraphs become `<p>`, a `"## "`
line becomes `<h2>`, inline `<a href="...html">` markup (already woven in by
`generate-article.js`'s link-insertion step) is left untouched, everything else is HTML-escaped.

`assembleFromDraftState(rawState)` is the CLI's convenience entry point: reads a state whose
`bodyTextEn`/`bodyTextZh` are RAW `body_text` (not yet HTML), runs `bodyTextToHtml()` on both,
fills in `readingTimeText` via `computeReadingTimeText()` if not already set (200 wpm EN / 300 cpm
ZH, minimum 1 minute — the same formula the wizard's `recalcReadingTime()` computes client-side
off a live Quill instance, reimplemented here so an unattended caller can derive it from plain
text instead of needing a browser), and calls `buildArticleDocument()`. Callers that already have
final HTML (e.g. after `graph-blocks.js`'s `insertGraphIntoBody()` has run) should call
`buildArticleDocument()` directly instead.

```bash
cd scripts
node build-article-document.js --state-file state.json > articles/slug.html
node build-article-document.js --state-file state.json --json   # {html, bodyEnHtml, bodyZhHtml}
```

### Validating without an API key

`validate-build-article-document.js` — no LLM involved (pure string/DOM transforms), matching
`validate-graph-blocks.js`'s own no-fixture-needed precedent:

```bash
node validate-build-article-document.js
```

It asserts: `bodyTextToHtml()` splits blank-line paragraphs into `<p>` tags, converts a `"## "`
line into `<h2>` (without also wrapping it in `<p>`), leaves an inline `<a href="...html">` anchor
untouched, HTML-escapes `&`/`<`/`>` in ordinary text, converts an internal single newline to
`<br>`, and handles empty/null input without throwing; `buildArticleDocument()` produces the
expected page skeleton (DOCTYPE start, `</body></html>` end, escaped EN/ZH titles, both language
bodies present verbatim, the right CTA preset selected — including a graceful fallback to
`"warrants"` for an unrecognized preset value — the author-box credibility component, the sticky
CTA bar, exactly two well-formed `application/ld+json` blocks, and correctly escaped attribute
values); `assembleFromDraftState()` chains `bodyTextToHtml()` into `buildArticleDocument()`
correctly and both derives `readingTimeText` when absent and honors an explicit override;
`computeReadingTimeText()` matches admin's `recalcReadingTime()` formula; and at the CLI level,
`--state-file` round-trips through `--json` output into a document containing both converted
language bodies, while a missing `--state-file` exits non-zero.

## translate-article.js

Component 3 ("Translation") of `extra-md-files/automated-article-scheduler.md`'s five new
components — flagged there as **"the highest-risk new piece"**: nothing in this codebase
auto-translates a full article today. The two existing AI-translate features are both
browser-only, per-field, human-in-the-loop (`admin/index.html`'s `translateNaPair()` and
`suggestGraphZh()`) — this pipeline has no human step by design, so translation
quality/HTML-safety has to be enforced by the script itself, not by a person reading it
after.

**The real risk:** by the time this runs, the EN body already contains real markup —
`<h2>`/`<h3>` headings, `<a href="other-slug.html">` internal links `generate-article.js`'s
link-insertion step wove in, the graph-block `<figure>`. A naive "send the whole HTML
string to an LLM and ask for Chinese back" risks the model paraphrasing inside a tag,
dropping an `href`, or reordering structure. This module avoids that shape of risk
entirely: **it never sends serialized HTML to the model and never re-parses model output
as HTML.**

Design, matching the doc's own spec:

1. **Parse** the EN HTML with `cheerio` (already a dependency).
2. **Walk TEXT NODES ONLY** — never attributes, so every `<a href="...">` keeps its `href`
   untouched by construction (`collectTranslatableTextNodes`) — skipping anything inside a
   `<figure class="graph-block ...">` subtree (those get their own steps-array translation
   via `graph-blocks.js`, not raw-HTML translation) and any whitespace-only node.
3. **Batch every collected text node into ONE structured LLM call** keyed by stable node
   IDs (`{"1": "...", "2": "...", ...}` in, same-shaped JSON out — `buildBatchTranslatePrompt`/
   `parseBatchTranslateResponse`), the same strict-JSON pattern every other LLM-backed script
   here already uses.
4. **Reinsert** each translated string back into its own node, in the SAME cheerio tree
   (`applyTranslatedTextNodes`) — never a raw string replace over serialized HTML, so a
   translated string can never accidentally reopen/close a tag (`dom-serializer` HTML-escapes
   text-node content on output regardless of what the model returns).
5. **Structural sanity check** before accepting the result (`checkStructuralSanity`): same
   tag count, same tag order, same href set (same order) as the EN version. Any mismatch
   **throws** rather than returning a possibly-broken result — same abort-don't-publish rule
   as the coverage/retention gates elsewhere in this pipeline.

`translateArticleBodyHtml(html, opts)` chains all five steps. Everything above is built on
one core primitive, `translateTextMap(idsToTexts, opts)` (prompt build -> call -> parse),
which three thin convenience wrappers also reuse for the doc's other stated translation
targets — same batched-call shape, plain text not HTML: `translateFields()` (title/
subtitle/summary/SEO meta fields — skips any field that's empty/not a string, passing it
through unchanged rather than sending it), `translateStringArray()` (graph-block step
labels, order preserved), and `translateFaqPairs()` (`seo-optimizer.js`'s
`metadata.faq` question/answer array, pair order preserved).

No `admin/index.html` mirror obligation — the two existing browser translate features are
deliberately narrower (single-field, human-reviewed) and don't share this module's
batched/whole-body shape.

```bash
cd scripts
OPENAI_API_KEY=sk-... node translate-article.js --body-file body.html
node translate-article.js --fields-file fields.json --json
node translate-article.js --body-file body.html --stub-translate --json   # offline testing only, see below
```

### Validating without an API key

`validate-translate-article.js` — every check runs against `stubMarkerTranslator`, a
deterministic non-LLM translator `translate-article.js` exports for exactly this purpose
(parses the id->text JSON straight back out of the prompt text and wraps every value with a
`【ZH-STUB】` marker) — also reachable from the real CLI via `--stub-translate`, so the CLI
itself is testable offline too, not just the library functions.

Per the doc's own instruction ("build and validate against real (already-published) article
bodies before ever wiring it into the live orchestrator"), the body-HTML checks run against
a **real published article's EN body**
(`articles/structured-warrant-risks-time-decay-malaysia.html`) rather than a hand-simplified
fixture — it has headings, nested `<strong>`, internal `<a href>` links, a `<table>`,
`<ul>`/`<ol>` lists, `<div class="faq-item">` blocks, and three real
`<figure class="graph-block ...">` blocks, exactly the structural variety this module has to
survive unscathed:

```bash
node validate-translate-article.js
```

It asserts: the prompt/parse round-trip accepts a well-formed response and rejects a
missing id, an unexpected extra id, an empty value, non-JSON, and a JSON array;
`collectTranslatableTextNodes()` finds every real text node in the real article (paragraph,
anchor, table-cell, list-item, and `faq-item` text) while never collecting any graph-block
figcaption/step/spoke text; `translateArticleBodyHtml()` translates ordinary and anchor text,
leaves every graph-block's own text completely untouched, and leaves the href set/order and
tag sequence byte-identical before and after (`checkStructuralSanity` passes on a genuine
translation); `checkStructuralSanity()` actually **throws** on six synthetic mismatches (tag
added/removed, tag order changed, href altered/dropped) — proving the gate itself works, not
just that a clean run doesn't trip it; `translateFields`/`translateStringArray`/
`translateFaqPairs` each round-trip correctly (order preserved, empty fields passed through
untouched, an empty array short-circuits without calling the translator); and at the CLI
level, `--body-file`/`--fields-file` with `--stub-translate` both exit 0 with the expected
shape, passing neither or both of `--body-file`/`--fields-file` exits non-zero, and running
without `--stub-translate` and no `OPENAI_API_KEY` in the shell fails loudly rather than
hanging or silently no-opping.

## auto-publish-article.js

Component 5 ("Orchestrator + scheduling") of
`extra-md-files/automated-article-scheduler.md`, build-order step 5. Wires
every component built in build-order steps 1-4 (`select-topic.js`,
`retrieval-layer.js`, `generate-article.js`, `seo-optimizer.js`,
`graph-blocks.js`, `translate-article.js`, `build-article-document.js`,
`extract-articles.js`, `extract-entities.js`) into the single unattended run
the doc's "Orchestration order" section specifies — topic selection → EN
draft+review → SEO → EN chart → ZH translation (title/subtitle/category/SEO/
body/chart steps) → ZH chart swapped into the translated body → full page
assembly → `articles.html`/`sitemap.xml` updates → knowledge-graph
extraction+the §3 fact-retention check → history-ledger update → **a draft
PR on a fresh branch** (not a direct commit to the default branch — see the
doc's 2026-08-14 addendum amending decision 1: the owner does not consider
zero human review before live financial-education content publishes an
acceptable starting risk, even with every technical safety gate passing).

The exported `runPipeline(opts)` is the git-free core (steps 1-13 — cadence
gate through the history-ledger write); `main()`/`gitPublish()` are the only
things that ever touch git (step 14), and only after a real (non-dry-run)
`runPipeline()` result comes back `status: "ok"`. Every LLM call site is
dependency-injected exactly like every sibling script here (`writer`/
`reviewer`/`seoWriter`/`translator`/`extract`/`judge`, all defaulting to the
real OpenAI-backed functions), so the whole pipeline is testable offline —
see "Validating without an API key" below.

Five safety gates, each an abort — no partial write is ever committed, and
any local file already written by that same run (articles/<slug>.html,
articles.html, sitemap.xml, admin/knowledge-graph.db/.json) is rolled back
byte-for-byte if a later gate in the same run fails:
- `no-topic` / `slug-collision` — select-topic.js found nothing eligible, or
  the picked slug already has an `articles/*.html` file (shouldn't happen
  given the history ledger, but checked anyway).
- `duplicate-risk-high` — a fresh `retrieval-layer.js` duplicate-risk check on
  the selected topic (belt-and-suspenders on top of select-topic.js's own
  exclusion — matters when `--topic` bypasses selection entirely).
- `coverage-review-failed` / `coverage-gap` — the reviewer call itself failed,
  or a checklist item is still "missing" after generate-article.js's one
  repair retry (this pipeline has no human to hand a partial result to).
- `translation-failed` — translate-article.js's own structural-sanity check
  (or any translator-call failure) — never publish a possibly-broken ZH page.
- `graph-extraction-failed` — extract-entities.js's `processArticle()` (which
  already chains the LLM extraction write + the §3 fact-retention checker)
  came back anything other than `"ok"`.

Cadence: reads `admin/auto-article-history.json`'s most recent `publishedAt`
and only proceeds past topic selection if `today - lastPublishedAt` is at
least a randomized 14-21 day target (rerolled every check, via
`isDueForNextCycle()`) — otherwise `status: "not-due"`, a normal no-op exit 0.
`--force` skips this gate.

```bash
cd scripts
OPENAI_API_KEY=sk-... node auto-publish-article.js --dry-run                 # real LLM calls, zero disk/git writes
OPENAI_API_KEY=sk-... node auto-publish-article.js --dry-run --topic "..."   # skip auto-selection, test one topic
OPENAI_API_KEY=sk-... node auto-publish-article.js --force                   # real run: writes files, commits, pushes, opens a draft PR
OPENAI_API_KEY=sk-... node auto-publish-article.js --force --no-push         # real run, local commit only -- for a first test on a disposable branch
node auto-publish-article.js --dry-run --stub-translate \
  --writer-fixture-dir D --reviewer-fixture-dir D --seo-fixture-dir D \
  --extract-fixture-dir D --judge-fixture-dir D                              # fully offline smoke test, no API key/network
```

`--base-branch` overrides the PR's target branch (default: read from
`git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`).
`--writer-model`/`--reviewer-model`/`--seo-model`/`--translate-model`/
`--extract-model` override each component's own default model tier (every
component already defaults to `gpt-4o-mini` except the writer, which uses
`gpt-4o` — see each script's own section above); leaving them unset lets each
component's own default apply. `--min-days`/`--max-days` override the cadence
gate's 14/21-day bounds. `--json` prints a single machine-readable result
object instead of the human-readable report (suppresses every other
`console.log` in `main()`, matching every sibling script's own `--json`
convention) — note this only covers `runPipeline()`'s own steps; a real
(non-dry-run, non-`--json`) run's `git`/`gh` subcommands still print their own
output via `stdio: 'inherit'`.

No `admin/index.html` mirror obligation and no entry in
`validate-admin-mirror-sync.js` — this script has no browser equivalent
(`admin/index.html`'s New Article wizard is the human-in-the-loop path this
pipeline exists to run without).

### Validating without an API key

`validate-auto-publish-article.js` drives the exported `runPipeline()`
directly with fixture/stub functions for every LLM call site (matching every
sibling script's own dependency-injection pattern), against a fully isolated
temp workspace under `scripts/output/auto-publish-fixtures/` (gitignored) — a
schema-only (empty) db, a synthetic 2-entry catalog, an empty `articles/`
dir, and throwaway `articles.html`/`sitemap.xml`/history-ledger files. The
real repo files (`admin/knowledge-graph.db`, `articles/`, `articles.html`,
`sitemap.xml`, `admin/auto-article-history.json`) are never read or written,
and `gitPublish()`/step 14 is never exercised at all (a validator should
never touch real git state) — every check is against `runPipeline()`'s
git-free core.

```bash
node validate-auto-publish-article.js
```

It asserts: every pure helper (`isDueForNextCycle`, `buildUpdatedArticlesListing`,
`buildUpdatedSitemap`, `replaceGraphFigure`, `deriveCategory`,
`snapshotFile`/`restoreSnapshot`) behaves correctly in isolation; a
`--dry-run` happy-path run (real steps 1-8 against fixtures, including a real
`stubMarkerTranslator` translation pass) returns `status: "ok"` with a
`【ZH-STUB】`-marked ZH title/body, exactly one graph figure in each language's
body (the ZH one built from the *translated* steps, not the stale EN one),
and writes nothing to disk at all; each of the five abort gates above fires
for real (a seeded near-duplicate `articles` row for `duplicate-risk-high`, a
reviewer fixture reporting a `"missing"` item for `coverage-gap`, a
throwing translator for `translation-failed`) and leaves the workspace
byte-for-byte untouched in every case; a real (non-dry-run) publish actually
writes `articles/<slug>.html` with the `.course-hero`/`.article-body`
structure `extract-articles.js` requires, links it from `articles.html` and
`sitemap.xml`, writes a real entity into the db via
`extract-entities.js`'s `processArticle()`, regenerates the JSON mirror, and
appends exactly one history-ledger entry; re-running the same topic afterward
is refused with `slug-collision` rather than overwritten; a bare rerun
(no `--force`) right after that publish reports `not-due`; a second real
publish whose judge fixture reports a fabricated `"dropped"` item comes back
`graph-extraction-failed` and rolls back everything steps 8-12 touched — the
new article file is deleted and `articles.html`/`sitemap.xml`/the db/the JSON
mirror are all restored byte-for-byte, with the history ledger never
touched; and at the CLI level, `--dry-run --json` against the same isolated
paths exits 0 with a clean, parseable JSON object (`status: "ok"`,
`dryRun: true`) and no article file written. No `OPENAI_API_KEY`/network
needed — same dependency-injection pattern as every LLM-backed script above.

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
spliced directly into those prompts — **plus two deterministic HTML-assembly
functions** `extra-md-files/automated-article-scheduler.md` explicitly calls
out as carrying the same sync obligation: `graph-blocks.js`'s
`buildFlowGraphHtml` (5th pair) and `build-article-document.js`'s
`buildArticleDocument` (6th pair). It imports the real functions from
`coverage-reviewer.js`/`seo-optimizer.js`/`extract-entities.js`/
`fact-retention-checker.js`/`generate-article.js`/`graph-blocks.js`/
`build-article-document.js`, slices the matching mirror function's source text
straight out of `admin/index.html` (brace-matched, comment/string-aware) and
evals it in a `vm` sandbox, then calls both sides with identical fixtures and
asserts the output strings are byte-for-byte equal:

```bash
cd scripts
node validate-admin-mirror-sync.js
```

The `buildArticleDocument` pair needs several more admin-side dependencies
extracted alongside it than any prompt-building pair did (`escapeAttr`,
`jsonLdScript`, `truncateWords`/`truncateChars`, `formatMonthYear(Zh)`,
`readingTimeTextZh`, and the static `NAV_HTML`/`FOOTER_HTML`/`CTA_PRESETS`
chrome constants) — the last three needed a new `extractVarStatementSource()`
helper alongside the existing `extractVarDecl()`, since they're `var X =
[...].join('\n');`/object-literal statements, not `extractVarDecl`'s
single-line array shape. `naGraphBlocks` (the wizard's live graph-panel
state `buildArticleDocument` closure-reads) is **not** extracted from
`admin/index.html` at all — it's synthesized as `var naGraphBlocks = [];` in
the sandbox instead, which is exactly the "no graph blocks inserted" case
this validator's fixtures exercise (see `build-article-document.js`'s own
section above for why the Node `buildArticleDocument()` expects final body
HTML rather than replicating that placeholder-substitution behavior). One
extraction is hand-written rather than sliced out of `admin/index.html`:
`escapeAttr`'s one-line body (`escapeHtml(str).replace(/"/g, '&quot;')`)
contains a bare `"` inside a *regex literal*, which the extractor's
string/comment-aware (but deliberately regex-literal-blind, per its own
header) brace-balancer misreads as the start of a string, then runs away
consuming the file far past `escapeAttr`'s real closing brace. Since
`escapeAttr` is a frozen two-line dependency (not itself a validated pair),
its known-correct source is inlined as a literal string instead of teaching
the scanner to distinguish regex literals from division.

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
excerpt for each failing pair) if any of the six covered functions has
drifted from its mirror; safe to run any time either side changes, and worth
adding to a pre-push check alongside the other `validate-*.js` scripts
above.
