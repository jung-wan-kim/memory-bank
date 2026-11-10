import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 같은 세션의 SessionEnd 가 다시 왔을 때 (2026-11-10).
 *
 * SessionEnd 는 같은 세션에 60초 안에 두 번 오는 일이 잦다(실측 840쌍, 간격 중앙 18.8초).
 * 훅 변형의 선점은 확정 마커 위에서도 성공하므로(--resume 으로 교환이 늘어난 세션의
 * 재추출), 첫 실행이 끝난 뒤 온 두 번째 실행은 같은 교환을 통째로 다시 추출한다 —
 * 추출 전 색인이 생긴 뒤로는 그것이 사실 두 벌이 된다.
 *
 * 고정하는 계약: 완료 마커가 "그때 읽은 교환 수"를 기억하고, 훅 변형은 교환 수가
 * 그대로면 다시 추출하지 않는다. 교환이 늘었으면 예전처럼 다시 추출한다.
 */

let calls = 0;
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => {
    calls++;
    return JSON.stringify([
      { fact: `repeat-probe-${calls}`, category: 'decision', scope_type: 'project', confidence: 0.9 },
    ]);
  },
}));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
}));

const SID = 'S-repeat';
let tmp: string;
let db: import('better-sqlite3').Database;

function addExchange(i: number, user?: string, assistant?: string): void {
  db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    `rep-${i}`, '/tmp/rep', `2026-10-01T0${i}:00:00.000Z`,
    user ?? `캐시 계층을 Redis 로 둘지 메모리로 둘지 결정해야 합니다. 근거도 알려주세요 (${i})`,
    assistant ?? `Redis 를 권장합니다. 여러 인스턴스가 같은 세션 저장소를 봐야 하기 때문입니다 (${i}).`,
    `/tmp/rep-${i}.jsonl`, 1, 10, SID);
}

const probeFacts = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM facts WHERE fact LIKE 'repeat-probe-%'").get() as { n: number }).n;
const marker = () =>
  db.prepare('SELECT extracted, saved, seen_exchanges FROM extraction_log WHERE session_id = ?').get(SID) as
    { extracted: number; saved: number; seen_exchanges: number | null } | undefined;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-repeat-end-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  calls = 0;
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('같은 세션의 SessionEnd 가 다시 왔을 때 (훅 변형)', () => {
  it('새 교환이 없으면 다시 추출하지 않는다 — LLM 호출도 사실도 한 번뿐', async () => {
    addExchange(0); addExchange(1);
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    const first = await runFactExtraction(db, SID, '/tmp/rep');
    expect(first.saved).toBe(1);

    const second = await runFactExtraction(db, SID, '/tmp/rep');
    expect(calls, '같은 교환을 다시 LLM 에 보내면 사실이 두 벌이 된다').toBe(1);
    expect(probeFacts()).toBe(1);
    expect(second.skipped).toBe('no_new_exchanges');
    expect(marker(), '건너뛴 실행은 마커를 건드리지 않는다').toEqual({ extracted: 1, saved: 1, seen_exchanges: 2 });
  });

  it('교환이 늘었으면 예전처럼 세션을 다시 추출하고 마커의 교환 수를 갱신한다', async () => {
    addExchange(0); addExchange(1);
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    await runFactExtraction(db, SID, '/tmp/rep');

    addExchange(2); // --resume 으로 이어 쓴 세션
    const again = await runFactExtraction(db, SID, '/tmp/rep');
    expect(again.skipped).toBeUndefined();
    expect(calls).toBe(2);
    expect(marker()?.seen_exchanges).toBe(3);
  });

  it('실질 교환이 없어 0건으로 끝난 세션도 새 교환이 없으면 다시 돌지 않는다', async () => {
    addExchange(0, 'ok', '네.'); addExchange(1, '/clear', 'Cleared.');
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    const first = await runFactExtraction(db, SID, '/tmp/rep');
    expect(first).toEqual({ extracted: 0, saved: 0 });
    expect(marker()).toEqual({ extracted: 0, saved: 0, seen_exchanges: 2 });

    expect((await runFactExtraction(db, SID, '/tmp/rep')).skipped).toBe('no_new_exchanges');
    expect(calls).toBe(0);
  });

  it('교환 수를 모르는 옛 마커(seen_exchanges 없음) 위에서는 예전처럼 다시 추출한다', async () => {
    addExchange(0); addExchange(1);
    db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, 3, 3)')
      .run(SID, '2026-10-02T00:00:00.000Z');
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    const result = await runFactExtraction(db, SID, '/tmp/rep');
    expect(result.skipped).toBeUndefined();
    expect(calls).toBe(1);
    expect(marker()?.seen_exchanges).toBe(2);
  });

  it('backfill(worker 변형)이 끝낸 세션도 교환 수를 남겨, 뒤이은 SessionEnd 가 다시 추출하지 않는다', async () => {
    addExchange(0); addExchange(1);
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    await runFactExtraction(db, SID, '/tmp/rep', undefined, { claimVariant: 'worker' });
    expect(marker()?.seen_exchanges).toBe(2);
    expect((await runFactExtraction(db, SID, '/tmp/rep')).skipped).toBe('no_new_exchanges');
    expect(calls).toBe(1);
  });
});
