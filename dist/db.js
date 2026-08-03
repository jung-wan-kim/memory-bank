import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { autoHealScopeProjects } from './project-canon.js';
import { EMBEDDING_VERSION } from './embeddings.js';
export const VEC_INT8_SCALE = 127;
/**
 * Authoritative vector dtype for vec_exchanges.
 *
 * Derived from the ACTUAL table schema in sqlite_master — not a metadata flag.
 * A flag can diverge from the real schema (missing/corrupt flag on an int8
 * table would silently send float32 params against int8 storage); parsing the
 * declared column type cannot. Absent table ⇒ 'int8' (that is what
 * initDatabase creates for fresh DBs).
 */
const VEC_TABLES = new Set(['vec_exchanges', 'vec_facts', 'vec_facts_kr', 'vec_categories']);
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
export function getVecDtype(db) {
    return getVecTableDtype(db, 'vec_exchanges');
}
/** Convert a float embedding to the blob matching the table dtype. */
export function embeddingToVecBlob(embedding, dtype) {
    if (dtype === 'int8') {
        const q = new Int8Array(embedding.length);
        for (let i = 0; i < embedding.length; i++) {
            q[i] = Math.max(-127, Math.min(127, Math.round(embedding[i] * VEC_INT8_SCALE)));
        }
        return Buffer.from(q.buffer);
    }
    return Buffer.from(new Float32Array(embedding).buffer);
}
/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export function vecParamSql(dtype) {
    return dtype === 'int8' ? 'vec_int8(?)' : '?';
}
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export function normalizeVecDistance(distance, dtype) {
    return dtype === 'int8' ? distance / VEC_INT8_SCALE : distance;
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
export function initDatabase() {
    const dbPath = getDbPath();
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
    // The authoritative dtype is the ACTUAL schema in sqlite_master (getVecDtype)
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
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
    END
  `);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
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
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)
  `);
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
    // vec_facts virtual table (sqlite-vec)
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);
    // Korean-text vector index: facts are embedded twice (fact / fact_kr) because
    // multilingual models match same-language pairs far better than cross-language.
    // Queries search both tables and take the best score per fact id.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts_kr USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);
    // Category embedding index: lets the ontology classifier retrieve the top-K
    // most-similar existing categories for a fact instead of dumping ALL
    // categories into the LLM prompt (measured 1,612 categories ≈ 95K tokens per
    // classify call). Embeddings (category name + description, 'passage' mode) are
    // written on createCategory; existing rows are backfilled by
    // scripts/backfill-category-embeddings.mjs.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_categories USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);
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
        const vecDtype = getVecDtype(db);
        db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(exchange.id);
        db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`)
            .run(exchange.id, embeddingToVecBlob(embedding, vecDtype));
        if (exchange.toolCalls && exchange.toolCalls.length > 0) {
            const toolStmt = db.prepare(`
        INSERT OR REPLACE INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            for (const toolCall of exchange.toolCalls) {
                toolStmt.run(toolCall.id, toolCall.exchangeId, toolCall.toolName, toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null, toolCall.toolResult || null, toolCall.isError ? 1 : 0, toolCall.timestamp);
            }
        }
    });
    // .immediate(): acquire the write lock at BEGIN, before any read — a
    // deferred BEGIN would let the int8 migration swap commit between our reads
    // and the lock upgrade (stale-dtype write / SQLITE_BUSY_SNAPSHOT).
    insertAll.immediate();
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
export function deleteExchange(db, id) {
    // Delete from vector table
    db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);
    // Delete from main table
    db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}
