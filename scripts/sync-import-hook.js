#!/usr/bin/env node

/**
 * SessionStart Hook: Import facts/ontology from sync/ folder (from other devices).
 * Runs before fact-consolidate-hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importFromSync } from '../dist/sync-import.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { getIndexDir } from '../dist/paths.js';

/** This hook runs async — its stderr goes nowhere — so failures also land in logs/sync-import.jsonl. */
function logFailure(entry) {
  try {
    const dir = path.join(getIndexDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync-import.jsonl');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('sync-import: cannot write log:', e instanceof Error ? e.message : e);
  }
}

async function main() {
  ensureNativeAbi('sync-import');
  try {
    const result = await importFromSync();
    if (result.newFacts > 0 || result.newDomains > 0) {
      console.log(`sync-import: +${result.newFacts} facts, +${result.newDomains} domains, +${result.newRelations} relations`);
    }
    if (result.rejectedJunk > 0) {
      // Not "new": the rows stay in the sync files until the exporting device
      // stops exporting them, so the same count can repeat every session.
      console.error(`sync-import: skipped ${result.rejectedJunk} template-residue row(s) present in the sync files`);
    }
    if (result.rejectedInstructionLike > 0) {
      // Text shaped like an instruction to the model (import-guard) is not imported as a "past decision".
      // Like the rows above it stays in the sync files, so this repeats until the line is removed there.
      console.error(`sync-import: refused ${result.rejectedInstructionLike} instruction-like fact(s) from the sync files: ${result.rejectedInstructionLikeSamples.join(', ')}`);
      logFailure({ action: 'refused-instruction-like', count: result.rejectedInstructionLike, samples: result.rejectedInstructionLikeSamples });
    }
    if (result.detachedCategoryRefs > 0) {
      console.error(`sync-import: ${result.detachedCategoryRefs} imported fact(s) referenced a category missing here — left unclassified for the ontology backfill`);
    }
    if (result.failedFacts > 0) {
      console.error(`sync-import: ${result.failedFacts} fact(s) failed to import — nothing was written for them; the next import retries`);
      logFailure({ action: 'partial', failed_facts: result.failedFacts, new_facts: result.newFacts, errors: result.failedFactErrors });
    }
  } catch (error) {
    // Non-fatal for the session, but recorded
    const msg = error instanceof Error ? error.message : String(error);
    console.error('sync-import: Error:', msg);
    logFailure({ action: 'failed', error: msg });
    process.exit(0);
  }
}

main();
