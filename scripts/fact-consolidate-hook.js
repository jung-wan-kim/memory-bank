#!/usr/bin/env node

/**
 * SessionStart Hook: Consolidate facts and inject context.
 *
 * Claude Code passes hook input as JSON on stdin:
 *   { "session_id": "...", "cwd": "...", "hook_event_name": "SessionStart", ... }
 *
 * Env vars (CWD / PROJECT_DIR / LAST_CONSOLIDATED_AT) remain as fallback
 * for manual invocation.
 *
 * The hook is registered WITHOUT `async` (hooks/hooks.json). Claude Code adds a
 * SessionStart hook's plain stdout to the session only when the hook runs
 * synchronously — while it was `async: true` the key-facts block reached Codex
 * (whose wrapper reads stdout) but never Claude Code (verified 2026-10-03).
 * Synchronous means Claude's first response waits for this process, so:
 *  - it reads through a READ-ONLY handle (openReadOnlyDatabase): no migrations,
 *    no write lock, never queued behind the workers below;
 *  - its imports stay light — no embedding model (embedding-version.ts split);
 *  - it reads and prints FIRST, then starts every slow step as a detached child
 *    it never waits for:
 *     - fact-consolidate-worker.js — LLM-based consolidation
 *     - session-start-maintenance.js — pending-work probes (~3.9s) that decide
 *       whether to resume the re-embed / ontology / extraction backfill workers
 * Measured 2026-10-03: ~0.17s wall per run (fresh node process, warm cache).
 * hooks.json caps it at 5s (~30x that) — a bound on how long a cold or wedged
 * start can hold the first response, at the cost of that session's key facts.
 *
 * The printed facts are recorded in the session's injection ledger, so the
 * per-prompt injection does not repeat a fact this block already showed.
 *
 * Session continuity and the intent profile are opt-in
 * (MEMORY_BANK_SESSION_CONTINUITY=1, MEMORY_BANK_INTENT_PROFILE=1). They compared
 * the absolute cwd against exchanges' slug column and so never printed anything;
 * with that fixed, the intent profile costs ~3s on large projects and its
 * "frequent tools" are historical (a since-banned browser plugin topped the list),
 * so neither turns on until its value is measured.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openReadOnlyDatabase } from '../dist/db.js';
import { getTopFacts } from '../dist/fact-db.js';
import { factTextKey, truncateFact } from '../dist/fact-text.js';
import { loadLedger, appendLedger } from '../dist/inject-ledger.js';

/** Upper bound for the whole block (10 facts × 160 chars cap ≈ 1,700 worst case). */
const BLOCK_CHAR_BUDGET = 1500;

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* not JSON — fall back to env */ }

  const project = input.cwd || process.env.CWD || process.env.PROJECT_DIR || process.cwd();

  try {
    // 1. Key facts — read-only, before any worker is started (header). A read
    //    failure is reported on stderr and must not stop the workers below.
    try {
      const db = openReadOnlyDatabase();
      const shown = [];
      if (db) try {
        const lines = [];
        let chars = 0;
        for (const fact of getTopFacts(db, project, 10)) {
          const line = `- [${fact.category}] ${truncateFact(fact.fact)} (${fact.consolidated_count}x confirmed)`;
          if (chars + line.length > BLOCK_CHAR_BUDGET) break;
          lines.push(line);
          shown.push(fact);
          chars += line.length + 1;
        }
        if (lines.length > 0) {
          console.log('');
          console.log('# Project Key Facts (auto-recalled)');
          for (const line of lines) console.log(line);
        }
      } finally {
        db.close();
      }
      // Same keys the per-prompt injection dedups on (id + text) — see header.
      if (shown.length > 0 && input.session_id) {
        appendLedger(input.session_id, loadLedger(input.session_id),
          shown.flatMap((f) => [f.id, factTextKey(f)]));
      }
    } catch (error) {
      console.error('fact-consolidate: key facts unavailable:', error instanceof Error ? error.message : error);
    }

    // 2. Offload slow work to detached children this hook never waits for:
    //    LLM consolidation, and the pending-work probes for backfill workers.
    //    MEMORY_BANK_SESSION_START_SPAWN=0 skips them (tests run this hook for
    //    its output and must not start LLM workers against a fixture DB).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const spawnWorkers = process.env.MEMORY_BANK_SESSION_START_SPAWN !== '0';
    for (const [script, env] of !spawnWorkers ? [] : [
      ['fact-consolidate-worker.js', { ...process.env, CWD: project }],
      ['session-start-maintenance.js', { ...process.env }],
    ]) {
      try {
        const child = spawn(process.execPath, [path.join(here, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env,
        });
        child.unref();
      } catch {
        // Non-fatal: background work resumes on a later session
      }
    }

    // 3. Last session context (for continuity) — opt-in, see header
    if (process.env.MEMORY_BANK_SESSION_CONTINUITY === '1') try {
      const { getLastSessionContext, formatSessionContinuity } = await import('../dist/session-continuity.js');
      const lastSession = getLastSessionContext(project);
      if (lastSession) {
        console.log('');
        console.log(formatSessionContinuity(lastSession));
      }
    } catch {
      // Non-fatal: session continuity is best-effort
    }

    // 4. Project intent profile — opt-in, see header
    if (process.env.MEMORY_BANK_INTENT_PROFILE === '1') try {
      const { predictIntent, formatIntentContext } = await import('../dist/intent-predictor.js');
      const intent = predictIntent(project);
      const intentCtx = formatIntentContext(intent);
      if (intentCtx) {
        console.log('');
        console.log(intentCtx);
      }
    } catch {
      // Non-fatal: intent prediction is best-effort
    }
  } catch (error) {
    console.error('fact-consolidate: Error:', error instanceof Error ? error.message : error);
    // Don't block session start on consolidation failure
    process.exit(0);
  }
}

main();
