#!/usr/bin/env node
/**
 * Focused retrieval-layer regression checks. These are intentionally small and
 * fixture-local: the generic `related_to` bug should fail before writer/reviewer
 * fixtures or the real knowledge graph are involved.
 */

import { DatabaseSync } from 'node:sqlite';
import { buildRetrievalContext, expandRelatedEntities, suggestInternalLinks } from './retrieval-layer.js';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT);
    CREATE TABLE edges (source_entity_id INTEGER, relation TEXT, target_entity_id INTEGER);
    CREATE TABLE articles (id INTEGER PRIMARY KEY, slug TEXT, filepath TEXT, title TEXT, summary TEXT);
    CREATE TABLE article_entities (article_id INTEGER, entity_id INTEGER, relevance_score REAL);
    CREATE TABLE source_articles (
      id INTEGER PRIMARY KEY,
      title TEXT,
      slug TEXT,
      category TEXT,
      keywords TEXT,
      original_content TEXT,
      original_url TEXT,
      status TEXT
    );
  `);

  const insertEntity = db.prepare('INSERT INTO entities (id, name, type) VALUES (?, ?, ?)');
  insertEntity.run(1, 'Stock Trading Course', 'topic');
  insertEntity.run(2, 'Gap Trading', 'strategy');
  insertEntity.run(3, 'Course Selection Criteria', 'concept');
  insertEntity.run(4, 'HSI Structured Warrants', 'product');
  insertEntity.run(5, 'Call Warrant', 'product');

  const insertEdge = db.prepare('INSERT INTO edges (source_entity_id, relation, target_entity_id) VALUES (?, ?, ?)');
  insertEdge.run(1, 'related_to', 2);
  insertEdge.run(1, 'part_of', 3);
  insertEdge.run(2, 'related_to', 4);
  insertEdge.run(1, 'distinguished_from', 5);

  const insertArticle = db.prepare('INSERT INTO articles (id, slug, filepath, title, summary) VALUES (?, ?, ?, ?, ?)');
  insertArticle.run(1, 'hsi-structured-warrants-malaysia', 'hsi.html', 'HSI Structured Warrants Malaysia', 'A page about HSI structured warrants.');
  insertArticle.run(2, 'choosing-a-trading-course', 'course.html', 'Choosing a Trading Course', 'A page about choosing trading courses.');

  const insertArticleEntity = db.prepare('INSERT INTO article_entities (article_id, entity_id, relevance_score) VALUES (?, ?, ?)');
  insertArticleEntity.run(1, 4, 0.95);
  insertArticleEntity.run(1, 2, 0.3); // passing mention: must not become a strong Gap Trading link target
  insertArticleEntity.run(2, 1, 0.9);
  insertArticleEntity.run(2, 3, 0.8);

  return db;
}

function assertCheck(checks, label, passed) {
  checks.push([label, Boolean(passed)]);
}

function run() {
  const checks = [];
  const db = setupDb();
  try {
    const context = buildRetrievalContext(db, 'Stock Trading Course');
    const checklistNames = context.checklist.map((c) => c.name);
    assertCheck(checks, 'seed entity remains required coverage', checklistNames.includes('Stock Trading Course'));
    assertCheck(checks, 'specific relation expands into required coverage', checklistNames.includes('Course Selection Criteria'));
    assertCheck(checks, 'generic related_to does not expand into required coverage by default', !checklistNames.includes('Gap Trading'));
    assertCheck(checks, 'second-hop topic pollution stays out too', !checklistNames.includes('HSI Structured Warrants'));
    assertCheck(checks, 'excluded weak related_to edges are reported for debugging', context.weakRelationWarnings.some((e) => e.source === 'Stock Trading Course' && e.target === 'Gap Trading'));
    assertCheck(checks, 'article summaries follow the filtered required entity set', context.articleSummaries.every((a) => a.slug !== 'hsi-structured-warrants-malaysia'));

    // relation passthrough (added for detectOffTopicSections() — admin-ai-article-creator-test-run
    // memory, 2026-08-20 addendum): buildChecklist() must carry each hop's raw edge relation type,
    // not just the formatted `why` string, so downstream code can distinguish a CONTRAST relation
    // (distinguished_from/contradicts) from a composing one (part_of/prerequisite_of) without
    // re-parsing prose.
    const seedItem = context.checklist.find((c) => c.name === 'Stock Trading Course');
    const partOfItem = context.checklist.find((c) => c.name === 'Course Selection Criteria');
    const contrastItem = context.checklist.find((c) => c.name === 'Call Warrant');
    assertCheck(checks, 'hop-0 seed checklist item carries relation: null', seedItem?.relation === null);
    assertCheck(checks, 'part_of hop-1 checklist item carries its raw relation type', partOfItem?.relation === 'part_of');
    assertCheck(checks, 'distinguished_from hop-1 checklist item carries its raw relation type', contrastItem?.relation === 'distinguished_from');

    const seeds = [{ id: 1, name: 'Stock Trading Course', type: 'topic', reason: 'test seed' }];
    const weakIncluded = expandRelatedEntities(db, seeds, { includeWeakRelations: true }).map((e) => e.name);
    assertCheck(checks, 'includeWeakRelations remains available for diagnostics/manual exploration', weakIncluded.includes('Gap Trading'));

    const weakLink = suggestInternalLinks(
      [
        {
          articleId: 1,
          slug: 'hsi-structured-warrants-malaysia',
          title: 'HSI Structured Warrants Malaysia',
          matchedEntities: [{ name: 'Gap Trading', relevance_score: 0.3 }],
        },
      ],
      [{ id: 2, name: 'Gap Trading', type: 'strategy', reason: 'test seed' }]
    );
    assertCheck(checks, 'internal links require a strong target-entity relevance score by default', weakLink.length === 0);

    const strongLink = suggestInternalLinks(
      [
        {
          articleId: 3,
          slug: 'gap-trading-malaysia',
          title: 'Gap Trading Malaysia',
          matchedEntities: [{ name: 'Gap Trading', relevance_score: 0.85 }],
        },
      ],
      [{ id: 2, name: 'Gap Trading', type: 'strategy', reason: 'test seed' }]
    );
    assertCheck(checks, 'strong target-entity relevance still produces an internal link', strongLink.length === 1 && strongLink[0].targetSlug === 'gap-trading-malaysia');
  } finally {
    db.close();
  }

  let failures = 0;
  for (const [label, passed] of checks) {
    if (passed) console.log(`  ok   ${label}`);
    else {
      failures++;
      console.error(`  FAIL ${label}`);
    }
  }
  console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
  if (failures) process.exit(1);
}

run();
