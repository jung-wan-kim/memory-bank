import { describe, it, expect, vi } from 'vitest';

/**
 * 모델 로드는 한 번만 (2026-10-03). 데몬은 바인드하자마자 미리 올리기를 시작하는데,
 * 그 사이 첫 프롬프트가 오면 같은 모델을 두 번째로 올렸다(데몬 임베딩 7.0초 vs 콜드 5.3초).
 */

let calls = 0;
let failNext = false;
let extractCalls = 0;
let failAtCall = 0;
// 문장마다 다른 단위 벡터(처음 본 순서대로 축 하나) — 표본이 일부만 있으면 기준선이 달라진다
const dims = new Map<string, number>();
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    if (failNext) { failNext = false; throw new Error('load failed'); }
    return (async (text: string) => {
      await new Promise((r) => setTimeout(r, 5)); // 실제 추론처럼 이벤트 루프를 한 번 넘긴다
      extractCalls++;
      if (failAtCall && extractCalls === failAtCall) { failAtCall = 0; throw new Error('extract failed'); }
      if (!dims.has(text)) dims.set(text, dims.size);
      const v = new Float32Array(384);
      v[dims.get(text)! % 384] = 1;
      return { data: v };
    }) as never;
  }),
}));

describe('initEmbeddings', () => {
  it('동시에 불려도 한 번만 올리고, 실패한 로드는 다음 호출이 다시 시도한다', async () => {
    const emb = await import('../src/embeddings.js');
    failNext = true;
    await expect(emb.initEmbeddings()).rejects.toThrow('load failed');
    expect(emb.embeddingsReady()).toBe(false);
    calls = 0;
    await Promise.all([emb.initEmbeddings(), emb.initEmbeddings(), emb.initEmbeddings()]);
    expect(calls).toBe(1);
    expect(emb.embeddingsReady()).toBe(true);
    await emb.initEmbeddings();
    expect(calls).toBe(1);
  });
});

describe('queryBaseline', () => {
  // 기준선 = 질의와 배경 표본 문장들의 최대 유사도. 질의를 마지막 표본 문장과 같게 두면
  // 표본 8개가 다 있을 때만 기준선이 1 이고, 일부만 있으면 0, 비어 있으면 -1 이다.
  // 기준선이 낮아지면 「기준선 + 여유」 관련도 거르기가 느슨해지거나 꺼진다.
  async function fresh() {
    vi.resetModules(); // 표본이 아직 없는 새 모듈
    const emb = await import('../src/embeddings.js');
    await emb.initEmbeddings();
    const q = await emb.generateEmbedding(emb.BACKGROUND_PROBES.at(-1)!, 'passage');
    return { emb, q };
  }

  it('표본 계산이 중간(3번째)에 실패하면, 다음 호출이 처음부터 다시 계산한다', async () => {
    const { emb, q } = await fresh();
    failAtCall = extractCalls + 3;
    await expect(emb.queryBaseline(q)).rejects.toThrow('extract failed');
    expect(await emb.queryBaseline(q), '일부만 찬 표본이 남으면 기준선 0').toBeCloseTo(1, 3);
  });

  it('동시에 불려도 표본은 한 번만 계산하고, 모두 다 찬 표본으로 기준선을 받는다', async () => {
    const { emb, q } = await fresh();
    const before = extractCalls;
    const got = await Promise.all([emb.queryBaseline(q), emb.queryBaseline(q), emb.queryBaseline(q)]);
    expect(got.map((x) => Math.round(x * 1000) / 1000), '빈 표본은 -1, 일부만 찬 표본은 0').toEqual([1, 1, 1]);
    expect(extractCalls - before, '표본 계산을 함께 기다린다').toBe(emb.BACKGROUND_PROBES.length);
  });
});
