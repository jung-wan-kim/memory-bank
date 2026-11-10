import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase, getVecQuant, embeddingToVecBlob } from '../src/db.js';
import { insertFact, deactivateFact, insertRevision, searchSimilarFacts } from '../src/fact-db.js';
import {
  restoreKoreanFromMergedFacts,
  restoreKoreanOncePerVersion,
  koreanRestoreStatePath,
} from '../src/fact-kr-restore.js';

/**
 * Facts that already lost their Korean sentence to a rewrite get it back from
 * the fact that was merged into them — when the ledger shows that is where
 * their sentence came from.
 *
 * Before the rewrite path carried the Korean sentence along, a fact that took
 * over another fact's sentence was left with fact_kr NULL and no Korean vector
 * (92 of 92 rewritten facts on a replay over a copy of the live store). The
 * merged-away row is still in the table with the Korean sentence of exactly
 * that sentence; only its vector is gone (an inactive fact has none).
 */

function textVector(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v = Array.from({ length: 384 }, () => next() - 0.5);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

describe('restoring the Korean sentence of facts rewritten without one', () => {
  let dir: string;
  let db: Database.Database;
  let embedded: string[];
  const embed = async (text: string) => { embedded.push(text); return textVector(text); };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-kr-restore-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'config');
    db = initDatabase();
    embedded = [];
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(s: { fact: string; at: string; factKr?: string; project?: string }): string {
    const id = insertFact(db, {
      fact: s.fact, category: 'decision', scope_type: 'project', scope_project: s.project ?? '/proj',
      source_exchange_ids: [], embedding: textVector(s.fact),
      fact_kr: s.factKr ?? null, embedding_kr: s.factKr ? textVector(s.factKr) : null,
    });
    db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?').run(s.at, s.at, id);
    return id;
  }
  /** What the rewrite did before the fix: `survivor` takes `gone`'s sentence, loses its Korean sentence; `gone` is retired. */
  function mergeWithoutKorean(survivor: string, gone: string): void {
    const s = db.prepare('SELECT fact FROM facts WHERE id = ?').get(survivor) as { fact: string };
    const g = db.prepare('SELECT fact FROM facts WHERE id = ?').get(gone) as { fact: string };
    insertRevision(db, { fact_id: survivor, previous_fact: s.fact, new_fact: g.fact, reason: 'evolved', source_exchange_id: null });
    db.prepare('UPDATE facts SET fact = ?, fact_kr = NULL WHERE id = ?').run(g.fact, survivor);
    db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(survivor);
    deactivateFact(db, gone);
  }
  const row = (id: string) => db.prepare('SELECT fact_kr, updated_at FROM facts WHERE id = ?').get(id) as { fact_kr: string | null; updated_at: string };
  const krBlob = (id: string): string | null => {
    const r = db.prepare('SELECT embedding FROM vec_facts_kr WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
    return r ? Buffer.from(r.embedding).toString('hex') : null;
  };
  const krBlobOf = (text: string) => embeddingToVecBlob(textVector(text), getVecQuant(db, 'vec_facts_kr')).toString('hex');
  const foundByKorean = (text: string) => searchSimilarFacts(db, textVector(text), '/proj', 5, 0.85).map((h) => h.fact.id);

  it('a fact that took over a merged-away fact\'s sentence gets that fact\'s Korean sentence and a Korean vector', async () => {
    const older = seed({ fact: 'The API is served at v1', at: day(1), factKr: 'API 는 v1 으로 제공한다' });
    const later = seed({ fact: 'The API is served at v2', at: day(2), factKr: 'API 는 v2 로 제공한다' });
    mergeWithoutKorean(older, later);
    const updatedBefore = row(older).updated_at;
    expect(foundByKorean('API 는 v2 로 제공한다'), 'fixture: the Korean query finds nothing').toEqual([]);

    const result = await restoreKoreanFromMergedFacts(db, embed);

    expect(result).toEqual({ candidates: 1, restored: 1, remaining: 0 });
    expect(row(older).fact_kr).toBe('API 는 v2 로 제공한다');
    expect(krBlob(older)).toBe(krBlobOf('API 는 v2 로 제공한다'));
    expect(foundByKorean('API 는 v2 로 제공한다')).toEqual([older]);
    expect(embedded).toEqual(['API 는 v2 로 제공한다']);
    expect(row(older).updated_at, 'a repair of the translation is not a change of the fact').toBe(updatedBefore);

    expect(await restoreKoreanFromMergedFacts(db, embed), 'nothing is left to restore').toEqual({ candidates: 0, restored: 0, remaining: 0 });
  });

  it('only a sentence the ledger shows was taken over is restored — and only from a row that kept its own sentence', async () => {
    // (a) never rewritten: a fact that simply has no Korean sentence is not a candidate, even with a same-sentence retired twin.
    const plain = seed({ fact: 'Tests run with vitest', at: day(1) });
    deactivateFact(db, seed({ fact: 'Tests run with vitest', at: day(2), factKr: '테스트는 vitest 로 돈다' }));

    // (b) the same-sentence row was itself rewritten once: its Korean sentence may translate its earlier sentence.
    const b1 = seed({ fact: 'Logs go to stdout', at: day(3), factKr: '로그는 stdout 으로 나간다' });
    const b2 = seed({ fact: 'Logs went to a file', at: day(4), factKr: '로그는 파일로 나갔다' });
    insertRevision(db, { fact_id: b2, previous_fact: 'Logs went to a file', new_fact: 'Logs go to stderr', reason: 'r', source_exchange_id: null });
    db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('Logs go to stderr', b2); // old code: fact_kr kept, now stale
    mergeWithoutKorean(b1, b2);

    // (c) the same-sentence row is in another project.
    const c1 = seed({ fact: 'Builds use esbuild', at: day(5), factKr: '빌드는 esbuild 를 쓴다' });
    const c2 = seed({ fact: 'Builds use rolldown', at: day(6), factKr: '빌드는 rolldown 을 쓴다', project: '/elsewhere' });
    insertRevision(db, { fact_id: c1, previous_fact: 'Builds use esbuild', new_fact: 'Builds use rolldown', reason: 'r', source_exchange_id: null });
    db.prepare('UPDATE facts SET fact = ?, fact_kr = NULL WHERE id = ?').run('Builds use rolldown', c1);
    db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(c1);
    deactivateFact(db, c2);

    // (d) the same-sentence row is still active (not merged away).
    const d1 = seed({ fact: 'CI runs on push', at: day(7), factKr: 'CI 는 push 마다 돈다' });
    seed({ fact: 'CI runs on pull requests', at: day(8), factKr: 'CI 는 PR 마다 돈다' });
    insertRevision(db, { fact_id: d1, previous_fact: 'CI runs on push', new_fact: 'CI runs on pull requests', reason: 'r', source_exchange_id: null });
    db.prepare('UPDATE facts SET fact = ?, fact_kr = NULL WHERE id = ?').run('CI runs on pull requests', d1);
    db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(d1);

    // (e) another fact's revision wrote the same sentence too: which row the Korean sentence belongs to is not certain.
    const e1 = seed({ fact: 'Node 20 is the runtime', at: day(9), factKr: 'Node 20 이 런타임이다' });
    const e2 = seed({ fact: 'Node 22 is the runtime', at: day(10), factKr: 'Node 22 가 런타임이다' });
    mergeWithoutKorean(e1, e2);
    const other = seed({ fact: 'Node 18 is the runtime', at: day(11) });
    insertRevision(db, { fact_id: other, previous_fact: 'Node 18 is the runtime', new_fact: 'Node 22 is the runtime', reason: 'r', source_exchange_id: null });

    const result = await restoreKoreanFromMergedFacts(db, embed);

    expect(result).toEqual({ candidates: 4, restored: 0, remaining: 0 }); // b1, c1, d1, e1 — `plain` is not one
    for (const id of [plain, b1, c1, d1, e1]) {
      expect(row(id).fact_kr).toBeNull();
      expect(krBlob(id)).toBeNull();
    }
    expect(embedded).toEqual([]);
  });

  it('a fact that already has a Korean sentence is left alone', async () => {
    const older = seed({ fact: 'Cache TTL is 5 minutes', at: day(1), factKr: '캐시 TTL 은 5분이다' });
    const later = seed({ fact: 'Cache TTL is 15 minutes', at: day(2), factKr: '캐시 TTL 은 15분이다' });
    mergeWithoutKorean(older, later);
    db.prepare('UPDATE facts SET fact_kr = ? WHERE id = ?').run('캐시 TTL 은 이제 15분', older); // filled by hand meanwhile

    expect(await restoreKoreanFromMergedFacts(db, embed)).toEqual({ candidates: 0, restored: 0, remaining: 0 });
    expect(row(older).fact_kr).toBe('캐시 TTL 은 이제 15분');
  });

  it('the per-pass limit leaves the rest for the next pass and says how many', async () => {
    const survivors: string[] = [];
    for (let i = 0; i < 3; i++) {
      const older = seed({ fact: `Service ${i} listens on port 80`, at: day(1 + i * 2), factKr: `서비스 ${i} 는 80 포트를 쓴다` });
      const later = seed({ fact: `Service ${i} listens on port 8080`, at: day(2 + i * 2), factKr: `서비스 ${i} 는 8080 포트를 쓴다` });
      mergeWithoutKorean(older, later);
      survivors.push(older);
    }

    expect(await restoreKoreanFromMergedFacts(db, embed, { limit: 2 })).toEqual({ candidates: 3, restored: 2, remaining: 1 });
    expect(await restoreKoreanFromMergedFacts(db, embed, { limit: 2 })).toEqual({ candidates: 1, restored: 1, remaining: 0 });
    expect(survivors.map((id) => row(id).fact_kr)).toEqual(survivors.map((_, i) => `서비스 ${i} 는 8080 포트를 쓴다`));
  });

  describe('once per plugin version', () => {
    function clearedPair(n: number): string {
      const older = seed({ fact: `Queue ${n} retries 3 times`, at: day(1 + n * 2), factKr: `큐 ${n} 은 3번 재시도한다` });
      const later = seed({ fact: `Queue ${n} retries 5 times`, at: day(2 + n * 2), factKr: `큐 ${n} 은 5번 재시도한다` });
      mergeWithoutKorean(older, later);
      return older;
    }

    it('runs for a version it has not run for, records the outcome, and does not run again for that version', async () => {
      const first = clearedPair(0);
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed)).toEqual({ candidates: 1, restored: 1, remaining: 0 });
      expect(row(first).fact_kr).toBe('큐 0 은 5번 재시도한다');
      const state = JSON.parse(fs.readFileSync(koreanRestoreStatePath(), 'utf8'));
      expect(state).toMatchObject({ pluginVersion: '1.8.0', candidates: 1, restored: 1, remaining: 0 });

      const second = clearedPair(1);
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed), 'same version: not run').toBeNull();
      expect(row(second).fact_kr).toBeNull();

      expect(await restoreKoreanOncePerVersion(db, '1.8.1', embed), 'another version: run again').toEqual({ candidates: 1, restored: 1, remaining: 0 });
      expect(row(second).fact_kr).toBe('큐 1 은 5번 재시도한다');
    });

    it('a pass that stopped at its limit runs again on the next call', async () => {
      clearedPair(0); clearedPair(1);
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed, { limit: 1 })).toEqual({ candidates: 2, restored: 1, remaining: 1 });
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed, { limit: 1 })).toEqual({ candidates: 1, restored: 1, remaining: 0 });
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed, { limit: 1 })).toBeNull();
    });

    it('a pass that fails is recorded and not repeated for that version — the error reaches the caller once', async () => {
      clearedPair(0);
      const failing = async () => { throw new Error('embedding model unavailable'); };
      await expect(restoreKoreanOncePerVersion(db, '1.8.0', failing)).rejects.toThrow('embedding model unavailable');
      expect(JSON.parse(fs.readFileSync(koreanRestoreStatePath(), 'utf8'))).toMatchObject({ pluginVersion: '1.8.0', error: 'embedding model unavailable' });
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed)).toBeNull();
    });

    it('an unreadable state file counts as "not run yet"', async () => {
      const first = clearedPair(0);
      fs.mkdirSync(path.dirname(koreanRestoreStatePath()), { recursive: true });
      fs.writeFileSync(koreanRestoreStatePath(), '{ not json');
      expect(await restoreKoreanOncePerVersion(db, '1.8.0', embed)).toEqual({ candidates: 1, restored: 1, remaining: 0 });
      expect(row(first).fact_kr).toBe('큐 0 은 5번 재시도한다');
    });
  });
});
