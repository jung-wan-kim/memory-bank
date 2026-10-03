import { describe, it, expect, vi } from 'vitest';

/**
 * 모델 로드는 한 번만 (2026-10-03). 데몬은 바인드하자마자 미리 올리기를 시작하는데,
 * 그 사이 첫 프롬프트가 오면 같은 모델을 두 번째로 올렸다(데몬 임베딩 7.0초 vs 콜드 5.3초).
 */

let calls = 0;
let failNext = false;
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    if (failNext) { failNext = false; throw new Error('load failed'); }
    return (async () => ({ data: new Float32Array(384) })) as never;
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
