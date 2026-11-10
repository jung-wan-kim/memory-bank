import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingExtractionCoreQuery, getExtractionConfig, DEFAULT_QUIET_MINUTES } from '../src/pending-extraction.js';

/**
 * backfill 은 조용해진 세션만 집는다 (2026-11-10).
 *
 * pending 술어에 "세션이 끝났는가"를 보는 조건이 없어, backfill 이 가장 최근 세션부터
 * 진행 중인 세션을 교환 2~4개 시점에 추출하고 완료 마커를 썼다(8월 이후 backfill 저장
 * 423세션 중 355개는 마지막 교환이 저장 10분 이내, 296개는 저장 뒤 30분 안에 다음
 * 교환이 있었다). 마지막 교환 뒤 N분 조용해야 대상이 된다.
 *
 * 탐침(세션 시작 정비)과 워커는 같은 함수에서 술어를 받으므로 조건은 여기 한 곳이다.
 */

let tmp: string;
let db: Database.Database;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function seed(sid: string, timestamps: string[]): void {
  const ins = db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, ?, 0, ?)');
  for (const ts of timestamps) ins.run(sid, ts, '/tmp/quiet-proj');
}

function pending(cfg: Parameters<typeof pendingExtractionCoreQuery>[0]): string[] {
  const { sql, params } = pendingExtractionCoreQuery(cfg);
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map((r) => r.sid).sort();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-quiet-'));
  db = new Database(path.join(tmp, 't.sqlite'));
  db.exec(`
    CREATE TABLE exchanges (id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT, is_sidechain INTEGER DEFAULT 0, cwd TEXT);
    CREATE TABLE extraction_log (session_id TEXT PRIMARY KEY, processed_at TEXT, extracted INTEGER, saved INTEGER, claim_owner TEXT);
  `);
});
afterEach(() => {
  db.close();
  delete process.env.BACKFILL_QUIET_MINUTES;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pending 술어의 조용함 조건', () => {
  it('방금 교환이 있었던 세션은 대상이 아니고, 기본 시간만큼 조용한 세션은 대상이다', () => {
    seed('active', [minutesAgo(30), minutesAgo(2)]);
    seed('quiet', [minutesAgo(DEFAULT_QUIET_MINUTES + 30), minutesAgo(DEFAULT_QUIET_MINUTES + 5)]);
    expect(pending({ minExchanges: 2, excludeProjects: [] })).toEqual(['quiet']);
  });

  it('조용함은 마지막 교환으로 잰다 — 옛 교환이 있어도 최근 교환이 있으면 진행 중이다', () => {
    seed('resumed', [minutesAgo(3 * 24 * 60), minutesAgo(3 * 24 * 60 - 1), minutesAgo(1)]);
    expect(pending({ minExchanges: 2, excludeProjects: [] })).toEqual([]);
  });

  it('시각을 읽을 수 없는 세션은 대상에 남는다 (영영 굶지 않게)', () => {
    seed('garbled', ['not-a-timestamp', 'also-not']);
    db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, NULL, 0, ?)').run('null-ts', '/tmp/quiet-proj');
    db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, NULL, 0, ?)').run('null-ts', '/tmp/quiet-proj');
    expect(pending({ minExchanges: 2, excludeProjects: [] })).toEqual(['garbled', 'null-ts']);
  });

  it('quietMinutes 로 시간을 바꾸고, 0 이면 조건을 끈다', () => {
    seed('ten-min', [minutesAgo(12), minutesAgo(10)]);
    expect(pending({ minExchanges: 2, excludeProjects: [], quietMinutes: 30 })).toEqual([]);
    expect(pending({ minExchanges: 2, excludeProjects: [], quietMinutes: 5 })).toEqual(['ten-min']);
    expect(pending({ minExchanges: 2, excludeProjects: [], quietMinutes: 0 })).toEqual(['ten-min']);
  });

  it('SQL 에 들어가는 값은 정수만 — 그 밖의 값은 기본 시간으로 읽는다', () => {
    seed('ten-min', [minutesAgo(12), minutesAgo(10)]);
    for (const bad of [Number.NaN, -5, 1.5, Number.POSITIVE_INFINITY, '5; DROP TABLE exchanges' as unknown as number]) {
      const { sql } = pendingExtractionCoreQuery({ minExchanges: 2, excludeProjects: [], quietMinutes: bad });
      expect(sql).toContain(`'-${DEFAULT_QUIET_MINUTES} minutes'`);
      expect(sql).not.toContain('DROP');
    }
    expect(pending({ minExchanges: 2, excludeProjects: [], quietMinutes: Number.NaN })).toEqual([]);
  });

  it('최소 교환 수·기존 마커 조건과 함께 적용된다', () => {
    seed('quiet-one', [minutesAgo(500)]);
    seed('quiet-done', [minutesAgo(500), minutesAgo(400)]);
    seed('quiet-open', [minutesAgo(500), minutesAgo(400)]);
    db.prepare('INSERT INTO extraction_log VALUES (?, ?, 2, 2, NULL)').run('quiet-done', minutesAgo(300));
    expect(pending({ minExchanges: 2, excludeProjects: [] })).toEqual(['quiet-open']);
  });
});

describe('BACKFILL_QUIET_MINUTES', () => {
  it('기본은 60분', () => {
    expect(DEFAULT_QUIET_MINUTES).toBe(60);
    expect(getExtractionConfig().quietMinutes).toBe(60);
  });

  it('0 이상 정수만 받는다 (0 = 끔), 그 밖은 기본값', () => {
    const read = (raw: string) => { process.env.BACKFILL_QUIET_MINUTES = raw; return getExtractionConfig().quietMinutes; };
    expect(read('15')).toBe(15);
    expect(read('0')).toBe(0);
    expect(read(' 90 ')).toBe(90);
    for (const bad of ['', 'abc', '-1', '1e3', '12.5', '99999999']) expect(read(bad), bad).toBe(60);
  });
});
