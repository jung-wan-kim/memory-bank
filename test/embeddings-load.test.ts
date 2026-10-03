import { describe, it, expect, vi } from 'vitest';

/**
 * 모델 로드는 한 번만 (2026-10-03). 데몬은 바인드하자마자 미리 올리기를 시작하는데,
 * 그 사이 첫 프롬프트가 오면 같은 모델을 두 번째로 올렸다(데몬 임베딩 7.0초 vs 콜드 5.3초).
 */

let calls = 0;
let failNext = false;
let failExtract = false;
const UNIT = new Float32Array(384).fill(1 / Math.sqrt(384)); // 정규화된 벡터 — 자기 자신과의 내적이 1
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    if (failNext) { failNext = false; throw new Error('load failed'); }
    return (async () => {
      await new Promise((r) => setTimeout(r, 5)); // 실제 추론처럼 이벤트 루프를 한 번 넘긴다
      if (failExtract) { failExtract = false; throw new Error('extract failed'); }
      return { data: UNIT };
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
  // 기준선 = 질의와 배경 표본 문장들의 최대 유사도. 표본을 아직 채우는 중에 다른 호출이
  // 빈 배열을 보면 기준선 -1 을 받아, 「기준선 + 여유」 관련도 거르기가 사실상 꺼진다.
  it('표본 계산 중 실패하면 다음 호출이 처음부터 다시 계산한다(일부만 찬 표본을 굳히지 않는다)', async () => {
    const emb = await import('../src/embeddings.js');
    await emb.initEmbeddings();
    failExtract = true;
    await expect(emb.queryBaseline(Array.from(UNIT))).rejects.toThrow('extract failed');
    expect(await emb.queryBaseline(Array.from(UNIT))).toBeCloseTo(1, 3);
  });

  it('동시에 불려도 모두 다 찬 표본으로 기준선을 받는다', async () => {
    vi.resetModules(); // 표본이 아직 없는 새 모듈
    const emb = await import('../src/embeddings.js');
    await emb.initEmbeddings();
    const q = Array.from(UNIT);
    const [a, b, c] = await Promise.all([emb.queryBaseline(q), emb.queryBaseline(q), emb.queryBaseline(q)]);
    expect([a, b, c].map((x) => Math.round(x * 1000) / 1000), '빈 표본을 본 호출은 -1').toEqual([1, 1, 1]);
  });
});
