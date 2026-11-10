import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact, searchFactsFiltered, setFactTags, FACT_KNN_MAX } from '../src/fact-db.js';
import { createRelation } from '../src/ontology-db.js';
import { summarizeRelated, clipLine, RELATED_MAX_ITEMS, RELATED_MAX_CHARS } from '../src/related-format.js';
import { formatFactSearch, formatFactTrace, formatCrossProjectInsights, formatGraphExploration, TRACE_MAX_SOURCES } from '../src/facts-tool.js';
import { vecAt, QUERY_VECTOR } from './helpers/search-seed.js';

const PROJECT = '/work/project-a';
const OTHER = '/work/project-b';

let tmpDir: string;
let db: Database.Database;
const prevDb = process.env.MEMORY_BANK_DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-facts-tool-'));
  process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'db.sqlite');
  db = initDatabase();
});

afterEach(() => {
  db.close();
  if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let axis = 0;
function fact(text: string, theta: number, over: { scope?: 'global' | 'project'; project?: string | null; category?: string; agent?: string; sources?: string[] } = {}): string {
  const scope = over.scope ?? 'project';
  return insertFact(db, {
    fact: text,
    category: over.category ?? 'knowledge',
    scope_type: scope,
    scope_project: scope === 'global' ? null : (over.project ?? PROJECT),
    source_exchange_ids: over.sources ?? [],
    embedding: vecAt(theta, 1 + (axis++ % 300)),
    coding_agent: over.agent,
  });
}

// SQ-10 — scope, category, agent and tag conditions ran after the candidate list was cut, so facts that
// exist came back as "no matching facts".
describe('searchFactsFiltered: conditions apply before the cut', () => {
  it('returns the in-scope facts behind 60 nearer facts of another project', () => {
    for (let i = 0; i < 60; i++) fact(`Other project note number ${i} about deploys`, 0.05 + i * 0.004, { project: OTHER });
    const mine = Array.from({ length: 10 }, (_, i) => fact(`Project A rule number ${i} about deploys`, 0.4 + i * 0.01));

    const { results, truncated } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 10 });
    expect(results.map((r) => r.fact.id)).toEqual(mine);
    expect(truncated).toBe(false);
  });

  it('fills the limit with facts that pass the category filter', () => {
    for (let i = 0; i < 80; i++) fact(`Knowledge note number ${i} about the billing webhook`, 0.05 + i * 0.003);
    const decisions = Array.from({ length: 6 }, (_, i) => fact(`Decision number ${i} about the billing webhook`, 0.4 + i * 0.01, { category: 'decision' }));

    const { results } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 5, filter: (f) => f.category === 'decision' });
    expect(results.map((r) => r.fact.id)).toEqual(decisions.slice(0, 5));
  });

  it('`other-projects` skips the current project and global facts instead of spending the limit on them', () => {
    for (let i = 0; i < 40; i++) fact(`Global habit number ${i} about notifications`, 0.05 + i * 0.004, { scope: 'global' });
    for (let i = 0; i < 20; i++) fact(`Project A habit number ${i} about notifications`, 0.25 + i * 0.004);
    const theirs = Array.from({ length: 4 }, (_, i) => fact(`Project B habit number ${i} about notifications`, 0.45 + i * 0.01, { project: OTHER }));

    const { results } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, scope: 'other-projects', limit: 5, threshold: 0.5 });
    expect(results.map((r) => r.fact.id)).toEqual(theirs);
  });

  it('stops at the similarity threshold without growing the search', () => {
    fact('Near enough fact about the release checklist', 0.2);
    fact('Far fact about something else entirely', 1.3);
    const { results, examined } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 10, threshold: 0.85 });
    expect(results.map((r) => r.fact.fact)).toEqual(['Near enough fact about the release checklist']);
    expect(examined).toBe(2);
  });

  it('says so when the vector ceiling is reached before the limit is filled', () => {
    expect(FACT_KNN_MAX).toBe(4096);
    db.transaction(() => {
      for (let i = 0; i < FACT_KNN_MAX + 50; i++) fact(`Other project filler fact number ${i}`, 0.05 + (i % 40) * 0.005, { project: OTHER });
    })();
    const wanted = fact('The one in-scope fact, beyond the ceiling', 0.6);

    const { results, truncated, examined } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 3, threshold: 0.5 });
    expect(results.map((r) => r.fact.id)).not.toContain(wanted);
    expect(results).toEqual([]);
    expect(truncated).toBe(true);
    expect(examined).toBe(FACT_KNN_MAX);
  });
});

// SQ-09 — the same sentence is stored under several ids (double imports, re-extraction) and filled the
// result list with copies.
describe('searchFactsFiltered: identical sentences are folded', () => {
  it('one row per sentence (whitespace and case ignored), with the folded ids, and the limit still filled', () => {
    const first = fact('Always answer in Korean', 0.10, { scope: 'global' });
    const copy1 = fact('always   answer in korean', 0.11, { scope: 'global' });
    const copy2 = fact('Always answer in Korean', 0.12);
    const second = fact('Send a Telegram note when the work is done', 0.2);
    const third = fact('Commit and push in separate commands', 0.3);

    const { results } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 3, threshold: 0.5, foldSameText: true });
    expect(results.map((r) => r.fact.id)).toEqual([first, second, third]);
    expect(results[0].duplicateIds).toEqual([copy1, copy2]);
    expect(results[1].duplicateIds).toEqual([]);

    const unfolded = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 3, threshold: 0.5 });
    expect(unfolded.results.map((r) => r.fact.id)).toEqual([first, copy1, copy2]);
  });

  it('a copy ranked after the limit is still reported under its sentence', () => {
    const first = fact('Always answer in Korean', 0.10, { scope: 'global' });
    const second = fact('Send a Telegram note when the work is done', 0.2);
    const lateCopy = fact('Always answer in Korean', 0.5);
    const { results } = searchFactsFiltered(db, QUERY_VECTOR, { project: PROJECT, limit: 2, threshold: 0.5, foldSameText: true });
    expect(results.map((r) => r.fact.id)).toEqual([first, second]);
    expect(results[0].duplicateIds).toEqual([lateCopy]);
  });
});

// ONT-07 / SQ-16 — every neighbour of a fact was printed in full: one fact carried 106 neighbours and
// 76,620 characters, and a project-scoped search listed other projects' facts as "Related".
describe('related facts in tool output are few, short and in scope', () => {
  it('summarizeRelated: belief-changing relations first, capped, clipped', () => {
    const related = [
      ...Array.from({ length: 9 }, (_, i) => ({ fact: { fact: `supporting fact ${i} ${'s'.repeat(500)}` }, relation: { relation_type: 'SUPPORTS' } })),
      { fact: { fact: 'the newer decision' }, relation: { relation_type: 'SUPERSEDES' } },
      { fact: { fact: 'the opposite claim' }, relation: { relation_type: 'CONTRADICTS' } },
    ];
    const summary = summarizeRelated(related);
    expect(RELATED_MAX_ITEMS).toBe(5);
    expect(RELATED_MAX_CHARS).toBe(160);
    expect(summary.shown.map((l) => l.relationType)).toEqual(['CONTRADICTS', 'SUPERSEDES', 'SUPPORTS', 'SUPPORTS', 'SUPPORTS']);
    expect(summary.shown[2].text).toMatch(/^supporting fact 0 s+…$/);
    expect(summary.shown.every((l) => l.text.length <= RELATED_MAX_CHARS)).toBe(true);
    expect(summary.omitted).toBe(6);
    expect(summarizeRelated([]).shown).toEqual([]);
  });

  it('clipLine collapses whitespace and never ends on half a surrogate pair', () => {
    expect(clipLine('a\n\n b\tc', 10)).toBe('a b c');
    const clipped = clipLine('x'.repeat(8) + '😀😀', 10);
    expect(clipped).toBe('x'.repeat(8) + '…');
  });

  it('search_facts: at most 5 related lines per fact, none from another project, the rest counted', () => {
    const hub = fact('The hub decision about caching', 0.1);
    for (let i = 0; i < 8; i++) createRelation(db, hub, 'SUPPORTS', fact(`In-scope neighbour ${i} ${'n'.repeat(300)}`, 1.3));
    for (let i = 0; i < 4; i++) createRelation(db, hub, 'SUPPORTS', fact(`Foreign neighbour ${i}`, 1.3, { project: OTHER }));

    const text = formatFactSearch(db, QUERY_VECTOR, { query: 'caching', project: PROJECT, limit: 1 });
    expect(text).toContain('## [knowledge] The hub decision about caching');
    const relatedLines = [...text.matchAll(/^  - \[SUPPORTS\] (.*)$/gm)];
    expect(relatedLines).toHaveLength(5);
    expect(relatedLines.every((m) => m[1].length <= RELATED_MAX_CHARS)).toBe(true);
    expect(text).not.toContain('Foreign neighbour');
    expect(text).toMatch(/…and 3 more related facts/);
  });

  it('search_facts: filters, folded copies and the result count', () => {
    const kept = fact('Deploys go through the staging gate first', 0.1, { category: 'decision', agent: 'codex' });
    const copy = fact('Deploys go through the staging gate first', 0.15, { category: 'decision', agent: 'codex', scope: 'global' });
    fact('A nearer fact of another category', 0.05);
    fact('A decision of another agent', 0.12, { category: 'decision' });
    setFactTags(db, kept, ['verified']);
    setFactTags(db, copy, ['verified']);

    const text = formatFactSearch(db, QUERY_VECTOR, { query: 'deploys', project: PROJECT, limit: 5, category: 'decision', coding_agent: 'codex', tags: ['Verified'] });
    expect(text).toMatch(/Results: 1\n/);
    expect(text).toContain(`- ID: ${kept}`);
    expect(text).toContain(`- Same sentence also stored as: ${copy}`);
    expect(text).not.toContain('another category');
    expect(text).not.toContain('another agent');
  });

  it('search_facts: no match says so', () => {
    expect(formatFactSearch(db, QUERY_VECTOR, { query: 'nothing', project: PROJECT, limit: 5 })).toContain('_No matching facts found._');
  });

  it('trace_fact: lists the newest source conversations up to the cap and counts the rest', () => {
    const sources: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < 40; i++) {
        const id = `ex-${String(i).padStart(2, '0')}`;
        sources.push(id);
        insertExchange(db, {
          id, project: 'demo', timestamp: `2026-10-${String(i % 28 + 1).padStart(2, '0')}T00:00:00.000Z`,
          userMessage: `source question ${i} ${'q'.repeat(1000)}`, assistantMessage: 'a', archivePath: `/archive/demo/s${i}.jsonl`, lineStart: 1, lineEnd: 2,
        }, vecAt(1.0, 1 + i));
      }
    })();
    const traced = fact('A fact with many sources', 0.1, { sources: [...sources, 'gone-1', 'gone-2'] });
    for (let i = 0; i < 9; i++) createRelation(db, traced, 'INFLUENCES', fact(`Trace neighbour ${i}`, 1.3));

    const text = formatFactTrace(db, QUERY_VECTOR, { query: 'sources', project: PROJECT, limit: 1 });
    expect(TRACE_MAX_SOURCES).toBe(5);
    expect(text).toContain('## A fact with many sources');
    expect([...text.matchAll(/^- \*\*\[demo, \d{4}-\d{2}-\d{2}\]\*\*$/gm)]).toHaveLength(5);
    expect(text).toMatch(/…and 35 more source exchanges/);
    expect(text).toMatch(/2 recorded source ids are no longer in the index/);
    expect(text).not.toMatch(/q{201}/); // each source shows a 200-char look
    expect([...text.matchAll(/^- \*\*\[INFLUENCES\]\*\* /gm)]).toHaveLength(5);
    expect(text).toMatch(/…and 4 more related facts/);
  });

  it('trace_fact and explore_graph find the project\'s fact behind 60 nearer facts of another project', () => {
    for (let i = 0; i < 60; i++) fact(`Other project note number ${i} about releases`, 0.05 + i * 0.004, { project: OTHER });
    fact('Project A ships releases on Tuesdays', 0.5);

    expect(formatFactTrace(db, QUERY_VECTOR, { query: 'releases', project: PROJECT, limit: 3 })).toContain('## Project A ships releases on Tuesdays');
    const explored = formatGraphExploration(db, QUERY_VECTOR, { query: 'releases', hops: 1, project: PROJECT });
    expect(explored).toContain('## Seed: Project A ships releases on Tuesdays');
    expect(explored).not.toContain('Other project note');
  });

  it('trace_fact: no fact to trace says so', () => {
    expect(formatFactTrace(db, QUERY_VECTOR, { query: 'nothing', project: PROJECT, limit: 3 })).toBe('No matching facts found to trace.');
  });

  it('cross_project_insights: other projects only, grouped by project', () => {
    for (let i = 0; i < 30; i++) fact(`Global note number ${i} on retries`, 0.05 + i * 0.004, { scope: 'global' });
    fact('Project A retry rule', 0.2);
    const theirs = fact('Project B retries three times with backoff', 0.5, { project: OTHER });

    const text = formatCrossProjectInsights(db, QUERY_VECTOR, { query: 'retries', currentProject: PROJECT, limit: 5 });
    expect(text).toContain(`## Project: ${OTHER}`);
    expect(text).toContain('Project B retries three times with backoff');
    expect(text).not.toContain('Global note');
    expect(text).not.toContain('Project A retry rule');
    expect(theirs).toBeTruthy();
  });

  it('explore_graph: connected facts are clipped and capped per seed', () => {
    const seed = fact('The seed fact about indexing', 0.1);
    for (let i = 0; i < 40; i++) createRelation(db, seed, 'SUPPORTS', fact(`Connected fact ${i} ${'c'.repeat(600)}`, 1.4));

    const text = formatGraphExploration(db, QUERY_VECTOR, { query: 'indexing', hops: 1, project: PROJECT });
    expect(text).toContain('## Seed: The seed fact about indexing');
    const connected = [...text.matchAll(/^- \*\*\[SUPPORTS\]\*\* (.*)$/gm)];
    expect(connected).toHaveLength(20);
    expect(connected.every((m) => m[1].length <= 300)).toBe(true);
    expect(text).toMatch(/…and 20 more connected facts/);
  });
});
