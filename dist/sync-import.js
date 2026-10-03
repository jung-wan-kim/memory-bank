import fs from 'fs';
import path from 'path';
import { initDatabase, getVecTableDtype, embeddingToVecBlob, vecParamSql } from './db.js';
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION } from './embeddings.js';
import { getSyncDir } from './sync-export.js';
import { canonicalizeProject } from './project-canon.js';
import { factRejectReason, ontologyNameRejectReason } from './fact-validity.js';
/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 */
export async function importFromSync() {
    const syncDir = getSyncDir();
    // rejectedJunk: template-residue rows found in the sync files (fact-validity.ts),
    //   plus categories under a rejected domain. They stay in the files until the
    //   exporting device stops exporting them, so the count repeats per run.
    // detachedCategoryRefs: imported facts whose ontology category does not exist
    //   here (rejected above, or never exported) — stored unclassified so the
    //   ontology backfill classifies them, instead of pointing at a missing row.
    const result = { newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0, rejectedJunk: 0, detachedCategoryRefs: 0 };
    const rejectedDomainIds = new Set();
    // Check if sync files exist
    const factsPath = path.join(syncDir, 'facts.jsonl');
    if (!fs.existsSync(factsPath)) {
        return result;
    }
    const db = initDatabase();
    try {
        // Import domains first (facts reference them via categories)
        const domainsPath = path.join(syncDir, 'ontology-domains.jsonl');
        if (fs.existsSync(domainsPath)) {
            const lines = fs.readFileSync(domainsPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const d = JSON.parse(line);
                    if (ontologyNameRejectReason(d.name)) {
                        result.rejectedJunk++;
                        rejectedDomainIds.add(String(d.id));
                        continue;
                    }
                    const existing = db.prepare('SELECT id FROM ontology_domains WHERE id = ?').get(d.id);
                    if (!existing) {
                        db.prepare('INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(d.id, d.name, d.description, d.created_at);
                        result.newDomains++;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        // Import categories
        const categoriesPath = path.join(syncDir, 'ontology-categories.jsonl');
        if (fs.existsSync(categoriesPath)) {
            const lines = fs.readFileSync(categoriesPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const c = JSON.parse(line);
                    if (ontologyNameRejectReason(c.name) || rejectedDomainIds.has(String(c.domain_id))) {
                        result.rejectedJunk++;
                        continue;
                    }
                    const existing = db.prepare('SELECT id FROM ontology_categories WHERE id = ?').get(c.id);
                    if (!existing) {
                        db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.domain_id, c.name, c.description, c.created_at);
                        result.newCategories++;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        // Import facts (need to generate embeddings for new ones)
        const factsLines = fs.readFileSync(factsPath, 'utf-8').split('\n').filter(l => l.trim());
        const newFacts = [];
        const seenInBatch = new Set();
        for (const line of factsLines) {
            try {
                const f = JSON.parse(line);
                const existingById = db.prepare('SELECT id FROM facts WHERE id = ?').get(f.id);
                if (existingById)
                    continue;
                if (factRejectReason(f)) {
                    result.rejectedJunk++;
                    continue;
                }
                // Canonicalize scope before dedup/insert — other devices may still
                // export slug-format project names.
                if (f.scope_project) {
                    f.scope_project = canonicalizeProject(db, f.scope_project);
                }
                // Content-based dedup: re-exports from other devices assign new ids
                // to identical facts, so id-only checks accumulate duplicates.
                const contentKey = `${f.fact}\u0000${f.scope_type}\u0000${f.scope_project ?? ''}`;
                if (seenInBatch.has(contentKey))
                    continue;
                const existingByContent = db.prepare(`
          SELECT id FROM facts
          WHERE is_active = 1 AND fact = ? AND scope_type = ? AND COALESCE(scope_project, '') = ?
        `).get(f.fact, f.scope_type, f.scope_project ?? '');
                if (existingByContent)
                    continue;
                seenInBatch.add(contentKey);
                newFacts.push(f);
            }
            catch { /* skip malformed */ }
        }
        if (newFacts.length > 0) {
            const categoryExists = db.prepare('SELECT 1 FROM ontology_categories WHERE id = ?');
            for (const f of newFacts) {
                if (f.ontology_category_id && !categoryExists.get(f.ontology_category_id)) {
                    f.ontology_category_id = null;
                    result.detachedCategoryRefs++;
                }
            }
            await initEmbeddings();
            for (const f of newFacts) {
                try {
                    const embedding = await generateEmbedding(f.fact);
                    db.prepare(`
            INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
              embedding, created_at, updated_at, consolidated_count, is_active, ontology_category_id,
              fact_kr, embedding_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `).run(f.id, f.fact, f.category, f.scope_type, f.scope_project, f.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), f.created_at, f.updated_at, f.consolidated_count, f.ontology_category_id, f.fact_kr ?? null, EMBEDDING_VERSION);
                    // Vector index (dtype-aware: int8 tables need vec_int8()-wrapped
                    // quantized blobs — a raw float32 blob throws on an int8 table)
                    const dtF = getVecTableDtype(db, 'vec_facts');
                    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(f.id);
                    db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(dtF)})`).run(f.id, embeddingToVecBlob(embedding, dtF));
                    // Korean-text vector index (same-language matching for Korean queries)
                    if (f.fact_kr) {
                        const embeddingKr = await generateEmbedding(f.fact_kr);
                        const dtK = getVecTableDtype(db, 'vec_facts_kr');
                        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(f.id);
                        db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${vecParamSql(dtK)})`).run(f.id, embeddingToVecBlob(embeddingKr, dtK));
                    }
                    result.newFacts++;
                }
                catch (e) {
                    console.error(`sync-import: failed to import fact ${f.id}:`, e instanceof Error ? e.message : e);
                }
            }
        }
        // Import relations
        const relationsPath = path.join(syncDir, 'ontology-relations.jsonl');
        if (fs.existsSync(relationsPath)) {
            const lines = fs.readFileSync(relationsPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const r = JSON.parse(line);
                    const existing = db.prepare('SELECT id FROM ontology_relations WHERE id = ?').get(r.id);
                    if (!existing) {
                        db.prepare(`
              INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(r.id, r.source_fact_id, r.relation_type, r.target_fact_id, r.reasoning, r.created_at);
                        result.newRelations++;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        return result;
    }
    finally {
        db.close();
    }
}
