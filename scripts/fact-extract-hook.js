#!/usr/bin/env node

/**
 * SessionEnd Hook: Extract facts from session conversations.
 *
 * Claude Code passes hook input as JSON on stdin:
 *   { "session_id": "...", "cwd": "...", "hook_event_name": "SessionEnd", ... }
 *
 * Env vars (SESSION_ID / CWD) are kept as a fallback for manual invocation.
 *
 * LLM extraction can exceed the hook timeout, so this hook only parses input
 * and spawns a detached worker (fact-extract-worker.js), then exits immediately.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

  const sessionId = input.session_id || process.env.SESSION_ID;
  const project = input.cwd || process.env.CWD || process.env.PROJECT_DIR || process.cwd();

  if (!sessionId) {
    console.log('fact-extract: session_id not found in stdin/env, skipping');
    process.exit(0);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const worker = path.join(here, 'fact-extract-worker.js');

  const child = spawn(process.execPath, [worker], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SESSION_ID: sessionId, CWD: project },
  });
  child.unref();

  console.log(`fact-extract: queued session ${sessionId} (worker pid ${child.pid})`);
  process.exit(0);
}

main();
