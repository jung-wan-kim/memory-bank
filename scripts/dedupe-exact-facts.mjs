#!/usr/bin/env node
/**
 * One-time cleanup: merge active facts of one scope whose sentences are equal
 * after collapsing whitespace and case (src/dedupe-exact-facts.ts). No LLM, no
 * embedding model. The oldest fact of each group stays, the rest are
 * deactivated (history is kept; nothing is deleted).
 *
 * The default is a DRY RUN on a read-only handle: it reports the groups and
 * cannot write. `--apply` writes, and must say what happens to the counts:
 *   --counts sum    the survivor takes the removed facts' confirmations
 *                   (what consolidation does for a DUPLICATE). The largest
 *                   groups are session boilerplate; summed, exactly those rise
 *                   to the top of the session-start facts.
 *   --counts keep   the survivor keeps its own count.
 * Sources are united either way. Ontology relations of a deactivated fact are
 * not re-pointed. Every changed row is copied into a backup table in the same
 * transaction (dedupe_exact_backup_<UTC time>); `--restore TABLE` undoes it.
 * Deactivations flow to the cloud plane on its next sync like any other.
 *
 * Usage:
 *   node scripts/dedupe-exact-facts.mjs [--db PATH] [--dry-run] [--list]
 *   node scripts/dedupe-exact-facts.mjs [--db PATH] --apply --counts sum|keep
 *   node scripts/dedupe-exact-facts.mjs [--db PATH] --restore TABLE
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from '../dist/paths.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { parseCliArgs, assertOnlyArgs } from '../dist/cli-args.js';
import { findExactDuplicateGroups, applyExactDedupe, restoreExactDedupe } from '../dist/dedupe-exact-facts.js';

ensureNativeAbi('dedupe-exact-facts');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { values: ['--db', '--counts', '--restore'], flags: ['--apply', '--dry-run', '--list'] });
  // Each mode rejects the other modes' arguments: `--restore T --dry-run` must not restore for real.
  if (args.values['--restore']) assertOnlyArgs(args, ['--restore', '--db'], '--restore (it has no preview)');
  else if (args.flags.has('--apply')) assertOnlyArgs(args, ['--apply', '--counts', '--db'], '--apply');
  else assertOnlyArgs(args, ['--dry-run', '--list', '--db'], 'a dry run');
} catch (e) {
  fail(e.message);
}
const apply = args.flags.has('--apply');
const counts = args.values['--counts'];
if (apply && counts !== 'sum' && counts !== 'keep') {
  fail('--apply needs --counts sum|keep (whether the surviving fact takes the removed facts\' confirmations — see the header)');
}
const dbPath = args.values['--db'] || process.env.MEMORY_BANK_DB_PATH || path.join(getIndexDir(), 'db.sqlite');
if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}`);

const restoreTable = args.values['--restore'];
// A dry run opens the database read-only: it cannot write, whatever the code below does.
const db = new Database(dbPath, apply || restoreTable ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
sqliteVec.load(db);
db.pragma('busy_timeout = 15000');
try {
  console.log('db:', dbPath);
  if (restoreTable) {
    const r = restoreExactDedupe(db, restoreTable);
    console.log(`reactivated ${r.reactivated} facts, restored ${r.survivorsRestored} survivors from ${restoreTable} (${r.skippedChanged} left alone: changed since the cleanup)`);
  } else {
    const groups = findExactDuplicateGroups(db);
    const redundant = groups.reduce((s, g) => s + g.removedIds.length, 0);
    const sizes = groups.map((g) => g.removedIds.length + 1).sort((a, b) => b - a);
    console.log(`exact-duplicate groups (same scope, same sentence): ${groups.length}`);
    console.log(`  facts in those groups: ${redundant + groups.length} — ${redundant} would be deactivated, ${groups.length} stay`);
    console.log(`  largest groups: ${sizes.slice(0, 10).join(', ') || '-'}`);
    if (args.flags.has('--list')) {
      for (const g of [...groups].sort((a, b) => b.removedIds.length - a.removedIds.length)) {
        console.log(`  ${g.removedIds.length + 1}× keep ${g.survivorId} [${g.scopeType}${g.scopeProject ? ` ${g.scopeProject}` : ''}] ${g.sentenceKey.slice(0, 80)}`);
      }
    }
    if (!apply) {
      console.log('dry run — nothing written. Re-run with --apply --counts sum|keep to merge.');
    } else {
      const r = applyExactDedupe(db, groups, { counts });
      console.log(`merged ${r.groups} groups, deactivated ${r.deactivated} facts; ${r.groupsChangedSinceCheck} groups changed during the run and were left alone`);
      console.log(r.backupTable ? `backup table: ${r.backupTable} (undo: --restore ${r.backupTable})` : 'nothing changed — no backup table');
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
