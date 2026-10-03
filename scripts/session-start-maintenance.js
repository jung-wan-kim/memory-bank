#!/usr/bin/env node

/**
 * SessionStart maintenance — decides which resumable background workers to
 * spawn (re-embed, ontology backfill, extraction backfill).
 *
 * Split out of fact-consolidate-hook.js (2026-10-03): the three "is there
 * pending work?" probes took ~3.9s on the real DB (pendingEx 2.5s,
 * pendingExtract 0.85s, pendingFact 0.53s). The hook itself must now run
 * synchronously so its key-facts block reaches Claude Code, and Claude's first
 * response waits for SessionStart hooks to finish — so these probes run here,
 * in a detached process the hook spawns and never waits for.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { buildReembedPending } from '../dist/reembed-selector.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = initDatabase();
  try {
    const spawnDetached = (script) => {
      try {
        const child = spawn(process.execPath, [path.join(here, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env },
        });
        child.unref();
      } catch {
        // Non-fatal: background work resumes on a later session
      }
    };
    // 2a. Auto-resume vector upgrades: if any rows still carry old-model
    // embeddings, spawn the resumable re-embed worker (its pid lockfile
    // prevents concurrent runs, so spawning is safe to attempt every start).
    try {
      const { EMBEDDING_VERSION } = await import('../dist/embeddings.js');
      // Match BOTH of the worker's fact conditions (reembedFacts: stale version;
      // embedKoreanFacts: a fact_kr with no vec_facts_kr row) so a Korean-vector
      // backlog also auto-spawns the worker — the version-only check missed it,
      // the same coupling drift that hid the exchange missing-vector backlog.
      const pendingFact = db.prepare(`
        SELECT 1 FROM facts f WHERE f.is_active = 1 AND (
          f.embedding_version != ?
          OR (f.fact_kr IS NOT NULL AND f.fact_kr != ''
              AND NOT EXISTS (SELECT 1 FROM vec_facts_kr_rowids v WHERE v.id = f.id))
        ) LIMIT 1
      `).get(EMBEDDING_VERSION);
      // Match the WORKER's own selector exactly (single source: buildReembedPending)
      // so the spawn condition can't drift from what the worker actually processes.
      // The old version-only check missed the (b) MISSING-VECTOR backlog — rows
      // that claim the current version but have no vec_exchanges row — so the
      // re-embed worker was never auto-spawned to heal them across sessions
      // (measured: 100k+ such rows sat undrained until manually kicked). It also
      // excludes worker-prompt pollution, so a pure-pollution DB won't spin the
      // worker up forever.
      const { clause, params } = buildReembedPending(EMBEDDING_VERSION);
      const pendingEx = db.prepare(`SELECT 1 FROM exchanges e WHERE ${clause} LIMIT 1`).get(...params);
      if (pendingFact || pendingEx) spawnDetached('reembed-worker.js');
    } catch {
      // Non-fatal: re-embedding resumes on a later session
    }

    // 2b. Auto-resume ontology classification backfill (historic facts saved
    // without classification).
    try {
      const pendingOnto = db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL LIMIT 1'
      ).get();
      if (pendingOnto) spawnDetached('backfill-ontology-worker.js');
    } catch { /* non-fatal */ }

    // 2c. Auto-resume cross-project extraction backfill (sessions that ended
    // before the fixed SessionEnd hook existed).
    try {
      // Match the WORKER's exact pending-session predicate (single source:
      // pendingExtractionCoreQuery) — the old bare NOT-IN-extraction_log check
      // over-counted by 508 (sessions below MIN_EXCHANGES + memory-bank-llm
      // pollution that the worker permanently skips), so it spawned the worker
      // on EVERY session start for phantom work it could never clear.
      const { sql: exSql, params: exParams } = pendingExtractionCoreQuery(getExtractionConfig());
      const pendingExtract = db.prepare(`SELECT 1 FROM (${exSql}) LIMIT 1`).get(...exParams);
      if (pendingExtract) spawnDetached('backfill-extract-worker.js');
    } catch { /* non-fatal */ }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  // stdio is ignored by the spawning hook — this only shows on a manual run.
  console.error('session-start-maintenance:', error instanceof Error ? error.message : error);
});
