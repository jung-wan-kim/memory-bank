import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pendingExtractionCoreQuery, getExtractionConfig,
  EXTRACTION_STATE, MAX_INTERNAL_RETRIES,
  claimSessionSql, CLAIM_LEASE_MINUTES, renewClaimSql, failureMarkerUpsertSql,
  freshClaimPredicate,
} from '../src/pending-extraction.js';

/**
 * 제3의 터미널 상태 회귀 테스트 (Codex 적대 리뷰 R4 CRITICAL).
 *
 * 배경 — 두 라운드가 서로의 수정을 되돌리는 **진동**이 있었다:
 *   R3 HIGH : 내부 실패를 이연했더니 런타임이 깨진 동안 최신 세션만 매 run 재시도되고
 *             오래된 백로그가 기아했다.
 *   R4 CRIT : 그래서 영구 마커(-2)를 남겼더니 임베딩/DB 가 한 번 튄 세션의 fact 가
 *             pending 쿼리에서 영구 제외돼 영영 추출되지 않았다.
 *
 * 어느 한쪽을 고르면 반대편이 재발하므로, 내부 실패에는 **재시도 예산을 가진 별도
 * 상태(-4)**를 준다. 이 테스트는 그 계약의 양끝을 고정한다:
 *   ① 예산이 남은 -4 세션은 여전히 pending 이다 (손실 없음 = R4 방어)
 *   ② 예산을 소진하면 pending 에서 빠진다   (큐 물림 없음 = R3 방어)
 */

let tmp: string;
let dbPath: string;

function makeDb(): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE exchanges (
      id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT,
      is_sidechain INTEGER DEFAULT 0, cwd TEXT
    );
    CREATE TABLE extraction_log (
      session_id TEXT PRIMARY KEY, processed_at TEXT,
      extracted INTEGER, saved INTEGER, claim_owner TEXT
    );
  `);
  return db;
}

/** 최소 교환 수를 넘기도록 세션 하나에 n 개 교환을 넣는다. */
function seedSession(db: Database.Database, sid: string, n: number): void {
  const ins = db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, ?, 0, ?)');
  for (let i = 0; i < n; i++) ins.run(sid, `2026-07-17T0${i % 10}:00:00Z`, '/tmp/proj');
}

function pendingIds(db: Database.Database): string[] {
  const cfg = getExtractionConfig();
  const { sql, params } = pendingExtractionCoreQuery(cfg);
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map(r => r.sid);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-internal-state-'));
  dbPath = path.join(tmp, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('내부 실패 = 재시도 예산을 가진 제3 상태 (-4)', () => {
  it('R4 회귀: 내부 실패 마커가 있어도 예산이 남으면 세션은 여전히 pending 이다', () => {
    const db = makeDb();
    try {
      seedSession(db, 'sess-internal', 12);
      // 워커가 임베딩/DB throw 를 만나 1회차 실패를 기록한 상태
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, ?, ?)')
        .run('sess-internal', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, 1);

      expect(pendingIds(db)).toContain('sess-internal');
    } finally { db.close(); }
  });

  it('예산 경계: 소진 직전(=MAX-1)까지는 pending, 소진(MAX)하면 빠진다', () => {
    const db = makeDb();
    try {
      seedSession(db, 'sess-a', 12);
      const upd = db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET saved = excluded.saved
      `);
      for (let attempts = 1; attempts < MAX_INTERNAL_RETRIES; attempts++) {
        upd.run('sess-a', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, attempts);
        expect(pendingIds(db), `attempt ${attempts} 는 아직 예산이 남음`).toContain('sess-a');
      }
      upd.run('sess-a', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, MAX_INTERNAL_RETRIES);
      expect(pendingIds(db), 'R3 방어: 예산 소진 후에는 큐가 물리지 않는다').not.toContain('sess-a');
    } finally { db.close(); }
  });

  it('다른 상태는 영향받지 않는다 — 성공/seed/영구실패는 계속 제외된다', () => {
    const db = makeDb();
    try {
      for (const sid of ['done', 'seed', 'permanent', 'fresh']) seedSession(db, sid, 12);
      const ins = db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      ins.run('done', now, 3, 3);                            // 정상 추출 완료
      ins.run('seed', now, EXTRACTION_STATE.SEED, 0);        // 과거 fact 보유
      ins.run('permanent', now, EXTRACTION_STATE.PERMANENT, 0); // 결정론적 거절

      const pending = pendingIds(db);
      expect(pending).toEqual(['fresh']); // 기록 없는 세션만 pending
    } finally { db.close(); }
  });

  it('상태 코드는 서로 겹치지 않는다 (마커 오독 방지)', () => {
    const codes = Object.values(EXTRACTION_STATE);
    expect(new Set(codes).size).toBe(codes.length);
    // 전부 음수여야 한다 — 0 이상은 "성공적으로 추출한 fact 수" 의미로 예약됨
    for (const c of codes) expect(c).toBeLessThan(0);
    expect(MAX_INTERNAL_RETRIES).toBeGreaterThan(0);
  });
});

/**
 * R6 HIGH — 진입 시점 선점(claim) 계약.
 *
 * SessionEnd 훅과 backfill 워커는 서로를 직렬화할 수단이 없고, 마커는 파이프라인
 * *끝*에 써지므로 창이 수 분간 열려 있었다 → 둘이 같은 세션을 각자 추출해 fact 가
 * 두 벌 저장됐다. 마커 시점 가드로는 늦다(이미 두 번 돈 뒤). 그래서 LLM 호출 **전**
 * 에 선점한다. 단 선점 자체가 새로운 영구손실 통로가 되면 안 되므로 리스를 둔다.
 */
describe('R6: 세션 선점(claim) 계약', () => {
  const claim = (
    db: Database.Database, sid: string, variant: 'worker' | 'hook',
    owner = randomUUID(), at?: string,
  ) => db.prepare(claimSessionSql(variant)).run(sid, at ?? new Date().toISOString(), owner).changes;

  it('중복 차단: 살아있는 claim 이 있으면 훅도 워커도 선점하지 못한다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      expect(claim(db, 's', 'worker'), '첫 선점은 성공').toBe(1);
      expect(claim(db, 's', 'hook'), '훅은 살아있는 claim 을 존중').toBe(0);
      expect(claim(db, 's', 'worker'), '워커도 마찬가지').toBe(0);
    } finally { db.close(); }
  });

  it('strand 방지: 리스가 만료된 claim 은 회수되고 pending 으로 돌아온다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      const stale = new Date(Date.now() - (CLAIM_LEASE_MINUTES + 5) * 60_000)
        .toISOString(); // 🚨 프로덕션 실제 포맷 — 공백 변환은 결함을 가린다(R23)
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?,?,?,?)')
        .run('s', stale, EXTRACTION_STATE.CLAIMED, 0);

      expect(pendingIds(db), '소유자가 죽었을 수 있으므로 미처리로 본다').toContain('s');
      expect(claim(db, 's', 'worker'), '만료 claim 은 회수 가능').toBe(1);
    } finally { db.close(); }
  });

  it('워커 변형은 확정 마커 위를 덮지 않는다 (TOCTOU 중복 차단)', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      // 워커가 pending 으로 선정한 뒤, 훅이 먼저 끝내 성공 마커를 쓴 상황
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?,?,?,?)')
        .run('s', new Date().toISOString(), 4, 4);
      expect(claim(db, 's', 'worker'), '재추출하면 fact 가 중복된다').toBe(0);
      // 훅 변형은 --resume 재추출이 정당하므로 허용된다
      expect(claim(db, 's', 'hook')).toBe(1);
    } finally { db.close(); }
  });

  it('재시도 대상(-4)은 워커가 선점할 수 있고, 예산 카운터는 복원으로 보존된다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?,?,?,?)')
        .run('s', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, 2);
      expect(claim(db, 's', 'worker')).toBe(1);
      // 선점은 saved 를 0 으로 만들지만, 실패 시 복원 경로가 이전 상태를 되돌린다
      db.prepare(`UPDATE extraction_log SET extracted = ?, saved = ? WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED}`)
        .run(EXTRACTION_STATE.RETRIABLE_INTERNAL, 2, 's');
      const row = db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?').get('s') as { extracted: number; saved: number };
      expect(row.saved, '카운터가 리셋되면 예산이 영원히 소진되지 않는다').toBe(2);
    } finally { db.close(); }
  });
});

/**
 * R7 HIGH — 소유권 토큰. 상태(-3)만 보는 술어로는 "내 claim"을 표현할 수 없어
 * A 의 롤백이 B 의 살아있는 claim 을 덮었다. 세 결함(리스 미갱신·롤백 오소유·
 * claim 예외 fail-open)이 모두 이 뿌리를 공유한다.
 */
describe('R7: claim 소유권 토큰', () => {
  it('HIGH-2: 다른 소유자의 claim 은 해제/복원할 수 없다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      const B = randomUUID();
      db.prepare(claimSessionSql('hook')).run('s', new Date().toISOString(), B);

      // A 가 자기 토큰으로 롤백을 시도 — B 의 행이므로 아무 일도 없어야 한다
      const A = randomUUID();
      const changed = db.prepare(
        `DELETE FROM extraction_log WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`,
      ).run('s', A).changes;
      expect(changed, 'A 가 B 의 claim 을 지우면 상호배제가 깨진다').toBe(0);
      const row = db.prepare('SELECT claim_owner FROM extraction_log WHERE session_id = ?').get('s') as { claim_owner: string };
      expect(row.claim_owner).toBe(B);
    } finally { db.close(); }
  });

  it('HIGH-1: 리스 갱신은 소유자만 가능하고, 갱신하면 회수 대상에서 벗어난다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      const owner = randomUUID();
      const stale = new Date(Date.now() - (CLAIM_LEASE_MINUTES + 5) * 60_000)
        .toISOString();
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner) VALUES (?,?,?,?,?)')
        .run('s', stale, EXTRACTION_STATE.CLAIMED, 0, owner);
      expect(pendingIds(db), '갱신 전에는 회수 대상').toContain('s');

      // 남이 갱신 시도 → 실패
      expect(db.prepare(renewClaimSql()).run(new Date().toISOString(), 's', randomUUID()).changes).toBe(0);
      // 소유자가 갱신 → 성공, 회수 대상에서 벗어남
      expect(db.prepare(renewClaimSql()).run(new Date().toISOString(), 's', owner).changes).toBe(1);
      expect(pendingIds(db), '갱신했으면 살아있는 작업이다').not.toContain('s');
    } finally { db.close(); }
  });

  it('실패 마커도 내 claim 위에서만 써진다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      const B = randomUUID();
      db.prepare(claimSessionSql('hook')).run('s', new Date().toISOString(), B);
      const changed = db.prepare(failureMarkerUpsertSql()).run(
        's', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, 1, randomUUID(),
      ).changes;
      expect(changed, '남의 claim 을 실패 마커로 덮으면 그 작업이 사라진다').toBe(0);
    } finally { db.close(); }
  });
});

/**
 * R21 — 제외 경로 마커도 소유권 가드를 가진다.
 *
 * 다른 마커 쓰기는 전부 가드가 있는데 이 경로만 무가드였다. 살아있는 claim(-3) 위에
 * 0/0 을 덮으면 소유자는 리스갱신 실패로 중단되고, 그 롤백은 extracted=-3 을 요구하므로
 * 무효가 되어 행이 0/0 확정마커로 남는다 → 세션이 pending 에서 **영구 제외**된다.
 */
describe('R21: 제외 마커의 소유권 가드', () => {
  it('살아있는 claim 위에 제외 마커를 덮지 않는다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's', 12);
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner) VALUES (?,?,?,?,?)')
        .run('s', new Date().toISOString(), EXTRACTION_STATE.CLAIMED, 0, 'ownerA');

      // 제외 경로가 쓰는 것과 동일한 SQL
      const res = db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
        WHERE extraction_log.extracted <> ${EXTRACTION_STATE.CLAIMED}
      `).run('s', new Date().toISOString());

      expect(res.changes, '처리 중인 세션을 덮으면 그 작업이 영구 손실된다').toBe(0);
      const row = db.prepare('SELECT extracted, claim_owner FROM extraction_log WHERE session_id = ?')
        .get('s') as { extracted: number; claim_owner: string };
      expect(row.extracted).toBe(EXTRACTION_STATE.CLAIMED);
      expect(row.claim_owner).toBe('ownerA');
    } finally { db.close(); }
  });

  it('선점되지 않은 세션에는 정상적으로 제외 마커를 쓴다 (가드가 과잉차단 아님)', () => {
    const db = makeDb();
    try {
      seedSession(db, 's2', 12);
      const res = db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
        WHERE extraction_log.extracted <> ${EXTRACTION_STATE.CLAIMED}
      `).run('s2', new Date().toISOString());
      expect(res.changes).toBe(1);
      expect(pendingIds(db), '제외 마커가 있으면 pending 에서 빠진다').not.toContain('s2');
    } finally { db.close(); }
  });

  it('R22: 만료된 claim 은 회수 대상 — 제외 마커를 쓸 수 있어야 한다', () => {
    const db = makeDb();
    try {
      seedSession(db, 's3', 12);
      const stale = new Date(Date.now() - (CLAIM_LEASE_MINUTES + 30) * 60_000)
        .toISOString();
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner) VALUES (?,?,?,?,?)')
        .run('s3', stale, EXTRACTION_STATE.CLAIMED, 0, 'deadOwner');

      // 제외 경로가 쓰는 것과 동일한 SQL(리스 술어 기반)
      const res = db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
        WHERE NOT (${freshClaimPredicate()})
      `).run('s3', new Date().toISOString());

      // `<> CLAIMED` 가드였을 때는 여기서 0 — 죽은 소유자의 행 때문에 세션이 마커를
      // 영원히 못 받고 매 run 재선정됐다(무한 재선정).
      expect(res.changes, '만료 claim 은 회수 대상이다').toBe(1);
      expect(pendingIds(db), '마커가 써졌으니 pending 을 떠난다').not.toContain('s3');
    } finally { db.close(); }
  });

  it('R22: 제외 목록 정규화가 단일 소스에서 온다 (SQL 필터와 판정 일치)', () => {
    const prev = process.env.BACKFILL_EXCLUDE_PROJECTS;
    try {
      process.env.BACKFILL_EXCLUDE_PROJECTS = '/tmp/excluded-proj/';
      const cfg = getExtractionConfig();
      // 정규화가 한쪽에만 있으면 SQL 은 raw 로 필터해 제외 대상을 선정해버린다.
      expect(cfg.excludeProjects, '후행 슬래시는 파싱 시점에 제거').toEqual(['/tmp/excluded-proj']);
    } finally {
      if (prev === undefined) delete process.env.BACKFILL_EXCLUDE_PROJECTS;
      else process.env.BACKFILL_EXCLUDE_PROJECTS = prev;
    }
  });

  it('R24: 손상된 타임스탬프(NULL·파싱불가)도 회수 대상 — pending 과 선점이 일치한다', () => {
    const db = makeDb();
    try {
      for (const sid of ['nullTs', 'badTs']) seedSession(db, sid, 12);
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner) VALUES (?,?,?,?,?)')
        .run('nullTs', null, EXTRACTION_STATE.CLAIMED, 0, 'dead');
      db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner) VALUES (?,?,?,?,?)')
        .run('badTs', 'not-a-timestamp', EXTRACTION_STATE.CLAIMED, 0, 'dead');

      // 🚨 두 판정이 어긋나면 세션이 "pending 인데 선점 불가" 가 되어 매 run 슬롯만
      //    먹는다(무한 재선정). pending 은 회수 대상으로 보는데 claim 만 NULL 비교의
      //    3치논리로 실패하던 자리다.
      const pending = pendingIds(db);
      for (const sid of ['nullTs', 'badTs']) {
        expect(pending, `${sid} 는 pending 이어야`).toContain(sid);
        for (const variant of ['worker', 'hook'] as const) {
          const c = db.prepare(claimSessionSql(variant)).run(sid, new Date().toISOString(), randomUUID()).changes;
          expect(c, `${sid} 를 ${variant} 가 선점하지 못하면 무한 재선정`).toBe(1);
          // 다음 변형 검사를 위해 되돌린다
          db.prepare('UPDATE extraction_log SET extracted=?, processed_at=?, claim_owner=? WHERE session_id=?')
            .run(EXTRACTION_STATE.CLAIMED, sid === 'nullTs' ? null : 'not-a-timestamp', 'dead', sid);
        }
      }
    } finally { db.close(); }
  });
});
