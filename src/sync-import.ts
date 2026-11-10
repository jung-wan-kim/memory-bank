import fs from 'fs';
import path from 'path';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from './db.js';
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION } from './embeddings.js';
import { getSyncDir, ownExportStillInDb, syncFilesNotMatchingMeta } from './sync-export.js';
import { getIndexDir } from './paths.js';
import { canonicalizeProject } from './project-canon.js';
import { normalizeCategory, ontologyNameRejectReason } from './fact-validity.js';
import { instructionLikeReason, recordImportedFact, syncFactRefusal, type ImportRejectReason } from './import-guard.js';

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
 * The highest consolidated_count an imported fact is stored with. The count
 * orders the session-start block ("most confirmed first"), and the file value
 * was stored as it came: one line with 999999 put a planted fact on the first
 * line of every project. The highest count this install has reached itself is
 * 51 (2026-11-11), so the bound changes no real row. It is a sanity bound, not
 * a ranking defence — a planted line can still claim a count up to it.
 */
export const MAX_IMPORTED_CONSOLIDATED_COUNT = 100;

/** The count to store for a sync-file value: an integer in 1..MAX_IMPORTED_CONSOLIDATED_COUNT. An absent value is 1. */
function importedConsolidatedCount(value: unknown): { count: number; adjusted: boolean } {
  if (value === undefined || value === null) return { count: 1, adjusted: false };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return { count: 1, adjusted: true };
  if (value > MAX_IMPORTED_CONSOLIDATED_COUNT) return { count: MAX_IMPORTED_CONSOLIDATED_COUNT, adjusted: true };
  return { count: value, adjusted: false };
}

/**
 * Why a relation in the sync files was not imported: one of its two facts is not in this database.
 *  - endpoint-refused: the fact was refused by this import (validity, credential-shaped, instruction-like)
 *  - endpoint-failed: the fact failed to import this run (the next import retries both)
 *  - endpoint-duplicate: the same sentence is already here under another id, so the file's id was not imported
 *  - endpoint-missing: the fact is neither here nor importable from the file (a torn line, an inactive fact — the
 *    export lists active facts only)
 */
export type SkippedRelationReason = 'endpoint-refused' | 'endpoint-failed' | 'endpoint-duplicate' | 'endpoint-missing';

/**
 * logs/sync-import.jsonl — the file the SessionStart hook records its failures in. The hook runs async, so its
 * stderr goes nowhere; what an import skipped is recorded here by the import itself. Never throws.
 */
function appendImportLog(entry: Record<string, unknown>): void {
  try {
    const dir = path.join(getIndexDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'sync-import.jsonl');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('sync-import: cannot write log:', e instanceof Error ? e.message : e);
  }
}

const describeCounts = (counts: Record<string, number>): string =>
  Object.entries(counts).map(([name, n]) => `${name} ${n}`).join(', ');

/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 *
 * Nothing in the files is passed over silently: a row that is not imported is
 * counted in the result by cause, and the counts are written to
 * logs/sync-import.jsonl (action 'skipped' — counts and ids only, no text).
 */
export async function importFromSync(): Promise<{
  newFacts: number; newDomains: number; newCategories: number; newRelations: number;
  rejectedJunk: number; detachedCategoryRefs: number; failedFacts: number; failedFactErrors: string[];
  rejectedSecrets: number; rejectedSecretReasons: Record<string, number>;
  rejectedInstructionLike: number; rejectedInstructionLikeSamples: string[];
  foldedCategories: number; clampedCounts: number;
  malformedLines: number; malformedLinesByFile: Record<string, number>;
  skippedRelations: number; skippedRelationReasons: Partial<Record<SkippedRelationReason, number>>;
  filesNotMatchingMeta: string[];
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
  // rejectedInstructionLike: rows whose text is an instruction aimed at the model (import-guard.ts): a fact's
  //   text or category, an ontology domain/category name, a relation's reasoning. Like rejectedJunk they stay
  //   in the files, so the count repeats per run. Samples: the first few "id: reason" (facts), or
  //   "domain|category|relation id: reason".
  // foldedCategories: imported facts whose category was neither one of the five names nor a known alias —
  //   stored as 'knowledge' (normalizeCategory). No file value is stored as a category as it came.
  // clampedCounts: imported facts whose consolidated_count was not an integer in
  //   1..MAX_IMPORTED_CONSOLIDATED_COUNT — stored as 1 (not a count) or as the bound (above it).
  // malformedLines: lines that are not a JSON object (a line torn mid-write, a stray fragment) or whose row
  //   the database could not take (wrong types, a category whose domain is not here). By file in
  //   malformedLinesByFile. A file that arrives whole later is imported then — nothing is lost for good.
  // skippedRelations: relations one of whose two facts is not in this database (SkippedRelationReason). The
  //   lines stay in the file, so the count repeats per run until the fact is here or the line is gone.
  // filesNotMatchingMeta: data files whose size is not the one meta.json declares — the folder was read
  //   while it was still being delivered. The import goes on with what is there; the torn lines are counted above.
  const result = {
    newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0, rejectedJunk: 0, detachedCategoryRefs: 0,
    failedFacts: 0, failedFactErrors: [] as string[],
    rejectedSecrets: 0, rejectedSecretReasons: {} as Record<string, number>,
    rejectedInstructionLike: 0, rejectedInstructionLikeSamples: [] as string[],
    foldedCategories: 0, clampedCounts: 0,
    malformedLines: 0, malformedLinesByFile: {} as Record<string, number>,
    skippedRelations: 0, skippedRelationReasons: {} as Partial<Record<SkippedRelationReason, number>>,
    filesNotMatchingMeta: [] as string[],
  };
  const rejectedDomainIds = new Set<string>();
  // Facts of the file that are not in this database after this run, by cause — what a relation's skip reason is read from.
  const refusedFactIds = new Set<string>();
  const duplicateFactIds = new Set<string>();
  const failedFactIds = new Set<string>();
  const malformed = (file: string): void => {
    result.malformedLines++;
    result.malformedLinesByFile[file] = (result.malformedLinesByFile[file] ?? 0) + 1;
  };
  /** The rows of a sync file, one JSON object per line. A line that is not one is counted, not thrown. */
  function* rowsOf(file: string): Generator<Record<string, any>> {
    const filePath = path.join(syncDir, file);
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { row = null; }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) { malformed(file); continue; }
      yield row as Record<string, any>;
    }
  }
  const refuseInstructionLike = (label: string, reason: ImportRejectReason): void => {
    result.rejectedInstructionLike++;
    if (result.rejectedInstructionLikeSamples.length < 5) result.rejectedInstructionLikeSamples.push(`${label}: ${reason}`);
  };

  // Check if sync files exist
  const factsPath = path.join(syncDir, 'facts.jsonl');
  if (!fs.existsSync(factsPath)) {
    return result;
  }

  const db = initDatabase();

  try {
    // sync/ is this install's own last export, untouched, and the DB has lost no row since:
    // nothing to add — do not read the files (sync-export.ts ownExportStillInDb).
    if (ownExportStillInDb(db, syncDir)) return result;

    result.filesNotMatchingMeta = syncFilesNotMatchingMeta(syncDir);

    // Import domains first (facts reference them via categories)
    const domainExists = db.prepare('SELECT 1 FROM ontology_domains WHERE id = ?');
    const insertDomain = db.prepare('INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)');
    for (const d of rowsOf('ontology-domains.jsonl')) {
      try {
        if (ontologyNameRejectReason(d.name)) { result.rejectedJunk++; rejectedDomainIds.add(String(d.id)); continue; }
        const domainGuard = instructionLikeReason(d.name);
        if (domainGuard) { refuseInstructionLike(`domain ${d.id}`, domainGuard); rejectedDomainIds.add(String(d.id)); continue; }
        if (domainExists.get(d.id)) continue;
        insertDomain.run(d.id, d.name, d.description, d.created_at);
        result.newDomains++;
      } catch {
        malformed('ontology-domains.jsonl');
      }
    }

    // Import categories
    const categoryRowExists = db.prepare('SELECT 1 FROM ontology_categories WHERE id = ?');
    const insertCategory = db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const c of rowsOf('ontology-categories.jsonl')) {
      try {
        if (ontologyNameRejectReason(c.name) || rejectedDomainIds.has(String(c.domain_id))) { result.rejectedJunk++; continue; }
        const categoryGuard = instructionLikeReason(c.name);
        if (categoryGuard) { refuseInstructionLike(`category ${c.id}`, categoryGuard); continue; }
        if (categoryRowExists.get(c.id)) continue;
        insertCategory.run(c.id, c.domain_id, c.name, c.description, c.created_at);
        result.newCategories++;
      } catch {
        malformed('ontology-categories.jsonl'); // e.g. its domain is not here (a torn domains file)
      }
    }

    // Import facts (need to generate embeddings for new ones)
    const newFacts: SyncFact[] = [];
    const seenInBatch = new Set<string>();
    const factExists = db.prepare('SELECT 1 FROM facts WHERE id = ?');
    const activeFactWithText = db.prepare(`
      SELECT id FROM facts
      WHERE is_active = 1 AND fact = ? AND scope_type = ? AND COALESCE(scope_project, '') = ?
    `);

    for (const row of rowsOf('facts.jsonl')) {
      try {
        const f = row as SyncFact;
        if (factExists.get(f.id)) continue;
        // The same judgment the export applies before it writes the file (import-guard.ts syncFactRefusal).
        const refusal = syncFactRefusal(f);
        if (refusal) {
          refusedFactIds.add(String(f.id));
          if (refusal.kind === 'validity') result.rejectedJunk++;
          else if (refusal.kind === 'secret') {
            result.rejectedSecrets++;
            result.rejectedSecretReasons[refusal.reason] = (result.rejectedSecretReasons[refusal.reason] ?? 0) + 1;
          } else refuseInstructionLike(String(f.id), refusal.reason as ImportRejectReason);
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
        if (seenInBatch.has(contentKey) || activeFactWithText.get(f.fact, f.scope_type, f.scope_project ?? '')) {
          duplicateFactIds.add(String(f.id));
          continue;
        }

        seenInBatch.add(contentKey);
        // The category and the count are stored from here on, never as the file wrote them:
        // the category is one of the five names, the count an integer within the bound.
        const folded = normalizeCategory(f.category);
        if (!folded.known) result.foldedCategories++;
        f.category = folded.category;
        const count = importedConsolidatedCount(f.consolidated_count);
        if (count.adjusted) result.clampedCounts++;
        f.consolidated_count = count.count;
        newFacts.push(f);
      } catch {
        malformed('facts.jsonl'); // a row whose values the lookups could not take (wrong types)
      }
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
        recordImportedFact(db, f.id); // origin mark: this fact came from a sync file, not from this device's extraction

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
          failedFactIds.add(String(f.id));
          const msg = e instanceof Error ? e.message : String(e);
          if (result.failedFactErrors.length < 5) result.failedFactErrors.push(`${f.id}: ${msg}`);
          console.error(`sync-import: failed to import fact ${f.id}:`, msg);
        }
      }
    }

    // Import relations. A relation needs both of its facts here (foreign keys): one that does not is
    // counted by cause instead of being left to fail the INSERT — that failure used to be swallowed.
    const relationExists = db.prepare('SELECT 1 FROM ontology_relations WHERE id = ?');
    const insertRelation = db.prepare(`
      INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const endpointSkipReason = (factId: unknown): SkippedRelationReason | null => {
      const key = String(factId);
      if (refusedFactIds.has(key)) return 'endpoint-refused';
      if (factExists.get(factId)) return null;
      if (failedFactIds.has(key)) return 'endpoint-failed';
      if (duplicateFactIds.has(key)) return 'endpoint-duplicate';
      return 'endpoint-missing';
    };
    for (const r of rowsOf('ontology-relations.jsonl')) {
      try {
        if (relationExists.get(r.id)) continue;
        const reasoningGuard = instructionLikeReason(r.reasoning);
        if (reasoningGuard) { refuseInstructionLike(`relation ${r.id}`, reasoningGuard); continue; }
        const skip = endpointSkipReason(r.source_fact_id) ?? endpointSkipReason(r.target_fact_id);
        if (skip) {
          result.skippedRelations++;
          result.skippedRelationReasons[skip] = (result.skippedRelationReasons[skip] ?? 0) + 1;
          continue;
        }
        insertRelation.run(r.id, r.source_fact_id, r.relation_type, r.target_fact_id, r.reasoning, r.created_at);
        result.newRelations++;
      } catch {
        malformed('ontology-relations.jsonl');
      }
    }

    // What was passed over, by cause. The hook's own log entries cover credential-shaped and
    // instruction-like rows and failed facts; everything else an import skips is recorded here.
    const skipped: Record<string, unknown> = {};
    if (result.malformedLines > 0) skipped.malformed_lines = result.malformedLinesByFile;
    if (result.skippedRelations > 0) skipped.skipped_relations = result.skippedRelationReasons;
    if (result.rejectedJunk > 0) skipped.rejected_validity = result.rejectedJunk;
    if (result.foldedCategories > 0) skipped.folded_categories = result.foldedCategories;
    if (result.clampedCounts > 0) skipped.clamped_counts = result.clampedCounts;
    if (result.detachedCategoryRefs > 0) skipped.detached_category_refs = result.detachedCategoryRefs;
    if (result.filesNotMatchingMeta.length > 0) skipped.files_not_matching_meta = result.filesNotMatchingMeta;
    if (Object.keys(skipped).length > 0) {
      appendImportLog({ action: 'skipped', ...skipped });
      const parts: string[] = [];
      if (result.malformedLines > 0) parts.push(`${result.malformedLines} unreadable line(s) (${describeCounts(result.malformedLinesByFile)})`);
      if (result.skippedRelations > 0) parts.push(`${result.skippedRelations} relation(s) whose fact is not here (${describeCounts(result.skippedRelationReasons as Record<string, number>)})`);
      if (result.foldedCategories > 0) parts.push(`${result.foldedCategories} fact(s) stored as 'knowledge' (category outside the five names)`);
      if (result.clampedCounts > 0) parts.push(`${result.clampedCounts} confirmation count(s) out of range`);
      if (result.filesNotMatchingMeta.length > 0) parts.push(`size differs from meta.json: ${result.filesNotMatchingMeta.join(', ')}`);
      if (parts.length > 0) console.error(`sync-import: passed over ${parts.join('; ')} — recorded in logs/sync-import.jsonl`);
    }

    return result;
  } finally {
    db.close();
  }
}
