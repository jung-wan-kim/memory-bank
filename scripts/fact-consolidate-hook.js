#!/usr/bin/env node

/**
 * SessionStart Hook: Consolidate facts and inject context
 *
 * Environment:
 *   CWD / PROJECT_DIR - current project path
 *   LAST_CONSOLIDATED_AT - last consolidation time (default: 24h ago)
 */

import { initDatabase } from '../dist/db.js';
import { consolidateFacts } from '../dist/consolidator.js';
import { getTopFacts } from '../dist/fact-db.js';
import { getLastSessionContext, formatSessionContinuity } from '../dist/session-continuity.js';

async function main() {
  const project = process.env.CWD || process.env.PROJECT_DIR || process.cwd();
  const lastConsolidated = process.env.LAST_CONSOLIDATED_AT
    || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const db = initDatabase();

    // 1. Consolidate new facts
    const result = await consolidateFacts(db, project, lastConsolidated);
    if (result.processed > 0) {
      console.log(`fact-consolidate: ${result.processed} processed, ${result.merged} merged, ${result.contradictions} contradictions, ${result.evolutions} evolutions`);
    }

    // 2. Inject top facts as context
    const topFacts = getTopFacts(db, project, 10);
    if (topFacts.length > 0) {
      console.log('');
      console.log('# Project Key Facts (auto-recalled)');
      for (const fact of topFacts) {
        console.log(`- [${fact.category}] ${fact.fact} (${fact.consolidated_count}x confirmed)`);
      }
    }

    db.close();

    // 3. Inject last session context (for continuity)
    try {
      const lastSession = getLastSessionContext(project);
      if (lastSession) {
        console.log('');
        console.log(formatSessionContinuity(lastSession));
      }
    } catch {
      // Non-fatal: session continuity is best-effort
    }
  } catch (error) {
    console.error('fact-consolidate: Error:', error instanceof Error ? error.message : error);
    // Don't block session start on consolidation failure
    process.exit(0);
  }
}

main();
