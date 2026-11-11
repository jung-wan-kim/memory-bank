import { embeddingToVecBlob, getVecQuant, vecParamSql } from './db.js';
import { EMBEDDING_VERSION } from './embedding-version.js';
/**
 * Housekeeping the SessionStart maintenance run does on the FACT side of the
 * database (scripts/session-start-maintenance.js): planner statistics, and
 * keeping the fact vector tables in step with the facts table.
 */
/**
 * Tables ANALYZE covers: the fact and ontology side only. The conversation
 * side is left out on purpose — analyzing `exchanges`, its FTS shadow tables
 * or `tool_calls` reads their indexes whole (GBs on a grown index), and no
 * query over them was mis-planned.
 */
export const ANALYZE_TABLES = [
    'facts', 'fact_revisions', 'ontology_domains', 'ontology_categories', 'ontology_relations', 'extraction_log',
];
/** Rows ANALYZE samples per index (PRAGMA analysis_limit) — keeps it at a few ms however large a table grows. */
export const ANALYSIS_LIMIT = 1000;
/**
 * Gather planner statistics for the fact-side tables.
 *
 * Without sqlite_stat1 the planner assumes every equality index narrows to
 * about ten rows and picks the narrowest one — on the facts table that was an
 * index on a 2-valued column. Measured on a 46,507-fact table: the key-facts
 * query 40.7ms → 0.021ms and facts-by-category 46.3ms → 0.41ms after
 * `ANALYZE facts`, which itself took 3ms. Statistics are plain tables: a
 * process running older code reads them or ignores them, nothing breaks.
 */
export function analyzeFactTables(db) {
    const t0 = Date.now();
    const previous = db.pragma('analysis_limit', { simple: true });
    db.pragma(`analysis_limit = ${ANALYSIS_LIMIT}`);
    try {
        for (const table of ANALYZE_TABLES)
            db.exec(`ANALYZE ${table}`);
    }
    finally {
        db.pragma(`analysis_limit = ${Number.isInteger(previous) ? previous : 0}`);
    }
    const placeholders = ANALYZE_TABLES.map(() => '?').join(', ');
    const stat_rows = db.prepare(`SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl IN (${placeholders})`).get(...ANALYZE_TABLES).n;
    return { tables: [...ANALYZE_TABLES], stat_rows, ms: Date.now() - t0 };
}
const FACT_EMBEDDING_BYTES = 384 * 4;
/** Deletes per transaction — the vec0 batch size the purge script found safe. */
const VEC_DELETE_BATCH = 2000;
/**
 * Bring the fact vector tables back in step with the facts table.
 *
 *  - A vector whose fact is inactive or gone is deleted. deactivateFact removes
 *    the vector now, but rows deactivated by older code kept theirs (measured
 *    live: 593 in vec_facts, 146 in vec_facts_kr) and every KNN still scans them.
 *  - An active fact at the current embedding version with no vec_facts row gets
 *    its row back from facts.embedding (the same float32 vector the row was
 *    first indexed from). Nothing else heals this: the re-embed worker only
 *    selects stale versions, so such a fact stayed invisible to vector search
 *    (measured live: 2 facts since 2026-07).
 *
 * vec_facts_kr rows cannot be written back here — the Korean vector is not
 * stored in the facts table; the re-embed worker rebuilds a missing one.
 * Running it again changes nothing.
 */
export function reconcileFactVectors(db) {
    const out = [];
    for (const table of ['vec_facts', 'vec_facts_kr']) {
        const outcome = { table, removed: 0, reinserted: 0, missing_no_embedding: 0 };
        const dead = db.prepare(`
      SELECT r.id AS id FROM ${table}_rowids r
      LEFT JOIN facts f ON f.id = r.id
      WHERE f.id IS NULL OR f.is_active = 0
    `).all().map((r) => r.id);
        const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        const deleteBatch = db.transaction((ids) => { for (const id of ids)
            del.run(id); });
        for (let i = 0; i < dead.length; i += VEC_DELETE_BATCH) {
            const chunk = dead.slice(i, i + VEC_DELETE_BATCH);
            deleteBatch.immediate(chunk);
            outcome.removed += chunk.length;
        }
        if (table === 'vec_facts') {
            // dtype/scale read and rows written in ONE write transaction, like every
            // other fact-vector write: the int8 migration swaps the table under
            // BEGIN IMMEDIATE, and a blob quantized for the old table must not land
            // in the new one.
            db.transaction(() => {
                const missing = db.prepare(`
          SELECT f.id AS id, f.embedding AS embedding FROM facts f
          WHERE f.is_active = 1 AND f.embedding_version = ?
            AND NOT EXISTS (SELECT 1 FROM vec_facts_rowids v WHERE v.id = f.id)
        `).all(EMBEDDING_VERSION);
                if (missing.length === 0)
                    return;
                const quant = getVecQuant(db, 'vec_facts');
                const ins = db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(quant)})`);
                for (const row of missing) {
                    if (!row.embedding || row.embedding.length !== FACT_EMBEDDING_BYTES) {
                        outcome.missing_no_embedding++;
                        continue;
                    }
                    // Copy before viewing as float32: a Buffer's byteOffset is not always 4-aligned.
                    const bytes = Uint8Array.from(row.embedding);
                    const vector = Array.from(new Float32Array(bytes.buffer));
                    ins.run(row.id, embeddingToVecBlob(vector, quant));
                    outcome.reinserted++;
                }
            }).immediate();
        }
        out.push(outcome);
    }
    return out;
}
