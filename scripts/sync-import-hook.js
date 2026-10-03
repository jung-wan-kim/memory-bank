#!/usr/bin/env node

/**
 * SessionStart Hook: Import facts/ontology from sync/ folder (from other devices).
 * Runs before fact-consolidate-hook.
 */

import { importFromSync } from '../dist/sync-import.js';

async function main() {
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
    if (result.detachedCategoryRefs > 0) {
      console.error(`sync-import: ${result.detachedCategoryRefs} imported fact(s) referenced a category missing here — left unclassified for the ontology backfill`);
    }
  } catch (error) {
    // Non-fatal
    console.error('sync-import: Error:', error instanceof Error ? error.message : error);
    process.exit(0);
  }
}

main();
