import { randomUUID } from 'crypto';
// === Domain CRUD ===
export function createDomain(db, name, description) {
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
    return (db
        .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Category CRUD ===
export function createCategory(db, domainId, name, description) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, domainId, name, description ?? null, now);
    return { id, domain_id: domainId, name, description: description ?? null, created_at: now };
}
export function listCategories(db, domainId) {
    if (domainId) {
        return db
            .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
            .all(domainId);
    }
    return db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all();
}
export function getCategoryByName(db, name, domainId) {
    if (domainId) {
        return (db
            .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE AND domain_id = ?`)
            .get(name, domainId) ?? null);
    }
    return (db
        .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Fact Classification ===
export function classifyFact(db, factId, categoryId) {
    db.prepare(`UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`).run(categoryId, new Date().toISOString(), factId);
}
export function getFactsByCategory(db, categoryId) {
    return db
        .prepare(`SELECT * FROM facts WHERE ontology_category_id = ? AND is_active = 1 ORDER BY consolidated_count DESC`)
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
export function createRelation(db, sourceFactId, relationType, targetFactId, reasoning) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
    return {
        id,
        source_fact_id: sourceFactId,
        relation_type: relationType,
        target_fact_id: targetFactId,
        reasoning: reasoning ?? null,
        created_at: now,
    };
}
export function getRelatedFacts(db, factId, hops = 1) {
    const visited = new Set([factId]);
    const results = [];
    let frontier = [factId];
    for (let hop = 0; hop < hops; hop++) {
        const nextFrontier = [];
        for (const currentId of frontier) {
            // Outgoing relations (source → target)
            const outgoing = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1`)
                .all(currentId);
            for (const row of outgoing) {
                const targetId = row['target_fact_id'];
                if (visited.has(targetId))
                    continue;
                visited.add(targetId);
                nextFrontier.push(targetId);
                const relation = rowToRelation(row);
                const fact = rowToFact(row);
                results.push({ fact, relation });
            }
            // Incoming relations (target ← source)
            const incoming = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1`)
                .all(currentId);
            for (const row of incoming) {
                const sourceId = row['source_fact_id'];
                if (visited.has(sourceId))
                    continue;
                visited.add(sourceId);
                nextFrontier.push(sourceId);
                const relation = rowToRelation(row);
                const fact = rowToFact(row);
                results.push({ fact, relation });
            }
        }
        frontier = nextFrontier;
        if (frontier.length === 0)
            break;
    }
    return results;
}
export function getRelationsForFact(db, factId) {
    return db
        .prepare(`SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`)
        .all(factId, factId);
}
// === Ontology Tree ===
export function getOntologyTree(db) {
    const domains = listDomains(db);
    const tree = [];
    for (const domain of domains) {
        const categories = listCategories(db, domain.id);
        const domainEntry = {
            domain,
            categories: [],
        };
        for (const category of categories) {
            const facts = getFactsByCategory(db, category.id);
            domainEntry.categories.push({ category, facts });
        }
        tree.push(domainEntry);
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
