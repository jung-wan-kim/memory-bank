import { describe, it, expect } from 'vitest';
import { processBatch } from '../src/indexer.js';

describe('indexer', () => {
  describe('processBatch', () => {
    it('should process all items and return results in order', async () => {
      const items = [1, 2, 3, 4, 5];
      const processor = async (n: number) => n * 2;
      const results = await processBatch(items, processor, 3);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should handle empty array', async () => {
      const results = await processBatch([], async (n: number) => n, 5);
      expect(results).toEqual([]);
    });

    it('should respect concurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const items = [1, 2, 3, 4, 5, 6];
      const processor = async (n: number) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 10));
        currentConcurrent--;
        return n;
      };

      await processBatch(items, processor, 2);
      // Should process in batches of 2, not all at once
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should work with concurrency of 1 (sequential)', async () => {
      const order: number[] = [];
      const items = [1, 2, 3];
      const processor = async (n: number) => {
        order.push(n);
        return n;
      };

      await processBatch(items, processor, 1);
      expect(order).toEqual([1, 2, 3]);
    });

    it('should handle concurrency larger than item count', async () => {
      const items = [1, 2];
      const processor = async (n: number) => n * 10;
      const results = await processBatch(items, processor, 100);
      expect(results).toEqual([10, 20]);
    });

    it('should propagate errors from processor', async () => {
      const items = [1, 2, 3];
      const processor = async (n: number) => {
        if (n === 2) throw new Error('fail on 2');
        return n;
      };

      await expect(processBatch(items, processor, 3)).rejects.toThrow('fail on 2');
    });

    it('should handle async processors with varying completion times', async () => {
      const items = ['fast', 'slow', 'medium'];
      const delays: Record<string, number> = { fast: 1, slow: 20, medium: 10 };
      const processor = async (item: string) => {
        await new Promise(r => setTimeout(r, delays[item]));
        return item.toUpperCase();
      };

      const results = await processBatch(items, processor, 3);
      expect(results).toEqual(['FAST', 'SLOW', 'MEDIUM']);
    });
  });
});
