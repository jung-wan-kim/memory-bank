import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export type VecDtype = 'float32' | 'int8';
/** dtype + int8 scale of one vec0 table. float32 tables carry scale 1. */
export interface VecQuant {
    dtype: VecDtype;
    scale: number;
}
/** Legacy scale: vec_exchanges, and any int8 table with no recorded scale. */
export declare const VEC_INT8_SCALE = 127;
/** Scale scripts/migrate-vec-facts-int8.mjs records for the fact-side tables it converts. */
export declare const FACT_VEC_INT8_SCALE = 600;
/** Per-table scale record. A missing row means the legacy 127. */
export declare const VEC_INT8_SCALE_TABLE = "vec_int8_scale";
/** The fact-side vec0 tables (per-table scale, compaction, int8 migration). */
export declare const FACT_VEC_TABLES: readonly ["vec_facts", "vec_facts_kr", "vec_categories"];
/** CREATE statement of a fact-side vec0 table — the one shape initDatabase, the
 * migration and compaction all produce. */
export declare function factVecTableDdl(table: string, type: 'int8' | 'FLOAT', opts?: {
    ifNotExists?: boolean;
}): string;
/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * migration swap. Unknown/absent table defaults to int8 (the fresh-DB DDL). */
export declare function getVecTableDtype(db: Database.Database, table: string): VecDtype;
/**
 * dtype + scale of a vec0 table. The dtype comes from the schema; the int8
 * scale from vec_int8_scale, which only the fact-vector int8 migration writes,
 * in the SAME transaction that swaps the table — so the two can only change
 * together. No row (or no record table at all) = 127: every int8 table before
 * per-table scales existed, and every table a fresh DB creates (what ≤1.7.6
 * creates too, so older processes sharing the DB read it right).
 * A recorded value outside (0, 10000] is corruption and throws: decoding with
 * a guessed scale would silently skew every similarity gate.
 */
export declare function getVecQuant(db: Database.Database, table: string): VecQuant;
/** Convert a float embedding to the blob matching the table's dtype + scale. */
export declare function embeddingToVecBlob(embedding: number[], quant: VecQuant): Buffer;
/** SQL placeholder for a vec0 MATCH/INSERT param under the table's dtype. */
export declare function vecParamSql(quant: VecQuant): string;
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×scale). */
export declare function normalizeVecDistance(distance: number, quant: VecQuant): number;
/**
 * Convert a (float32-scale) L2 distance between UNIT vectors to cosine
 * similarity. e5 embeddings are L2-normalized, so ‖a-b‖² = 2(1 - cos) and
 * cos = 1 - d²/2. Single source of truth: every relevance gate / threshold in
 * search, fact search, repeat detection, ontology and the avatar responder
 * used to inline this identical expression (9 copies) — a metric change in one
 * place would silently make those gates disagree. Pass a NORMALIZED distance
 * (run it through normalizeVecDistance first for int8 tables).
 */
export declare function l2DistanceToSimilarity(distance: number): number;
export declare function migrateSchema(db: Database.Database): void;
/** FTS sync on DELETE. Exported for the rebuild, which empties `exchanges` without it (see rebuild.ts). */
export declare const EXCHANGES_FTS_AD_DDL = "\n    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN\n      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)\n      VALUES('delete', old.rowid, old.user_message, old.assistant_message);\n    END\n  ";
/**
 * How long after dropping idx_facts_active an index of that name is left alone.
 *
 * A 1.7.x process sharing the database re-creates the index on its own open
 * (`CREATE INDEX IF NOT EXISTS`), reading the whole fact table under the write
 * lock — measured 1.6-3.4s at 46,507 facts. Dropping it again on every open of
 * this code made the two versions rebuild it for as long as both ran: every
 * open of the older one paid those seconds (an older MCP server opens the
 * database per tool call). So an index that is back within this time of the
 * last drop stays. The queries that plan worse on it carry a `+is_active`
 * hint and stay off it either way: the two the drop was measured on (key facts
 * in fact-db.ts, the ontology tree in ontology-db.ts) and the per-category /
 * per-scope fact counts added after 1.7.x (ontology-db.ts activeFactCounts,
 * findCategoriesByNameKey, getFactsByCategory; fact-db.ts
 * searchSimilarFactsSameScope) — without the hint those took one extraction
 * from about 2s to over 9s while the index was back. Other `is_active = 1`
 * queries plan as they did in 1.7.x. After that time — the older processes of an
 * upgrade are long replaced — it is dropped again. 6 hours: chosen, not
 * measured; the interval of the session-start maintenance, the other cleanup
 * that is not done per open.
 */
export declare const FACTS_ACTIVE_INDEX_REDROP_MS: number;
/** One turn of one file: what insertExchange looks up to remove older snapshots of a turn. */
export declare const EXCHANGE_TURN_INDEX = "idx_exchanges_path_line";
/**
 * Create the (archive_path, line_start) index while the exchanges table is
 * EMPTY — a fresh DB, or right after `index --rebuild` emptied it. On a
 * populated table the build reads every row to the end (line_start sits behind
 * both message columns), under the write lock: on the measured 10GB DB a scan
 * of that table took 23s cold and up to 6 minutes, far past every other
 * process's 5s busy_timeout — not something a DB open may do. Without the
 * index the same lookup runs through idx_archive_path (it visits that file's
 * rows; measured 0.07ms per lookup at 600 rows of 10KB, 23ms at 600 rows of
 * 200KB). A populated DB gets the index from
 * `scripts/dedupe-exchange-snapshots.mjs --create-index`, run on purpose.
 */
export declare function ensureExchangeTurnIndex(db: Database.Database): void;
/** Build the (archive_path, line_start) index whatever the table size — see ensureExchangeTurnIndex for the cost. */
export declare function createExchangeTurnIndex(db: Database.Database): void;
/**
 * Snapshots of a turn that insertExchange replaced, waiting for what names
 * them as a source to be pointed at the row that replaced them
 * (repointQueuedExchangeSources). A row is written in the transaction that
 * deletes the snapshot, so a process that ends before the sources are moved
 * leaves the pair for the next indexing run.
 */
export declare const EXCHANGE_REPOINT_TABLE = "exchange_repoints";
/**
 * Read-only handle for a hot read path that must neither write nor wait on
 * writers — the synchronous SessionStart hook. initDatabase() runs migrations
 * and a dedup DELETE on every open, so a reader using it queues behind the
 * workers that session start launches (busy_timeout 5s) and, on SQLITE_BUSY,
 * starts the session without its key facts. A read-only WAL reader never takes
 * the write lock (measured: 0ms while another process held it). No migrations,
 * no sqlite-vec; null when the database file does not exist yet.
 */
export declare function openReadOnlyDatabase(): Database.Database | null;
export declare function initDatabase(): Database.Database;
/**
 * Longest tool_input stored per tool call (UTF-16 code units). tool_calls was
 * the largest table of one measured DB — 1.5GB, 35.9% of the file, 938MiB of
 * it tool_input — while its only reader shows the first 300 characters
 * (ui/server.cjs); nothing parses it back as JSON. The full input stays in the
 * archived transcript, which the `read` tool serves. Applies to rows written
 * from now on; existing rows are left as they are.
 */
export declare const TOOL_INPUT_MAX_CHARS = 1000;
/**
 * Write one exchange with its vector and tool calls. Returns false, with
 * nothing written, when a fuller snapshot of the same turn is already indexed
 * (see below) — true otherwise.
 */
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], _toolNames?: string[]): boolean;
/**
 * True when a fuller snapshot of this exchange's turn is already indexed — the
 * same file and start line, ending later. insertExchange refuses such a write;
 * a caller asks first so it does not embed text that will not be stored.
 */
export declare function hasFullerSnapshot(db: Database.Database, exchange: Pick<ConversationExchange, 'archivePath' | 'lineStart' | 'lineEnd'>): boolean;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export interface RepointResult {
    /** Replaced snapshots that were waiting. */
    pairs: number;
    /** Whether the fact table had to be read (false: no waiting snapshot could be named by a fact). */
    scanned: boolean;
    /** Facts whose source list was changed. */
    facts: number;
    /** Fact revisions whose source was changed. */
    revisions: number;
}
/**
 * Point what names a replaced snapshot as its source at the row that replaced
 * it: the entries of facts.source_exchange_ids and
 * fact_revisions.source_exchange_id. A fact extracted while only the shorter
 * snapshot existed would otherwise name a row that is gone, and `trace_fact`
 * skips sources it cannot find. (Facts carry every exchange id of their
 * session: on one measured DB 13,573 facts named such a snapshot.) The fact
 * itself is unchanged — updated_at is left alone.
 *
 * Works through the pairs insertExchange wrote down:
 *  1. A pair whose session has no extraction_log row is dropped unread: every
 *     extraction claims its session there before it saves a fact, so no fact
 *     names an exchange of a session that was never extracted (measured on a
 *     live DB: the 59,585 exchanges facts name belong to 1,810 sessions, all
 *     1,810 with a row). This is the usual case — the last turn of a session
 *     still in use — and costs two index lookups.
 *  2. For the rest, ONE read of every fact's source list, without the write
 *     lock, finds the facts and revisions that name a replaced snapshot.
 *  3. A short write transaction changes those rows (each read again inside
 *     it) and removes the pairs it worked through.
 * Safe to run from several processes: a pair handled twice changes nothing the
 * second time.
 */
export declare function repointQueuedExchangeSources(db: Database.Database): RepointResult;
/** Delete one exchange with its tool calls and vector — all or nothing. */
export declare function deleteExchange(db: Database.Database, id: string): void;
/**
 * How long one delete batch may hold the write lock before it commits. Every
 * other process waits 5s for that lock and then fails ("database is locked" —
 * a session-start hook, a worker, the MCP server opening the DB). A batch
 * bounded only by row count (2,000) held it for over 5s on a large DB: each
 * row is an FTS delete (its whole text tokenized again) and a vec0 delete.
 */
export declare const DELETE_BATCH_MAX_MS = 400;
/**
 * Pause between two delete batches. A process waiting for the lock retries at
 * intervals of up to 100ms (SQLite's busy handler); batches that follow each
 * other at once leave it microseconds to land in, and it starves until its 5s
 * are over. The pause is longer than its longest sleep.
 */
export declare const DELETE_BATCH_PAUSE_MS = 120;
export interface DeleteExchangesOptions {
    /** Commit the batch once it has taken this long (default DELETE_BATCH_MAX_MS). 0 = one row per batch. */
    maxBatchMs?: number;
    /** Wait this long between batches (default DELETE_BATCH_PAUSE_MS). 0 = none. */
    pauseMs?: number;
    /** Called after each committed batch with the rows deleted so far; no transaction is open here. */
    onBatch?: (deleted: number) => void;
}
/**
 * Wait between two write transactions that follow each other, long enough for
 * a process waiting on the write lock to take it (see DELETE_BATCH_PAUSE_MS).
 * Call it with no transaction open.
 */
export declare function pauseForOtherWriters(ms?: number): void;
/**
 * Delete many exchanges in batches, each one transaction (see
 * deleteExchangeRows for the order). A batch ends at `batchSize` rows or after
 * DELETE_BATCH_MAX_MS, whichever comes first, and the next one starts after a
 * pause — so other processes keep writing while a maintenance command deletes.
 */
export declare function deleteExchanges(db: Database.Database, ids: readonly string[], batchSize?: number, opts?: DeleteExchangesOptions): number;
/**
 * True when this exchange is already indexed as it stands: same id (the id is
 * derived from the file and its line range, and transcripts are append-only,
 * so the same id is the same text), embedded with the current model, and its
 * vector row present. A caller that sees true may skip embedding it again —
 * before this check every sync re-embedded and re-wrote every exchange of a
 * file that had grown by one line (measured live: 1,657 rows rewritten in a
 * day for 25 new exchanges; one 1.07GB conversation took 109s per sync).
 */
export declare function isExchangeCurrent(db: Database.Database, id: string): boolean;
