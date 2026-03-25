import fs from 'fs';
import path from 'path';
import { initDatabase } from './db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { getSyncDir } from './sync-export.js';
/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 */
export async function importFromSync() {
    const syncDir = getSyncDir();
    const result = { newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0 };
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
        for (const line of factsLines) {
            try {
                const f = JSON.parse(line);
                const existing = db.prepare('SELECT id FROM facts WHERE id = ?').get(f.id);
                if (!existing) {
                    newFacts.push(f);
                }
            }
            catch { /* skip malformed */ }
        }
        if (newFacts.length > 0) {
            await initEmbeddings();
            for (const f of newFacts) {
                try {
                    const embedding = await generateEmbedding(f.fact);
                    db.prepare(`
            INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
              embedding, created_at, updated_at, consolidated_count, is_active, ontology_category_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(f.id, f.fact, f.category, f.scope_type, f.scope_project, f.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), f.created_at, f.updated_at, f.consolidated_count, f.ontology_category_id);
                    // Vector index
                    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(f.id);
                    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(f.id, Buffer.from(new Float32Array(embedding).buffer));
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
