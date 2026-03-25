#!/usr/bin/env node

/**
 * SessionEnd Hook: Export facts/ontology to sync/ folder for cross-device sync.
 * Runs after fact-extract-hook.
 */

import { exportForSync } from '../dist/sync-export.js';

try {
  const result = exportForSync();
  if (result.facts > 0) {
    console.log(`sync-export: ${result.facts} facts, ${result.domains} domains, ${result.relations} relations`);
  }
} catch (error) {
  // Non-fatal
  console.error('sync-export: Error:', error instanceof Error ? error.message : error);
  process.exit(0);
}
