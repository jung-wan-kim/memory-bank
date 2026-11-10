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
  // Active facts the export left out because an import refuses them (credential-shaped, session-environment
  // boilerplate, instruction-like — sync-export.ts). The module says so on stderr only when the export changed;
  // this line is what the user sees every time. Nothing is added when nothing was left out.
  const leftOut = result.withheld > 0
    ? `; left out ${result.withheld} active fact(s) an import refuses (by reason: withheld_facts in sync/meta.json)`
    : '';
  if (result.written.length === 0) {
    // Nothing changed since the last export — no file was rewritten (sync-export.ts).
    console.log(`sync-export: unchanged (${result.facts} facts) — nothing written${leftOut}`);
  } else if (result.facts > 0 || result.withheld > 0) {
    // (0 facts exported because every active one was left out is still worth a line)
    console.log(`sync-export: ${result.facts} facts, ${result.domains} domains, ${result.relations} relations (wrote ${result.written.join(', ')})${leftOut}`);
  }
} catch (error) {
  // Non-fatal
  console.error('sync-export: Error:', error instanceof Error ? error.message : error);
  process.exit(0);
}
