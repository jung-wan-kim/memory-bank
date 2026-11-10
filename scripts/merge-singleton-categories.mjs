#!/usr/bin/env node
/**
 * P2 data migration: merge "singleton" ontology categories (few facts) into a
 * nearby STABLE category in the SAME domain, by embedding similarity. Reverses
 * category sprawl (measured: 1,612 categories, 750 with a single fact) so the
 * ontology behaves like a graph instead of near-1:1 tags.
 *
 * Safety:
 *   - Only categories with <= MERGE_MAX_FACTS active facts are candidates (default 1).
 *   - Target must be in the SAME domain, NOT a candidate itself (count > max), and
 *     similarity >= MERGE_SIM_THRESHOLD (default 0.93). No singleton→singleton
 *     merges → no chains.
 *   - Facts are REASSIGNED (never deleted); only the now-empty source category +
 *     its vec_categories row are removed. Every merge is logged with the ids of
 *     the facts it moved (category_merge_log.fact_ids), so it can be undone by hand.
 *   - DRY_RUN=1 or --dry-run previews without writing: the database is opened
 *     read-only, so not even the schema changes (the first version created the
 *     merge-log table and ran initDatabase()'s migrations in a dry run).
 *   - Any other argument stops the run before the database is opened — a typo
 *     like --dryrun used to be ignored and the merge ran for real.
 *
 * Requires category embeddings (scripts/backfill-category-embeddings.mjs first).
 * Idempotent: re-running merges any remaining qualifying singletons.
 * Usage: [DRY_RUN=1] [MERGE_SIM_THRESHOLD=0.93] [MERGE_MAX_FACTS=1] node scripts/merge-singleton-categories.mjs [--dry-run]
 */
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, openReadOnlyDatabase } from '../dist/db.js';
import { initEmbeddings, generateEmbedding } from '../dist/embeddings.js';
import { searchSimilarCategories, deleteCategoryEmbedding } from '../dist/ontology-db.js';
import { parseCliArgs } from '../dist/cli-args.js';

let cli;
try {
  cli = parseCliArgs(process.argv.slice(2), { flags: ['--dry-run'] });
} catch (e) {
  console.error(`merge-singleton-categories: ${e instanceof Error ? e.message : e}`);
  console.error('Usage: [DRY_RUN=1] [MERGE_SIM_THRESHOLD=0.93] [MERGE_MAX_FACTS=1] node scripts/merge-singleton-categories.mjs [--dry-run]');
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN === '1' || cli.flags.has('--dry-run');
const SIM = Math.min(Math.max(parseFloat(process.env.MERGE_SIM_THRESHOLD || '0.93'), 0.5), 0.999);
const MAX_FACTS = Math.max(parseInt(process.env.MERGE_MAX_FACTS || '1', 10) || 1, 1);
const simOf = (d) => 1 - (d * d) / 2;

/** Read-only handle for a dry run (no migrations, nothing created); sqlite-vec for the category KNN. */
function openForDryRun() {
  const ro = openReadOnlyDatabase();
  if (!ro) throw new Error('no database to preview (nothing has been indexed yet)');
  sqliteVec.load(ro);
  return ro;
}

let db;
try {
  db = DRY_RUN ? openForDryRun() : initDatabase();
} catch (e) {
  console.error('merge-singleton-categories failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}
try {
  await initEmbeddings();

  if (!DRY_RUN) {
    // Durable audit log so a merge can be traced/rolled back (source→target +
    // the ids of the facts moved). Without this the destructive delete leaves
    // no recovery path.
    db.exec(`CREATE TABLE IF NOT EXISTS category_merge_log (
      merged_at TEXT NOT NULL,
      source_id TEXT NOT NULL, source_name TEXT,
      target_id TEXT NOT NULL, target_name TEXT,
      domain TEXT, similarity REAL, facts_reassigned INTEGER,
      fact_ids TEXT
    )`);
    // A table created by the first version has no fact_ids (it logged a count only).
    const logColumns = db.prepare(`SELECT name FROM pragma_table_info('category_merge_log')`).all().map((c) => c.name);
    if (!logColumns.includes('fact_ids')) db.exec('ALTER TABLE category_merge_log ADD COLUMN fact_ids TEXT');
  }

  // TOTAL fact count per category (active AND inactive). Counting only active
  // facts would mis-classify a category with 1 active + N inactive facts as a
  // "singleton" and destructively merge it. A true singleton has <= MAX_FACTS
  // total facts.
  const counts = new Map();
  for (const r of db.prepare(
    'SELECT ontology_category_id id, count(*) n FROM facts WHERE ontology_category_id IS NOT NULL GROUP BY ontology_category_id'
  ).all()) counts.set(r.id, r.n);

  const cats = db.prepare('SELECT id, domain_id, name, description FROM ontology_categories').all();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const candidates = cats.filter((c) => (counts.get(c.id) || 0) <= MAX_FACTS);
  const before = cats.length;
  console.log(`merge: ${before} categories, ${candidates.length} candidates (<=${MAX_FACTS} facts), sim>=${SIM}${DRY_RUN ? ' [DRY_RUN]' : ''}`);

  let merged = 0, reassigned = 0;
  for (const src of candidates) {
    const text = src.description ? `${src.name}: ${src.description}` : src.name;
    const emb = await generateEmbedding(text, 'passage');
    const hits = searchSimilarCategories(db, emb, 30);
    // nearest STABLE same-domain category, not self, above threshold
    const target = hits.find((h) =>
      h.category.id !== src.id &&
      h.category.domain_id === src.domain_id &&
      (counts.get(h.category.id) || 0) > MAX_FACTS &&
      simOf(h.distance) >= SIM &&
      byId.has(h.category.id)
    );
    if (!target) continue;

    const n = counts.get(src.id) || 0;
    console.log(`  merge "${src.name}" (${n}f) → "${target.category.name}" sim=${simOf(target.distance).toFixed(3)} [${target.domainName}]`);
    if (!DRY_RUN) {
      const tx = db.transaction(() => {
        const moved = db.prepare('SELECT id FROM facts WHERE ontology_category_id = ? ORDER BY id').all(src.id).map((f) => f.id);
        const res = db.prepare('UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE ontology_category_id = ?')
          .run(target.category.id, new Date().toISOString(), src.id);
        reassigned += res.changes;
        db.prepare(`INSERT INTO category_merge_log (merged_at, source_id, source_name, target_id, target_name, domain, similarity, facts_reassigned, fact_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          new Date().toISOString(), src.id, src.name, target.category.id, target.category.name,
          target.domainName, simOf(target.distance), res.changes, JSON.stringify(moved));
        db.prepare('DELETE FROM ontology_categories WHERE id = ?').run(src.id);
        deleteCategoryEmbedding(db, src.id);
      });
      tx();
    }
    merged++;
  }

  const after = db.prepare('SELECT count(*) c FROM ontology_categories').get().c;
  console.log(`merge: done — merged ${merged} categories, reassigned ${reassigned} facts. categories ${before} → ${after}${DRY_RUN ? ' (dry-run, no change)' : ''}`);
} catch (e) {
  console.error('merge-singleton-categories failed:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  db.close();
}
