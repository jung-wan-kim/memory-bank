import { describe, it, expect } from 'vitest';
import { initEmbeddings, generateEmbedding, generateExchangeEmbedding } from '../src/embeddings.js';

describe('Embeddings', () => {
  it('should initialize embedding model', async () => {
    await initEmbeddings();
    // Should not throw
  }, 30000);

  it('should generate 384-dim embedding for text', async () => {
    const embedding = await generateEmbedding('hello world');
    expect(embedding).toHaveLength(384);
    expect(typeof embedding[0]).toBe('number');
  }, 30000);

  it('should return normalized embeddings (L2 norm ≈ 1)', async () => {
    const embedding = await generateEmbedding('test normalization');
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  }, 30000);

  it('should handle empty string', async () => {
    const embedding = await generateEmbedding('');
    expect(embedding).toHaveLength(384);
  }, 30000);

  it('should handle very long text (truncation)', async () => {
    const longText = 'word '.repeat(5000); // ~25000 chars
    const embedding = await generateEmbedding(longText);
    expect(embedding).toHaveLength(384);
  }, 30000);

  it('should produce similar embeddings for similar text', async () => {
    const emb1 = await generateEmbedding('TypeScript programming language');
    const emb2 = await generateEmbedding('TypeScript coding language');
    const emb3 = await generateEmbedding('cooking pasta recipe');

    // Cosine similarity (embeddings are normalized, so dot product = cosine)
    const sim12 = emb1.reduce((sum, v, i) => sum + v * emb2[i], 0);
    const sim13 = emb1.reduce((sum, v, i) => sum + v * emb3[i], 0);

    expect(sim12).toBeGreaterThan(sim13);
  }, 30000);

  it('should generate exchange embedding combining user + assistant', async () => {
    const embedding = await generateExchangeEmbedding(
      'How do I use TypeScript?',
      'TypeScript is a typed superset of JavaScript.'
    );
    expect(embedding).toHaveLength(384);
  }, 30000);

  it('should include tool names in exchange embedding', async () => {
    const withoutTools = await generateExchangeEmbedding('query', 'response');
    const withTools = await generateExchangeEmbedding('query', 'response', ['Read', 'Write']);

    // Embeddings should differ when tools are included
    const diff = withoutTools.reduce((sum, v, i) => sum + Math.abs(v - withTools[i]), 0);
    expect(diff).toBeGreaterThan(0.01);
  }, 30000);

  it('should handle empty tool names array', async () => {
    const withEmpty = await generateExchangeEmbedding('query', 'response', []);
    const withNone = await generateExchangeEmbedding('query', 'response');

    // Should be identical
    const diff = withEmpty.reduce((sum, v, i) => sum + Math.abs(v - withNone[i]), 0);
    expect(diff).toBeCloseTo(0, 5);
  }, 30000);
});
