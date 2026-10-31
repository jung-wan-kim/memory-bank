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
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], _toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
/**
 * Resume point for incremental sync: the line_start of the last exchange
 * indexed for this archive, or 0 when none is. Transcripts are append-only, so
 * everything before it is final; the exchange AT it may have been indexed
 * while its reply was still streaming and is re-read on the next sync.
 */
export declare function getResumeLine(db: Database.Database, archivePath: string): number;
/**
 * Drop rows at or past `fromLine` for this archive that the re-read did not
 * produce again. An exchange's id hashes its last assistant line, so a reply
 * that kept streaming after the previous sync comes back under a new id and
 * leaves the cut-off row behind. Removes its tool calls and vector too.
 */
export declare function deleteSupersededExchanges(db: Database.Database, archivePath: string, fromLine: number, keepIds: string[]): number;
export declare function deleteExchange(db: Database.Database, id: string): void;
