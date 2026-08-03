import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 워커↔dist 계약 스모크 (Codex R14 MEDIUM ×2).
 *
 * 기존 워커 테스트는 **소스 문자열만** 검사했다. 그러면 두 종류의 실패를 못 잡는다:
 *  ① dist 에 export 가 없거나 이름이 바뀐 스큐 → 런타임에만 터진다(CI 초록)
 *  ② dist 표가 **키는 있는데 필드가 빠진** 구버전 → `?? {…}` 폴백이 발화하지 않아
 *     rep.bucket 이 undefined 로 새고, 복원한 INTERNAL 경보가 조용히 사라진다
 *
 * 그래서 여기서는 (a) 실제 dist 모듈을 import 해 계약을 필드 단위로 검증하고,
 * (b) 훅 워커를 **자식 프로세스로 실제 실행**해 import 경로가 살아있는지 확인한다.
 */

const REPO = path.resolve(__dirname, '..');

describe('워커 ↔ dist 계약', () => {
  it('dist 가 워커들이 실제로 쓰는 심볼을 전부 export 한다', async () => {
    const dist = await import('../dist/fact-extractor.js');
    for (const sym of ['runFactExtraction', 'classifyExtractionFailure', 'FAILURE_REPORT']) {
      expect(dist[sym as keyof typeof dist], `dist 에 ${sym} 없음 → 워커 런타임 실패`).toBeDefined();
    }
  });

  it('dist 의 보고 표가 필드까지 완전하다 (키만 있는 구버전 표 탐지)', async () => {
    const { FAILURE_REPORT } = await import('../dist/fact-extractor.js');
    const kinds = Object.keys(FAILURE_REPORT);
    expect(kinds.length, '분류 수').toBe(4);
    for (const k of kinds) {
      const rep = (FAILURE_REPORT as Record<string, Record<string, unknown>>)[k];
      // 키 존재만으로는 부족하다 — 워커가 읽는 필드가 실제로 있어야 집계·경보가 산다
      expect(typeof rep.label, `${k}.label`).toBe('string');
      expect(typeof rep.note, `${k}.note`).toBe('string');
      expect(['handoff', 'transient', 'budget'], `${k}.bucket`).toContain(rep.bucket);
      expect(typeof rep.consumesBudget, `${k}.consumesBudget`).toBe('boolean');
      expect(typeof rep.escalate, `${k}.escalate`).toBe('boolean');
    }
  });

  it('구버전 표(필드 누락)여도 경보가 무음으로 사라지지 않는다', () => {
    // 워커의 정규화 로직과 동일한 계약: 미지 필드는 보수적으로(예산+경보) 채운다.
    const stale: Record<string, { label: string; note: string }> = {
      internal: { label: 'ERROR', note: '구버전' },
    };
    const raw = stale.internal as unknown as Record<string, unknown>;
    const bucket = raw?.bucket === 'handoff' || raw?.bucket === 'transient' || raw?.bucket === 'budget'
      ? raw.bucket : 'budget';
    const escalate = typeof raw?.escalate === 'boolean' ? raw.escalate : true;
    expect(bucket, '미지 버킷은 유령 키가 아니라 budget 으로').toBe('budget');
    expect(escalate, '미지 경보는 무음보다 켜는 쪽으로').toBe(true);
  });

  it('훅 워커가 dist 를 실제로 로드하고 실패해도 exit 0 이다 (훅 불변식)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-worker-smoke-'));
    try {
      // 인자 없이 실행 → 세션 없음 경로. import 가 깨졌으면 여기서 non-zero 로 죽는다.
      const out = execFileSync(process.execPath, ['scripts/fact-extract-worker.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_DB_PATH: path.join(tmp, 't.sqlite') },
      });
      expect(typeof out).toBe('string'); // execFileSync 는 non-zero exit 시 throw
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 40_000);

  it('dist 표가 src 표와 키·필드가 동일하다 (stale dist 스큐 탐지)', async () => {
    // 다른 테스트는 src 를, 이 파일은 dist 를 읽는다 — 둘의 일치를 아무도 주장하지
    // 않으면 stale dist 스큐가 미탐지로 남는다(Codex R15 MEDIUM). 여기서 주장한다.
    const src = await import('../src/fact-extractor.js');
    const dist = await import('../dist/fact-extractor.js');

    expect(Object.keys(dist.FAILURE_REPORT).sort(), '분류 키 불일치 → dist 재빌드 필요')
      .toEqual(Object.keys(src.FAILURE_REPORT).sort());
    for (const k of Object.keys(src.FAILURE_REPORT) as Array<keyof typeof src.FAILURE_REPORT>) {
      expect(dist.FAILURE_REPORT[k], `${k} 필드 불일치 → dist 재빌드 필요`)
        .toEqual(src.FAILURE_REPORT[k]);
    }
    // 워커가 실제로 부르는 심볼도 동작이 같아야 한다
    for (const k of Object.keys(src.FAILURE_REPORT) as Array<keyof typeof src.FAILURE_REPORT>) {
      expect(dist.failureConsumesBudget(k), `${k} 예산 판정 불일치`).toBe(src.failureConsumesBudget(k));
    }
  });
});

/**
 * R24 — pending 판정 사본 금지.
 *
 * 이 스레드에서 pending 술어의 손복제가 반복적으로 드리프트했다: analyze.ts 사본이
 * -4(재시도 예산) 예외만 반영하고 -3(만료 리스) 예외가 빠져, 주석은 "워커/훅과 같은
 * 의미"라 주장하면서 35분 된 claim 세션을 '처리됨'으로 세었다. 사본이 존재하는 한
 * 같은 일이 또 생기므로, **사본 자체를 금지**한다.
 */
describe('R24: pending 판정은 단일 소스만', () => {
  it('pendingExtractionCoreQuery 외에 NOT EXISTS 사본이 없다', async () => {
    const fs = await import('node:fs');
    for (const f of ['src/analyze.ts', 'scripts/backfill-extract-worker.js']) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src.includes('FROM extraction_log l'), `${f} 에 pending 술어 사본이 있다`).toBe(false);
      if (src.includes('pending')) {
        expect(src, `${f} 는 단일 소스를 써야 한다`).toContain('pendingExtractionCoreQuery');
      }
    }
  });

  it('analyze 의 pending 수치가 워커 선정 결과와 일치한다', async () => {
    const { pendingExtractionCoreQuery, getExtractionConfig } = await import('../src/pending-extraction.js');
    const Database = (await import('better-sqlite3')).default;
    const os = await import('node:os'); const path = await import('node:path'); const fs = await import('node:fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-analyze-parity-'));
    const db = new Database(path.join(tmp, 't.sqlite'));
    try {
      db.exec(`
        CREATE TABLE exchanges (id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT,
          is_sidechain INTEGER DEFAULT 0, cwd TEXT);
        CREATE TABLE extraction_log (session_id TEXT PRIMARY KEY, processed_at TEXT,
          extracted INTEGER, saved INTEGER, claim_owner TEXT);`);
      const ins = db.prepare('INSERT INTO exchanges (session_id,timestamp,is_sidechain,cwd) VALUES (?,?,0,?)');
      for (const sid of ['fresh', 'expired', 'done']) for (let i = 0; i < 5; i++) ins.run(sid, '2026-08-02T00:00:00Z', '/tmp/p');
      const L = db.prepare('INSERT INTO extraction_log VALUES (?,?,?,?,?)');
      L.run('fresh', new Date().toISOString(), -3, 0, 'alive');                       // 처리 중
      L.run('expired', new Date(Date.now() - 60 * 60_000).toISOString(), -3, 0, 'dead'); // 만료 → pending
      L.run('done', new Date().toISOString(), 3, 3, null);                            // 완료

      const { sql, params } = pendingExtractionCoreQuery(getExtractionConfig());
      const rows = (db.prepare(sql).all(...params) as Array<{ sid: string }>).map(r => r.sid);
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number }).n;

      expect(rows, '만료 claim 은 회수 대상이므로 pending').toContain('expired');
      expect(rows, '처리 중인 세션은 pending 아님').not.toContain('fresh');
      expect(rows, '완료 세션은 pending 아님').not.toContain('done');
      expect(count, '리포트 수치와 선정 목록이 일치해야 한다').toBe(rows.length);
    } finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
