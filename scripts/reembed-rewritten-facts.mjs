#!/usr/bin/env node
/**
 * One-time repair: give facts whose sentence consolidation rewrote (≤1.7.9,
 * before it re-embedded rewritten sentences) the vector of the sentence they
 * hold now. See src/reembed-rewritten.ts for how a stale fact is found — it is
 * measured (the sentence is embedded again and compared with the stored
 * vector), so a fact whose vector already matches is never touched.
 *
 * The default is a DRY RUN on a read-only handle: it embeds the candidates'
 * sentences with the local model and reports how many are stale; it cannot
 * write. `--apply` writes, and must say what to do with fact_kr:
 *   --fact-kr clear   remove fact_kr and its Korean vector on every repaired
 *                     fact (it was written with the old sentence; what the
 *                     consolidator now does on a rewrite). Korean-side matching
 *                     for those facts is gone until scripts/translate-facts.mjs
 *                     (LLM) fills fact_kr again and the re-embed worker builds
 *                     the vector.
 *   --fact-kr keep    leave fact_kr and its vector as they are.
 * Before the first changed row, the old bytes of every changed row go into a
 * backup table in the same transaction (reembed_rewritten_backup_<UTC time>);
 * `--restore TABLE` puts them back. updated_at is never touched.
 *
 * Usage:
 *   node scripts/reembed-rewritten-facts.mjs [--db PATH] [--dry-run]
 *   node scripts/reembed-rewritten-facts.mjs [--db PATH] --apply --fact-kr clear|keep
 *   node scripts/reembed-rewritten-facts.mjs [--db PATH] --restore TABLE
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from '../dist/paths.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { parseCliArgs, assertOnlyArgs } from '../dist/cli-args.js';
import { checkRewrittenFacts, applyRewrittenFacts, restoreRewrittenFacts } from '../dist/reembed-rewritten.js';

ensureNativeAbi('reembed-rewritten-facts');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { values: ['--db', '--fact-kr', '--restore'], flags: ['--apply', '--dry-run'] });
  // Each mode rejects the other modes' arguments: `--restore T --dry-run` must not restore for real.
  if (args.values['--restore']) assertOnlyArgs(args, ['--restore', '--db'], '--restore (it has no preview)');
  else if (args.flags.has('--apply')) assertOnlyArgs(args, ['--apply', '--fact-kr', '--db'], '--apply');
  else assertOnlyArgs(args, ['--dry-run', '--db'], 'a dry run');
} catch (e) {
  fail(e.message);
}
const apply = args.flags.has('--apply');
const factKr = args.values['--fact-kr'];
if (apply && factKr !== 'clear' && factKr !== 'keep') {
  fail('--apply needs --fact-kr clear|keep (what to do with the Korean sentence of a repaired fact — see the header)');
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
    const r = restoreRewrittenFacts(db, restoreTable);
    console.log(`restored ${r.restored} facts from ${restoreTable} (${r.skippedChanged} left alone: their sentence changed since the backup)`);
  } else {
    let embedder;
    const embed = async (text) => {
      // Loaded on the first candidate: a database with nothing to check never loads the model.
      embedder ??= (await import('../dist/embeddings.js')).generateEmbedding;
      return embedder(text);
    };
    const check = await checkRewrittenFacts(db, embed);
    console.log(`candidates (active facts holding a revision's sentence): ${check.candidates}`);
    console.log(`  vector matches the sentence: ${check.current}`);
    console.log(`  stale (vector is another sentence's): ${check.stale.length} — ${check.stale.filter((s) => s.hasFactKr).length} of them have a fact_kr`);
    console.log(`  not checked: ${check.skippedNoEmbedding} without a stored embedding, ${check.skippedOldVersion} on an older embedding version (the re-embed worker rebuilds those)`);
    if (!apply) {
      console.log('dry run — nothing written. Re-run with --apply --fact-kr clear|keep to repair.');
    } else {
      const r = applyRewrittenFacts(db, check.stale, { factKr });
      console.log(`re-embedded ${r.reembedded} facts; fact_kr removed on ${r.factKrCleared}; ${r.changedSinceCheck} changed during the run and were left for the next one`);
      console.log(r.backupTable ? `backup table: ${r.backupTable} (undo: --restore ${r.backupTable})` : 'nothing changed — no backup table');
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
