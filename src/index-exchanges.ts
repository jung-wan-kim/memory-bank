import type Database from 'better-sqlite3';
import { insertExchange, isExchangeCurrent } from './db.js';
import { generateExchangeEmbedding } from './embeddings.js';
import { shouldIndexExchange } from './noise.js';
import { ConversationExchange } from './types.js';

export interface IndexExchangesResult {
  /** Embedded and written. */
  indexed: number;
  /** Already indexed as they stand (same id, current embedding version, vector present) — not embedded again. */
  unchanged: number;
  /** Never indexed: the plugin's own worker prompts and machine noise (shouldIndexExchange). */
  filtered: number;
}

/**
 * The one place a parsed exchange goes into the index. sync, the three indexer
 * entry points and repair all come through here, so the guards cannot drift
 * apart again (repair used to re-index worker prompts that sync refused):
 *   1. shouldIndexExchange — worker prompts and machine noise are never stored;
 *   2. isExchangeCurrent — an exchange already indexed as it stands is not
 *      embedded or written again;
 *   3. insertExchange — which also removes older snapshots of the same turn.
 * The number of insertExchange call sites in src/ is pinned by test/noise.test.ts.
 */
export async function indexExchanges(
  db: Database.Database,
  exchanges: ConversationExchange[],
  opts: { codingAgent?: string } = {},
): Promise<IndexExchangesResult> {
  const result: IndexExchangesResult = { indexed: 0, unchanged: 0, filtered: 0 };
  for (const exchange of exchanges) {
    if (!shouldIndexExchange(exchange)) {
      result.filtered++;
      continue;
    }
    if (isExchangeCurrent(db, exchange.id)) {
      result.unchanged++;
      continue;
    }
    if (opts.codingAgent) exchange.codingAgent = opts.codingAgent;

    const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
    const embedding = await generateExchangeEmbedding(
      exchange.userMessage,
      exchange.assistantMessage,
      toolNames
    );
    insertExchange(db, exchange, embedding, toolNames);
    result.indexed++;
  }
  return result;
}
