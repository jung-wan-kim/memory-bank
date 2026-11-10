#!/usr/bin/env node

/**
 * SessionEnd Hook: Export facts/ontology to sync/ folder for cross-device sync.
 * Runs after fact-extract-hook.
 */

import { exportForSync } from '../dist/sync-export.js';
import { ensureNativeAbi } from '../dist/node-abi.js';

ensureNativeAbi('sync-export');

try {
  const result = exportForSync();
  if (result.written.length === 0) {
    // Nothing changed since the last export — no file was rewritten (sync-export.ts).
    console.log(`sync-export: unchanged (${result.facts} facts) — nothing written`);
  } else if (result.facts > 0) {
    console.log(`sync-export: ${result.facts} facts, ${result.domains} domains, ${result.relations} relations (wrote ${result.written.join(', ')})`);
  }
} catch (error) {
  // Non-fatal
  console.error('sync-export: Error:', error instanceof Error ? error.message : error);
  process.exit(0);
}
