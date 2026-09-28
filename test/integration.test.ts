import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations, formatResults } from '../src/search.js';
import { generateEmbedding, generateExchangeEmbedding } from '../src/embeddings.js';
import type { ConversationExchange } from '../src/types.js';
import { parseConversationFile } from '../src/parser.js';
import { createTestDb, getFixturePath } from './test-utils.js';
import { indexTestFiles } from './test-indexer.js';
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Integration Tests', () => {
  let testDbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    // Create temp directory for test database
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-test-'));
    testDbPath = path.join(tmpDir, 'test.db');

    cleanup = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    };

    // Override DB path for tests
    process.env.MEMORY_BANK_DB_PATH = testDbPath;
  });

  afterEach(() => {
    delete process.env.MEMORY_BANK_DB_PATH;
    if (cleanup) cleanup();
  });

  describe('Indexing', () => {
    it('should index a conversation successfully', async () => {
      const fixturePath = getFixturePath('short-conversation.jsonl');

      await indexTestFiles([fixturePath]);

      // Verify data was indexed
      const db = initDatabase();
      const count = db.prepare('SELECT COUNT(*) as count FROM exchanges').get() as { count: number };
      expect(count.count).toBeGreaterThan(0);
      db.close();
    });

    it('should handle multiple conversations', async () => {
      const shortPath = getFixturePath('short-conversation.jsonl');
      const longPath = getFixturePath('long-conversation.jsonl');

      await indexTestFiles([shortPath, longPath]);

      const db = initDatabase();
      const count = db.prepare('SELECT COUNT(*) as count FROM exchanges').get() as { count: number };
      expect(count.count).toBeGreaterThan(1);
      db.close();
    });

    it('should store embeddings in vec_exchanges table', async () => {
      const fixturePath = getFixturePath('short-conversation.jsonl');

      await indexTestFiles([fixturePath]);

      const db = initDatabase();
      const vecCount = db.prepare('SELECT COUNT(*) as count FROM vec_exchanges').get() as { count: number };
      expect(vecCount.count).toBeGreaterThan(0);
      db.close();
    });

    it('should preserve conversation metadata', async () => {
      const fixturePath = getFixturePath('long-conversation.jsonl');

      await indexTestFiles([fixturePath]);

      const db = initDatabase();
      const row = db.prepare('SELECT * FROM exchanges LIMIT 1').get() as any;

      expect(row.project).toBeDefined();
      expect(row.timestamp).toBeDefined();
      expect(row.user_message).toBeDefined();
      expect(row.assistant_message).toBeDefined();
      expect(row.archive_path).toBe(fixturePath);
      db.close();
    });
  });

  describe('Vector Search', () => {
    beforeEach(async () => {
      // Index test conversations
      await indexTestFiles([getFixturePath('short-conversation.jsonl')]);
    });

    it('should find conversations by semantic similarity', async () => {
      const results = await searchConversations('Employee class design', {
        limit: 5,
        mode: 'vector'
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return similarity scores', async () => {
      const results = await searchConversations('Python dataclass', {
        limit: 5,
        mode: 'vector'
      });

      if (results.length > 0) {
        expect(results[0].similarity).toBeDefined();
        // Similarity is 1 - distance, where distance can be > 1 for dissimilar items
        // So similarity can be negative (valid for poor matches)
        expect(typeof results[0].similarity).toBe('number');
        expect(results[0].similarity).toBeLessThanOrEqual(1);
      }
    });

    it('should respect limit parameter', async () => {
      const results = await searchConversations('class', {
        limit: 2,
        mode: 'vector'
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Text Search', () => {
    beforeEach(async () => {
      await indexTestFiles([getFixturePath('long-conversation.jsonl')]);
    });

    it('should find exact text matches', async () => {
      const results = await searchConversations('Docker', {
        limit: 10,
        mode: 'text'
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);

      // If Docker appears in the conversation, we should find it
      if (results.length > 0) {
        const hasDocker = results.some(r =>
          r.exchange.userMessage.includes('Docker') ||
          r.exchange.assistantMessage.includes('Docker')
        );
        expect(hasDocker).toBe(true);
      }
    });

    it('should be case-insensitive', async () => {
      const lowerResults = await searchConversations('docker', {
        limit: 10,
        mode: 'text'
      });

      const upperResults = await searchConversations('DOCKER', {
        limit: 10,
        mode: 'text'
      });

      // Should find same results regardless of case
      expect(lowerResults.length).toBe(upperResults.length);
    });
  });

  describe('Combined Search', () => {
    beforeEach(async () => {
      await indexTestFiles([
        getFixturePath('short-conversation.jsonl'),
        getFixturePath('long-conversation.jsonl')
      ]);
    });

    it('should combine vector and text results', async () => {
      const results = await searchConversations('testing', {
        limit: 10,
        mode: 'both'
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should deduplicate combined results', async () => {
      const results = await searchConversations('conversation', {
        limit: 20,
        mode: 'both'
      });

      // Check for duplicate IDs
      const ids = results.map(r => r.exchange.id);
      const uniqueIds = new Set(ids);

      expect(ids.length).toBe(uniqueIds.size); // No duplicates
    });

    it('should preserve row-level text/vector provenance without a fake 100% text score', async () => {
      const query = 'provenancealpha';
      const exchanges: ConversationExchange[] = [
        {
          id: 'provenance-both',
          project: 'provenance-fixture',
          timestamp: '2026-08-13T00:00:01.000Z',
          userMessage: `${query} exact match with a vector`,
          assistantMessage: 'Both retrieval surfaces should find this exchange.',
          archivePath: path.join(path.dirname(testDbPath), 'provenance-both.jsonl'),
          lineStart: 1,
          lineEnd: 2,
        },
        {
          id: 'provenance-text-only',
          project: 'provenance-fixture',
          timestamp: '2026-08-13T00:00:02.000Z',
          userMessage: `${query} exact match without a stored vector`,
          assistantMessage: 'Only literal retrieval should find this exchange.',
          archivePath: path.join(path.dirname(testDbPath), 'provenance-text-only.jsonl'),
          lineStart: 1,
          lineEnd: 2,
        },
        {
          id: 'provenance-vector-only',
          project: 'provenance-fixture',
          timestamp: '2026-08-13T00:00:03.000Z',
          userMessage: 'semantic retrieval origin metadata',
          assistantMessage: 'This row deliberately omits the literal query token.',
          archivePath: path.join(path.dirname(testDbPath), 'provenance-vector-only.jsonl'),
          lineStart: 1,
          lineEnd: 2,
        },
      ];

      const db = initDatabase();
      for (const exchange of exchanges) {
        const embedding = await generateExchangeEmbedding(
          exchange.userMessage,
          exchange.assistantMessage
        );
        insertExchange(db, exchange, embedding);
      }
      db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('provenance-text-only');
      db.close();

      const results = await searchConversations(query, { mode: 'both', limit: 1000 });
      const byId = new Map(
        results
          .filter((result) => result.exchange.id.startsWith('provenance-'))
          .map((result) => [result.exchange.id, result])
      );

      expect([...byId.keys()].sort()).toEqual([
        'provenance-both',
        'provenance-text-only',
        'provenance-vector-only',
      ]);

      const both = byId.get('provenance-both')!;
      expect(both.matchSource).toBe('both');
      expect(both.textScore).toBeNull();
      expect(both.vectorScore).toBe(both.similarity);

      const textOnly = byId.get('provenance-text-only')!;
      expect(textOnly.matchSource).toBe('text');
      expect(textOnly.textScore).toBeNull();
      expect(textOnly.vectorScore).toBeNull();
      expect(textOnly.similarity).toBeNull();

      const vectorOnly = byId.get('provenance-vector-only')!;
      expect(vectorOnly.matchSource).toBe('vector');
      expect(vectorOnly.textScore).toBeNull();
      expect(vectorOnly.vectorScore).toBe(vectorOnly.similarity);

      const formatted = await formatResults([textOnly, both]);
      expect(formatted).toContain('text match (score unavailable)');
      expect(formatted).toContain('vector + text match');
      expect(formatted).not.toContain('100% match');
    });
  });

  describe('Date Filtering', () => {
    beforeEach(async () => {
      await indexTestFiles([getFixturePath('short-conversation.jsonl')]);
    });

    it('should filter by after date', async () => {
      const results = await searchConversations('class', {
        mode: 'vector',
        after: '2025-10-08'
      });

      results.forEach(r => {
        const date = new Date(r.exchange.timestamp);
        const filterDate = new Date('2025-10-08');
        expect(date >= filterDate).toBe(true);
      });
    });

    it('should filter by before date', async () => {
      const results = await searchConversations('class', {
        mode: 'vector',
        before: '2025-10-09'
      });

      results.forEach(r => {
        const date = new Date(r.exchange.timestamp);
        const filterDate = new Date('2025-10-09');
        expect(date <= filterDate).toBe(true);
      });
    });

    it('should handle date range', async () => {
      const results = await searchConversations('class', {
        mode: 'vector',
        after: '2025-10-01',
        before: '2025-10-31'
      });

      results.forEach(r => {
        const date = new Date(r.exchange.timestamp);
        expect(date >= new Date('2025-10-01')).toBe(true);
        expect(date <= new Date('2025-10-31')).toBe(true);
      });
    });

    it.each([
      {
        label: 'after',
        query: 'filter aware after candidate',
        nearest: { timestamp: '2025-01-01T00:00:00.000Z', codingAgent: 'claude-code' },
        target: { timestamp: '2026-08-13T00:00:00.000Z', codingAgent: 'claude-code' },
        options: { mode: 'vector' as const, after: '2026-08-12', limit: 1 },
      },
      {
        label: 'before',
        query: 'filter aware before candidate',
        nearest: { timestamp: '2026-08-13T00:00:00.000Z', codingAgent: 'claude-code' },
        target: { timestamp: '2025-01-01T00:00:00.000Z', codingAgent: 'claude-code' },
        options: { mode: 'both' as const, before: '2025-01-02', limit: 1 },
      },
      {
        label: 'coding_agent',
        query: 'filter aware coding agent candidate',
        nearest: { timestamp: '2026-08-13T00:00:00.000Z', codingAgent: 'claude-code' },
        target: { timestamp: '2026-08-13T00:00:00.000Z', codingAgent: 'codex' },
        options: { mode: 'vector' as const, coding_agent: 'codex', limit: 1 },
      },
    ])('does not let pre-filter vector top-k starve a $label match', async ({
      query,
      nearest,
      target,
      options,
    }) => {
      const queryEmbedding = await generateEmbedding(query, 'query');
      const distantEmbedding = queryEmbedding.map((value) => -value);
      const db = initDatabase();

      const insert = (
        id: string,
        timestamp: string,
        codingAgent: string,
        embedding: number[]
      ) => {
        insertExchange(db, {
          id,
          project: 'filter-overfetch-fixture',
          timestamp,
          userMessage: `${id} user message`,
          assistantMessage: `${id} assistant message`,
          archivePath: path.join(path.dirname(testDbPath), `${id}.jsonl`),
          lineStart: 1,
          lineEnd: 2,
          codingAgent,
        }, embedding);
      };

      // The out-of-filter row is the global nearest neighbour. With k=limit=1,
      // vec0 chooses it before the joined predicate can remove it.
      insert('filter-nearest', nearest.timestamp, nearest.codingAgent, queryEmbedding);
      insert('filter-target', target.timestamp, target.codingAgent, distantEmbedding);
      db.close();

      const results = await searchConversations(query, options);

      expect(results.map((result) => result.exchange.id)).toEqual([
        'filter-target',
      ]);
    });
  });
});
