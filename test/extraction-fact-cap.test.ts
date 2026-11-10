import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 세션당 사실 상한 (2026-11-10).
 *
 * 상한 20건이 "배치를 시간순으로 돌다가 차면 중단"으로 구현돼 있어, 긴 세션은 앞쪽
 * 2~3개 배치에서 20건이 차고 뒤쪽 배치는 LLM 에 가지도 않았다(20건에서 끊긴 74회의
 * 대조된 사실 82.5% 가 앞 1/5 구간). selectSpreadBatches 가 처음·중간·끝을 고르게
 * 골라도 상한 때문에 무효였다.
 *
 * 고정하는 계약: 선택된 배치는 전부 LLM 에 간다 → 상한은 그 뒤에, 배치마다 신뢰도
 * 높은 것부터 돌아가며 뽑아 적용한다 → 잘라 낸 수를 결과로 돌려준다.
 */

interface Reply { fact: string; category: string; scope_type: string; confidence: number }
let calls = 0;
let reply: (call: number) => Reply[] = () => [];
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => { calls++; return JSON.stringify(reply(calls)); },
}));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
  classifyAndLinkFacts: async () => ({
    classified: 0, deterministic: 0, failed: 0, fallback: 0, transient: 0,
    relations: { judged: 0, created: 0, reverseExisting: 0, siblingSupersedes: 0, reverseSupersedes: 0 },
  }),
}));

const SID = 'cap-session';
let tmp: string;
let db: import('better-sqlite3').Database;

/** 실질 교환 n 개(배치 크기 5 → 배치 n/5 개). */
function seedExchanges(n: number): void {
  const ins = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  for (let i = 0; i < n; i++) {
    ins.run(`cap-${i}`, '/tmp/cap', new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      `배포 파이프라인의 ${i}번째 단계를 어떻게 구성할지 결정해야 합니다. 근거도 알려주세요.`,
      `${i}번째 단계는 캐시를 먼저 복원한 뒤 빌드하도록 구성합니다. 재현성과 속도 때문입니다.`,
      `/tmp/cap-${i}.jsonl`, 1, 10, SID);
  }
}

function savedFacts(): string[] {
  return (db.prepare("SELECT fact FROM facts WHERE fact LIKE 'b%-f%' ORDER BY rowid").all() as Array<{ fact: string }>)
    .map((r) => r.fact);
}

/** 'b3-f2' → 3 */
const batchOf = (fact: string) => Number(/^b(\d+)-/.exec(fact)![1]);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fact-cap-'));
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

describe('세션당 사실 상한', () => {
  it('12배치 × 8건: 모든 배치가 LLM 에 가고, 배치마다 신뢰도 상위 5건씩 60건이 저장된다', async () => {
    seedExchanges(60);
    // 배치 안에서 뒤로 갈수록 신뢰도가 높다 — "앞에서부터 자르기"와 "신뢰도순"이 갈린다.
    reply = (call) => Array.from({ length: 8 }, (_, i) => ({
      fact: `b${call}-f${i}`, category: 'decision', scope_type: 'project', confidence: 0.8 + i * 0.02,
    }));
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, SID, '/tmp/cap');

    expect(calls, '뒤쪽 배치가 LLM 에 닿지 않으면 세션의 결론이 사실로 남지 않는다').toBe(12);
    const facts = savedFacts();
    expect(facts).toHaveLength(60);
    expect(result.extracted).toBe(60);
    expect(result.saved).toBe(60);
    expect(result.truncated).toBe(36);
    for (let b = 1; b <= 12; b++) {
      const own = facts.filter((f) => batchOf(f) === b);
      expect(own, `배치 ${b} 의 몫`).toEqual([3, 4, 5, 6, 7].map((i) => `b${b}-f${i}`));
    }
  });

  it('한 배치가 25건을 내면 예전 상한 20건을 신뢰도순으로 적용하고 원래 순서로 저장한다', async () => {
    seedExchanges(5);
    reply = () => Array.from({ length: 25 }, (_, i) => ({
      fact: `b1-f${i}`, category: 'decision', scope_type: 'project', confidence: i < 5 ? 0.7 : 0.9,
    }));
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, SID, '/tmp/cap');

    expect(calls).toBe(1);
    expect(result.truncated).toBe(5);
    expect(savedFacts()).toEqual(Array.from({ length: 20 }, (_, i) => `b1-f${i + 5}`));
  });

  it('상한에 닿지 않으면 아무것도 자르지 않고 LLM 이 낸 순서 그대로 저장한다', async () => {
    seedExchanges(10);
    reply = (call) => [0, 1, 2].map((i) => ({
      fact: `b${call}-f${i}`, category: 'decision', scope_type: 'project', confidence: 0.95 - i * 0.1,
    }));
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, SID, '/tmp/cap');

    expect(calls).toBe(2);
    expect(result.truncated).toBeUndefined();
    expect(savedFacts()).toEqual(['b1-f0', 'b1-f1', 'b1-f2', 'b2-f0', 'b2-f1', 'b2-f2']);
  });
});

/**
 * MEMORY_BANK_MAX_EXTRACT_CALLS 는 세션당 추출 배치 수다. 값에 상한이 없어서 1000 을 주면
 * 400교환(80배치) 세션이 추출 호출 80회를 냈다 — 저장되는 사실은 어차피 60건까지인데.
 */
describe('세션당 추출 배치 수 (MEMORY_BANK_MAX_EXTRACT_CALLS)', () => {
  const ENV = 'MEMORY_BANK_MAX_EXTRACT_CALLS';
  afterEach(() => { delete process.env[ENV]; });
  const oneFact = (call: number) => [{ fact: `b${call}-f0`, category: 'decision', scope_type: 'project', confidence: 0.9 }];

  it('값이 상한(60)을 넘으면 60 배치로 자른다 — 400교환 세션에 값 1000', async () => {
    process.env[ENV] = '1000';
    seedExchanges(400);
    reply = oneFact;
    const { runFactExtraction, MAX_EXTRACT_CALLS_CEILING } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, SID, '/tmp/cap');

    expect(MAX_EXTRACT_CALLS_CEILING).toBe(60);
    expect(calls, '80배치 전부가 아니라 상한까지만').toBe(60);
    expect(result.saved).toBe(60);
  });

  it('기본값은 12, 상한 이하의 값은 그대로 쓴다', async () => {
    const { extractCallBudget } = await import('../src/fact-extractor.js');
    delete process.env[ENV];
    expect(extractCallBudget()).toEqual({ calls: 12 });
    process.env[ENV] = '30';
    expect(extractCallBudget()).toEqual({ calls: 30 });
    process.env[ENV] = '60';
    expect(extractCallBudget()).toEqual({ calls: 60 });
    process.env[ENV] = '61';
    expect(extractCallBudget()).toEqual({ calls: 60, clampedFrom: 61 });
    process.env[ENV] = '999999999999';
    expect(extractCallBudget()).toEqual({ calls: 60, clampedFrom: 999999999999 });
  });

  it('정수가 아닌 값·0·음수는 기본값이다 (앞부분만 읽어 다른 수가 되지 않는다)', async () => {
    const { extractCallBudget } = await import('../src/fact-extractor.js');
    for (const raw of ['', '0', '-3', 'abc', '1e3', '12.9', '20 calls', ' ']) {
      process.env[ENV] = raw;
      expect(extractCallBudget(), JSON.stringify(raw)).toEqual({ calls: 12 });
    }
    process.env[ENV] = ' 20 ';
    expect(extractCallBudget(), '앞뒤 공백은 허용').toEqual({ calls: 20 });
  });

  it('값 30 인 80배치 세션은 추출 호출 30회', async () => {
    process.env[ENV] = '30';
    seedExchanges(400);
    reply = oneFact;
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    await runFactExtraction(db, SID, '/tmp/cap');
    expect(calls).toBe(30);
  });
});
