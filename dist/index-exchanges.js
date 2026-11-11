import { hasFullerSnapshot, insertExchange, isExchangeCurrent, repointQueuedExchangeSources } from './db.js';
import { generateExchangeEmbedding } from './embeddings.js';
import { shouldIndexExchange } from './noise.js';
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
export async function indexExchanges(db, exchanges, opts = {}) {
    const result = { indexed: 0, unchanged: 0, filtered: 0, superseded: 0 };
    let failed = true;
    try {
        for (const exchange of exchanges) {
            if (!shouldIndexExchange(exchange)) {
                result.filtered++;
                continue;
            }
            if (isExchangeCurrent(db, exchange.id)) {
                result.unchanged++;
                continue;
            }
            if (hasFullerSnapshot(db, exchange)) {
                result.superseded++;
                continue;
            }
            if (opts.codingAgent)
                exchange.codingAgent = opts.codingAgent;
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
            if (insertExchange(db, exchange, embedding, toolNames))
                result.indexed++;
            else
                result.superseded++; // the fuller snapshot arrived while this one was being embedded
        }
        failed = false;
    }
    finally {
        moveSourcesOfReplacedSnapshots(db, failed);
    }
    return result;
}
/**
 * Step 5 above. The pairs are stored in the database, so one that is not moved
 * now is moved by the next call: a lock that could not be had is logged and
 * left for then, and after a failed indexing run nothing thrown here may hide
 * the error already on its way out.
 */
function moveSourcesOfReplacedSnapshots(db, afterFailure) {
    try {
        repointQueuedExchangeSources(db);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!afterFailure && !/database is locked|database table is locked|SQLITE_BUSY/i.test(message))
            throw error;
        console.error(`[index] sources of replaced snapshots not moved yet (the next indexing run does it): ${message}`);
    }
}
