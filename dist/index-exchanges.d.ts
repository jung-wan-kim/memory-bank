import type Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export interface IndexExchangesResult {
    /** Embedded and written. */
    indexed: number;
    /** Already indexed as they stand (same id, current embedding version, vector present) — not embedded again. */
    unchanged: number;
    /** Never indexed: the plugin's own worker prompts and machine noise (shouldIndexExchange). */
    filtered: number;
    /**
     * Not written: a fuller snapshot of the same turn is already indexed. The
     * caller read the file before it grew and another process indexed the longer
     * turn since.
     */
    superseded: number;
}
/**
 * The one place a parsed exchange goes into the index. sync, the three indexer
 * entry points and repair all come through here, so the guards cannot drift
 * apart again (repair used to re-index worker prompts that sync refused):
 *   1. shouldIndexExchange — worker prompts and machine noise are never stored;
 *   2. isExchangeCurrent — an exchange already indexed as it stands is not
 *      embedded or written again;
 *   3. hasFullerSnapshot — a shorter copy of a turn that is indexed in full is
 *      not embedded (insertExchange refuses it again inside its transaction);
 *   4. insertExchange — which also removes older snapshots of the same turn;
 *   5. repointQueuedExchangeSources — what named a removed snapshot as its
 *      source is pointed at the row that replaced it, after the writes and
 *      outside their transactions.
 * The number of insertExchange call sites in src/ is pinned by test/noise.test.ts.
 */
export declare function indexExchanges(db: Database.Database, exchanges: ConversationExchange[], opts?: {
    codingAgent?: string;
}): Promise<IndexExchangesResult>;
