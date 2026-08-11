-- Knowledge-graph store schema for the AI Article Generation Pipeline.
--
-- Canonical source: extra-md-files/ai-article-pipeline.md, §2 "Logical schema" (the
-- "SQL -- this is the real schema, not a JSON stand-in" block). This file is that block,
-- verbatim, plus indexes (marked below) -- it is the version-controlled, human-diffable DDL
-- source of truth for admin/knowledge-graph.db. The compiled .db is opaque in git diffs
-- (see §2's storage-format rationale, an accepted trade-off, not a gap) -- re-run this file
-- to rebuild or verify the schema rather than editing the .db by hand.
--
-- Read/written via the GitHub Contents API per that doc -- there is no server process for
-- this repo (see root CLAUDE.md). Applying this file does not touch article HTML under
-- articles/, which stays the single source of truth for content (§2 "Article source of truth").

PRAGMA foreign_keys = ON;

-- Free-form key/value metadata about this store (description, schema_source,
-- generated_at, generated_by, article_count -- see regenerateJsonMirror() in
-- scripts/extract-articles.js for the shape currently written here).
CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Core article records
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    slug TEXT UNIQUE,           -- filename stem, e.g. "what-are-structured-warrants-malaysia"
                                 -- (matches sitemap.xml / articles.html cards / admin's URL-slug
                                 -- field -- joins cleanly with existing site data)
    filepath TEXT,               -- "articles/<slug>.html"
    title TEXT,
    summary TEXT,
    body_text TEXT,               -- cleaned, boilerplate-stripped ENGLISH content
    published_at TEXT,
    last_updated TEXT,
    status TEXT                  -- draft, published, archived
);

-- Entities/topics extracted from articles
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY,
    name TEXT,
    type TEXT                   -- topic, product, person, concept, etc.
);

-- Which entities appear in which articles. UNIQUE(article_id, entity_id) is
-- defense in depth against extract-entities.js writing the same entity twice
-- for one article (e.g. a same-name-different-casing duplicate that slipped
-- past parseExtractionResponse's own dedup) -- see insertArticleEntity's
-- INSERT OR REPLACE in scripts/extract-entities.js.
CREATE TABLE IF NOT EXISTS article_entities (
    article_id INTEGER REFERENCES articles(id),
    entity_id INTEGER REFERENCES entities(id),
    relevance_score REAL,
    UNIQUE(article_id, entity_id)
);

-- Relationships between entities (the "graph" part). Deliberately global/
-- entity-level, not per-article — an edge belongs to whichever entity pair it
-- connects, not to "the article that created it" (there is no article_id
-- here, and none is planned; see §2 Step 8 in ai-article-pipeline.md).
--
-- KNOWN LIMITATION: because of that, scripts/extract-entities.js's
-- writeExtractionResult() re-extracting ONE article deletes every edge
-- between that article's own entity set — including an edge that happens to
-- connect two entities also used by a DIFFERENT article, even though this
-- write only has that other article's edge secondhand (via shared entities,
-- not because it re-extracted that article too). If that edge doesn't get
-- re-emitted by the current article's own extraction, it silently
-- disappears from the graph until something re-extracts the other article.
-- This is a real cross-article overwrite risk, not a hypothetical — see the
-- comment on writeExtractionResult() for the mechanics. Fixing it properly
-- would mean adding an article_id column here (tracking per-article
-- provenance) plus a separate global dedup/merge pass for display, since the
-- same real-world edge could then be legitimately duplicated per article.
-- That's a structural change, intentionally not done yet — this comment
-- exists so the gap is a documented, known trade-off rather than a silent
-- surprise discovered via a missing edge.
CREATE TABLE IF NOT EXISTS edges (
    source_entity_id INTEGER REFERENCES entities(id),
    relation TEXT,               -- related_to, prerequisite_of, part_of, contradicts, updates
    target_entity_id INTEGER REFERENCES entities(id)
);

-- Existing/generated internal links between articles
CREATE TABLE IF NOT EXISTS links (
    source_article_id INTEGER REFERENCES articles(id),
    target_article_id INTEGER REFERENCES articles(id),
    link_text TEXT
);

-- Phase 1 (Source Article Collection) — extra-md-files/ai-article-pipeline.md's Phase 1,
-- MVP-scoped per extra-md-files/pipeline-phase-4-6-7-1-mvp.md §4: manual-paste import only
-- (no live scanning of any external domain). Rows are staged by the admin's "Import Source
-- Article" form as pending/*.json (see scripts/import-source-articles.js), then synced into
-- this table by that script. `status` covers the doc's full lifecycle, but this pass only
-- ever writes 'pending' (staged, not yet synced) and 'imported' (synced by the script) --
-- 'reviewed'/'ready'/'generated'/'published'/'ignored' stay unused until a later pass
-- actually builds the workflow that would set them, rather than faking unused UI now.
CREATE TABLE IF NOT EXISTS source_articles (
    id INTEGER PRIMARY KEY,
    title TEXT,
    slug TEXT,                   -- generated from title if not already present on import
    original_url TEXT,
    published_at TEXT,
    author TEXT,
    category TEXT,
    original_content TEXT,       -- full pasted source text (§ Phase 1's manual-paste fallback)
    featured_image TEXT,
    import_date TEXT,
    status TEXT CHECK (status IN ('pending', 'imported', 'reviewed', 'ready', 'generated', 'published', 'ignored')),
    notes TEXT
);

-- ---------------------------------------------------------------------------
-- Indexes -- NOT part of §2's SQL block. Added because SQLite does not
-- auto-index REFERENCES columns, and §2 Step 6 (the retrieval layer) walks
-- exactly these FK columns: entities for an article, articles for an entity,
-- edges in both directions, and existing links in both directions.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_article_entities_article ON article_entities(article_id);
CREATE INDEX IF NOT EXISTS idx_article_entities_entity  ON article_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_article_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_article_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_articles_slug ON source_articles(slug);
CREATE INDEX IF NOT EXISTS idx_source_articles_status ON source_articles(status);

-- entities.name has no declared UNIQUE (the column itself is just TEXT, above) but every writer
-- -- extract-entities.js's writeExtractionResult() -- already looks it up `WHERE name = ?
-- COLLATE NOCASE` before ever inserting, so in practice it's already 1:1. This index turns that
-- practice into an enforced guarantee (case-insensitive, matching that lookup) instead of a
-- convention a future writer could silently break -- see admin/index.html's kcExpandRelatedEntities()
-- comment, which keys a browser-side entity graph by name and depends on this holding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name COLLATE NOCASE);
