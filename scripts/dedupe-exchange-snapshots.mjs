#!/usr/bin/env node

/**
 * One-time cleanup: remove duplicate snapshots of a conversation turn.
 *
 * A turn indexed while its answer was still being written used to be indexed
 * again under a new id on every later sync, leaving the shorter snapshots
 * behind (measured on one index: 11,981 extra rows, up to 102 for one turn).
 * Indexing no longer does that (insertExchange replaces the older snapshot);
 * this removes the rows that are already there. For each
 * (archive_path, line_start) the row with the largest line_end stays, and
 * facts whose source_exchange_ids name a removed row are pointed at it.
 *
 * Safety model:
 *   - DRY-RUN BY DEFAULT: prints what would change. The database is opened
 *     READ-ONLY (no migration, no write). Pass --apply to change it.
 *   - STRICT ARGUMENTS: an unknown or repeated flag stops the run.
 *   - BACKUP FIRST: on --apply the rows to delete (exchanges + tool_calls),
 *     the id map and the affected facts' original source_exchange_ids are
 *     written to <index dir>/backups/dedupe-snapshots-<timestamp>.sqlite and
 *     counted before anything is changed.
 *   - Facts are re-pointed before the rows are deleted; rows go in batches
 *     (2,000 rows or 400ms, whichever comes first, with a pause in between —
 *     deleteExchanges, src/db.ts). An interrupted run is finished by running
 *     it again.
 *   - CLOSE THE OTHER CLAUDE CODE SESSIONS before --apply. The backup reads a
 *     snapshot and the deletes leave gaps, so another process still gets the
 *     write lock (measured on a copy of a live DB, 11,982 rows removed: no
 *     failed lock wait, the longest 1.4s) — but a session that indexes while
 *     this runs can write duplicate rows the run did not see: it then ends
 *     with "duplicate rows remain … run again" and exit 1. (The dry run only
 *     reads.)
 *
 * --create-index (with --apply) also builds the (archive_path, line_start)
 * index that new databases get at creation. On a large index this reads the
 * whole exchanges table under the write lock (measured scans of a 10GB DB:
 * 23s to 6 minutes) — other processes get SQLITE_BUSY meanwhile. Run it when
 * nothing else is using the database.
 *
 * Finding the duplicates reads the whole exchanges table too (dry run included).
 *
 * Usage:
 *   node scripts/dedupe-exchange-snapshots.mjs                         # dry-run
 *   node scripts/dedupe-exchange-snapshots.mjs --apply                 # backup + re-point facts + delete
 *   node scripts/dedupe-exchange-snapshots.mjs --apply --create-index  # … and build the index
 */

import { initDatabase, openReadOnlyDatabase, createExchangeTurnIndex, EXCHANGE_TURN_INDEX } from '../dist/db.js';
import { planSnapshotDedupe, applySnapshotDedupe } from '../dist/snapshot-dedupe.js';
import { newBackupPath } from '../dist/row-backup.js';
import { parseCliArgs } from '../dist/cli-args.js';

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { flags: ['--apply', '--create-index'] });
} catch (e) {
  console.error(`dedupe-exchange-snapshots: ${e.message}`);
  console.error('usage: dedupe-exchange-snapshots.mjs [--apply [--create-index]]');
  console.error('       (no --apply = dry run; close the other Claude Code sessions before --apply)');
  process.exit(1);
}
const apply = args.flags.has('--apply');
const createIndex = args.flags.has('--create-index');
if (createIndex && !apply) {
  console.error('dedupe-exchange-snapshots: --create-index changes the database — it needs --apply');
  process.exit(1);
}

function printPlan(plan) {
  console.log(`turns with more than one row: ${plan.turns} (in ${plan.files} files, up to ${plan.maxRowsPerTurn} rows for one turn)`);
  console.log(`rows to remove: ${plan.extraRows}`);
  console.log(`facts to re-point at the remaining row: ${plan.factsToRewrite}`);
  if (plan.factsWithInvalidSources > 0) {
    console.log(`facts whose source_exchange_ids is not valid JSON (left alone): ${plan.factsWithInvalidSources}`);
  }
}

function main() {
  const db = apply ? initDatabase() : openReadOnlyDatabase();
  if (!db) {
    console.log('no database yet — nothing to do.');
    return;
  }
  try {
    const hasIndex = () => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(EXCHANGE_TURN_INDEX) !== undefined;
    if (!apply) {
      printPlan(planSnapshotDedupe(db));
      console.log(`${EXCHANGE_TURN_INDEX}: ${hasIndex() ? 'present' : 'absent (--apply --create-index builds it)'}`);
      console.log('\nDRY-RUN (no changes made). Re-run with --apply to backup + re-point facts + delete.');
      console.log('Close the other Claude Code sessions before --apply: a session that indexes meanwhile can leave duplicate rows this run does not see (it then asks to be run again).');
      return;
    }

    const result = applySnapshotDedupe(db, newBackupPath('dedupe-snapshots'));
    printPlan(result.plan);
    if (result.backupPath) {
      console.log(`\nbackup: ${result.backupPath}`);
      console.log(`re-pointed ${result.rewrittenFacts} facts, deleted ${result.deletedRows} rows; duplicate rows left: ${result.remainingExtraRows}`);
    } else {
      console.log('\nnothing to remove — every turn has one row.');
    }
    if (result.remainingExtraRows !== 0) {
      process.exitCode = 1;
      console.error('WARNING: duplicate rows remain (written by another process meanwhile?) — run again.');
    }

    if (createIndex) {
      if (hasIndex()) {
        console.log(`${EXCHANGE_TURN_INDEX}: already present`);
      } else {
        const t0 = Date.now();
        createExchangeTurnIndex(db);
        console.log(`${EXCHANGE_TURN_INDEX}: built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  } finally {
    db.close();
  }
}

main();
