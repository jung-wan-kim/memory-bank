import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Fact, FactRevision } from './types.js';

interface InsertFactParams {
  fact: string;
  category: string;
  scope_type: string;
  scope_project: string | null;
  source_exchange_ids: string[];
  embedding: number[] | null;  // number[] to match generateEmbedding() return type
  coding_agent?: string;       // e.g., 'claude-code', 'codex', 'opencode'
}

interface UpdateFactParams {
  fact?: string;
  embedding?: number[] | null;
  consolidated_count_increment?: boolean;
}

interface InsertRevisionParams {
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
}

export function insertFact(db: Database.Database, params: InsertFactParams): string {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active, coding_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
  `).run(
    id,
    params.fact,
    params.category,
    params.scope_type,
    params.scope_project,
    JSON.stringify(params.source_exchange_ids),
    params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null,
    now,
    now,
    params.coding_agent || 'claude-code',
  );

  // Insert into vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVec(id, Buffer.from(new Float32Array(params.embedding).buffer));
  }

  return id;
}

export function getActiveFacts(db: Database.Database): Fact[] {
  return (db.prepare('SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC')
    .all() as Record<string, unknown>[])
    .map(rowToFact);
}

export function getFactsByProject(db: Database.Database, project: string): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `).all(project) as Record<string, unknown>[]).map(rowToFact);
}

export function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void {
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

  values.push(id);
  db.prepare(`UPDATE facts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Update vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVec(id, Buffer.from(new Float32Array(params.embedding).buffer));
  }
}

export function deactivateFact(db: Database.Database, id: string): void {
  db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function deleteFact(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
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

export function searchSimilarFacts(
  db: Database.Database,
  embedding: number[],
  project: string | null,
  limit: number = 5,
  threshold: number = 0.85,
): Array<{ fact: Fact; distance: number }> {
  const vecResults = db.prepare(`
    SELECT id, distance
    FROM vec_facts
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(Buffer.from(new Float32Array(embedding).buffer), limit * 2) as Array<{ id: string; distance: number }>;

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of vecResults) {
    // L2 distance -> cosine similarity approximation
    const similarity = 1 - (vr.distance * vr.distance) / 2;
    if (similarity < threshold) continue;

    const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1').get(vr.id) as Record<string, unknown> | undefined;
    if (!row) continue;

    const fact = rowToFact(row);
    // Scope filter: same project or global only
    if (project && fact.scope_type === 'project' && fact.scope_project !== project) continue;

    results.push({ fact, distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Get top facts using a relevance score that combines:
 * - Confirmation count (consolidated_count) — how established is this fact
 * - Recency (updated_at) — how recent is this fact
 * - Scope priority — project-specific facts rank higher than global for that project
 *
 * Score = (log2(consolidated_count + 1) * 3) + recency_bonus + scope_bonus
 *   recency_bonus: 5 if updated in last 7 days, 3 if last 30 days, 1 if last 90 days, 0 otherwise
 *   scope_bonus: 2 for project-scoped facts, 0 for global
 */
export function getTopFacts(db: Database.Database, project: string, limit: number = 10): Fact[] {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();

  return (db.prepare(`
    SELECT *,
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(consolidated_count + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN updated_at >= ? THEN 5 WHEN updated_at >= ? THEN 3 WHEN updated_at >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score
    FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(d7, d30, d90, project, project, limit) as Record<string, unknown>[]).map(rowToFact);
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
  `).all(project, limit) as Record<string, unknown>[]).map(rowToFact);
}

export function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `).all(since, project) as Record<string, unknown>[]).map(rowToFact);
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
  const vecResults = db.prepare(`
    SELECT id, distance
    FROM vec_facts
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(Buffer.from(new Float32Array(embedding).buffer), limit * 2) as Array<{ id: string; distance: number }>;

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of vecResults) {
    const similarity = 1 - (vr.distance * vr.distance) / 2;
    if (similarity < threshold) continue;

    const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1').get(vr.id) as Record<string, unknown> | undefined;
    if (!row) continue;

    results.push({ fact: rowToFact(row), distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
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
  };
}
