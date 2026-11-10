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
 *   - Deletes run in batches, each one transaction: a batch ends at 2,000
 *     rows or after 400ms, whichever comes first, and the next one starts
 *     after a pause, so other processes get the write lock in between
 *     (deleteExchanges, src/db.ts). tool_calls are deleted explicitly (the
 *     schema this code creates has no ON DELETE CASCADE on them).
 *   - CLOSE THE OTHER CLAUDE CODE SESSIONS before --apply. The backup step
 *     still copies under the write lock, in one transaction: for a large
 *     purge that is longer than the 5s every other process waits, and a
 *     session's hook, worker or MCP server fails with "database is
 *     locked" meanwhile. (The dry run only reads; it needs no such care.)
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
import { initDatabase, openReadOnlyDatabase, deleteExchanges } from '../dist/db.js';
import { getIndexDir } from '../dist/paths.js';
import { buildPollutionWhere, countPurgeLeftovers, PURGE_WORKLIST_TABLE } from '../dist/pollution-predicate.js';
import { parseCliArgs } from '../dist/cli-args.js';

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { flags: ['--apply', '--legacy-prompts', '--warmup', '--observer'] });
} catch (e) {
  console.error(`purge-llm-sessions: ${e.message}`);
  console.error('usage: purge-llm-sessions.mjs [--legacy-prompts] [--warmup] [--observer] [--apply]');
  console.error('       (no --apply = dry run; close the other Claude Code sessions before --apply)');
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
      console.log('Close the other Claude Code sessions before --apply: the backup copies under the write lock, and their writes fail with "database is locked" while it runs.');
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

    // --- Delete in BATCHED transactions: deleteExchanges (src/db.ts), the same
    // loop the snapshot dedupe and --prune-missing use. A batch ends at 2,000
    // ids or after DELETE_BATCH_MAX_MS, whichever comes first, and the next one
    // starts after a pause, so a session-start hook, a worker or an MCP server
    // waiting for the write lock gets it in between. This script's own loop
    // was bounded by row count only: 2,000 rows, each an FTS delete and a vec0
    // delete, held the lock past the 5s other processes wait, batch after
    // batch (measured on a copy of a live DB: 25 failed lock waits in one purge).
    // The row limit stays: one giant transaction deleting 50K+ vec0 rows trips
    // SQLITE_CORRUPT_VTAB in the extension's chunk bookkeeping (observed live
    // at ~54K). A crash between batches leaves a partial purge — harmless: the
    // run is idempotent (predicate-driven) and the NEXT run resumes where this
    // one stopped, while the up-front backup already holds every row.
    // Order inside a batch, per id: tool_calls, vector, exchange (FTS triggers
    // keep exchanges_fts in sync).
    let reported = 0;
    deleteExchanges(db, ids, 2000, {
      onBatch: (deleted) => {
        // One line per 10,000 rows, and one when the last batch is in.
        if (deleted === ids.length || Math.floor(deleted / 10000) > Math.floor(reported / 10000)) {
          console.log(`  deleted ${deleted}/${ids.length}`);
        }
        reported = deleted;
      },
    });

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
