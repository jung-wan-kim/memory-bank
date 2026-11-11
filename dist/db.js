import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { autoHealScopeProjects } from './project-canon.js';
import { EMBEDDING_VERSION } from './embedding-version.js';
import { assertNotLiveDbUnderTest } from './test-guard.js';
import { preparePrivateDbFile } from './file-perms.js';
/** Legacy scale: vec_exchanges, and any int8 table with no recorded scale. */
export const VEC_INT8_SCALE = 127;
/** Scale scripts/migrate-vec-facts-int8.mjs records for the fact-side tables it converts. */
export const FACT_VEC_INT8_SCALE = 600;
/** Per-table scale record. A missing row means the legacy 127. */
export const VEC_INT8_SCALE_TABLE = 'vec_int8_scale';
/** The fact-side vec0 tables (per-table scale, compaction, int8 migration). */
export const FACT_VEC_TABLES = ['vec_facts', 'vec_facts_kr', 'vec_categories'];
const MAX_INT8_SCALE = 10_000;
/** CREATE statement of a fact-side vec0 table — the one shape initDatabase, the
 * migration and compaction all produce. */
export function factVecTableDdl(table, type, opts = {}) {
    return `CREATE VIRTUAL TABLE ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${table} USING vec0(id TEXT PRIMARY KEY, embedding ${type}[384])`;
}
const VEC_TABLES = new Set(['vec_exchanges', ...FACT_VEC_TABLES]);
/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * migration swap. Unknown/absent table defaults to int8 (the fresh-DB DDL). */
export function getVecTableDtype(db, table) {
    if (!VEC_TABLES.has(table))
        throw new Error(`not a vec table: ${table}`);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!row?.sql)
        return 'int8';
    return /int8\s*\[/i.test(row.sql) ? 'int8' : 'float32';
}
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
export function getVecQuant(db, table) {
    const dtype = getVecTableDtype(db, table);
    if (dtype === 'float32')
        return { dtype, scale: 1 };
    const hasRecord = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(VEC_INT8_SCALE_TABLE);
    if (!hasRecord)
        return { dtype, scale: VEC_INT8_SCALE };
    const row = db.prepare(`SELECT scale FROM ${VEC_INT8_SCALE_TABLE} WHERE table_name = ?`).get(table);
    if (!row)
        return { dtype, scale: VEC_INT8_SCALE };
    if (!Number.isFinite(row.scale) || row.scale <= 0 || row.scale > MAX_INT8_SCALE) {
        throw new Error(`${VEC_INT8_SCALE_TABLE}: invalid scale ${row.scale} for ${table}`);
    }
    return { dtype, scale: row.scale };
}
/** Convert a float embedding to the blob matching the table's dtype + scale. */
export function embeddingToVecBlob(embedding, quant) {
    if (quant.dtype === 'int8') {
        const q = new Int8Array(embedding.length);
        for (let i = 0; i < embedding.length; i++) {
            q[i] = Math.max(-127, Math.min(127, Math.round(embedding[i] * quant.scale)));
        }
        return Buffer.from(q.buffer);
    }
    return Buffer.from(new Float32Array(embedding).buffer);
}
/** SQL placeholder for a vec0 MATCH/INSERT param under the table's dtype. */
export function vecParamSql(quant) {
    return quant.dtype === 'int8' ? 'vec_int8(?)' : '?';
}
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×scale). */
export function normalizeVecDistance(distance, quant) {
    return quant.dtype === 'int8' ? distance / quant.scale : distance;
}
/**
 * Convert a (float32-scale) L2 distance between UNIT vectors to cosine
 * similarity. e5 embeddings are L2-normalized, so ‖a-b‖² = 2(1 - cos) and
 * cos = 1 - d²/2. Single source of truth: every relevance gate / threshold in
 * search, fact search, repeat detection, ontology and the avatar responder
 * used to inline this identical expression (9 copies) — a metric change in one
 * place would silently make those gates disagree. Pass a NORMALIZED distance
 * (run it through normalizeVecDistance first for int8 tables).
 */
export function l2DistanceToSimilarity(distance) {
    return 1 - (distance * distance) / 2;
}
export function migrateSchema(db) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all();
    const columnNames = new Set(columns.map(c => c.name));
    const migrations = [
        { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN last_indexed INTEGER' },
        { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN parent_uuid TEXT' },
        { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0' },
        { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN session_id TEXT' },
        { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN cwd TEXT' },
        { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN git_branch TEXT' },
        { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN claude_version TEXT' },
        { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_level TEXT' },
        { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_disabled BOOLEAN' },
        { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_triggers TEXT' },
        { name: 'coding_agent', sql: "ALTER TABLE exchanges ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'" },
    ];
    let migrated = false;
    for (const migration of migrations) {
        if (!columnNames.has(migration.name)) {
            console.error(`Migrating schema: adding ${migration.name} column...`);
            db.prepare(migration.sql).run();
            migrated = true;
        }
    }
    if (migrated) {
        console.error('Migration complete.');
    }
}
/** FTS sync on DELETE. Exported for the rebuild, which empties `exchanges` without it (see rebuild.ts). */
export const EXCHANGES_FTS_AD_DDL = `
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
    END
  `;
/**
 * FTS sync on UPDATE, limited to the two indexed columns. Without the column
 * list every UPDATE of an exchange — the re-embed worker's
 * `SET embedding = NULL, embedding_version = ?, last_indexed = ?` — deleted
 * and re-inserted that row's whole text in the FTS index.
 */
const EXCHANGES_FTS_AU_DDL = `
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE OF user_message, assistant_message ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `;
/**
 * Replace an exchanges_fts_au made by an older build (no column list) with the
 * column-limited one, in one transaction so the trigger is never absent to
 * another connection. An older process's CREATE TRIGGER IF NOT EXISTS finds
 * the name taken and leaves it alone. Lock contention is not an error: the
 * old trigger is only slower, and the next open tries again.
 */
function narrowFtsUpdateTrigger(db) {
    const current = () => db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='exchanges_fts_au'`).get()?.sql ?? '';
    const isNarrow = (sql) => /AFTER\s+UPDATE\s+OF\s+user_message\s*,\s*assistant_message\s+ON/i.test(sql);
    if (isNarrow(current()))
        return;
    try {
        db.transaction(() => {
            if (isNarrow(current()))
                return; // another process replaced it first
            db.exec('DROP TRIGGER IF EXISTS exchanges_fts_au');
            db.exec(EXCHANGES_FTS_AU_DDL);
        }).immediate();
    }
    catch (e) {
        const msg = e?.message ?? '';
        if (!/database is locked|database table is locked|SQLITE_BUSY/i.test(msg))
            throw e;
        console.error('[db] exchanges_fts_au 트리거 교체 지연 — 락 경합, 다음 초기화에서 재시도');
    }
}
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
export const FACTS_ACTIVE_INDEX_REDROP_MS = 6 * 60 * 60 * 1000;
const FACTS_ACTIVE_INDEX_DROPPED_AT = 'idx_facts_active_dropped_at';
function dropFactsActiveIndex(db) {
    const exists = () => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_facts_active'`).get() !== undefined;
    if (!exists())
        return;
    // fts_meta is this database's key/value table (created above); every reader asks for its own key.
    const recorded = Number(db.prepare(`SELECT value FROM fts_meta WHERE key = ?`).get(FACTS_ACTIVE_INDEX_DROPPED_AT)?.value);
    const sinceDrop = Date.now() - recorded;
    // No record, an unreadable one, or one from the future (the clock was set back) never keeps the index.
    if (Number.isFinite(sinceDrop) && sinceDrop >= 0 && sinceDrop < FACTS_ACTIVE_INDEX_REDROP_MS)
        return;
    try {
        db.transaction(() => {
            db.exec(`DROP INDEX IF EXISTS idx_facts_active`);
            db.prepare(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES(?, ?)`).run(FACTS_ACTIVE_INDEX_DROPPED_AT, String(Date.now()));
        }).immediate();
    }
    catch (e) {
        // Lock contention is not an error: the index only makes some plans slower, and the next open tries again.
        const msg = e?.message ?? '';
        if (!/database is locked|database table is locked|SQLITE_BUSY/i.test(msg))
            throw e;
        console.error('[db] idx_facts_active 제거 지연 — 락 경합, 다음 초기화에서 재시도');
    }
}
/** One turn of one file: what insertExchange looks up to remove older snapshots of a turn. */
export const EXCHANGE_TURN_INDEX = 'idx_exchanges_path_line';
const EXCHANGE_TURN_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${EXCHANGE_TURN_INDEX} ON exchanges(archive_path, line_start)`;
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
export function ensureExchangeTurnIndex(db) {
    const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(EXCHANGE_TURN_INDEX) !== undefined;
    if (has)
        return;
    if (db.prepare('SELECT 1 FROM exchanges LIMIT 1').get() !== undefined)
        return;
    db.exec(EXCHANGE_TURN_INDEX_DDL);
}
/** Build the (archive_path, line_start) index whatever the table size — see ensureExchangeTurnIndex for the cost. */
export function createExchangeTurnIndex(db) {
    db.exec(EXCHANGE_TURN_INDEX_DDL);
}
/**
 * Snapshots of a turn that insertExchange replaced, waiting for what names
 * them as a source to be pointed at the row that replaced them
 * (repointQueuedExchangeSources). A row is written in the transaction that
 * deletes the snapshot, so a process that ends before the sources are moved
 * leaves the pair for the next indexing run.
 */
export const EXCHANGE_REPOINT_TABLE = 'exchange_repoints';
const EXCHANGE_REPOINT_DDL = `
  CREATE TABLE IF NOT EXISTS ${EXCHANGE_REPOINT_TABLE} (
    from_id TEXT PRIMARY KEY,
    to_id TEXT NOT NULL,
    session_id TEXT,
    queued_at INTEGER NOT NULL
  )`;
/**
 * Read-only handle for a hot read path that must neither write nor wait on
 * writers — the synchronous SessionStart hook. initDatabase() runs migrations
 * and a dedup DELETE on every open, so a reader using it queues behind the
 * workers that session start launches (busy_timeout 5s) and, on SQLITE_BUSY,
 * starts the session without its key facts. A read-only WAL reader never takes
 * the write lock (measured: 0ms while another process held it). No migrations,
 * no sqlite-vec; null when the database file does not exist yet.
 */
export function openReadOnlyDatabase() {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath))
        return null;
    return new Database(dbPath, { readonly: true, fileMustExist: true });
}
export function initDatabase() {
    const dbPath = getDbPath();
    assertNotLiveDbUnderTest(dbPath); // a test run never opens the live database (no-op outside tests)
    preparePrivateDbFile(dbPath); // a new database is created 0600; an older install is made owner-only once
    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const db = new Database(dbPath);
    // Load sqlite-vec extension
    sqliteVec.load(db);
    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // Cap the -wal file so it is truncated back after each checkpoint. The default
    // (-1 = unlimited) let the WAL grow WITHOUT BOUND under this workload: many
    // long-lived MCP-server readers (one per session) keep a read mark active
    // almost continuously, so SQLite's auto-checkpoint can rarely advance past the
    // oldest reader and the file only ever grew — observed live at 1.4 GB, which
    // crawled the re-embed drain from ~13 to ~3 rows/s. Applied on EVERY connection
    // (every worker + the MCP server), so no single writer can bloat the WAL no
    // matter which path is active. 64 MiB is far above normal working-set needs; it
    // only reclaims runaway file space after checkpoints.
    db.pragma('journal_size_limit = 67108864');
    // Required so the exchanges_fts AFTER DELETE trigger fires when an exchange is
    // re-indexed via `INSERT OR REPLACE` (the REPLACE-induced delete does NOT fire
    // delete triggers unless recursive_triggers is on — verified: without it a
    // re-indexed exchange leaves a stale FTS row). Keeps the external-content FTS
    // index consistent with the source table on every write path.
    db.pragma('recursive_triggers = ON');
    // Create exchanges table
    db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT,
      coding_agent TEXT DEFAULT 'claude-code'
    )
  `);
    // Create tool_calls table
    db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
    )
  `);
    // Create vector search index.
    //
    // dtype: int8 quantized vectors use 4× less storage and ~2× faster KNN with
    // no recall@10 loss (measured on a 50K-exchange benchmark: 73.6MB→18.4MB,
    // p50 19.1ms→8.7ms, recall identical). Fresh DBs are created int8; existing
    // float32 DBs keep float32 until scripts/migrate-vec-int8.mjs converts them.
    // The authoritative dtype is the ACTUAL schema in sqlite_master (getVecQuant)
    // — float32 and int8 blobs are not interchangeable, and deriving from the
    // real schema (not a flag) makes flag/schema divergence impossible.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);
    // Run migrations first
    migrateSchema(db);
    // Create indexes (after migrations ensure columns exist)
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coding_agent ON exchanges(coding_agent)
  `);
    ensureExchangeTurnIndex(db);
    db.exec(EXCHANGE_REPOINT_DDL);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
  `);
    // === Full-text search index (FTS5) for exchanges ===
    // External-content FTS5: stores only the inverted index (not a second copy of
    // the text), reading the source columns from `exchanges` via rowid. Replaces
    // the O(rows) `LIKE '%q%'` full scan (measured p50 3.2s / p95 14.5s on 239K
    // rows) with a BM25-ranked index lookup. Triggers keep it in sync on every
    // insert/update/delete (INSERT OR REPLACE fires AFTER DELETE then AFTER INSERT,
    // so re-indexed exchanges stay consistent). The one-time backfill of existing
    // rows is done by scripts/backfill-fts.mjs (`'rebuild'`), NOT here — keeping
    // initDatabase() cheap since it runs on every MCP/hook invocation.
    //
    // detail=column: token positions are not stored — search.ts only issues
    // per-token (quoted single-term) matches, never phrase/NEAR queries, and
    // BM25 ranking still works at column granularity. On the production DB the
    // default detail=full index cost 2.9GB vs ~1.3GB for detail=column.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_message, assistant_message,
      content='exchanges', content_rowid='rowid',
      tokenize='porter unicode61',
      detail=column
    )
  `);
    // Readiness flag (deterministic, not probed). For an external-content FTS5
    // table the index is EMPTY right after creation even though the content table
    // (exchanges) already has rows — so `SELECT rowid FROM exchanges_fts` would
    // falsely look "ready". Track readiness explicitly instead. We (re)initialize
    // the flag whenever it is MISSING — not only when the FTS table is newly
    // created — so a DB from an earlier build (FTS table present, flag absent) or
    // a crash between CREATE and the flag write is still handled correctly rather
    // than permanently falling back to LIKE. When the flag is absent we cannot
    // prove the index is populated, so be conservative: an empty exchanges set is
    // ready (triggers index every future insert); a non-empty set stays NOT ready
    // until scripts/backfill-fts.mjs rebuilds the index and sets the flag.
    db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const hasFtsFlag = db.prepare(`SELECT 1 FROM fts_meta WHERE key='exchanges_fts_built'`).get() !== undefined;
    if (!hasFtsFlag) {
        const exchangesHaveRows = db.prepare('SELECT 1 FROM exchanges LIMIT 1').get() !== undefined;
        // INSERT OR IGNORE (not plain INSERT): initDatabase() runs in every MCP/hook
        // process, so two callers can both observe a missing flag and race to insert.
        // OR IGNORE makes the first writer win and the rest no-op instead of crashing
        // on SQLITE_CONSTRAINT_PRIMARYKEY. The value is deterministic for the DB state,
        // so a lost race is harmless.
        db.prepare(`INSERT OR IGNORE INTO fts_meta(key, value) VALUES('exchanges_fts_built', ?)`)
            .run(exchangesHaveRows ? '0' : '1');
    }
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ai AFTER INSERT ON exchanges BEGIN
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
    db.exec(EXCHANGES_FTS_AD_DDL);
    db.exec(EXCHANGES_FTS_AU_DDL);
    narrowFtsUpdateTrigger(db);
    // === Facts Schema ===
    db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT,
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      source_exchange_ids TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_count INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_project)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)
  `);
    // idx_facts_active(is_active) is no longer created, and is dropped where an
    // older build made it. It indexes a 2-valued column and repeats the leading
    // column of idx_facts_active_created_id; with no sqlite_stat1 rows the
    // planner estimates every equality index at ~10 rows and picked it for
    // `… AND is_active = 1` queries — measured live: the key-facts query 48ms vs
    // 0.02ms through idx_facts_scope, facts-by-category 4.41s vs 0.046s per 60
    // categories. Nothing is written once the index is gone.
    dropFactsActiveIndex(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      previous_fact TEXT NOT NULL,
      new_fact TEXT NOT NULL,
      reason TEXT,
      source_exchange_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id)
  `);
    // Per-table int8 scale record (see getVecQuant). Only the int8 migration
    // writes a row, in the transaction that swaps the table; no row = 127.
    db.exec(`
    CREATE TABLE IF NOT EXISTS ${VEC_INT8_SCALE_TABLE} (
      table_name TEXT PRIMARY KEY,
      scale REAL NOT NULL
    )
  `);
    // Fact-side vector indexes, created int8 with NO scale record (= 127, exactly
    // what 1.7.6 creates — so a 1.7.6 process sharing a fresh DB decodes it right):
    //  - vec_facts: the fact text.
    //  - vec_facts_kr: Korean-text index. Facts are embedded twice (fact / fact_kr)
    //    because multilingual models match same-language pairs far better than
    //    cross-language; queries search both tables and take the best score per id.
    //  - vec_categories: lets the ontology classifier retrieve the top-K
    //    most-similar existing categories for a fact instead of dumping ALL
    //    categories into the LLM prompt (measured 1,612 categories ≈ 95K tokens per
    //    classify call). Embeddings (category name + description, 'passage' mode)
    //    are written on createCategory; existing rows are backfilled by
    //    scripts/backfill-category-embeddings.mjs.
    // FACT_VEC_INT8_SCALE is recorded only by scripts/migrate-vec-facts-int8.mjs,
    // which first refuses while older-version code holds the DB. An existing
    // table is never touched here.
    for (const table of FACT_VEC_TABLES)
        db.exec(factVecTableDdl(table, 'int8', { ifNotExists: true }));
    // === Ontology Schema ===
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    // Idempotent column addition for facts.ontology_category_id
    const factColumns = db.prepare(`SELECT name FROM pragma_table_info('facts')`).all();
    const factColumnNames = new Set(factColumns.map((c) => c.name));
    if (!factColumnNames.has('ontology_category_id')) {
        db.prepare('ALTER TABLE facts ADD COLUMN ontology_category_id TEXT').run();
    }
    if (!factColumnNames.has('fact_kr')) {
        db.prepare('ALTER TABLE facts ADD COLUMN fact_kr TEXT').run();
    }
    if (!factColumnNames.has('coding_agent')) {
        db.prepare("ALTER TABLE facts ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'").run();
    }
    // Embedding model version (1 = all-MiniLM-L6-v2, 2 = multilingual L12-v2).
    // The re-embed worker upgrades rows where version < current.
    if (!factColumnNames.has('embedding_version')) {
        db.prepare('ALTER TABLE facts ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 1').run();
    }
    // Ontology classification attempt ledger: without it, a fact whose
    // classification permanently fails (unparseable LLM output, oversized
    // content) stays NULL forever and is re-selected by every backfill run —
    // one wasted LLM call per run per stuck fact. After MAX attempts the
    // classifier persists the General/Misc fallback so the fact leaves the
    // queue for good (it stays fully searchable — ontology is an overlay).
    if (!factColumnNames.has('ontology_attempts')) {
        db.prepare('ALTER TABLE facts ADD COLUMN ontology_attempts INTEGER NOT NULL DEFAULT 0').run();
    }
    // Consolidation attempt ledger (cross-run): a driver fact whose comparison
    // CALL keeps failing is held (retried) up to MAX attempts, then skipped so it
    // can't wedge the cursor. This distinguishes a short/transient outage (a few
    // attempts, then it succeeds and the counter resets) from a persistently
    // un-processable fact (reaches MAX and is skipped) WITHOUT inspecting the
    // provider-specific error — run-local counting alone can't, because a real
    // outage spans separate worker runs.
    if (!factColumnNames.has('consolidation_attempts')) {
        db.prepare('ALTER TABLE facts ADD COLUMN consolidation_attempts INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!factColumnNames.has('ontology_last_attempt_at')) {
        db.prepare('ALTER TABLE facts ADD COLUMN ontology_last_attempt_at TEXT').run();
    }
    // User-assigned tags (JSON array of strings, same storage shape as
    // source_exchange_ids). The ontology overlay is LLM-generated and therefore
    // not addressable by the user; tags are the one axis a person controls
    // directly — arbitrary labels for review layers ("verified"), cross-project
    // grouping ("mobile"), or case collection ("bug-report"). NULL means
    // untagged; the column is never written by the automatic pipeline.
    if (!factColumnNames.has('tags')) {
        db.prepare('ALTER TABLE facts ADD COLUMN tags TEXT').run();
    }
    const exchangeColumns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all();
    if (!exchangeColumns.some((c) => c.name === 'embedding_version')) {
        db.prepare('ALTER TABLE exchanges ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0').run();
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL REFERENCES facts(id),
      relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
      target_fact_id TEXT NOT NULL REFERENCES facts(id),
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    // Relation dedup + cross-process uniqueness (idempotent migration) — on
    // the TRIPLE (source, type, target), never the pair: distinct relation
    // TYPES between the same facts (a SUPPORTS b + a CONTRADICTS b) are valid,
    // user-visible graph data and must not be collapsed. Only EXACT duplicate
    // triples (same type re-written by pre-idempotency retries) are removed,
    // keeping the earliest row. A short-lived 2026-07-05 build shipped a
    // pair-level index by mistake — drop it so the triple index governs.
    db.exec(`DROP INDEX IF EXISTS idx_ontology_relations_pair`);
    db.exec(`
    DELETE FROM ontology_relations
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM ontology_relations
      GROUP BY source_fact_id, relation_type, target_fact_id
    )
  `);
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_relations_triple
    ON ontology_relations(source_fact_id, relation_type, target_fact_id)
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ontology_relations(source_fact_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ontology_relations(target_fact_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_ontology ON facts(ontology_category_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_coding_agent ON facts(coding_agent)`);
    // Keyset pagination for the consolidation drain (getAllNewFactsSince): serves
    // both `WHERE is_active = 1 AND (created_at, id) > cursor` and the
    // `ORDER BY created_at, id` without a temp sort over the whole table.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_active_created_id ON facts(is_active, created_at, id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_categories_domain ON ontology_categories(domain_id)`);
    // Tracks which sessions have been through fact extraction (SessionEnd hook
    // or the backfill worker). Makes extraction idempotent and lets the backfill
    // find unprocessed sessions across ALL projects.
    db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0
    )
  `);
    // Dead-letter marker for extraction (Codex 적대 리뷰 2026-07-17). A batch whose
    // LLM call fails DETERMINISTICALLY (400/413/max_tokens — the same input always
    // fails) is dropped so one bad batch can't wedge the session queue forever, but
    // dropping it silently means those exchanges' facts are lost with no record.
    // The count is persisted so the loss is queryable instead of invisible:
    //   SELECT session_id, dropped_batches FROM extraction_log WHERE dropped_batches > 0;
    // check-then-ALTER 는 경쟁 상태다 — hook 과 MCP 서버가 동시에 초기화하면 한쪽이
    // duplicate column 으로 실패해 DB 초기화 전체가 죽는다. 이미 있으면 성공으로
    // 흡수하고, 그 외 에러만 전파한다 (Codex 리뷰 R3 MEDIUM).
    {
        const cols = db.prepare(`SELECT name FROM pragma_table_info('extraction_log')`)
            .all();
        if (!cols.some((c) => c.name === 'dropped_batches')) {
            try {
                db.prepare('ALTER TABLE extraction_log ADD COLUMN dropped_batches INTEGER NOT NULL DEFAULT 0').run();
            }
            catch (e) {
                // 실패를 3분류한다 (Codex 리뷰 R3/R4 MEDIUM). duplicate 만 흡수하고 전부
                // 던지면, 다른 프로세스가 쓰기 락을 쥔 순간의 초기화가 통째로 죽어
                // 훅/워커가 그 세션을 아예 처리하지 못한다 — 일시적 경합이 기능 정지가 된다.
                const msg = e?.message ?? '';
                if (/duplicate column name/i.test(msg)) {
                    /* 이미 있음 — 다른 프로세스가 먼저 추가 */
                }
                else if (/database is locked|database table is locked|SQLITE_BUSY/i.test(msg)) {
                    // 일시적 경합: 이 컬럼은 선택적 메타데이터(폐기 배치 카운터)이므로 다음
                    // 초기화가 추가한다. 그때까지 이 컬럼을 쓰는 INSERT 는 자체 catch 로
                    // 마커를 남기지 않을 뿐이고, 세션은 pending 에 남아 재처리된다(손실 없음).
                    console.error('[db] extraction_log.dropped_batches 마이그레이션 지연 — 락 경합, 다음 초기화에서 재시도');
                }
                else {
                    throw e; // 진짜 스키마 이상은 조용히 넘기지 않는다
                }
            }
        }
        // claim_owner: 세션 선점의 **소유권 토큰**. 상태(-3)만으로는 "내 claim"을 SQL 로
        // 식별할 수 없어 한 러너의 롤백이 다른 러너의 살아있는 claim 을 덮는다(R7 HIGH-2).
        if (!cols.some((c) => c.name === 'claim_owner')) {
            try {
                db.prepare('ALTER TABLE extraction_log ADD COLUMN claim_owner TEXT').run();
            }
            catch (e) {
                const msg = e?.message ?? '';
                if (/duplicate column name/i.test(msg)) {
                    /* 다른 프로세스가 먼저 추가 */
                }
                else if (/database is locked|database table is locked|SQLITE_BUSY/i.test(msg)) {
                    console.error('[db] extraction_log.claim_owner 마이그레이션 지연 — 락 경합, 다음 초기화에서 재시도');
                }
                else {
                    throw e;
                }
            }
        }
    }
    // Self-heal slug-format scope_project rows (cheap probe; no-op when clean).
    // Keeps the canonical path format intact even when other devices sync in
    // facts written by older code.
    autoHealScopeProjects(db);
    return db;
}
/**
 * Longest tool_input stored per tool call (UTF-16 code units). tool_calls was
 * the largest table of one measured DB — 1.5GB, 35.9% of the file, 938MiB of
 * it tool_input — while its only reader shows the first 300 characters
 * (ui/server.cjs); nothing parses it back as JSON. The full input stays in the
 * archived transcript, which the `read` tool serves. Applies to rows written
 * from now on; existing rows are left as they are.
 */
export const TOOL_INPUT_MAX_CHARS = 1000;
function capToolInput(json) {
    if (json.length <= TOOL_INPUT_MAX_CHARS)
        return json;
    let end = TOOL_INPUT_MAX_CHARS;
    // Never cut between the two halves of a surrogate pair (a lone half is not valid text).
    const last = json.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        end--;
    return `${json.slice(0, end)}…[truncated: ${json.length - end} more chars]`;
}
/**
 * Write one exchange with its vector and tool calls. Returns false, with
 * nothing written, when a fuller snapshot of the same turn is already indexed
 * (see below) — true otherwise.
 */
export function insertExchange(db, exchange, embedding, _toolNames) {
    const now = Date.now();
    // ONE transaction for exchanges + vec + tool_calls, with the dtype read
    // INSIDE it. Two invariants depend on this:
    //  1. No partial state: an exchanges row without its vector must never be
    //     observable (the int8 migration snapshots/verifies by comparing the
    //     two tables — a row committed between separate transactions would be
    //     missed by its delta pass and lose its vector permanently).
    //  2. dtype consistency: the migration swaps the vec table dtype under
    //     BEGIN IMMEDIATE; reading dtype inside our own write transaction
    //     serializes against the swap, so we can never quantize for a schema
    //     that changed between the read and the write.
    const insertAll = db.transaction(() => {
        // Other snapshots of this turn. The id is md5(path:userLine-lastAssistantLine),
        // so a turn indexed while its answer was still being written gets a NEW id
        // on the next sync, and the shorter snapshot used to stay behind under the
        // old one (measured live: 11,981 extra rows, up to 102 for one turn). One
        // turn of one file = one (archive_path, line_start) = one row.
        const otherSnapshots = db.prepare('SELECT id, line_end FROM exchanges WHERE archive_path = ? AND line_start = ? AND id <> ?').all(exchange.archivePath, exchange.lineStart, exchange.id);
        // The row that stays is the one that ends latest (transcripts are
        // append-only: it holds everything the shorter ones hold). A shorter copy
        // arriving late must not replace it — a sync that read the file, then
        // wrote after the session's final turn had been indexed by another
        // process, used to delete the full row and leave its own shorter one,
        // which nothing but a rebuild brought back.
        if (otherSnapshots.some((other) => other.line_end > exchange.lineEnd))
            return false;
        if (otherSnapshots.length > 0) {
            // What names a replaced snapshot as its source is moved to this row
            // later, outside this transaction (repointQueuedExchangeSources): finding
            // it means reading every fact's source list — 61MB on the measured DB,
            // 1.6-2.4s under the write lock for every turn that had grown since the
            // last sync. Here the pair is only written down.
            db.exec(EXCHANGE_REPOINT_DDL);
            const forward = db.prepare(`UPDATE ${EXCHANGE_REPOINT_TABLE} SET to_id = ? WHERE to_id = ?`);
            const enqueue = db.prepare(`INSERT OR REPLACE INTO ${EXCHANGE_REPOINT_TABLE} (from_id, to_id, session_id, queued_at) VALUES (?, ?, ?, ?)`);
            for (const stale of otherSnapshots) {
                forward.run(exchange.id, stale.id); // a→stale still waiting becomes a→this row
                enqueue.run(stale.id, exchange.id, exchange.sessionId || null, now);
                deleteExchangeRows(db, stale.id);
            }
        }
        // This exchange's own tool calls from an earlier indexing. The schema this
        // file creates has no ON DELETE CASCADE on tool_calls.exchange_id (only
        // some older DBs carry one), so the REPLACE below does not remove them and
        // every re-index added the same calls again.
        db.prepare('DELETE FROM tool_calls WHERE exchange_id = ?').run(exchange.id);
        db.prepare(`
      INSERT OR REPLACE INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
       parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version,
       thinking_level, thinking_disabled, thinking_triggers, coding_agent, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(exchange.id, exchange.project, exchange.timestamp, exchange.userMessage, exchange.assistantMessage, exchange.archivePath, exchange.lineStart, exchange.lineEnd, now, exchange.parentUuid || null, exchange.isSidechain ? 1 : 0, exchange.sessionId || null, exchange.cwd || null, exchange.gitBranch || null, exchange.claudeVersion || null, exchange.thinkingLevel || null, exchange.thinkingDisabled ? 1 : 0, exchange.thinkingTriggers || null, exchange.codingAgent || 'claude-code', 
        // The embedding parameter was just generated with the current model, so
        // stamp the current version — search filters on it and the re-embed
        // worker must not redo freshly indexed rows.
        EMBEDDING_VERSION);
        // Vector upsert: DELETE+INSERT since virtual tables don't support REPLACE.
        const vecQuant = getVecQuant(db, 'vec_exchanges');
        db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(exchange.id);
        db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecQuant)})`)
            .run(exchange.id, embeddingToVecBlob(embedding, vecQuant));
        if (exchange.toolCalls && exchange.toolCalls.length > 0) {
            const toolStmt = db.prepare(`
        INSERT OR REPLACE INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            for (const toolCall of exchange.toolCalls) {
                toolStmt.run(toolCall.id, toolCall.exchangeId, toolCall.toolName, toolCall.toolInput ? capToolInput(JSON.stringify(toolCall.toolInput)) : null, toolCall.toolResult || null, toolCall.isError ? 1 : 0, toolCall.timestamp);
            }
        }
        return true;
    });
    // .immediate(): acquire the write lock at BEGIN, before any read — a
    // deferred BEGIN would let the int8 migration swap commit between our reads
    // and the lock upgrade (stale-dtype write / SQLITE_BUSY_SNAPSHOT).
    return insertAll.immediate();
}
/**
 * True when a fuller snapshot of this exchange's turn is already indexed — the
 * same file and start line, ending later. insertExchange refuses such a write;
 * a caller asks first so it does not embed text that will not be stored.
 */
export function hasFullerSnapshot(db, exchange) {
    return db.prepare('SELECT 1 FROM exchanges WHERE archive_path = ? AND line_start = ? AND line_end > ? LIMIT 1').get(exchange.archivePath, exchange.lineStart, exchange.lineEnd) !== undefined;
}
export function getAllExchanges(db) {
    const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
    return stmt.all();
}
export function getFileLastIndexed(db, archivePath) {
    const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
    const row = stmt.get(archivePath);
    return row.lastIndexed;
}
/**
 * Rows of one exchange, children first: tool_calls → vector → exchange. The
 * tool_calls FK has no ON DELETE CASCADE in the schema this file creates, and
 * better-sqlite3 turns foreign_keys on, so deleting the exchange first fails
 * with SQLITE_CONSTRAINT_FOREIGNKEY whenever it has tool calls. No transaction
 * of its own — every caller wraps it.
 */
function deleteExchangeRows(db, id) {
    db.prepare('DELETE FROM tool_calls WHERE exchange_id = ?').run(id);
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(id);
    db.prepare('DELETE FROM exchanges WHERE id = ?').run(id);
}
/** A fact's source list as stored (JSON array of exchange ids); null when it is not one. */
function parseSourceList(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null; // a malformed list names no exchange (every reader of this column treats it so)
    }
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
export function repointQueuedExchangeSources(db) {
    const result = { pairs: 0, scanned: false, facts: 0, revisions: 0 };
    const queued = db.prepare(`SELECT from_id AS fromId, to_id AS toId, session_id AS sessionId FROM ${EXCHANGE_REPOINT_TABLE}`).all();
    if (queued.length === 0)
        return result;
    result.pairs = queued.length;
    const byFrom = new Map(queued.map((q) => [q.fromId, q.toId]));
    const isIndexed = db.prepare('SELECT 1 FROM exchanges WHERE id = ?');
    const wasExtracted = db.prepare('SELECT 1 FROM extraction_log WHERE session_id = ?');
    const target = new Map();
    for (const q of queued) {
        if (isIndexed.get(q.fromId))
            continue; // indexed again under that id: what names it is right as it is
        if (q.sessionId !== null && !wasExtracted.get(q.sessionId))
            continue; // never extracted: nothing names it
        // insertExchange keeps the queue flat (a→b becomes a→c when b is replaced); follow a chain anyway.
        let to = q.toId;
        for (let hop = 0; hop < 16 && to !== q.fromId && byFrom.has(to); hop++)
            to = byFrom.get(to);
        target.set(q.fromId, to);
    }
    const factIds = [];
    const revisionIds = [];
    if (target.size > 0) {
        result.scanned = true;
        const facts = db.prepare(`SELECT id, source_exchange_ids AS sources FROM facts WHERE source_exchange_ids IS NOT NULL AND source_exchange_ids != '[]'`).iterate();
        for (const row of facts) {
            if (parseSourceList(row.sources)?.some((id) => typeof id === 'string' && target.has(id)))
                factIds.push(row.id);
        }
        const revisions = db.prepare('SELECT id, source_exchange_id AS source FROM fact_revisions WHERE source_exchange_id IS NOT NULL').iterate();
        for (const row of revisions) {
            if (target.has(row.source))
                revisionIds.push(row.id);
        }
    }
    db.transaction(() => {
        if (factIds.length > 0) {
            const readFact = db.prepare('SELECT source_exchange_ids AS sources FROM facts WHERE id = ?');
            const writeFact = db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?');
            for (const id of factIds) {
                const list = parseSourceList(readFact.get(id)?.sources ?? null);
                if (!list || !list.some((entry) => typeof entry === 'string' && target.has(entry)))
                    continue;
                // The row a snapshot was replaced by may already be in the list: one entry per exchange.
                const moved = [...new Set(list.map((entry) => (typeof entry === 'string' ? target.get(entry) ?? entry : entry)))];
                writeFact.run(JSON.stringify(moved), id);
                result.facts++;
            }
        }
        if (revisionIds.length > 0) {
            const readRevision = db.prepare('SELECT source_exchange_id AS source FROM fact_revisions WHERE id = ?');
            const writeRevision = db.prepare('UPDATE fact_revisions SET source_exchange_id = ? WHERE id = ?');
            for (const id of revisionIds) {
                const to = target.get(readRevision.get(id)?.source ?? '');
                if (to === undefined)
                    continue;
                writeRevision.run(to, id);
                result.revisions++;
            }
        }
        // Only the pairs read above, as they were read: one queued since then waits for the next run.
        const done = db.prepare(`DELETE FROM ${EXCHANGE_REPOINT_TABLE} WHERE from_id = ? AND to_id = ?`);
        for (const q of queued)
            done.run(q.fromId, q.toId);
    }).immediate();
    return result;
}
/** Delete one exchange with its tool calls and vector — all or nothing. */
export function deleteExchange(db, id) {
    db.transaction(() => deleteExchangeRows(db, id)).immediate();
}
/**
 * How long one delete batch may hold the write lock before it commits. Every
 * other process waits 5s for that lock and then fails ("database is locked" —
 * a session-start hook, a worker, the MCP server opening the DB). A batch
 * bounded only by row count (2,000) held it for over 5s on a large DB: each
 * row is an FTS delete (its whole text tokenized again) and a vec0 delete.
 */
export const DELETE_BATCH_MAX_MS = 400;
/**
 * Pause between two delete batches. A process waiting for the lock retries at
 * intervals of up to 100ms (SQLite's busy handler); batches that follow each
 * other at once leave it microseconds to land in, and it starves until its 5s
 * are over. The pause is longer than its longest sleep.
 */
export const DELETE_BATCH_PAUSE_MS = 120;
/**
 * Wait between two write transactions that follow each other, long enough for
 * a process waiting on the write lock to take it (see DELETE_BATCH_PAUSE_MS).
 * Call it with no transaction open.
 */
export function pauseForOtherWriters(ms = DELETE_BATCH_PAUSE_MS) {
    if (ms > 0)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Delete many exchanges in batches, each one transaction (see
 * deleteExchangeRows for the order). A batch ends at `batchSize` rows or after
 * DELETE_BATCH_MAX_MS, whichever comes first, and the next one starts after a
 * pause — so other processes keep writing while a maintenance command deletes.
 */
export function deleteExchanges(db, ids, batchSize = 2000, opts = {}) {
    // At most 2,000 per transaction: one transaction deleting 50K+ vec0 rows
    // tripped SQLITE_CORRUPT_VTAB in the extension's chunk bookkeeping (observed
    // live, scripts/purge-llm-sessions.mjs).
    const maxBatchMs = opts.maxBatchMs ?? DELETE_BATCH_MAX_MS;
    const pauseMs = opts.pauseMs ?? DELETE_BATCH_PAUSE_MS;
    let next = 0;
    const deleteBatch = db.transaction(() => {
        const started = Date.now();
        let n = 0;
        while (next + n < ids.length && n < batchSize) {
            deleteExchangeRows(db, ids[next + n]);
            n++;
            if (Date.now() - started >= maxBatchMs)
                break;
        }
        return n;
    });
    while (next < ids.length) {
        // `next` moves only after the commit: a batch that throws deleted nothing.
        next += deleteBatch.immediate();
        opts.onBatch?.(next);
        if (next < ids.length)
            pauseForOtherWriters(pauseMs);
    }
    return next;
}
/**
 * True when this exchange is already indexed as it stands: same id (the id is
 * derived from the file and its line range, and transcripts are append-only,
 * so the same id is the same text), embedded with the current model, and its
 * vector row present. A caller that sees true may skip embedding it again —
 * before this check every sync re-embedded and re-wrote every exchange of a
 * file that had grown by one line (measured live: 1,657 rows rewritten in a
 * day for 25 new exchanges; one 1.07GB conversation took 109s per sync).
 */
export function isExchangeCurrent(db, id) {
    return db.prepare(`
    SELECT 1 FROM exchanges e
    WHERE e.id = ? AND e.embedding_version = ?
      AND EXISTS (SELECT 1 FROM vec_exchanges_rowids v WHERE v.id = e.id)
  `).get(id, EMBEDDING_VERSION) !== undefined;
}
