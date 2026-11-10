import fs from 'fs';
import path from 'path';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from './db.js';
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION } from './embeddings.js';
import { getSyncDir } from './sync-export.js';
import { canonicalizeProject } from './project-canon.js';
import { factRejectReason, ontologyNameRejectReason } from './fact-validity.js';
import { secretRejectReason } from './secret-scan.js';

interface SyncFact {
  id: string;
  fact: string;
  fact_kr?: string | null;
  category: string;
  scope_type: string;
  scope_project: string | null;
  source_exchange_ids: string;
  created_at: string;
  updated_at: string;
  consolidated_count: number;
  ontology_category_id: string | null;
}

/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 */
export async function importFromSync(): Promise<{
  newFacts: number; newDomains: number; newCategories: number; newRelations: number;
  rejectedJunk: number; detachedCategoryRefs: number; failedFacts: number; failedFactErrors: string[];
  rejectedSecrets: number; rejectedSecretReasons: Record<string, number>;
}> {
  const syncDir = getSyncDir();
  // rejectedJunk: rows in the sync files that fact-validity.ts refuses (template residue,
  //   a copy of the extraction prompt's example, session-environment boilerplate),
  //   plus categories under a rejected domain. They stay in the files until the
  //   exporting device stops exporting them, so the count repeats per run.
  // detachedCategoryRefs: imported facts whose ontology category does not exist
  //   here (rejected above, or never exported) — stored unclassified so the
  //   ontology backfill classifies them, instead of pointing at a missing row.
  // failedFacts: facts whose embedding or write failed — retried by the next import (nothing was committed for them).
  // failedFactErrors: the first few causes, so the hook's log says why, not only how many.
  // rejectedSecrets: facts whose text carries a credential-shaped string (secret-scan.ts) —
  //   never imported; like rejectedJunk the rows stay in the sync files until the exporting
  //   device stops exporting them. rejectedSecretReasons counts them by kind (no text).
  const result = {
    newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0, rejectedJunk: 0, detachedCategoryRefs: 0,
    failedFacts: 0, failedFactErrors: [] as string[],
    rejectedSecrets: 0, rejectedSecretReasons: {} as Record<string, number>,
  };
  const rejectedDomainIds = new Set<string>();

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
          if (ontologyNameRejectReason(d.name)) { result.rejectedJunk++; rejectedDomainIds.add(String(d.id)); continue; }
          const existing = db.prepare('SELECT id FROM ontology_domains WHERE id = ?').get(d.id);
          if (!existing) {
            db.prepare('INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
              d.id, d.name, d.description, d.created_at
            );
            result.newDomains++;
          }
        } catch { /* skip malformed */ }
      }
    }

    // Import categories
    const categoriesPath = path.join(syncDir, 'ontology-categories.jsonl');
    if (fs.existsSync(categoriesPath)) {
      const lines = fs.readFileSync(categoriesPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const c = JSON.parse(line);
          if (ontologyNameRejectReason(c.name) || rejectedDomainIds.has(String(c.domain_id))) { result.rejectedJunk++; continue; }
          const existing = db.prepare('SELECT id FROM ontology_categories WHERE id = ?').get(c.id);
          if (!existing) {
            db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(
              c.id, c.domain_id, c.name, c.description, c.created_at
            );
            result.newCategories++;
          }
        } catch { /* skip malformed */ }
      }
    }

    // Import facts (need to generate embeddings for new ones)
    const factsLines = fs.readFileSync(factsPath, 'utf-8').split('\n').filter(l => l.trim());
    const newFacts: SyncFact[] = [];
    const seenInBatch = new Set<string>();

    for (const line of factsLines) {
      try {
        const f: SyncFact = JSON.parse(line);
        const existingById = db.prepare('SELECT id FROM facts WHERE id = ?').get(f.id);
        if (existingById) continue;
        if (factRejectReason(f)) { result.rejectedJunk++; continue; }
        const secretReason = secretRejectReason(f.fact) ?? secretRejectReason(f.fact_kr);
        if (secretReason) {
          result.rejectedSecrets++;
          result.rejectedSecretReasons[secretReason] = (result.rejectedSecretReasons[secretReason] ?? 0) + 1;
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
        if (seenInBatch.has(contentKey)) continue;
        const existingByContent = db.prepare(`
          SELECT id FROM facts
          WHERE is_active = 1 AND fact = ? AND scope_type = ? AND COALESCE(scope_project, '') = ?
        `).get(f.fact, f.scope_type, f.scope_project ?? '');
        if (existingByContent) continue;

        seenInBatch.add(contentKey);
        newFacts.push(f);
      } catch { /* skip malformed */ }
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

      // Row + vectors commit together under the write lock, and the table
      // dtype/scale is read inside it: a vec table swap (compaction, int8
      // migration/restore) can't land between the read and the write, and a
      // failed vector write can't leave a committed row that the next import
      // skips by id — that fact would be missing from vector search for good.
      const writeFact = db.transaction((f: SyncFact, embedding: number[], embeddingKr: number[] | null) => {
        db.prepare(`
          INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
            embedding, created_at, updated_at, consolidated_count, is_active, ontology_category_id,
            fact_kr, embedding_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          f.id, f.fact, f.category, f.scope_type, f.scope_project, f.source_exchange_ids,
          Buffer.from(new Float32Array(embedding).buffer),
          f.created_at, f.updated_at, f.consolidated_count, f.ontology_category_id,
          f.fact_kr ?? null, EMBEDDING_VERSION
        );

        // Vector index (dtype/scale-aware: int8 tables need vec_int8()-wrapped
        // blobs quantized at the table's scale — a raw float32 blob throws)
        const qF = getVecQuant(db, 'vec_facts');
        db.prepare('DELETE FROM vec_facts WHERE id = ?').run(f.id);
        db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(qF)})`).run(
          f.id, embeddingToVecBlob(embedding, qF)
        );

        // Korean-text vector index (same-language matching for Korean queries)
        if (embeddingKr) {
          const qK = getVecQuant(db, 'vec_facts_kr');
          db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(f.id);
          db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${vecParamSql(qK)})`).run(
            f.id, embeddingToVecBlob(embeddingKr, qK)
          );
        }
      });

      for (const f of newFacts) {
        try {
          const embedding = await generateEmbedding(f.fact);
          const embeddingKr = f.fact_kr ? await generateEmbedding(f.fact_kr) : null;
          writeFact.immediate(f, embedding, embeddingKr);

          result.newFacts++;
        } catch (e) {
          result.failedFacts++;
          const msg = e instanceof Error ? e.message : String(e);
          if (result.failedFactErrors.length < 5) result.failedFactErrors.push(`${f.id}: ${msg}`);
          console.error(`sync-import: failed to import fact ${f.id}:`, msg);
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
        } catch { /* skip malformed */ }
      }
    }

    return result;
  } finally {
    db.close();
  }
}
