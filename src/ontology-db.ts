import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getVecQuant, embeddingToVecBlob, vecParamSql, normalizeVecDistance } from './db.js';
import { ontologyNameRejectReason } from './fact-validity.js';
import { scopeMatcher } from './project-family.js';
import { canonicalizeProject } from './project-canon.js';
import type {
  OntologyDomain,
  OntologyCategory,
  OntologyRelation,
  RelationType,
  DomainTree,
  Fact,
} from './types.js';

// === Domain CRUD ===

export function createDomain(
  db: Database.Database,
  name: string,
  description?: string,
): OntologyDomain {
  const rejectReason = ontologyNameRejectReason(name);
  if (rejectReason) throw new Error(`createDomain refused (${rejectReason}): ${String(name).slice(0, 60)}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, name, description ?? null, now);
  return { id, name, description: description ?? null, created_at: now };
}

export function listDomains(db: Database.Database): OntologyDomain[] {
  return (db.prepare(`SELECT * FROM ontology_domains ORDER BY name`).all() as OntologyDomain[]);
}

export function getDomain(db: Database.Database, id: string): OntologyDomain | null {
  return (
    (db.prepare(`SELECT * FROM ontology_domains WHERE id = ?`).get(id) as OntologyDomain | undefined) ?? null
  );
}

export function getDomainByName(db: Database.Database, name: string): OntologyDomain | null {
  return (
    (db
      .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
      .get(name) as OntologyDomain | undefined) ?? null
  );
}

// === Category CRUD ===

export function createCategory(
  db: Database.Database,
  domainId: string,
  name: string,
  description?: string,
): OntologyCategory {
  const rejectReason = ontologyNameRejectReason(name);
  if (rejectReason) throw new Error(`createCategory refused (${rejectReason}): ${String(name).slice(0, 60)}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, domainId, name, description ?? null, now);
  return { id, domain_id: domainId, name, description: description ?? null, created_at: now };
}

export function listCategories(
  db: Database.Database,
  domainId?: string,
): OntologyCategory[] {
  if (domainId) {
    return (db
      .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
      .all(domainId) as OntologyCategory[]);
  }
  return (db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all() as OntologyCategory[]);
}

export function getCategoryByName(
  db: Database.Database,
  name: string,
  domainId?: string,
): OntologyCategory | null {
  if (domainId) {
    return (
      (db
        .prepare(
          `SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE AND domain_id = ?`,
        )
        .get(name, domainId) as OntologyCategory | undefined) ?? null
    );
  }
  return (
    (db
      .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE`)
      .get(name) as OntologyCategory | undefined) ?? null
  );
}

// === Category embeddings (candidate retrieval for the classifier) ===

/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export function upsertCategoryEmbedding(
  db: Database.Database,
  categoryId: string,
  embedding: number[],
): void {
  // dtype/scale read inside the write transaction (see fact-db upsertFactVector).
  db.transaction(() => {
    const q = getVecQuant(db, 'vec_categories');
    db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
    db.prepare(`INSERT INTO vec_categories (id, embedding) VALUES (?, ${vecParamSql(q)})`)
      .run(categoryId, embeddingToVecBlob(embedding, q));
  }).immediate();
}

export function deleteCategoryEmbedding(db: Database.Database, categoryId: string): void {
  try {
    db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
  } catch { /* table may not exist on very old DBs */ }
}

/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export function searchSimilarCategories(
  db: Database.Database,
  embedding: number[],
  k: number = 20,
): Array<{ category: OntologyCategory; domainName: string; distance: number }> {
  const knn = () => {
    const q = getVecQuant(db, 'vec_categories');
    const rows = db.prepare(`
      SELECT id, distance FROM vec_categories
      WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT ?
    `).all(embeddingToVecBlob(embedding, q), k) as Array<{ id: string; distance: number }>;
    // ×scale int8 distances → float32-equivalent scale for callers.
    for (const h of rows) h.distance = normalizeVecDistance(h.distance, q);
    return rows;
  };
  let hits: Array<{ id: string; distance: number }>;
  try {
    hits = knn();
  } catch (e) {
    // Only an absent table (very old DBs) reads as "no candidates". A swap
    // (compaction, int8 migration) can change dtype/scale between the read and
    // the MATCH, so one retry; anything else — bad scale record, wrong schema —
    // throws with its cause. The classifier turns a lookup that stays broken
    // into IndexRepairError (ontology-classifier.ts categoryHits).
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    hits = knn();
  }

  const results: Array<{ category: OntologyCategory; domainName: string; distance: number }> = [];
  const catStmt = db.prepare('SELECT * FROM ontology_categories WHERE id = ?');
  const domStmt = db.prepare('SELECT name FROM ontology_domains WHERE id = ?');
  for (const h of hits) {
    const category = catStmt.get(h.id) as OntologyCategory | undefined;
    if (!category) continue; // stale vector row (category was merged/deleted)
    const dom = domStmt.get(category.domain_id) as { name: string } | undefined;
    results.push({ category, domainName: dom?.name ?? '?', distance: h.distance });
  }
  return results;
}

// === Fact Classification ===

export function classifyFact(
  db: Database.Database,
  factId: string,
  categoryId: string,
): void {
  db.prepare(
    `UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`,
  ).run(categoryId, new Date().toISOString(), factId);
}

export function getFactsByCategory(db: Database.Database, categoryId: string): Fact[] {
  return (db
    .prepare(
      `SELECT * FROM facts WHERE ontology_category_id = ? AND is_active = 1 ORDER BY consolidated_count DESC`,
    )
    .all(categoryId) as Record<string, unknown>[])
    .map(rowToFact);
}

export function getFactsByDomain(db: Database.Database, domainId: string): Fact[] {
  return (db
    .prepare(
      `SELECT f.* FROM facts f
       JOIN ontology_categories c ON f.ontology_category_id = c.id
       WHERE c.domain_id = ? AND f.is_active = 1
       ORDER BY f.consolidated_count DESC`,
    )
    .all(domainId) as Record<string, unknown>[])
    .map(rowToFact);
}

// === Relation CRUD ===

export function createRelation(
  db: Database.Database,
  sourceFactId: string,
  relationType: RelationType,
  targetFactId: string,
  reasoning?: string,
): OntologyRelation {
  // Idempotent on the TRIPLE (source, type, target) — matching the UNIQUE
  // index. Retries (classification re-runs under a held-back
  // IndexRepairError, backfill re-selection) must not stack duplicate rows
  // of the SAME type; distinct relation TYPES between the same facts remain
  // valid, user-visible graph data (a SUPPORTS b + a CONTRADICTS b) and are
  // deliberately NOT collapsed — an LLM type-flap across retries therefore
  // adds at most one row per type (bounded by the 4-type enum).
  const existing = db
    .prepare(
      `SELECT * FROM ontology_relations
       WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`,
    )
    .get(sourceFactId, relationType, targetFactId) as OntologyRelation | undefined;
  if (existing) return existing;

  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
  } catch (error) {
    // Recover ONLY from the expected unique-constraint race (another process
    // inserted the same triple between our check and insert) — any other
    // failure (schema, CHECK violation, corruption) must surface, not be
    // laundered into a fake winner lookup.
    const code = (error as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw error;
    const winner = db
      .prepare(
        `SELECT * FROM ontology_relations
         WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`,
      )
      .get(sourceFactId, relationType, targetFactId) as OntologyRelation | undefined;
    if (winner) return winner;
    throw error;
  }
  return {
    id,
    source_fact_id: sourceFactId,
    relation_type: relationType,
    target_fact_id: targetFactId,
    reasoning: reasoning ?? null,
    created_at: now,
  };
}

/** Options of getRelatedFacts that only the injection selection (and its replay bench) passes. */
export interface RelatedFactsOptions {
  /** Widen scopeProject to its repository family (project-family.ts). */
  scopeFamily?: boolean;
  /** Replay bench only: facts that existed at the replayed moment. */
  visibleFact?: (id: string) => boolean;
  /** Replay bench only: relations that existed at the replayed moment. */
  visibleRelation?: (relation: OntologyRelation) => boolean;
}

/**
 * Get related facts with relevance decay.
 *
 * Each hop reduces relevance by the decay factor:
 * - hop 0 (direct): relevance = 1.0
 * - hop 1: relevance = decay (default 0.6)
 * - hop 2: relevance = decay^2 (default 0.36)
 *
 * Results are sorted by relevance descending.
 * Facts below minRelevance are pruned.
 */
/**
 * @param scopeProject - If provided, only return facts from this project or global scope.
 *                       Prevents cross-project noise in graph traversal.
 *                       Pass null/undefined to allow cross-project traversal (e.g., explore_graph).
 */
export function getRelatedFacts(
  db: Database.Database,
  factId: string,
  hops: number = 1,
  decay: number = 0.6,
  minRelevance: number = 0.2,
  scopeProject?: string | null,
  opts: RelatedFactsOptions = {},
): Array<{ fact: Fact; relation: OntologyRelation; relevance: number; hop: number }> {
  // The same canonical project the KNN scope filter uses (searchSimilarFacts): a slug-form project
  // resolves to its path, so both paths of one injection see the same scope.
  const inScope = scopeMatcher(scopeProject ? canonicalizeProject(db, scopeProject) : null, opts.scopeFamily === true);
  const visited = new Set<string>([factId]);
  const results: Array<{ fact: Fact; relation: OntologyRelation; relevance: number; hop: number }> = [];

  let frontier = [factId];

  for (let hop = 0; hop < hops; hop++) {
    const hopRelevance = Math.pow(decay, hop);
    if (hopRelevance < minRelevance) break; // Prune entire hop if too weak

    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // Outgoing relations (source → target).
      // Multiple relation TYPES may connect the same pair; the visited-set is
      // keyed by fact id, so exactly ONE edge per neighbour is surfaced. The
      // ORDER BY makes that choice DETERMINISTIC and belief-safety-first:
      // CONTRADICTS/SUPERSEDES must never be silently hidden behind an
      // affirmative SUPPORTS/INFLUENCES row that happened to come first.
      const outgoing = db
        .prepare(
          `SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`,
        )
        .all(currentId) as Array<Record<string, unknown>>;

      // Group candidate edges per neighbour (rows arrive in belief-safety
      // order): the surfaced edge is the FIRST one whose relevance clears
      // minRelevance — a safety edge that fails the floor must not consume
      // the neighbour's single slot and hide a qualifying affirmative edge.
      const outByNeighbour = new Map<string, Array<Record<string, unknown>>>();
      for (const row of outgoing) {
        const targetId = row['target_fact_id'] as string;
        if (visited.has(targetId)) continue;
        const rows = outByNeighbour.get(targetId);
        if (rows) rows.push(row);
        else outByNeighbour.set(targetId, [row]);
      }
      for (const [targetId, rows] of outByNeighbour) {
        const fact = rowToFact(rows[0]);

        // Scope filter: skip facts from other projects (unless scopeProject is null)
        if (fact.scope_type === 'project' && !inScope(fact.scope_project)) continue;
        if (opts.visibleFact && !opts.visibleFact(fact.id)) continue;

        // Select the surfaced edge FIRST: a neighbour with no qualifying
        // edge is PRUNED — it must not enter the frontier, or traversal
        // would leak paths through edges the relevance floor rejected
        // ("Facts below minRelevance are pruned" is a path contract, not
        // just a display filter).
        let chosen: { relation: OntologyRelation; relevance: number } | null = null;
        for (const row of rows) {
          const relation = rowToRelation(row);
          if (opts.visibleRelation && !opts.visibleRelation(relation)) continue;
          // Relation type weight: SUPPORTS/INFLUENCES stronger than CONTRADICTS/SUPERSEDES
          const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
          const relevance = hopRelevance * typeWeight;
          if (relevance >= minRelevance) {
            chosen = { relation, relevance };
            break;
          }
        }
        if (!chosen) continue;

        visited.add(targetId);
        nextFrontier.push(targetId);
        results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
      }

      // Incoming relations (target ← source)
      const incoming = db
        .prepare(
          `SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`,
        )
        .all(currentId) as Array<Record<string, unknown>>;

      // Same per-neighbour grouping as the outgoing side (see comment above).
      const inByNeighbour = new Map<string, Array<Record<string, unknown>>>();
      for (const row of incoming) {
        const sourceId = row['source_fact_id'] as string;
        if (visited.has(sourceId)) continue;
        const rows = inByNeighbour.get(sourceId);
        if (rows) rows.push(row);
        else inByNeighbour.set(sourceId, [row]);
      }
      for (const [sourceId, rows] of inByNeighbour) {
        const fact = rowToFact(rows[0]);

        // Scope filter: skip facts from other projects
        if (fact.scope_type === 'project' && !inScope(fact.scope_project)) continue;
        if (opts.visibleFact && !opts.visibleFact(fact.id)) continue;

        // Same pruning contract as the outgoing side: no qualifying edge →
        // no frontier entry, no path leak.
        let chosen: { relation: OntologyRelation; relevance: number } | null = null;
        for (const row of rows) {
          const relation = rowToRelation(row);
          if (opts.visibleRelation && !opts.visibleRelation(relation)) continue;
          const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
          const relevance = hopRelevance * typeWeight;
          if (relevance >= minRelevance) {
            chosen = { relation, relevance };
            break;
          }
        }
        if (!chosen) continue;

        visited.add(sourceId);
        nextFrontier.push(sourceId);
        results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevance - a.relevance);

  return results;
}

export function getRelationsForFact(
  db: Database.Database,
  factId: string,
): OntologyRelation[] {
  return db
    .prepare(
      `SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`,
    )
    .all(factId, factId) as OntologyRelation[];
}

// === Ontology Tree ===

/** What getOntologyTree returns: everything by default, or a filtered / fact-capped view. */
export interface OntologyTreeOptions {
  /** Keep domains whose name contains this (case-insensitive for ASCII; `%` and `_` are literal). */
  domain?: string;
  /** Keep categories whose name contains this (same matching). Domains left with no category are dropped. */
  category?: string;
  /** Keep only these categories. */
  categoryIds?: string[];
  /** Facts loaded per category, most confirmed first. Omitted = every active fact; 0 = counts only. */
  factsPerCategory?: number;
}

/**
 * Domain → category → active facts, with each category's active-fact total (`factCount`).
 *
 * Two statements whatever the size of the ontology: one aggregate JOIN for the tree and the counts, one
 * ranked query for the facts. It used to run one facts query per category, and with no table statistics
 * the planner served each of them from the two-valued idx_facts_active — every active fact was visited
 * once per category (7,146 categories × 30K facts on the live DB: minutes, with the MCP server blocked).
 * The unary plus on is_active keeps that index out of the plan; facts are reached through
 * idx_facts_ontology (ontology_category_id).
 */
export function getOntologyTree(db: Database.Database, opts: OntologyTreeOptions = {}): DomainTree[] {
  const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const where: string[] = [];
  const params: string[] = [];
  if (opts.domain) {
    where.push(`d.name LIKE ? ESCAPE '\\'`);
    params.push(likePattern(opts.domain));
  }
  if (opts.category) {
    where.push(`c.name LIKE ? ESCAPE '\\'`);
    params.push(likePattern(opts.category));
  }
  if (opts.categoryIds) {
    where.push(`c.id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(opts.categoryIds));
  }

  const rows = db
    .prepare(
      `SELECT d.id AS d_id, d.name AS d_name, d.description AS d_description, d.created_at AS d_created_at,
              c.id AS c_id, c.name AS c_name, c.description AS c_description, c.created_at AS c_created_at,
              COUNT(f.id) AS fact_count
       FROM ontology_domains d
       LEFT JOIN ontology_categories c ON c.domain_id = d.id
       LEFT JOIN facts f ON f.ontology_category_id = c.id AND +f.is_active = 1
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY d.id, c.id
       ORDER BY d.name, c.name`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const tree: DomainTree[] = [];
  const byCategory = new Map<string, DomainTree['categories'][number]>();
  let current: DomainTree | null = null;
  for (const row of rows) {
    if (!current || current.domain.id !== row['d_id']) {
      current = {
        domain: {
          id: row['d_id'] as string,
          name: row['d_name'] as string,
          description: (row['d_description'] as string | null) ?? null,
          created_at: row['d_created_at'] as string,
        },
        categories: [],
      };
      tree.push(current);
    }
    if (row['c_id'] === null) continue; // a domain with no category
    const entry: DomainTree['categories'][number] = {
      category: {
        id: row['c_id'] as string,
        domain_id: current.domain.id,
        name: row['c_name'] as string,
        description: (row['c_description'] as string | null) ?? null,
        created_at: row['c_created_at'] as string,
      },
      facts: [],
      factCount: row['fact_count'] as number,
    };
    current.categories.push(entry);
    byCategory.set(entry.category.id, entry);
  }

  const perCategory = opts.factsPerCategory ?? Number.MAX_SAFE_INTEGER;
  const wanted = [...byCategory.values()].filter((entry) => entry.factCount > 0).map((entry) => entry.category.id);
  if (perCategory > 0 && wanted.length > 0) {
    // Rank on a narrow projection, then read the full rows of the winners only.
    const factRows = db
      .prepare(
        `WITH ranked AS (
           SELECT f.id AS id, f.ontology_category_id AS cid,
                  ROW_NUMBER() OVER (
                    PARTITION BY f.ontology_category_id
                    ORDER BY f.consolidated_count DESC, f.created_at DESC, f.id
                  ) AS rn
           FROM json_each(?) AS want
           CROSS JOIN facts f ON f.ontology_category_id = want.value
           WHERE +f.is_active = 1
         )
         SELECT f.* FROM ranked r JOIN facts f ON f.id = r.id
         WHERE r.rn <= ?
         ORDER BY r.cid, r.rn`,
      )
      .all(JSON.stringify(wanted), perCategory) as Array<Record<string, unknown>>;
    for (const row of factRows) {
      byCategory.get(row['ontology_category_id'] as string)?.facts.push(rowToFact(row));
    }
  }

  return tree;
}

// === Row Mappers ===

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
  };
}

function rowToRelation(row: Record<string, unknown>): OntologyRelation {
  return {
    id: (row['rel_id'] ?? row['id']) as string,
    source_fact_id: row['source_fact_id'] as string,
    relation_type: row['relation_type'] as RelationType,
    target_fact_id: row['target_fact_id'] as string,
    reasoning: (row['reasoning'] as string | null) ?? null,
    created_at: (row['rel_created_at'] ?? row['created_at']) as string,
  };
}
