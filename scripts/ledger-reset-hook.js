#!/usr/bin/env node

/**
 * SessionStart(compact) Hook: clear this session's injection ledger after a compaction.
 *
 * Claude Code passes hook input as JSON on stdin:
 *   { "session_id": "...", "cwd": "...", "hook_event_name": "SessionStart", "source": "compact", ... }
 *
 * The ledger (dist/inject-ledger.js) keeps a fact out of later prompts because the
 * fact is already in the conversation. A compaction replaces the conversation with
 * a summary and keeps the session id, so that stops being true while the ledger
 * stays — the fact was never injected again for the rest of the session (measured
 * 2026-11-10: 11 of 94 ledgers belonged to compacted sessions, 315 facts held back).
 * After this hook the next prompt can pull those facts in again; they are recorded
 * anew when they are delivered.
 *
 * Registered under the SessionStart matcher `compact` only (hooks/hooks.json), and
 * WITHOUT `async`: the reset must be done before the next prompt's injection hook
 * reads the ledger. The script also checks `source` itself — run for any other
 * source (a host that ignores matchers, a manual run) it does nothing, because a
 * resumed or freshly started session still holds what was injected into it.
 *
 * Only that session's ledger file is removed. Nothing is printed: stdout of a
 * SessionStart hook becomes session context. Each run appends one
 * `via:'session-start'` line to the injection log — `status:'ledger-reset'` with
 * the number of keys cleared, or `status:'error'` when there was no usable session
 * id or the file could not be removed (the ledger then still blocks those facts,
 * and the log must say so).
 *
 * Imports stay light (node built-ins only behind dist/): no better-sqlite3, no
 * embedding model — the hook runs synchronously inside the session.
 */

import { resetLedger } from '../dist/inject-ledger.js';
import { appendInjectLog, pluginVersion, sessionKey } from '../dist/inject-log.js';
import { readHookInput } from '../dist/hook-stdin.js';

async function main() {
  const raw = await readHookInput(process.stdin, 3000);
  let input = null;
  try { input = JSON.parse(raw); } catch { /* not JSON — nothing to act on */ }
  if (!input || typeof input !== 'object' || input.source !== 'compact') return;

  const t0 = Date.now();
  const logBase = {
    via: 'session-start',
    source: 'compact',
    project: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    has_session: Boolean(input.session_id),
    session_key: sessionKey(input.session_id),
    plugin_version: pluginVersion(),
  };
  try {
    const cleared = resetLedger(input.session_id);
    if (cleared === null) {
      appendInjectLog({ ...logBase, status: 'error', error: 'no usable session id — ledger not reset', duration_ms: Date.now() - t0 });
      return;
    }
    appendInjectLog({ ...logBase, status: 'ledger-reset', ledger_cleared: cleared, duration_ms: Date.now() - t0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('ledger-reset: could not clear the session ledger:', message);
    appendInjectLog({ ...logBase, status: 'error', error: `ledger not reset: ${message}`.slice(0, 300), duration_ms: Date.now() - t0 });
  }
}

main();
