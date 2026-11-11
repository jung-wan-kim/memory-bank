import { randomUUID } from 'crypto';
import { getVecQuant, embeddingToVecBlob, vecParamSql, normalizeVecDistance } from './db.js';
import { ontologyNameRejectReason } from './fact-validity.js';
import { scopeMatcher } from './project-family.js';
import { canonicalizeProject } from './project-canon.js';
// === Domain CRUD ===
export function createDomain(db, name, description) {
    const rejectReason = ontologyNameRejectReason(name);
    if (rejectReason)
        throw new Error(`createDomain refused (${rejectReason}): ${String(name).slice(0, 60)}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(id, name, description ?? null, now);
    return { id, name, description: description ?? null, created_at: now };
}
export function listDomains(db) {
    return db.prepare(`SELECT * FROM ontology_domains ORDER BY name`).all();
}
export function getDomain(db, id) {
    return (db.prepare(`SELECT * FROM ontology_domains WHERE id = ?`).get(id) ?? null);
}
export function getDomainByName(db, name) {
    const exact = db
        .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
        .get(name);
    if (exact)
        return exact;
    // "Dev Ops" / "dev-ops" are the domain "DevOps" (see ontologyNameKey). The
    // domain list is small (28 live), so the keys are compared here instead of
    // being stored; the oldest row wins when legacy rows share a key.
    const key = ontologyNameKey(name);
    const rows = db.prepare(`SELECT * FROM ontology_domains ORDER BY created_at, id`).all();
    return rows.find((d) => ontologyNameKey(d.name) === key) ?? null;
}
// === Name identity ===
/**
 * Identity of a domain/category name: NFKC, lower case, "&" read as "and",
 * every other character that is not a letter or digit dropped. "Memory-Bank
 * Architecture", "memory bank architecture" and "MemoryBank  Architecture" are
 * one name; "CI/CD" and "CI CD" are one name.
 *
 * Why: lookups were an exact match (NOCASE), so the classifier's spelling
 * variants of one name became separate rows — 792 names existed under several
 * domains (1,974 rows) and 44 pairs inside one domain (live DB, 2026-11-10).
 *
 * The stored `ontology_categories.name_key` is this function's output. Changing
 * the rule means rebuilding the column (`UPDATE ontology_categories SET
 * name_key = NULL` — the next lookup refills it).
 */
export function ontologyNameKey(name) {
    const folded = String(name).normalize('NFKC').toLowerCase();
    const key = folded.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '');
    // A name with no letter or digit keeps its own text, so two such names are
    // never "the same" by having an empty key.
    return key !== '' ? key : folded.replace(/\s+/g, ' ').trim();
}
/**
 * Looser identity, for one use only: the model said it was reusing a category
 * but spelled no existing name (classifier, `is_new_category: false`). Also
 * folds a plural "s", the word "and" and word order — "State Managements" and
 * "Management State" both mean "State Management". Too loose for general
 * lookups; compared only against the candidates shown for that fact.
 */
export function looseOntologyNameKey(name) {
    const words = String(name).normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w !== '' && w !== 'and')
        .map((w) => {
        if (w.length > 4 && w.endsWith('ies'))
            return `${w.slice(0, -3)}y`;
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss'))
            return w.slice(0, -1);
        return w;
    });
    return words.sort().join(' ');
}
// Connections whose ontology_categories table is known to have the name_key
// column and index (the DDL is checked once per connection).
const nameKeyColumnReady = new WeakSet();
/**
 * Idempotent migration of `ontology_categories.name_key` (+ its index), run by
 * the category lookups below rather than initDatabase(): only code that writes
 * the taxonomy needs it. Every call also fills rows whose key is NULL — a
 * process running older code and the sync import insert categories without
 * the column, and such a row must not stay invisible to the lookup (it would
 * be created a second time). With the index that check is one probe.
 *
 * Returns how many rows were filled.
 */
export function ensureCategoryNameKeys(db) {
    if (!nameKeyColumnReady.has(db)) {
        const columns = db.prepare(`SELECT name FROM pragma_table_info('ontology_categories')`).all();
        if (!columns.some((c) => c.name === 'name_key')) {
            try {
                db.prepare('ALTER TABLE ontology_categories ADD COLUMN name_key TEXT').run();
            }
            catch (error) {
                // Two processes can both see the column missing; the loser's ALTER
                // fails with "duplicate column name" and the column is there.
                if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error)))
                    throw error;
            }
        }
        // Looked up first so a connection that finds the index issues no DDL at all.
        const hasIndex = db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ontology_categories_name_key'`)
            .get() !== undefined;
        if (!hasIndex) {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_categories_name_key ON ontology_categories(name_key)`);
        }
        nameKeyColumnReady.add(db);
    }
    const missing = db.prepare(`SELECT id, name FROM ontology_categories WHERE name_key IS NULL`).all();
    if (missing.length === 0)
        return 0;
    const fill = db.prepare(`UPDATE ontology_categories SET name_key = ? WHERE id = ? AND name_key IS NULL`);
    let filled = 0;
    db.transaction(() => {
        for (const row of missing)
            filled += fill.run(ontologyNameKey(row.name), row.id).changes;
    })();
    return filled;
}
/**
 * Every category whose name has this key (in one domain when `domainId` is
 * given), most used first: active facts, then the oldest row, then id. The
 * order is the tie-break wherever one name has several rows — the first row is
 * the one a lookup returns and new facts go to, so the same name resolves to
 * the same row on every call.
 */
export function findCategoriesByNameKey(db, key, domainId) {
    ensureCategoryNameKeys(db);
    return db
        .prepare(`SELECT c.id, c.domain_id, c.name, c.description, c.created_at,
              (SELECT COUNT(*) FROM facts f WHERE f.ontology_category_id = c.id AND +f.is_active = 1) AS active_facts
       FROM ontology_categories c
       WHERE c.name_key = ?${domainId ? ' AND c.domain_id = ?' : ''}
       ORDER BY active_facts DESC, c.created_at, c.id`)
        .all(...(domainId ? [key, domainId] : [key]));
}
/**
 * Active fact count per category id (ids with no facts are absent).
 *
 * `+is_active`, here and in the other statements of this file that name a
 * category next to it: an older process sharing the database re-creates
 * idx_facts_active(is_active) and this version leaves it for hours (db.ts,
 * FACTS_ACTIVE_INDEX_REDROP_MS). With no table statistics the planner then
 * answers `ontology_category_id = ? AND is_active = 1` from that two-valued
 * index — every active fact read per call, and classification calls this for
 * each candidate category of each saved fact (measured at 30,584 active
 * facts: 29-51ms a call against under 0.1ms through idx_facts_ontology; one
 * extraction run that saved 6 facts took 9.3s instead of 2.1s). The unary
 * plus keeps the term out of index selection; the rows counted are the same.
 */
export function activeFactCounts(db, categoryIds) {
    const counts = new Map();
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ? AND +is_active = 1`);
    for (const id of new Set(categoryIds)) {
        const n = stmt.get(id).n;
        if (n > 0)
            counts.set(id, n);
    }
    return counts;
}
function toCategory(row) {
    return { id: row.id, domain_id: row.domain_id, name: row.name, description: row.description, created_at: row.created_at };
}
// === Category CRUD ===
/**
 * Create a category, or return the one this domain already has under the same
 * name key — idempotent on (domain, key) the way createRelation is on its
 * triple. The lookup and the insert share one write transaction, so two
 * processes classifying at once cannot both insert the name. (No UNIQUE index
 * enforces this: 44 pairs of same-name rows inside one domain predate the key
 * and are not merged here.)
 */
export function createCategory(db, domainId, name, description) {
    const rejectReason = ontologyNameRejectReason(name);
    if (rejectReason)
        throw new Error(`createCategory refused (${rejectReason}): ${String(name).slice(0, 60)}`);
    ensureCategoryNameKeys(db);
    const key = ontologyNameKey(name);
    return db.transaction(() => {
        const existing = findCategoriesByNameKey(db, key, domainId)[0];
        if (existing)
            return toCategory(existing);
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at, name_key) VALUES (?, ?, ?, ?, ?, ?)`).run(id, domainId, name, description ?? null, now, key);
        return { id, domain_id: domainId, name, description: description ?? null, created_at: now };
    }).immediate();
}
export function listCategories(db, domainId) {
    if (domainId) {
        return db
            .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
            .all(domainId);
    }
    return db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all();
}
/**
 * The category of this name (by ontologyNameKey — case, spacing and
 * punctuation do not matter), inside one domain when `domainId` is given.
 * Several rows can carry one name (see createCategory); the most used one is
 * returned, the same row on every call.
 */
export function getCategoryByName(db, name, domainId) {
    const row = findCategoriesByNameKey(db, ontologyNameKey(name), domainId)[0];
    return row ? toCategory(row) : null;
}
// === Category embeddings (candidate retrieval for the classifier) ===
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export function upsertCategoryEmbedding(db, categoryId, embedding) {
    // dtype/scale read inside the write transaction (see fact-db upsertFactVector).
    db.transaction(() => {
        const q = getVecQuant(db, 'vec_categories');
        db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
        db.prepare(`INSERT INTO vec_categories (id, embedding) VALUES (?, ${vecParamSql(q)})`)
            .run(categoryId, embeddingToVecBlob(embedding, q));
    }).immediate();
}
export function deleteCategoryEmbedding(db, categoryId) {
    try {
        db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
    }
    catch { /* table may not exist on very old DBs */ }
}
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export function searchSimilarCategories(db, embedding, k = 20) {
    const knn = () => {
        const q = getVecQuant(db, 'vec_categories');
        const rows = db.prepare(`
      SELECT id, distance FROM vec_categories
      WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT ?
    `).all(embeddingToVecBlob(embedding, q), k);
        // ×scale int8 distances → float32-equivalent scale for callers.
        for (const h of rows)
            h.distance = normalizeVecDistance(h.distance, q);
        return rows;
    };
    let hits;
    try {
        hits = knn();
    }
    catch (e) {
        // Only an absent table (very old DBs) reads as "no candidates". A swap
        // (compaction, int8 migration) can change dtype/scale between the read and
        // the MATCH, so one retry; anything else — bad scale record, wrong schema —
        // throws with its cause. The classifier turns a lookup that stays broken
        // into IndexRepairError (ontology-classifier.ts categoryHits).
        if (/no such table/i.test(e instanceof Error ? e.message : String(e)))
            return [];
        hits = knn();
    }
    const results = [];
    const catStmt = db.prepare('SELECT * FROM ontology_categories WHERE id = ?');
    const domStmt = db.prepare('SELECT name FROM ontology_domains WHERE id = ?');
    for (const h of hits) {
        const category = catStmt.get(h.id);
        if (!category)
            continue; // stale vector row (category was merged/deleted)
        const dom = domStmt.get(category.domain_id);
        results.push({ category, domainName: dom?.name ?? '?', distance: h.distance });
    }
    return results;
}
// === Fact Classification ===
export function classifyFact(db, factId, categoryId) {
    db.prepare(`UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`).run(categoryId, new Date().toISOString(), factId);
}
export function getFactsByCategory(db, categoryId) {
    return db
        .prepare(`SELECT * FROM facts WHERE ontology_category_id = ? AND +is_active = 1 ORDER BY consolidated_count DESC`)
        .all(categoryId)
        .map(rowToFact);
}
export function getFactsByDomain(db, domainId) {
    return db
        .prepare(`SELECT f.* FROM facts f
       JOIN ontology_categories c ON f.ontology_category_id = c.id
       WHERE c.domain_id = ? AND f.is_active = 1
       ORDER BY f.consolidated_count DESC`)
        .all(domainId)
        .map(rowToFact);
}
// === Relation CRUD ===
/** createRelation declined to write a relation that cannot be true (see createRelation). */
export class RelationRefusedError extends Error {
    reason;
    constructor(reason, detail) {
        super(`createRelation refused (${reason}): ${detail}`);
        this.reason = reason;
        this.name = 'RelationRefusedError';
    }
}
export function createRelation(db, sourceFactId, relationType, targetFactId, reasoning) {
    // Idempotent on the TRIPLE (source, type, target) — matching the UNIQUE
    // index. Retries (classification re-runs under a held-back
    // IndexRepairError, backfill re-selection) must not stack duplicate rows
    // of the SAME type; distinct relation TYPES between the same facts remain
    // valid, user-visible graph data (a SUPPORTS b + a CONTRADICTS b) and are
    // deliberately NOT collapsed — an LLM type-flap across retries therefore
    // adds at most one row per type (bounded by the 4-type enum).
    //
    // Two shapes are refused (RelationRefusedError), like template residue in
    // createDomain/createCategory:
    //  - a relation of a fact to itself;
    //  - SUPERSEDES whose mirror already exists. "a replaced b" and "b replaced
    //    a" cannot both hold, and a reader of the pair cannot tell which is the
    //    current belief (245 such pairs live, all written before the 2026-10-03
    //    direction fix). The check and the insert share one write transaction,
    //    so two processes judging the pair at once cannot each write one half.
    //    Rows that bypass this function (sync import) are not covered.
    if (sourceFactId === targetFactId) {
        throw new RelationRefusedError('self-relation', `${relationType} ${sourceFactId}`);
    }
    if (relationType === 'SUPERSEDES') {
        return db.transaction(() => {
            if (hasSupersedes(db, targetFactId, sourceFactId)) {
                throw new RelationRefusedError('supersedes-cycle', `${targetFactId} already SUPERSEDES ${sourceFactId}`);
            }
            return insertRelation(db, sourceFactId, relationType, targetFactId, reasoning);
        }).immediate();
    }
    return insertRelation(db, sourceFactId, relationType, targetFactId, reasoning);
}
/** True when `sourceFactId SUPERSEDES targetFactId` is stored. */
export function hasSupersedes(db, sourceFactId, targetFactId) {
    return db
        .prepare(`SELECT 1 FROM ontology_relations
       WHERE source_fact_id = ? AND relation_type = 'SUPERSEDES' AND target_fact_id = ? LIMIT 1`)
        .get(sourceFactId, targetFactId) !== undefined;
}
function insertRelation(db, sourceFactId, relationType, targetFactId, reasoning) {
    const existing = db
        .prepare(`SELECT * FROM ontology_relations
       WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`)
        .get(sourceFactId, relationType, targetFactId);
    if (existing)
        return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
        db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
    }
    catch (error) {
        // Recover ONLY from the expected unique-constraint race (another process
        // inserted the same triple between our check and insert) — any other
        // failure (schema, CHECK violation, corruption) must surface, not be
        // laundered into a fake winner lookup.
        const code = error.code ?? '';
        if (!code.startsWith('SQLITE_CONSTRAINT'))
            throw error;
        const winner = db
            .prepare(`SELECT * FROM ontology_relations
         WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`)
            .get(sourceFactId, relationType, targetFactId);
        if (winner)
            return winner;
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
export function getRelatedFacts(db, factId, hops = 1, decay = 0.6, minRelevance = 0.2, scopeProject, opts = {}) {
    // The same canonical project the KNN scope filter uses (searchSimilarFacts): a slug-form project
    // resolves to its path, so both paths of one injection see the same scope.
    const inScope = scopeMatcher(scopeProject ? canonicalizeProject(db, scopeProject) : null, opts.scopeFamily === true);
    const visited = new Set([factId]);
    const results = [];
    let frontier = [factId];
    for (let hop = 0; hop < hops; hop++) {
        const hopRelevance = Math.pow(decay, hop);
        if (hopRelevance < minRelevance)
            break; // Prune entire hop if too weak
        const nextFrontier = [];
        for (const currentId of frontier) {
            // Outgoing relations (source → target).
            // Multiple relation TYPES may connect the same pair; the visited-set is
            // keyed by fact id, so exactly ONE edge per neighbour is surfaced. The
            // ORDER BY makes that choice DETERMINISTIC and belief-safety-first:
            // CONTRADICTS/SUPERSEDES must never be silently hidden behind an
            // affirmative SUPPORTS/INFLUENCES row that happened to come first.
            const outgoing = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`)
                .all(currentId);
            // Group candidate edges per neighbour (rows arrive in belief-safety
            // order): the surfaced edge is the FIRST one whose relevance clears
            // minRelevance — a safety edge that fails the floor must not consume
            // the neighbour's single slot and hide a qualifying affirmative edge.
            const outByNeighbour = new Map();
            for (const row of outgoing) {
                const targetId = row['target_fact_id'];
                if (visited.has(targetId))
                    continue;
                const rows = outByNeighbour.get(targetId);
                if (rows)
                    rows.push(row);
                else
                    outByNeighbour.set(targetId, [row]);
            }
            for (const [targetId, rows] of outByNeighbour) {
                const fact = rowToFact(rows[0]);
                // Scope filter: skip facts from other projects (unless scopeProject is null)
                if (fact.scope_type === 'project' && !inScope(fact.scope_project))
                    continue;
                if (opts.visibleFact && !opts.visibleFact(fact.id))
                    continue;
                // Select the surfaced edge FIRST: a neighbour with no qualifying
                // edge is PRUNED — it must not enter the frontier, or traversal
                // would leak paths through edges the relevance floor rejected
                // ("Facts below minRelevance are pruned" is a path contract, not
                // just a display filter).
                let chosen = null;
                for (const row of rows) {
                    const relation = rowToRelation(row);
                    if (opts.visibleRelation && !opts.visibleRelation(relation))
                        continue;
                    // Relation type weight: SUPPORTS/INFLUENCES stronger than CONTRADICTS/SUPERSEDES
                    const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
                    const relevance = hopRelevance * typeWeight;
                    if (relevance >= minRelevance) {
                        chosen = { relation, relevance };
                        break;
                    }
                }
                if (!chosen)
                    continue;
                visited.add(targetId);
                nextFrontier.push(targetId);
                results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
            }
            // Incoming relations (target ← source)
            const incoming = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`)
                .all(currentId);
            // Same per-neighbour grouping as the outgoing side (see comment above).
            const inByNeighbour = new Map();
            for (const row of incoming) {
                const sourceId = row['source_fact_id'];
                if (visited.has(sourceId))
                    continue;
                const rows = inByNeighbour.get(sourceId);
                if (rows)
                    rows.push(row);
                else
                    inByNeighbour.set(sourceId, [row]);
            }
            for (const [sourceId, rows] of inByNeighbour) {
                const fact = rowToFact(rows[0]);
                // Scope filter: skip facts from other projects
                if (fact.scope_type === 'project' && !inScope(fact.scope_project))
                    continue;
                if (opts.visibleFact && !opts.visibleFact(fact.id))
                    continue;
                // Same pruning contract as the outgoing side: no qualifying edge →
                // no frontier entry, no path leak.
                let chosen = null;
                for (const row of rows) {
                    const relation = rowToRelation(row);
                    if (opts.visibleRelation && !opts.visibleRelation(relation))
                        continue;
                    const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
                    const relevance = hopRelevance * typeWeight;
                    if (relevance >= minRelevance) {
                        chosen = { relation, relevance };
                        break;
                    }
                }
                if (!chosen)
                    continue;
                visited.add(sourceId);
                nextFrontier.push(sourceId);
                results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
            }
        }
        frontier = nextFrontier;
        if (frontier.length === 0)
            break;
    }
    // Sort by relevance descending
    results.sort((a, b) => b.relevance - a.relevance);
    return results;
}
export function getRelationsForFact(db, factId) {
    return db
        .prepare(`SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`)
        .all(factId, factId);
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
export function getOntologyTree(db, opts = {}) {
    const likePattern = (text) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const where = [];
    const params = [];
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
        .prepare(`SELECT d.id AS d_id, d.name AS d_name, d.description AS d_description, d.created_at AS d_created_at,
              c.id AS c_id, c.name AS c_name, c.description AS c_description, c.created_at AS c_created_at,
              COUNT(f.id) AS fact_count
       FROM ontology_domains d
       LEFT JOIN ontology_categories c ON c.domain_id = d.id
       LEFT JOIN facts f ON f.ontology_category_id = c.id AND +f.is_active = 1
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY d.id, c.id
       ORDER BY d.name, c.name`)
        .all(...params);
    const tree = [];
    const byCategory = new Map();
    let current = null;
    for (const row of rows) {
        if (!current || current.domain.id !== row['d_id']) {
            current = {
                domain: {
                    id: row['d_id'],
                    name: row['d_name'],
                    description: row['d_description'] ?? null,
                    created_at: row['d_created_at'],
                },
                categories: [],
            };
            tree.push(current);
        }
        if (row['c_id'] === null)
            continue; // a domain with no category
        const entry = {
            category: {
                id: row['c_id'],
                domain_id: current.domain.id,
                name: row['c_name'],
                description: row['c_description'] ?? null,
                created_at: row['c_created_at'],
            },
            facts: [],
            factCount: row['fact_count'],
        };
        current.categories.push(entry);
        byCategory.set(entry.category.id, entry);
    }
    const perCategory = opts.factsPerCategory ?? Number.MAX_SAFE_INTEGER;
    const wanted = [...byCategory.values()].filter((entry) => entry.factCount > 0).map((entry) => entry.category.id);
    if (perCategory > 0 && wanted.length > 0) {
        // Rank on a narrow projection, then read the full rows of the winners only.
        const factRows = db
            .prepare(`WITH ranked AS (
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
         ORDER BY r.cid, r.rn`)
            .all(JSON.stringify(wanted), perCategory);
        for (const row of factRows) {
            byCategory.get(row['ontology_category_id'])?.facts.push(rowToFact(row));
        }
    }
    return tree;
}
// === Row Mappers ===
function rowToFact(row) {
    const embeddingRaw = row['embedding'];
    let embedding = null;
    if (embeddingRaw instanceof Buffer) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    else if (embeddingRaw instanceof Uint8Array) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    return {
        id: row['id'],
        fact: row['fact'],
        category: row['category'],
        scope_type: row['scope_type'],
        scope_project: row['scope_project'] ?? null,
        source_exchange_ids: row['source_exchange_ids']
            ? JSON.parse(row['source_exchange_ids'])
            : [],
        embedding,
        created_at: row['created_at'],
        updated_at: row['updated_at'],
        consolidated_count: row['consolidated_count'],
        is_active: Boolean(row['is_active']),
    };
}
function rowToRelation(row) {
    return {
        id: (row['rel_id'] ?? row['id']),
        source_fact_id: row['source_fact_id'],
        relation_type: row['relation_type'],
        target_fact_id: row['target_fact_id'],
        reasoning: row['reasoning'] ?? null,
        created_at: (row['rel_created_at'] ?? row['created_at']),
    };
}
