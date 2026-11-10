import { describe, it, expect } from 'vitest';
import { searchMultipleConcepts } from '../src/search.js';

describe('multi-concept search', () => {
  it('should find conversations matching all concepts', async () => {
    // This test will use the actual database
    // Looking for conversations that discuss both "React Router" AND "authentication"
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 5 });

    // Should return results
    expect(Array.isArray(results)).toBe(true);

    // Exact word matches come first (in keyword order); the semantic matches after them are sorted by
    // average similarity.
    const semantic = results.filter((r) => r.matchedBy === 'semantic').map((r) => r.averageSimilarity);
    expect(semantic).toEqual([...semantic].sort((a, b) => b - a));
    const firstSemantic = results.findIndex((r) => r.matchedBy === 'semantic');
    expect(results.slice(firstSemantic === -1 ? results.length : firstSemantic).every((r) => r.matchedBy === 'semantic')).toBe(true);
  });

  it('should have lower similarity for unrelated concepts than related ones', async () => {
    const unrelated = await searchMultipleConcepts(['xyzabc123', 'qwerty789'], { limit: 5 });

    expect(Array.isArray(unrelated)).toBe(true);
    // e5 similarity scores are compressed: as cosine (what `similarity` is since
    // the search uses l2DistanceToSimilarity) unrelated pairs still score
    // ~0.72-0.9, so assert relative ordering against a related query instead
    // of an absolute near-zero bound (which was calibrated for all-MiniLM-L6-v2).
    if (unrelated.length > 0) {
      expect(unrelated[0].averageSimilarity).toBeLessThan(0.95);

      // Relative ordering is only meaningful once stored vectors match the
      // current model — during background re-embedding the live DB holds
      // mixed-version vectors and rankings are noise.
      const { initDatabase } = await import('../src/db.js');
      const { EMBEDDING_VERSION } = await import('../src/embeddings.js');
      const db = initDatabase();
      const pending = db.prepare(
        'SELECT 1 FROM exchanges WHERE embedding_version != ? LIMIT 1'
      ).get(EMBEDDING_VERSION);
      db.close();
      if (!pending) {
        const related = await searchMultipleConcepts(['React', 'Router'], { limit: 5 });
        if (related.length > 0) {
          expect(unrelated[0].averageSimilarity).toBeLessThan(related[0].averageSimilarity);
        }
      }
    }
  });

  it('should respect limit parameter', async () => {
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should include similarity scores for each concept', async () => {
    const results = await searchMultipleConcepts(['React', 'Router'], { limit: 1 });

    if (results.length > 0) {
      expect(results[0].conceptSimilarities).toBeDefined();
      expect(results[0].conceptSimilarities?.length).toBe(2);
      expect(results[0].averageSimilarity).toBeDefined();
    }
  });
});
