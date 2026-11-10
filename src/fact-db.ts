import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Fact, FactRevision } from './types.js';
import { canonicalizeProject } from './project-canon.js';
import { EMBEDDING_VERSION } from './embedding-version.js';
import { getVecQuant, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity } from './db.js';
import { factRejectReason, factTextRejectReason, factKrRejectReason } from './fact-validity.js';
import { scopeMatcher } from './project-family.js';
import { VEC0_KNN_K_MAX } from './vec-limits.js';

type FactVecTable = 'vec_facts' | 'vec_facts_kr' | 'vec_categories';

/** dtype/scale-aware MATCH/INSERT param for a fact-side vec table: the SQL
 * placeholder (vec_int8(?) wrap for int8), the correctly-encoded blob and the
 * table's VecQuant (to normalize distances). float32 tables (pre-migration
 * DBs) and int8 tables at 127 (legacy and fresh DBs) or 600 (after
 * scripts/migrate-vec-facts-int8.mjs) are all served — the schema and the
 * recorded scale decide. */
function vecParamFor(db: Database.Database, table: FactVecTable, embedding: number[]) {
  const q = getVecQuant(db, table);
  return { sql: vecParamSql(q), blob: embeddingToVecBlob(embedding, q), q };
}

/**
 * DELETE+INSERT one vector (vec0 has no REPLACE). The dtype/scale is read
 * INSIDE the write transaction (BEGIN IMMEDIATE when outermost, a savepoint
 * inside a caller's transaction), so a concurrent migration swap can never
 * leave a blob encoded for the table it replaced.
 */
function upsertFactVector(db: Database.Database, table: FactVecTable, id: string, embedding: number[]): void {
  db.transaction(() => {
    const p = vecParamFor(db, table, embedding);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${p.sql})`).run(id, p.blob);
  }).immediate();
}

/**
 * Run a KNN against a fact-side vec table. Only a MISSING table (very old
 * DBs) reads as "no candidates". A migration can swap the table's dtype/scale
 * between reading it and the MATCH, so one retry re-reads it; any other
 * failure (corrupt scale record, dimension mismatch, closed handle) throws —
 * returning [] here made it look like "no relevant facts" to injection,
 * MCP search and consolidation alike.
 */
function factKnn<T>(table: FactVecTable, run: () => T, empty: T): T {
  try {
    return run();
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return empty;
    return run();
  }
}


interface InsertFactParams {
  fact: string;
  category: string;
  scope_type: string;
  scope_project: string | null;
  source_exchange_ids: string[];
  embedding: number[] | null;  // number[] to match generateEmbedding() return type
  coding_agent?: string;       // e.g., 'claude-code', 'codex', 'opencode'
  fact_kr?: string | null;     // Korean translation — enables same-language matching for Korean queries
  embedding_kr?: number[] | null;
}

interface UpdateFactParams {
  /**
   * New sentence. When it differs from the stored one, the row's fact_kr — a
   * translation of the OLD sentence — does not stay: it becomes `fact_kr` when
   * that is given, and is cleared otherwise, together with its vec_facts_kr
   * row. Pass `embedding` with it: this function does not embed, and a row
   * keeps whatever vector it has.
   */
  fact?: string;
  embedding?: number[] | null;
  /**
   * Korean sentence of the sentence the row holds after this update (null =
   * none). A caller that rewrites `fact` and has the new sentence's Korean one
   * passes it here — a rewritten fact left without one is out of reach of
   * Korean queries (measured: top-10 for 92 of 92 queries before a rewrite, 26
   * after). `embedding_kr` is its vector; given without one, the row's old
   * Korean vector is removed and the re-embed worker builds the new one.
   */
  fact_kr?: string | null;
  embedding_kr?: number[] | null;
  consolidated_count_increment?: boolean;
  /** Confirmations to add — the consolidated_count of a fact merged into this one. */
  consolidated_count_add?: number;
  /** Sources to add (set union, order kept) — the sources of a fact merged into this one. */
  add_source_exchange_ids?: string[];
}

interface InsertRevisionParams {
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
}

export function insertFact(db: Database.Database, params: InsertFactParams): string {
  // Last line of defence for every writer (extractor, capture-decision, the
  // cc-sync memory-doc importer): template residue never reaches the table.
  const rejectReason = factRejectReason(params);
  if (rejectReason) throw new Error(`insertFact refused (${rejectReason}): ${String(params.fact).slice(0, 60)}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  const scopeProject = params.scope_project
    ? canonicalizeProject(db, params.scope_project)
    : params.scope_project;

  // Row + vectors in one write transaction (a savepoint inside a caller's): a
  // failed vector write must not leave a committed row without its vector —
  // no probe or worker re-creates a missing vec_facts row for a current-
  // version fact, so it would be invisible to vector search for good.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active, coding_agent, fact_kr, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
    `).run(
      id,
      params.fact,
      params.category,
      params.scope_type,
      scopeProject,
      JSON.stringify(params.source_exchange_ids),
      params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null,
      now,
      now,
      params.coding_agent || 'claude-code',
      params.fact_kr ?? null,
      EMBEDDING_VERSION,
    );

    // Insert into vector index (atomic DELETE+INSERT via transaction)
    if (params.embedding) upsertFactVector(db, 'vec_facts', id, params.embedding);

    // Korean-text vector index (same-language matching for Korean queries)
    if (params.embedding_kr) upsertFactVector(db, 'vec_facts_kr', id, params.embedding_kr);
  }).immediate();

  return id;
}

export function getActiveFacts(db: Database.Database): Fact[] {
  return (db.prepare('SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC')
    .all() as Record<string, unknown>[])
    .map(rowToFact);
}

export function getFactsByProject(db: Database.Database, project: string): Fact[] {
  const canon = canonicalizeProject(db, project);
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `).all(canon) as Record<string, unknown>[]).map(rowToFact);
}

export function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void {
  if (params.fact !== undefined) {
    const reason = factTextRejectReason(params.fact);
    if (reason) throw new Error(`updateFact refused (${reason}): ${JSON.stringify(String(params.fact)).slice(0, 80)}`);
  }
  if (params.fact_kr !== undefined && params.fact_kr !== null) {
    const reason = factKrRejectReason(params.fact_kr);
    if (reason) throw new Error(`updateFact refused (fact_kr: ${reason}): ${JSON.stringify(String(params.fact_kr)).slice(0, 80)}`);
  }
  const now = new Date().toISOString();
  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (params.fact !== undefined) {
    updates.push('fact = ?');
    values.push(params.fact);
  }
  if (params.embedding !== undefined) {
    updates.push('embedding = ?');
    values.push(params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null);
  }
  if (params.consolidated_count_increment) {
    updates.push('consolidated_count = consolidated_count + 1');
  }
  if (params.consolidated_count_add !== undefined) {
    if (!Number.isInteger(params.consolidated_count_add) || params.consolidated_count_add < 1) {
      throw new Error(`updateFact refused (consolidated_count_add must be a positive integer): ${params.consolidated_count_add}`);
    }
    updates.push('consolidated_count = consolidated_count + ?');
    values.push(params.consolidated_count_add);
  }

  // Row + vector together (see insertFact): the stored embedding and the
  // index must not disagree after a failed vector write.
  db.transaction(() => {
    // Read inside the write transaction: the comparison and the union below
    // must see the row this UPDATE is about to change.
    const current = db.prepare('SELECT fact, fact_kr, source_exchange_ids FROM facts WHERE id = ?')
      .get(id) as { fact: string; fact_kr: string | null; source_exchange_ids: string | null } | undefined;
    const rowUpdates = [...updates];
    const rowValues = [...values];
    const sentenceChanges = current !== undefined && params.fact !== undefined && params.fact !== current.fact;
    // The Korean sentence translates the stored one; after a rewrite the old
    // one would describe a sentence the row no longer holds — it is replaced
    // by the one given, or cleared.
    const nextKr = params.fact_kr !== undefined ? params.fact_kr : sentenceChanges ? null : undefined;
    const krChanges = current !== undefined && nextKr !== undefined && nextKr !== (current.fact_kr ?? null);
    if (krChanges) {
      rowUpdates.push('fact_kr = ?');
      rowValues.push(nextKr);
    }
    if (current && params.add_source_exchange_ids?.length) {
      const merged = [...new Set([...(JSON.parse(current.source_exchange_ids || '[]') as string[]), ...params.add_source_exchange_ids])];
      rowUpdates.push('source_exchange_ids = ?');
      rowValues.push(JSON.stringify(merged));
    }
    db.prepare(`UPDATE facts SET ${rowUpdates.join(', ')} WHERE id = ?`).run(...rowValues, id);
    if (params.embedding) upsertFactVector(db, 'vec_facts', id, params.embedding);
    // The Korean vector follows the Korean sentence: gone with the old one
    // (and never left behind a sentence that has none), written when the new
    // one came with its vector.
    if (krChanges || (sentenceChanges && !nextKr)) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
    if (current && nextKr && params.embedding_kr) upsertFactVector(db, 'vec_facts_kr', id, params.embedding_kr);
  }).immediate();
}

/**
 * A fact's Korean sentence with its stored Korean vector (decoded, see
 * storedFactVector), or null when the fact has no Korean sentence. `vector` is
 * null when the sentence has no vec_facts_kr row — always the case for an
 * inactive fact (deactivateFact removes it).
 */
export function getFactKorean(db: Database.Database, id: string): { text: string; vector: number[] | null } | null {
  const row = db.prepare('SELECT fact_kr FROM facts WHERE id = ?').get(id) as { fact_kr: string | null } | undefined;
  const text = row?.fact_kr;
  if (!text || text.trim() === '') return null;
  return { text, vector: storedFactVector(db, 'vec_facts_kr', id) };
}

/**
 * Write a fact's Korean sentence and its vector, leaving the fact itself as it
 * is — `updated_at` included (a translation filled in later is not a change of
 * the fact; getTopFacts ranks by how recently a fact changed).
 */
export function setFactKorean(db: Database.Database, id: string, text: string, vector: number[]): void {
  const reason = factKrRejectReason(text);
  if (reason) throw new Error(`setFactKorean refused (${reason}): ${JSON.stringify(String(text)).slice(0, 80)}`);
  db.transaction(() => {
    const changed = db.prepare('UPDATE facts SET fact_kr = ? WHERE id = ?').run(text, id).changes;
    if (changed === 0) throw new Error(`setFactKorean: fact not found: ${id}`);
    upsertFactVector(db, 'vec_facts_kr', id, vector);
  }).immediate();
}

export function deactivateFact(db: Database.Database, id: string): void {
  db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
  // Deactivated facts must not occupy vector index slots
  db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
}

export function deleteFact(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
  db.prepare('DELETE FROM fact_revisions WHERE fact_id = ?').run(id);
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

export function insertRevision(db: Database.Database, params: InsertRevisionParams): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.fact_id, params.previous_fact, params.new_fact, params.reason, params.source_exchange_id, new Date().toISOString());
  return id;
}

export function getRevisions(db: Database.Database, factId: string): FactRevision[] {
  return db.prepare(
    'SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY created_at DESC'
  ).all(factId) as FactRevision[];
}

/** Options of searchSimilarFacts that only the injection selection (and its replay bench) passes. */
export interface FactSearchOptions {
  /** Widen the project scope to the repository family (project-family.ts). */
  scopeFamily?: boolean;
  /**
   * Replay bench only: which vector rows existed at the replayed moment. Applied
   * BEFORE the overfetch cut, so the cut sees the same top rows the index held
   * then (rows added later cannot crowd them out).
   */
  visibleId?: (id: string) => boolean;
}

// vec0 refuses a larger k (vec-limits.ts) — at 6400 the replay bench threw once
// fewer than candidateFetch of the nearest 3,200 rows were visible.
const VISIBLE_FETCH_CAP = VEC0_KNN_K_MAX;

export function searchSimilarFacts(
  db: Database.Database,
  embedding: number[],
  project: string | null,
  limit: number = 5,
  threshold: number = 0.85,
  opts: FactSearchOptions = {},
): Array<{ fact: Fact; distance: number }> {
  const canonProject = project ? canonicalizeProject(db, project) : project;
  const inScope = scopeMatcher(canonProject, opts.scopeFamily === true);

  // Search both language indexes: the query language is unknown, and
  // multilingual models score same-language pairs far higher than
  // cross-language pairs. Keep the best (smallest) distance per fact id.
  //
  // Overfetch well beyond `limit`: the scope filter below runs AFTER the
  // vector lookup, and in a multi-project DB the global top-N is easily
  // dominated by other projects' facts — fetching only limit*2 starves the
  // requested scope of candidates entirely.
  const candidateFetch = Math.max(limit * 2, 50);
  // Per-table dtype: the two language indexes can be at DIFFERENT dtypes
  // mid-migration, and int8 distances come back ×scale — normalize
  // BEFORE the cross-table merge or the scales are incomparable.
  const knn = (table: FactVecTable, n: number) => factKnn(table, () => {
    const p = vecParamFor(db, table, embedding);
    const rows = db.prepare(`
      SELECT id, distance FROM ${table}
      WHERE embedding MATCH ${p.sql}
      ORDER BY distance
      LIMIT ?
    `).all(p.blob, n) as Array<{ id: string; distance: number }>;
    for (const r of rows) r.distance = normalizeVecDistance(r.distance, p.q);
    return rows;
  }, [] as Array<{ id: string; distance: number }>);
  const visibleId = opts.visibleId;
  const fetch = (table: FactVecTable) => {
    if (!visibleId) return knn(table, candidateFetch);
    // Grow the fetch until candidateFetch visible rows are in hand (or the index runs out).
    for (let n = Math.min(candidateFetch * 4, VISIBLE_FETCH_CAP); ; n = Math.min(n * 4, VISIBLE_FETCH_CAP)) {
      const rows = knn(table, n);
      const visible = rows.filter((r) => visibleId(r.id));
      if (visible.length >= candidateFetch || rows.length < n || n >= VISIBLE_FETCH_CAP) return visible.slice(0, candidateFetch);
    }
  };

  const best = new Map<string, number>();
  for (const vr of [...fetch('vec_facts'), ...fetch('vec_facts_kr')]) {
    const cur = best.get(vr.id);
    if (cur === undefined || vr.distance < cur) best.set(vr.id, vr.distance);
  }
  const merged = [...best.entries()]
    .map(([id, distance]) => ({ id, distance }))
    .sort((a, b) => a.distance - b.distance);

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of merged) {
    // L2 distance -> cosine similarity approximation
    const similarity = l2DistanceToSimilarity(vr.distance);
    if (similarity < threshold) continue;

    // embedding_version filter: during a model migration the vector tables
    // can still hold old-model rows; comparing them against a current-model
    // query embedding silently misranks. Skip until the worker upgrades them.
    const row = db.prepare(
      'SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?'
    ).get(vr.id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;
    if (!row) continue;

    const fact = rowToFact(row);
    // Scope filter: same project (or its repository family, when asked) or global only
    if (fact.scope_type === 'project' && !inScope(fact.scope_project)) continue;

    results.push({ fact, distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Distance from `embedding` to one fact's stored vectors: the smaller of its
 * English and Korean vectors — the same rule the KNN above ranks by (it keeps
 * the best distance per id across both tables), normalized for int8 tables.
 * null when the fact has no vector of the current embedding version.
 */
export function factVectorDistance(db: Database.Database, factId: string, embedding: number[]): number | null {
  const row = db.prepare('SELECT embedding_version FROM facts WHERE id = ?').get(factId) as { embedding_version: number } | undefined;
  if (!row || row.embedding_version !== EMBEDDING_VERSION) return null;
  let best: number | null = null;
  for (const table of ['vec_facts', 'vec_facts_kr'] as const) {
    const d = factKnn(table, () => {
      const p = vecParamFor(db, table, embedding);
      const hit = db.prepare(`SELECT vec_distance_l2(embedding, ${p.sql}) AS d FROM ${table} WHERE id = ?`)
        .get(p.blob, factId) as { d: number } | undefined;
      return hit ? normalizeVecDistance(hit.d, p.q) : null;
    }, null as number | null);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

export interface SameScopeSearchOptions {
  /**
   * Called when the search stopped at the KNN k limit with fewer than `limit`
   * results while rows above the threshold were still unread — in-scope
   * matches farther than the nearest `k` rows were not examined.
   */
  onCapReached?: (info: { k: number; found: number }) => void;
  /**
   * Also search with this fact's own stored Korean vector (its vec_facts_kr
   * row, when it has one). `embedding` is one language's vector, and a
   * multilingual model scores cross-language pairs well below same-language
   * ones (measured on live facts: 0.93 against 0.99) — an English sentence's
   * vector does not reach the same fact written in Korean, its Korean
   * translation's vector does. Each fact keeps its best distance over both.
   */
  krVectorOfFactId?: string;
}

/**
 * One fact's stored vector in a fact-side vec table, decoded to float32 scale
 * (int8 rows are divided by the table's scale; re-encoding the result for the
 * same table gives the stored bytes back). null when the fact has no row there.
 */
function storedFactVector(db: Database.Database, table: FactVecTable, id: string): number[] | null {
  return factKnn(table, () => {
    const q = getVecQuant(db, table);
    const row = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    const bytes = row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength);
    return q.dtype === 'int8'
      ? Array.from(new Int8Array(bytes), (x) => x / q.scale)
      : Array.from(new Float32Array(bytes));
  }, null as number[] | null);
}

/**
 * Nearest active facts restricted to EXACTLY one scope — used by consolidation
 * so a project-private fact and a global fact can never be compared/merged
 * across the boundary (which would leak private text into global memory or let
 * one project mutate shared global facts). The scope filter is applied to the
 * FULL overfetched candidate list BEFORE truncation, so a same-scope match is
 * not starved out by closer out-of-scope rows (which the general
 * searchSimilarFacts truncates first).
 *
 * scope: { type:'global' } → global facts only.
 *        { type:'project', project } → that project's own facts only (no global).
 *
 * Paging ends as soon as nothing further can pass: a KNN returns rows nearest
 * first, so once a table's last returned row is below `threshold` every row
 * behind it is too. k never exceeds VEC0_KNN_K_MAX — when more rows than that
 * pass the threshold and fewer than `limit` of the nearest ones are in scope,
 * the search returns what those nearest rows held (not a throw, not []) and
 * reports it through `opts.onCapReached`.
 */
export function searchSimilarFactsSameScope(
  db: Database.Database,
  embedding: number[],
  scope: { type: 'global' } | { type: 'project'; project: string },
  limit: number = 5,
  threshold: number = 0.85,
  opts: SameScopeSearchOptions = {},
): Array<{ fact: Fact; distance: number }> {
  const canonProject = scope.type === 'project' ? canonicalizeProject(db, scope.project) : null;

  // Early out only if the scope is genuinely empty (nothing to match against).
  const scopeCount = scope.type === 'global'
    ? (db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND scope_type = 'global' AND embedding_version = ?").get(EMBEDDING_VERSION) as { n: number }).n
    : (db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ? AND embedding_version = ?").get(canonProject, EMBEDDING_VERSION) as { n: number }).n;
  if (scopeCount === 0) return [];

  // fetchN returns rows AND whether the index returned fewer than requested
  // (i.e. it was exhausted). We page on the VECTOR-TABLE row count, not the
  // active-fact count: the vec tables can hold stale/old-version rows that rank
  // ahead of a valid in-scope row and are only rejected later by the
  // embedding_version filter, so bounding by active facts could stop before
  // reaching the match. `exhausted` is the correct, index-size-independent stop.
  // `done` adds the distance-order stop: the table ran out, OR its farthest
  // returned row is already below the threshold (nothing behind it can pass).
  const fetchN = (table: FactVecTable, query: number[], n: number): { rows: Array<{ id: string; distance: number }>; done: boolean } =>
    factKnn(table, () => {
      const p = vecParamFor(db, table, query);
      const rows = db.prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ${p.sql} ORDER BY distance LIMIT ?
      `).all(p.blob, n) as Array<{ id: string; distance: number }>;
      // Normalize ×scale int8 distances BEFORE the cross-table merge.
      for (const r of rows) r.distance = normalizeVecDistance(r.distance, p.q);
      const exhausted = rows.length < n;
      return { rows, done: exhausted || l2DistanceToSimilarity(rows[rows.length - 1].distance) < threshold };
    }, { rows: [], done: true });

  // vec0 refuses k > VEC0_KNN_K_MAX. The old ceiling (100,000) let k grow
  // 200 → 800 → 3,200 → 12,800 and the fourth page threw on every driver with
  // fewer than `limit` matches in an index of more than 3,200 rows.
  // Query vectors: the given one, plus the driver's own Korean vector when asked for.
  const queries = [embedding];
  const krVector = opts.krVectorOfFactId ? storedFactVector(db, 'vec_facts_kr', opts.krVectorOfFactId) : null;
  if (krVector) queries.push(krVector);

  let fetchCount = Math.min(Math.max(limit * 20, 200), VEC0_KNN_K_MAX);
  let results: Array<{ fact: Fact; distance: number }> = [];
  for (;;) {
    const lookups = queries.flatMap((q) => [fetchN('vec_facts', q, fetchCount), fetchN('vec_facts_kr', q, fetchCount)]);
    const best = new Map<string, number>();
    for (const vr of lookups.flatMap((l) => l.rows)) {
      const cur = best.get(vr.id);
      if (cur === undefined || vr.distance < cur) best.set(vr.id, vr.distance);
    }
    const merged = [...best.entries()].map(([id, distance]) => ({ id, distance })).sort((x, y) => x.distance - y.distance);

    results = [];
    for (const vr of merged) {
      const similarity = l2DistanceToSimilarity(vr.distance);
      if (similarity < threshold) continue;
      const row = db.prepare(
        'SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?'
      ).get(vr.id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;
      if (!row) continue;
      const fact = rowToFact(row);
      if (scope.type === 'global') {
        if (fact.scope_type !== 'global') continue;
      } else if (fact.scope_type !== 'project' || fact.scope_project !== canonProject) {
        continue;
      }
      results.push({ fact, distance: vr.distance });
      if (results.length >= limit) break;
    }

    // Stop when we have enough or no lookup can yield another passing row.
    if (results.length >= limit || lookups.every((l) => l.done)) break;
    // At the k limit with rows above the threshold still unread: return what
    // the nearest rows held and say so — a partial answer the caller can count,
    // instead of failing the search (and with it the whole drain).
    if (fetchCount >= VEC0_KNN_K_MAX) {
      opts.onCapReached?.({ k: fetchCount, found: results.length });
      break;
    }
    fetchCount = Math.min(fetchCount * 4, VEC0_KNN_K_MAX);
  }

  return results;
}

/** Global facts in the session-start block: at most this many of `limit`; the other slots are the project's. */
export const TOP_FACTS_GLOBAL_MAX = 3;

/**
 * consolidated_count stops adding to the score here. It counts DUPLICATE/EVOLUTION
 * merges, not independent confirmations, so it grows fastest for text that every
 * session re-states (memory-file facts: 20 merges in two days from one source
 * conversation, measured 2026-11-10) — uncapped, its log outweighed everything else.
 */
const TOP_FACTS_COUNT_CAP = 4;

/** MEMORY_BANK_KEY_FACTS_GLOBAL_MAX: a non-negative integer; anything else is the default. */
export function topFactsGlobalMax(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  return /^\d+$/.test(t) ? Number(t) : TOP_FACTS_GLOBAL_MAX;
}

/**
 * The facts of the session-start "Project Key Facts" block: the project's first,
 * then at most `globalMax` global ones.
 *
 * - Project = the repository family of `rawProject` (scopeMatcher, the predicate
 *   the per-prompt injection uses): a session in a sub-folder or a linked worktree
 *   gets the repository's facts, the repository gets its worktrees'. A path
 *   outside any repository sees its exact scope only, as before.
 * - Slots: global facts take min(globalMax, limit) slots at most, project facts
 *   the rest. A slot the global side cannot fill goes to the project; a slot the
 *   project cannot fill stays empty — the cap on global facts is a cap. (Before,
 *   the two sides competed on one score and the final order was by score: every
 *   project opened with the same heavily-merged global facts.)
 * - Score, within each side: count term 3 × (1 + log2(min(consolidated_count,
 *   TOP_FACTS_COUNT_CAP) + 1)), recency 5 / 3 / 1 / 0 for updated within 7 / 30 /
 *   90 days / older, and +2 for a fact scoped to exactly this cwd (ahead of the
 *   rest of its family).
 * - Ties: most recently updated first, then id — a total order, so the same rows
 *   give the same block. 96.6% of project facts have count 1 (measured), so most
 *   of the project side is decided here; without it the cut among equals was
 *   whatever order SQLite happened to return.
 */
export function getTopFacts(
  db: Database.Database,
  rawProject: string,
  limit: number = 10,
  opts: { globalMax?: number } = {},
): Fact[] {
  const project = canonicalizeProject(db, rawProject);
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();

  const scoreExpr = `
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(MIN(consolidated_count, ${TOP_FACTS_COUNT_CAP}) + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN updated_at >= ? THEN 5 WHEN updated_at >= ? THEN 3 WHEN updated_at >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score`;
  const order = 'ORDER BY relevance_score DESC, updated_at DESC, id ASC';

  // `+is_active` keeps the planner off the two-valued is_active index (it walks every
  // active fact) and on idx_facts_scope, which holds only the rows of the scopes asked for.
  const wanted = opts.globalMax ?? TOP_FACTS_GLOBAL_MAX;
  const globalSlots = Math.max(0, Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : TOP_FACTS_GLOBAL_MAX, limit));
  const globalRows = globalSlots === 0 ? [] : db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE +is_active = 1 AND scope_type = 'global'
    ${order}
    LIMIT ?
  `).all(d7, d30, d90, project, globalSlots) as Record<string, unknown>[];

  // The family predicate reads the filesystem, so it runs over the distinct project
  // scopes (an index-only read, a few hundred values), not over fact rows.
  // No project (empty cwd) = no project facts: scopeMatcher reads a missing project as "every
  // scope is visible" (its meaning for searches), which here would put every project's facts
  // into one session's block.
  const inScope = project ? scopeMatcher(project, true) : () => false;
  const scopes = (db.prepare("SELECT DISTINCT scope_project AS s FROM facts WHERE scope_type = 'project'")
    .all() as Array<{ s: string | null }>)
    .map((r) => r.s)
    .filter((s): s is string => s !== null && inScope(s));
  const projectSlots = limit - globalRows.length;
  const projectRows = scopes.length === 0 || projectSlots <= 0 ? [] : db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE +is_active = 1 AND scope_type = 'project' AND scope_project IN (${scopes.map(() => '?').join(', ')})
    ${order}
    LIMIT ?
  `).all(d7, d30, d90, project, ...scopes, projectSlots) as Record<string, unknown>[];

  return [...projectRows, ...globalRows].map(rowToFact);
}

/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export function getTopFactsByCount(db: Database.Database, project: string, limit: number = 10): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
    LIMIT ?
  `).all(canonicalizeProject(db, project), limit) as Record<string, unknown>[]).map(rowToFact);
}

export function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `).all(since, canonicalizeProject(db, project)) as Record<string, unknown>[]).map(rowToFact);
}

/**
 * All active facts after a KEYSET cursor `(createdAt, id)`, EVERY scope/project,
 * each row once, ordered by (created_at, id). The composite key is what makes
 * the consolidate cursor strictly monotonic PER FACT: ordering by created_at
 * alone stalls when a whole timestamp group is larger than the per-run budget
 * (the cursor can't advance into a shared timestamp without risking a skip), so
 * `id` is the unique tiebreaker that lets the drain progress one fact at a time.
 *
 * cursor null → from the beginning (all active facts).
 *
 * KNOWN LIMITATION (best-effort dedup): a fact IMPORTED mid-drain with an old
 * `created_at` that sorts before the current cursor is not re-driven by this
 * pass (it's still a similarity CANDIDATE for future facts, so a duplicate is
 * still caught opportunistically). Consolidation is a background convenience,
 * not an exhaustive guarantee, so this is accepted rather than adding a
 * full re-scan on every import.
 */
export function getAllNewFactsSince(
  db: Database.Database,
  cursor: { createdAt: string; id: string } | null,
  limit: number = 2000,
): Fact[] {
  // Bounded page (keyset) — NEVER materialize the whole table: seeding from the
  // beginning could otherwise pull tens of thousands of rows into memory in one
  // query. The keyset cursor makes each run resume exactly where the last ended,
  // so the backlog drains page-by-page. The idx_facts_active_created_id index
  // (is_active, created_at, id) serves both the filter and the ORDER BY without
  // a temp sort.
  if (!cursor) {
    return (db.prepare(`
      SELECT * FROM facts WHERE is_active = 1 ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(limit) as Record<string, unknown>[]).map(rowToFact);
  }
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND (created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at ASC, id ASC LIMIT ?
  `).all(cursor.createdAt, cursor.createdAt, cursor.id, limit) as Record<string, unknown>[]).map(rowToFact);
}

/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export function searchAllFacts(
  db: Database.Database,
  embedding: number[],
  limit: number = 10,
  threshold: number = 0.6,
): Array<{ fact: Fact; distance: number }> {
  const vecResults = factKnn('vec_facts', () => {
    const pAll = vecParamFor(db, 'vec_facts', embedding);
    const rows = db.prepare(`
      SELECT id, distance
      FROM vec_facts
      WHERE embedding MATCH ${pAll.sql}
      ORDER BY distance
      LIMIT ?
    `).all(pAll.blob, limit * 2) as Array<{ id: string; distance: number }>;
    for (const r of rows) r.distance = normalizeVecDistance(r.distance, pAll.q);
    return rows;
  }, [] as Array<{ id: string; distance: number }>);

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of vecResults) {
    const similarity = l2DistanceToSimilarity(vr.distance);
    if (similarity < threshold) continue;

    const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1').get(vr.id) as Record<string, unknown> | undefined;
    if (!row) continue;

    results.push({ fact: rowToFact(row), distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
}

/** sqlite-vec's ceiling for one KNN (`LIMIT`/k above it is refused). */
export const FACT_KNN_MAX = 4096;

export interface FilteredFactSearch {
  /** The project whose facts (plus global facts) are in scope; null = every scope. */
  project: string | null;
  /**
   * 'in-scope' (default): the project's facts and global facts.
   * 'other-projects': project-scoped facts of projects OTHER than `project` (cross-project insights).
   */
  scope?: 'in-scope' | 'other-projects';
  limit?: number;
  threshold?: number;
  /** A further condition on the fact (category, agent, tags …). */
  filter?: (fact: Fact) => boolean;
  /** Fold facts whose sentence is identical (whitespace and case ignored) into the best-ranked one. */
  foldSameText?: boolean;
}

export interface FilteredFactHit {
  fact: Fact;
  distance: number;
  /** Ids of the other facts that carry the same sentence (foldSameText), best-ranked first. */
  duplicateIds: string[];
}

/**
 * Nearest facts under conditions that are applied BEFORE the cut to `limit`.
 *
 * searchSimilarFacts takes a fixed number of candidates (max(limit×2, 50) per table) and filters after
 * it; the MCP tools then filtered once more after ITS cut. A project whose facts sat behind other
 * projects' facts, or a category filter, came back with a few rows or none while matching facts existed
 * (measured: 3 returned of 14 in scope; `category=decision` → 0 with 2 in the top 50). Here the candidate
 * list grows ×4 until `limit` facts pass every condition, the indexes run out, the similarity threshold is
 * crossed, or the sqlite-vec ceiling is reached — and `truncated` says when it was the ceiling.
 * Both language indexes are searched (the best distance per fact wins), like searchSimilarFacts.
 */
export function searchFactsFiltered(
  db: Database.Database,
  embedding: number[],
  opts: FilteredFactSearch,
): { results: FilteredFactHit[]; examined: number; truncated: boolean } {
  const limit = opts.limit ?? 5;
  const threshold = opts.threshold ?? 0.85;
  const canonProject = opts.project ? canonicalizeProject(db, opts.project) : opts.project;
  const inScope = scopeMatcher(canonProject, false);
  const scopeOk = opts.scope === 'other-projects'
    ? (fact: Fact) => fact.scope_type === 'project' && fact.scope_project !== canonProject
    : (fact: Fact) => fact.scope_type !== 'project' || inScope(fact.scope_project);

  const knn = (table: FactVecTable, n: number) => factKnn(table, () => {
    const p = vecParamFor(db, table, embedding);
    const rows = db.prepare(`
      SELECT id, distance FROM ${table}
      WHERE embedding MATCH ${p.sql}
      ORDER BY distance
      LIMIT ?
    `).all(p.blob, n) as Array<{ id: string; distance: number }>;
    // Normalize ×scale int8 distances BEFORE the cross-table merge.
    for (const r of rows) r.distance = normalizeVecDistance(r.distance, p.q);
    return rows;
  }, [] as Array<{ id: string; distance: number }>);
  const rowStmt = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?');

  for (let fetchCount = Math.min(FACT_KNN_MAX, Math.max(limit * 4, 50)); ; fetchCount = Math.min(fetchCount * 4, FACT_KNN_MAX)) {
    const a = knn('vec_facts', fetchCount);
    const b = knn('vec_facts_kr', fetchCount);
    const best = new Map<string, number>();
    for (const vr of [...a, ...b]) {
      const cur = best.get(vr.id);
      if (cur === undefined || vr.distance < cur) best.set(vr.id, vr.distance);
    }
    const merged = [...best.entries()].map(([id, distance]) => ({ id, distance })).sort((x, y) => x.distance - y.distance);

    const results: FilteredFactHit[] = [];
    const bySentence = new Map<string, FilteredFactHit>();
    let crossedThreshold = false;
    for (const vr of merged) {
      if (l2DistanceToSimilarity(vr.distance) < threshold) {
        crossedThreshold = true; // sorted by distance: nothing further can pass
        break;
      }
      // Once the limit is filled the rest of this list is read only to find copies of what is shown.
      if (results.length >= limit && !opts.foldSameText) break;
      const row = rowStmt.get(vr.id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;
      if (!row) continue; // inactive, or a vector the re-embed worker has not upgraded yet
      const fact = rowToFact(row);
      if (!scopeOk(fact)) continue;
      if (opts.filter && !opts.filter(fact)) continue;

      if (opts.foldSameText) {
        const key = fact.fact.replace(/\s+/g, ' ').trim().toLowerCase();
        const shown = bySentence.get(key);
        if (shown) {
          shown.duplicateIds.push(fact.id);
          continue;
        }
        if (results.length >= limit) continue;
        const hit: FilteredFactHit = { fact, distance: vr.distance, duplicateIds: [] };
        bySentence.set(key, hit);
        results.push(hit);
      } else {
        results.push({ fact, distance: vr.distance, duplicateIds: [] });
      }
    }

    const exhausted = a.length < fetchCount && b.length < fetchCount;
    if (results.length >= limit || exhausted || crossedThreshold || fetchCount >= FACT_KNN_MAX) {
      return {
        results,
        examined: merged.length,
        truncated: results.length < limit && !exhausted && !crossedThreshold,
      };
    }
  }
}

function rowToFact(row: Record<string, unknown>): Fact {
  const embeddingRaw = row['embedding'];
  let embedding: Float32Array | null = null;
  if (embeddingRaw instanceof Buffer) {
    embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
  } else if (embeddingRaw instanceof Uint8Array) {
    embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
  }

  return {
    id: row['id'] as string,
    fact: row['fact'] as string,
    category: row['category'] as Fact['category'],
    scope_type: row['scope_type'] as Fact['scope_type'],
    scope_project: (row['scope_project'] as string | null) ?? null,
    source_exchange_ids: row['source_exchange_ids']
      ? JSON.parse(row['source_exchange_ids'] as string)
      : [],
    embedding,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    consolidated_count: row['consolidated_count'] as number,
    is_active: Boolean(row['is_active']),
    ontology_category_id: (row['ontology_category_id'] as string | null) ?? null,
    coding_agent: (row['coding_agent'] as string | null) ?? null,
    tags: parseTags(row['tags']),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// User tags
//
// The ontology overlay (domain/category) is LLM-generated: useful, but the user
// cannot address it. Tags are the one labelling axis a person controls directly.
// The automatic pipeline (fact-extractor, consolidator, ontology-classifier)
// never writes this column, so a tag survives re-classification and re-embedding.
// ─────────────────────────────────────────────────────────────────────────────

/** Max characters in one tag. Long enough for "needs-verification", short
 *  enough that a tag stays a label rather than a sentence. */
export const MAX_TAG_LENGTH = 64;
/** Max tags on one fact. Bounds the JSON column and keeps LIKE scans cheap. */
export const MAX_TAGS_PER_FACT = 32;

/** Characters allowed in a tag: any unicode letter/number (Korean included)
 *  plus - _ . / : — deliberately excluding " and \ so a tag can never break
 *  the JSON encoding or the LIKE matcher below. */
const TAG_ALLOWED = /^[\p{L}\p{N}\-_./:]+$/u;

/**
 * Normalize one user-supplied tag: trim, collapse inner whitespace to '-',
 * lowercase. Returns null when the result is empty, too long, or contains a
 * disallowed character — callers must treat null as "reject", never as "skip
 * silently", so a typo surfaces instead of vanishing.
 */
export function normalizeTag(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, '-').toLowerCase();
  if (!collapsed) return null;
  if (collapsed.length > MAX_TAG_LENGTH) return null;
  if (!TAG_ALLOWED.test(collapsed)) return null;
  return collapsed;
}

/**
 * Parse the stored tags column. A row written by this module is always valid
 * JSON; a row hand-edited via sqlite3 may not be. Rather than throwing inside
 * every read path (which would take down search for one bad row), an
 * unparseable value degrades to [] — the fact stays fully searchable, it just
 * shows no tags. Use `memory-bank tags --verify` to find such rows.
 */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

function requireFactRow(db: Database.Database, factId: string): { tags: string[] } {
  const row = db.prepare('SELECT tags FROM facts WHERE id = ?').get(factId) as
    | { tags: string | null }
    | undefined;
  if (!row) throw new Error(`fact not found: ${factId}`);
  return { tags: parseTags(row.tags) };
}

function writeTags(db: Database.Database, factId: string, tags: string[]): void {
  db.prepare('UPDATE facts SET tags = ? WHERE id = ?').run(
    tags.length ? JSON.stringify(tags) : null,
    factId
  );
}

/** Tags currently on a fact. Throws when the fact does not exist. */
export function getFactTags(db: Database.Database, factId: string): string[] {
  return requireFactRow(db, factId).tags;
}

/**
 * Add tags to a fact (set union, order-stable). Rejects the whole call when any
 * input tag is invalid or the result would exceed MAX_TAGS_PER_FACT — a partial
 * apply would leave the user unsure which tags landed.
 */
export function addFactTags(
  db: Database.Database,
  factId: string,
  rawTags: string[]
): { tags: string[]; added: string[] } {
  const normalized: string[] = [];
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
    normalized.push(tag);
  }
  const current = requireFactRow(db, factId).tags;
  const seen = new Set(current);
  const added: string[] = [];
  for (const tag of normalized) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    added.push(tag);
  }
  const next = [...current, ...added];
  if (next.length > MAX_TAGS_PER_FACT) {
    throw new Error(
      `too many tags on ${factId}: ${next.length} > ${MAX_TAGS_PER_FACT}`
    );
  }
  if (added.length) writeTags(db, factId, next);
  return { tags: next, added };
}

/** Remove tags from a fact. Tags that were not present are reported, not an error. */
export function removeFactTags(
  db: Database.Database,
  factId: string,
  rawTags: string[]
): { tags: string[]; removed: string[]; absent: string[] } {
  const targets = new Set<string>();
  const absentInput: string[] = [];
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) { absentInput.push(raw); continue; }
    targets.add(tag);
  }
  const current = requireFactRow(db, factId).tags;
  const next = current.filter((t) => !targets.has(t));
  const removed = current.filter((t) => targets.has(t));
  const absent = [...targets].filter((t) => !current.includes(t)).concat(absentInput);
  if (removed.length) writeTags(db, factId, next);
  return { tags: next, removed, absent };
}

/** Replace a fact's tags wholesale. Passing [] clears them. */
export function setFactTags(
  db: Database.Database,
  factId: string,
  rawTags: string[]
): string[] {
  const next: string[] = [];
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
    if (!next.includes(tag)) next.push(tag);
  }
  if (next.length > MAX_TAGS_PER_FACT) {
    throw new Error(`too many tags: ${next.length} > ${MAX_TAGS_PER_FACT}`);
  }
  requireFactRow(db, factId); // existence check — fail loud on a bad id
  writeTags(db, factId, next);
  return next;
}

/**
 * All tags in use with their fact counts, most used first. Scans only rows that
 * actually carry tags, so cost tracks tagged facts rather than total facts.
 */
export function listTags(
  db: Database.Database,
  opts: { project?: string; includeInactive?: boolean } = {}
): Array<{ tag: string; count: number }> {
  const where: string[] = ['tags IS NOT NULL'];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('is_active = 1');
  if (opts.project) {
    const canon = canonicalizeProject(db, opts.project);
    where.push("((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')");
    params.push(canon);
  }
  const rows = db
    .prepare(`SELECT tags FROM facts WHERE ${where.join(' AND ')}`)
    .all(...params) as Array<{ tags: string | null }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Facts carrying the given tags. `match: 'all'` (default) requires every tag,
 * 'any' requires at least one. Matching is done on the JSON text with the
 * surrounding quotes included, so "api" never matches "api-v2".
 */
export function findFactsByTags(
  db: Database.Database,
  rawTags: string[],
  opts: { project?: string; match?: 'all' | 'any'; limit?: number; includeInactive?: boolean } = {}
): Fact[] {
  const tags: string[] = [];
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (!tags.length) return [];

  const where: string[] = ['tags IS NOT NULL'];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('is_active = 1');
  if (opts.project) {
    const canon = canonicalizeProject(db, opts.project);
    where.push("((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')");
    params.push(canon);
  }
  const joiner = opts.match === 'any' ? ' OR ' : ' AND ';
  const tagClauses = tags.map(() => `tags LIKE '%"' || ? || '"%'`);
  where.push(`(${tagClauses.join(joiner)})`);
  params.push(...tags);

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToFact(row));
}
