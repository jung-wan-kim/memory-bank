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
 * write. `--apply` writes, and must say what to do with fact_kr (there is no
 * default — the choice is always typed):
 *   --fact-kr keep    leave fact_kr and its Korean vector as they are. THE ONE
 *                     TO USE unless a translation run follows: the Korean
 *                     sentence was written for the old sentence, but it is what
 *                     a Korean query still finds the fact by.
 *   --fact-kr clear   remove fact_kr and its Korean vector on every repaired
 *                     fact (they describe the old sentence). Only when
 *                     scripts/translate-facts.mjs (LLM calls, run by hand) is
 *                     run next — what comes back by itself is a part: the
 *                     run ends by restoring a Korean sentence only where a
 *                     merged, deactivated fact still holds one for the same
 *                     sentence (src/fact-kr-restore.ts, no LLM — the pass the
 *                     consolidation worker runs once per plugin version, done
 *                     here because the worker's is usually over by now).
 *                     Measured on a copy of a live DB after `clear`: of 624
 *                     rewritten active facts left without a Korean sentence it
 *                     restored 71; the 436 whose sentence is English only have
 *                     no Korean vector until they are translated.
 * Before the first changed row, the old bytes of every changed row go into a
 * backup table in the same transaction (reembed_rewritten_backup_<UTC time>);
 * `--restore TABLE` puts them back. updated_at is never touched.
 *
 * Usage:
 *   node scripts/reembed-rewritten-facts.mjs [--db PATH] [--dry-run]
 *   node scripts/reembed-rewritten-facts.mjs [--db PATH] --apply --fact-kr keep|clear
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
import { restoreKoreanToEnd } from '../dist/fact-kr-restore.js';

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
  fail('--apply needs --fact-kr clear|keep (what to do with the Korean sentence of a repaired fact): '
    + 'keep leaves it and is the one to use unless you run scripts/translate-facts.mjs next; '
    + 'clear removes it, and only part of the removed sentences comes back without that translation run — see the header');
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
      console.log('dry run — nothing written. Re-run with --apply --fact-kr keep to repair (keep: the Korean sentences stay as they are).');
      console.log('--fact-kr clear removes them instead; use it only when scripts/translate-facts.mjs (LLM calls, run by hand) is run next — '
        + 'without it only part of them comes back (the run ends by restoring those a merged fact still holds), see the header.');
    } else {
      const r = applyRewrittenFacts(db, check.stale, { factKr });
      console.log(`re-embedded ${r.reembedded} facts; fact_kr removed on ${r.factKrCleared}; ${r.changedSinceCheck} changed during the run and were left for the next one`);
      console.log(r.backupTable ? `backup table: ${r.backupTable} (undo: --restore ${r.backupTable})` : 'nothing changed — no backup table');
      if (factKr === 'clear') {
        // The Korean sentences that exist for the new sentences come back here (fact-kr-restore.ts, no LLM).
        // The consolidation worker runs the same pass once per plugin version, and that pass is usually over
        // before this script is run — left to it, none of the facts cleared above got theirs back. It runs
        // on every `--apply --fact-kr clear`, also when nothing was stale: running the command again is how
        // a restore that failed is repeated.
        try {
          const k = await restoreKoreanToEnd(db, embed);
          console.log(`fact_kr restored on ${k.restored} of ${k.candidates} rewritten facts without a Korean sentence `
            + '(from the merged fact that holds the same sentence, no LLM); '
            + `the other ${k.candidates - k.restored} have none until scripts/translate-facts.mjs translates them`);
        } catch (e) {
          console.error(`fact_kr restore failed (${e instanceof Error ? e.message : e}) — what is reported above is written; `
            + 'run the same command again to repeat the restore');
          process.exitCode = 1;
        }
      }
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
