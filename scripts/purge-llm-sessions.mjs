#!/usr/bin/env node

/**
 * One-time cleanup for exchanges that should never have been indexed. The
 * indexing guards stop NEW ones (`isExcludedProject`, `shouldIndexExchange`);
 * rows indexed before a guard existed remain in the exchanges table, the FTS
 * index and the vec_exchanges vector index, polluting both text and semantic
 * search. This script removes them.
 *
 * Pollution families:
 *   1. SLUG (always): project slug ends with `-memory-bank-llm` — the plugin's
 *      own worker sessions after the fixed-workdir change but before indexing
 *      exclusion. Measured locally: 14,287 exchanges.
 *   2. LEGACY-PROMPT (--legacy-prompts): worker sessions from BEFORE the fixed
 *      workdir existed — the Agent SDK query() ran with the CALLER project's
 *      cwd, so their transcripts were indexed under REAL project slugs and
 *      cannot be identified by slug at all. Identified instead by the exact
 *      leading text of the worker system prompts (versioned in src/).
 *      Measured locally: 59,940 exchanges (~16% of the corpus).
 *   3. WARMUP (--warmup): the agent warm-up turn — a sidechain exchange whose
 *      user message is exactly `Warmup`. Measured on one index 2026-11-10:
 *      150,715 exchanges (44.1%).
 *   4. OBSERVER (--observer): another memory plugin's observer sessions — user
 *      message starting with `<observed_from_primary_session>`. Measured on
 *      the same index: 131,638 exchanges (38.5%).
 *   Families 3-4 are the SQL twin of isNoiseExchange (src/noise.ts).
 *
 * NOT done here: facts extracted from purged exchanges keep the purged ids in
 * source_exchange_ids (measured: 5,522 facts point at warm-up / observer rows).
 * `trace_fact` on such a fact finds no exchange for those ids. Decide what to
 * do with those facts before purging families 3-4.
 *
 * Safety model:
 *   - DRY-RUN BY DEFAULT: prints what would be deleted. Pass --apply to mutate.
 *     A dry run opens the database READ-ONLY (no migration, no heal, no write).
 *   - STRICT ARGUMENTS: an unknown or repeated flag stops the run (a typo of
 *     --apply must not look like a dry run that "found nothing to do", and a
 *     typo of a family flag must not purge fewer families than intended).
 *   - BACKUP FIRST: on --apply, the polluted exchanges + tool_calls rows are
 *     copied into `<index dir>/purge-llm-backup.sqlite` before any delete runs,
 *     and the copy is verified against the worklist. The file is APPENDED to
 *     (rows already in it are kept, never overwritten) — a re-run after an
 *     interrupted purge used to write a second full copy. Embeddings are not
 *     backed up — regenerable from the exchange text.
 *   - Slug discriminator matches isExcludedProject exactly (slug ending
 *     `-memory-bank-llm`). Prompt discriminators are exact multi-word template
 *     leads (≥49 chars) — a real human message starting with the verbatim
 *     template text is vanishingly rare, and the backup covers even that.
 *   - Deletes run in batches of 2,000, each one transaction; tool_calls are
 *     deleted explicitly (the schema this code creates has no ON DELETE
 *     CASCADE on them).
 *   - AFTER: the worklist ids are looked up again in exchanges, tool_calls and
 *     the vector index; anything left is reported and the exit code is 1.
 *
 * Usage:
 *   node scripts/purge-llm-sessions.mjs                            # dry-run, slug family
 *   node scripts/purge-llm-sessions.mjs --apply                    # backup + delete, slug family
 *   node scripts/purge-llm-sessions.mjs --legacy-prompts           # dry-run, slug + worker prompts
 *   node scripts/purge-llm-sessions.mjs --warmup --observer        # dry-run, slug + machine noise
 *   node scripts/purge-llm-sessions.mjs --warmup --observer --apply
 */

import path from 'node:path';
import { initDatabase, openReadOnlyDatabase } from '../dist/db.js';
import { getIndexDir } from '../dist/paths.js';
import { buildPollutionWhere, countPurgeLeftovers, PURGE_WORKLIST_TABLE } from '../dist/pollution-predicate.js';
import { parseCliArgs } from '../dist/cli-args.js';

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { flags: ['--apply', '--legacy-prompts', '--warmup', '--observer'] });
} catch (e) {
  console.error(`purge-llm-sessions: ${e.message}`);
  console.error('usage: purge-llm-sessions.mjs [--legacy-prompts] [--warmup] [--observer] [--apply]');
  process.exit(1);
}
const apply = args.flags.has('--apply');
const families = {
  legacyPrompts: args.flags.has('--legacy-prompts'),
  warmup: args.flags.has('--warmup'),
  observer: args.flags.has('--observer'),
};

function main() {
  // A dry run must not change the database it reports on: initDatabase() runs
  // migrations, a dedup DELETE and the scope heal on every open.
  const db = apply ? initDatabase() : openReadOnlyDatabase();
  if (!db) {
    console.log('no database yet — nothing to purge.');
    return;
  }
  try {
    // Build the pollution predicate once (shared src helper, canonical prefixes);
    // every count / backup / delete below uses the SAME (where, params) so they
    // can never diverge.
    const { where, params } = buildPollutionWhere(families);

    const counts = {
      exchanges: db.prepare(`SELECT count(*) AS n FROM exchanges WHERE ${where}`).get(...params).n,
      toolCalls: db.prepare(
        `SELECT count(*) AS n FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE ${where})`
      ).get(...params).n,
      vectors: db.prepare(
        `SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE ${where})`
      ).get(...params).n,
    };

    const names = ['slug', families.legacyPrompts && 'legacy-prompts', families.warmup && 'warmup', families.observer && 'observer'].filter(Boolean);
    console.log(`families: ${names.join(' + ')}`);
    console.log(`polluted exchanges: ${counts.exchanges}`);
    console.log(`polluted tool_calls: ${counts.toolCalls}`);
    console.log(`polluted vectors:    ${counts.vectors}`);

    if (counts.exchanges === 0 && counts.vectors === 0) {
      console.log('nothing to purge — index is clean.');
      return;
    }
    if (!apply) {
      console.log('\nDRY-RUN (no changes made). Re-run with --apply to backup + delete.');
      return;
    }

    // --- Backup first (reversibility): append full rows to the backup DB.
    // Its own IMMEDIATE transaction (write lock up front — a deferred BEGIN
    // would start as a reader and the later lock upgrade dies with
    // SQLITE_BUSY_SNAPSHOT whenever a concurrent worker commits in between). ---
    const backupPath = path.join(getIndexDir(), 'purge-llm-backup.sqlite');
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${PURGE_WORKLIST_TABLE} (id TEXT PRIMARY KEY)`);
    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS bak`);
    let ids;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        // The id worklist is captured in the SAME transaction as the backup so
        // the two can never diverge; deletes below run off this exact list.
        db.exec(`DELETE FROM temp.${PURGE_WORKLIST_TABLE}`);
        db.prepare(`INSERT INTO temp.${PURGE_WORKLIST_TABLE} (id) SELECT id FROM main.exchanges WHERE ${where}`).run(...params);
        ids = db.prepare(`SELECT id FROM temp.${PURGE_WORKLIST_TABLE}`).all().map((r) => r.id);

        // Append: tables are created on the first run, and a row already in the
        // file (an earlier, interrupted run) is kept as it is. A backup whose
        // tables no longer match the live schema fails here, loudly — move the
        // old file aside and run again.
        db.exec('CREATE TABLE IF NOT EXISTS bak.exchanges AS SELECT * FROM main.exchanges WHERE 0');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bak.purge_backup_exchanges_id ON exchanges(id)');
        db.exec('CREATE TABLE IF NOT EXISTS bak.tool_calls AS SELECT * FROM main.tool_calls WHERE 0');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bak.purge_backup_tool_calls_id ON tool_calls(id)');
        db.exec(`INSERT OR IGNORE INTO bak.exchanges SELECT * FROM main.exchanges WHERE id IN (SELECT id FROM temp.${PURGE_WORKLIST_TABLE})`);
        db.exec(`INSERT OR IGNORE INTO bak.tool_calls SELECT * FROM main.tool_calls WHERE exchange_id IN (SELECT id FROM temp.${PURGE_WORKLIST_TABLE})`);

        // Verify the backup holds every row BEFORE any delete runs.
        const missingEx = db.prepare(
          `SELECT count(*) AS n FROM temp.${PURGE_WORKLIST_TABLE} p WHERE NOT EXISTS (SELECT 1 FROM bak.exchanges b WHERE b.id = p.id)`
        ).get().n;
        const missingTc = db.prepare(
          `SELECT count(*) AS n FROM main.tool_calls t WHERE t.exchange_id IN (SELECT id FROM temp.${PURGE_WORKLIST_TABLE})
             AND NOT EXISTS (SELECT 1 FROM bak.tool_calls b WHERE b.id = t.id)`
        ).get().n;
        if (missingEx !== 0 || missingTc !== 0) {
          throw new Error(`backup is missing rows: exchanges ${missingEx}, tool_calls ${missingTc}`);
        }
        db.exec('COMMIT');
      } catch (e) {
        // The file may hold rows of earlier runs — it is never removed here.
        db.exec('ROLLBACK');
        throw new Error(`backup failed, nothing was deleted (${backupPath}): ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      try { db.exec('DETACH DATABASE bak'); } catch { /* already detached on error paths */ }
    }
    console.log(`backed up ${ids.length} exchanges to ${backupPath}`);

    // --- Delete in BATCHED transactions (2K ids each). One giant transaction
    // deleting 50K+ vec0 rows trips SQLITE_CORRUPT_VTAB in the extension's
    // chunk bookkeeping (observed live at ~54K); small batches are safe. A
    // crash between batches leaves a partial purge — harmless: the run is
    // idempotent (predicate-driven) and the NEXT run resumes where this one
    // stopped, while the up-front backup already holds every row.
    // Order inside a batch: vec rows (per-id — vec0 takes no subqueries),
    // tool_calls, then exchanges (FTS triggers keep exchanges_fts in sync).
    const BATCH = 2000;
    const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
    const delTc = db.prepare('DELETE FROM tool_calls WHERE exchange_id = ?');
    const delEx = db.prepare('DELETE FROM exchanges WHERE id = ?');
    const delBatch = db.transaction((chunk) => {
      for (const id of chunk) { delVec.run(id); delTc.run(id); delEx.run(id); }
    });
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      delBatch.immediate(ids.slice(i, i + BATCH));
      deleted += Math.min(BATCH, ids.length - i);
      if (deleted % 10000 < BATCH) console.log(`  deleted ${deleted}/${ids.length}`);
    }

    // --- Post-verify against the worklist: everything gone ---
    const left = countPurgeLeftovers(db);
    console.log(`\npurged. left of the ${ids.length} worklist ids — exchanges: ${left.exchanges}, tool_calls: ${left.toolCalls}, vectors: ${left.vectors}`);
    console.log(`backup: ${backupPath}`);
    if (left.exchanges !== 0 || left.toolCalls !== 0 || left.vectors !== 0) {
      process.exitCode = 1;
      console.error('WARNING: purge incomplete — inspect manually.');
    }
  } finally {
    db.close();
  }
}

main();
