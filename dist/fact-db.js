import { randomUUID } from 'crypto';
import { canonicalizeProject } from './project-canon.js';
import { EMBEDDING_VERSION } from './embeddings.js';
import { getVecTableDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity } from './db.js';
/** dtype-aware MATCH/INSERT param for a fact-side vec table: the SQL
 * placeholder (vec_int8(?) wrap for int8) and the correctly-encoded blob.
 * float32 tables (pre-migration DBs) and int8 tables (fresh DBs / migrated)
 * are both served — the actual schema decides. */
function vecParamFor(db, table, embedding) {
    const dt = getVecTableDtype(db, table);
    return { sql: vecParamSql(dt), blob: embeddingToVecBlob(embedding, dt), dt };
}
export function insertFact(db, params) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const scopeProject = params.scope_project
        ? canonicalizeProject(db, params.scope_project)
        : params.scope_project;
    db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active, coding_agent, fact_kr, embedding_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
  `).run(id, params.fact, params.category, params.scope_type, scopeProject, JSON.stringify(params.source_exchange_ids), params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null, now, now, params.coding_agent || 'claude-code', params.fact_kr ?? null, EMBEDDING_VERSION);
    // Insert into vector index (atomic DELETE+INSERT via transaction)
    if (params.embedding) {
        const p = vecParamFor(db, 'vec_facts', params.embedding);
        const upsertVec = db.transaction((vecId, buf) => {
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`).run(vecId, buf);
        });
        upsertVec(id, p.blob);
    }
    // Korean-text vector index (same-language matching for Korean queries)
    if (params.embedding_kr) {
        const pk = vecParamFor(db, 'vec_facts_kr', params.embedding_kr);
        const upsertVecKr = db.transaction((vecId, buf) => {
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(vecId);
            db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${pk.sql})`).run(vecId, buf);
        });
        upsertVecKr(id, pk.blob);
    }
    return id;
}
export function getActiveFacts(db) {
    return db.prepare('SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC')
        .all()
        .map(rowToFact);
}
export function getFactsByProject(db, project) {
    const canon = canonicalizeProject(db, project);
    return db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `).all(canon).map(rowToFact);
}
export function updateFact(db, id, params) {
    const now = new Date().toISOString();
    const updates = ['updated_at = ?'];
    const values = [now];
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
        const p = vecParamFor(db, 'vec_facts', params.embedding);
        const upsertVec = db.transaction((vecId, buf) => {
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`).run(vecId, buf);
        });
        upsertVec(id, p.blob);
    }
}
export function deactivateFact(db, id) {
    db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    // Deactivated facts must not occupy vector index slots
    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
    db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
}
export function deleteFact(db, id) {
    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
    db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
    db.prepare('DELETE FROM fact_revisions WHERE fact_id = ?').run(id);
    db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}
export function insertRevision(db, params) {
    const id = randomUUID();
    db.prepare(`
    INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.fact_id, params.previous_fact, params.new_fact, params.reason, params.source_exchange_id, new Date().toISOString());
    return id;
}
export function getRevisions(db, factId) {
    return db.prepare('SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY created_at DESC').all(factId);
}
export function searchSimilarFacts(db, embedding, project, limit = 5, threshold = 0.85) {
    const canonProject = project ? canonicalizeProject(db, project) : project;
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
    // mid-migration, and int8 distances come back ×127-scaled — normalize
    // BEFORE the cross-table merge or the scales are incomparable.
    const fetch = (table) => {
        try {
            const p = vecParamFor(db, table, embedding);
            const rows = db.prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ${p.sql}
        ORDER BY distance
        LIMIT ?
      `).all(p.blob, candidateFetch);
            for (const r of rows)
                r.distance = normalizeVecDistance(r.distance, p.dt);
            return rows;
        }
        catch {
            return []; // table may not exist on very old DBs
        }
    };
    const best = new Map();
    for (const vr of [...fetch('vec_facts'), ...fetch('vec_facts_kr')]) {
        const cur = best.get(vr.id);
        if (cur === undefined || vr.distance < cur)
            best.set(vr.id, vr.distance);
    }
    const merged = [...best.entries()]
        .map(([id, distance]) => ({ id, distance }))
        .sort((a, b) => a.distance - b.distance);
    const results = [];
    for (const vr of merged) {
        // L2 distance -> cosine similarity approximation
        const similarity = l2DistanceToSimilarity(vr.distance);
        if (similarity < threshold)
            continue;
        // embedding_version filter: during a model migration the vector tables
        // can still hold old-model rows; comparing them against a current-model
        // query embedding silently misranks. Skip until the worker upgrades them.
        const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?').get(vr.id, EMBEDDING_VERSION);
        if (!row)
            continue;
        const fact = rowToFact(row);
        // Scope filter: same project or global only
        if (canonProject && fact.scope_type === 'project' && fact.scope_project !== canonProject)
            continue;
        results.push({ fact, distance: vr.distance });
        if (results.length >= limit)
            break;
    }
    return results;
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
 */
export function searchSimilarFactsSameScope(db, embedding, scope, limit = 5, threshold = 0.85) {
    const canonProject = scope.type === 'project' ? canonicalizeProject(db, scope.project) : null;
    // Early out only if the scope is genuinely empty (nothing to match against).
    const scopeCount = scope.type === 'global'
        ? db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND scope_type = 'global' AND embedding_version = ?").get(EMBEDDING_VERSION).n
        : db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ? AND embedding_version = ?").get(canonProject, EMBEDDING_VERSION).n;
    if (scopeCount === 0)
        return [];
    // fetchN returns rows AND whether the index returned fewer than requested
    // (i.e. it was exhausted). We page on the VECTOR-TABLE row count, not the
    // active-fact count: the vec tables can hold stale/old-version rows that rank
    // ahead of a valid in-scope row and are only rejected later by the
    // embedding_version filter, so bounding by active facts could stop before
    // reaching the match. `exhausted` is the correct, index-size-independent stop.
    const fetchN = (table, n) => {
        try {
            const p = vecParamFor(db, table, embedding);
            const rows = db.prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ${p.sql} ORDER BY distance LIMIT ?
      `).all(p.blob, n);
            // Normalize ×127-scaled int8 distances BEFORE the cross-table merge.
            for (const r of rows)
                r.distance = normalizeVecDistance(r.distance, p.dt);
            return { rows, exhausted: rows.length < n };
        }
        catch {
            return { rows: [], exhausted: true };
        }
    };
    const HARD_CAP = 100_000; // safety ceiling so a pathological index can't loop unbounded
    let fetchCount = Math.max(limit * 20, 200);
    let results = [];
    for (;;) {
        const a = fetchN('vec_facts', fetchCount);
        const b = fetchN('vec_facts_kr', fetchCount);
        const best = new Map();
        for (const vr of [...a.rows, ...b.rows]) {
            const cur = best.get(vr.id);
            if (cur === undefined || vr.distance < cur)
                best.set(vr.id, vr.distance);
        }
        const merged = [...best.entries()].map(([id, distance]) => ({ id, distance })).sort((x, y) => x.distance - y.distance);
        results = [];
        for (const vr of merged) {
            const similarity = l2DistanceToSimilarity(vr.distance);
            if (similarity < threshold)
                continue;
            const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?').get(vr.id, EMBEDDING_VERSION);
            if (!row)
                continue;
            const fact = rowToFact(row);
            if (scope.type === 'global') {
                if (fact.scope_type !== 'global')
                    continue;
            }
            else if (fact.scope_type !== 'project' || fact.scope_project !== canonProject) {
                continue;
            }
            results.push({ fact, distance: vr.distance });
            if (results.length >= limit)
                break;
        }
        // Stop when we have enough, both indexes are exhausted, or we hit the cap.
        const bothExhausted = a.exhausted && b.exhausted;
        if (results.length >= limit || bothExhausted || fetchCount >= HARD_CAP)
            break;
        fetchCount = Math.min(fetchCount * 4, HARD_CAP);
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
 *
 * Project facts are guaranteed up to half of the result slots: heavily-confirmed
 * global facts otherwise outscore any newly extracted project fact (count=1)
 * forever, so project context would never surface in injection.
 */
export function getTopFacts(db, rawProject, limit = 10) {
    const project = canonicalizeProject(db, rawProject);
    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
    const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
    const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();
    const scoreExpr = `
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(consolidated_count + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN updated_at >= ? THEN 5 WHEN updated_at >= ? THEN 3 WHEN updated_at >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score`;
    const projectRows = db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ?
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(d7, d30, d90, project, project, limit);
    const globalRows = db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'global'
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(d7, d30, d90, project, limit);
    const reserved = Math.ceil(limit / 2);
    const guaranteed = projectRows.slice(0, reserved);
    const rest = [...projectRows.slice(reserved), ...globalRows]
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, Math.max(0, limit - guaranteed.length));
    return [...guaranteed, ...rest]
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .map(rowToFact);
}
/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export function getTopFactsByCount(db, project, limit = 10) {
    return db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
    LIMIT ?
  `).all(canonicalizeProject(db, project), limit).map(rowToFact);
}
export function getNewFactsSince(db, project, since) {
    return db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `).all(since, canonicalizeProject(db, project)).map(rowToFact);
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
export function getAllNewFactsSince(db, cursor, limit = 2000) {
    // Bounded page (keyset) — NEVER materialize the whole table: seeding from the
    // beginning could otherwise pull tens of thousands of rows into memory in one
    // query. The keyset cursor makes each run resume exactly where the last ended,
    // so the backlog drains page-by-page. The idx_facts_active_created_id index
    // (is_active, created_at, id) serves both the filter and the ORDER BY without
    // a temp sort.
    if (!cursor) {
        return db.prepare(`
      SELECT * FROM facts WHERE is_active = 1 ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(limit).map(rowToFact);
    }
    return db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND (created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at ASC, id ASC LIMIT ?
  `).all(cursor.createdAt, cursor.createdAt, cursor.id, limit).map(rowToFact);
}
/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export function searchAllFacts(db, embedding, limit = 10, threshold = 0.6) {
    const pAll = vecParamFor(db, 'vec_facts', embedding);
    const vecResults = db.prepare(`
    SELECT id, distance
    FROM vec_facts
    WHERE embedding MATCH ${pAll.sql}
    ORDER BY distance
    LIMIT ?
  `).all(pAll.blob, limit * 2);
    for (const r of vecResults)
        r.distance = normalizeVecDistance(r.distance, pAll.dt);
    const results = [];
    for (const vr of vecResults) {
        const similarity = l2DistanceToSimilarity(vr.distance);
        if (similarity < threshold)
            continue;
        const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1').get(vr.id);
        if (!row)
            continue;
        results.push({ fact: rowToFact(row), distance: vr.distance });
        if (results.length >= limit)
            break;
    }
    return results;
}
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
        ontology_category_id: row['ontology_category_id'] ?? null,
        coding_agent: row['coding_agent'] ?? null,
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
export function normalizeTag(raw) {
    if (typeof raw !== 'string')
        return null;
    const collapsed = raw.trim().replace(/\s+/g, '-').toLowerCase();
    if (!collapsed)
        return null;
    if (collapsed.length > MAX_TAG_LENGTH)
        return null;
    if (!TAG_ALLOWED.test(collapsed))
        return null;
    return collapsed;
}
/**
 * Parse the stored tags column. A row written by this module is always valid
 * JSON; a row hand-edited via sqlite3 may not be. Rather than throwing inside
 * every read path (which would take down search for one bad row), an
 * unparseable value degrades to [] — the fact stays fully searchable, it just
 * shows no tags. Use `memory-bank tags --verify` to find such rows.
 */
export function parseTags(raw) {
    if (typeof raw !== 'string' || !raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((t) => typeof t === 'string' && t.length > 0);
    }
    catch {
        return [];
    }
}
function requireFactRow(db, factId) {
    const row = db.prepare('SELECT tags FROM facts WHERE id = ?').get(factId);
    if (!row)
        throw new Error(`fact not found: ${factId}`);
    return { tags: parseTags(row.tags) };
}
function writeTags(db, factId, tags) {
    db.prepare('UPDATE facts SET tags = ? WHERE id = ?').run(tags.length ? JSON.stringify(tags) : null, factId);
}
/** Tags currently on a fact. Throws when the fact does not exist. */
export function getFactTags(db, factId) {
    return requireFactRow(db, factId).tags;
}
/**
 * Add tags to a fact (set union, order-stable). Rejects the whole call when any
 * input tag is invalid or the result would exceed MAX_TAGS_PER_FACT — a partial
 * apply would leave the user unsure which tags landed.
 */
export function addFactTags(db, factId, rawTags) {
    const normalized = [];
    for (const raw of rawTags) {
        const tag = normalizeTag(raw);
        if (!tag)
            throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
        normalized.push(tag);
    }
    const current = requireFactRow(db, factId).tags;
    const seen = new Set(current);
    const added = [];
    for (const tag of normalized) {
        if (seen.has(tag))
            continue;
        seen.add(tag);
        added.push(tag);
    }
    const next = [...current, ...added];
    if (next.length > MAX_TAGS_PER_FACT) {
        throw new Error(`too many tags on ${factId}: ${next.length} > ${MAX_TAGS_PER_FACT}`);
    }
    if (added.length)
        writeTags(db, factId, next);
    return { tags: next, added };
}
/** Remove tags from a fact. Tags that were not present are reported, not an error. */
export function removeFactTags(db, factId, rawTags) {
    const targets = new Set();
    const absentInput = [];
    for (const raw of rawTags) {
        const tag = normalizeTag(raw);
        if (!tag) {
            absentInput.push(raw);
            continue;
        }
        targets.add(tag);
    }
    const current = requireFactRow(db, factId).tags;
    const next = current.filter((t) => !targets.has(t));
    const removed = current.filter((t) => targets.has(t));
    const absent = [...targets].filter((t) => !current.includes(t)).concat(absentInput);
    if (removed.length)
        writeTags(db, factId, next);
    return { tags: next, removed, absent };
}
/** Replace a fact's tags wholesale. Passing [] clears them. */
export function setFactTags(db, factId, rawTags) {
    const next = [];
    for (const raw of rawTags) {
        const tag = normalizeTag(raw);
        if (!tag)
            throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
        if (!next.includes(tag))
            next.push(tag);
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
export function listTags(db, opts = {}) {
    const where = ['tags IS NOT NULL'];
    const params = [];
    if (!opts.includeInactive)
        where.push('is_active = 1');
    if (opts.project) {
        const canon = canonicalizeProject(db, opts.project);
        where.push("((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')");
        params.push(canon);
    }
    const rows = db
        .prepare(`SELECT tags FROM facts WHERE ${where.join(' AND ')}`)
        .all(...params);
    const counts = new Map();
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
export function findFactsByTags(db, rawTags, opts = {}) {
    const tags = [];
    for (const raw of rawTags) {
        const tag = normalizeTag(raw);
        if (!tag)
            throw new Error(`invalid tag: ${JSON.stringify(raw)}`);
        if (!tags.includes(tag))
            tags.push(tag);
    }
    if (!tags.length)
        return [];
    const where = ['tags IS NOT NULL'];
    const params = [];
    if (!opts.includeInactive)
        where.push('is_active = 1');
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
        .prepare(`SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params, limit);
    return rows.map((row) => rowToFact(row));
}
