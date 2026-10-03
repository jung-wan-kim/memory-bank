import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export type VecDtype = 'float32' | 'int8';
export declare const VEC_INT8_SCALE = 127;
/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * migration swap. Unknown/absent table defaults to int8 (the fresh-DB DDL). */
export declare function getVecTableDtype(db: Database.Database, table: string): VecDtype;
export declare function getVecDtype(db: Database.Database): VecDtype;
/** Convert a float embedding to the blob matching the table dtype. */
export declare function embeddingToVecBlob(embedding: number[], dtype: VecDtype): Buffer;
/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export declare function vecParamSql(dtype: VecDtype): string;
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export declare function normalizeVecDistance(distance: number, dtype: VecDtype): number;
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
export declare function deleteExchange(db: Database.Database, id: string): void;
