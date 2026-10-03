#!/usr/bin/env node
/**
 * UserPromptSubmit context injection — thin client.
 *
 * Fast path: connect to the warm inject daemon (a unix-socket sidecar inside
 * any running MCP server, which already has the embedding model loaded) and
 * get the context back in ~150ms. Cold fallback: compute locally exactly as
 * before (~2.3s, dominated by model load) when no daemon answers — first
 * session start, daemon disabled, or any socket hiccup.
 *
 * Input (either):
 *   stdin JSON  { "prompt": "...", "cwd": "..." }   ← Claude Code hook contract
 *   env         USER_PROMPT / CWD                   ← manual invocation
 *
 * IMPORTANT: keep the import list here LIGHT — the fast path must not pay for
 * better-sqlite3/transformers imports. Heavy modules load lazily only in the
 * fallback. prompt-gate/inject-log are node-builtin-only modules.
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { injectionQuery } from '../dist/prompt-gate.js';
import { appendInjectLog } from '../dist/inject-log.js';
import { injectSocketPathIn, ownPackageVersion } from '../dist/version-guard.js';
import { selfHealDeps } from '../dist/deps-heal.js';
import { loadLedger, appendLedger } from '../dist/inject-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const SOCKET_CONNECT_TIMEOUT_MS = 300;
const SOCKET_RESPONSE_TIMEOUT_MS = 3000;
// The daemon says {"warming":true} while its model is still loading (right after
// session start). Loading a second copy cold costs the same ~5s and doubles the
// CPU, so wait for the one already loading — but not forever.
const SOCKET_WARMING_TIMEOUT_MS = 20000;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    // A large envelope arrives in several chunks; decode as a stream so a
    // multi-byte character split across chunks stays whole.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function injectSocketPath() {
  // Mirrors paths.ts getIndexDir() without importing the heavy dist chain.
  const base = process.env.MEMORY_BANK_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'superpowers');
  // Same version → same socket as this install's daemon (never an older one's).
  return injectSocketPathIn(path.join(base, 'conversation-index'), ownPackageVersion());
}

/**
 * Ask the warm daemon. Resolves { context, ledgerKeys } on an answer, or
 * { failed: 'no-daemon' | 'daemon-timeout' | 'daemon-closed' | 'daemon-error' }
 * (never rejects) so the caller falls back — the hook must never break a user
 * prompt. 'daemon-closed': the daemon hung up without a full answer; waiting out
 * the warming deadline after that only delays the fallback.
 */
function askDaemon(prompt, cwd, sessionId, meta) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let timer = null;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let conn;
    try {
      conn = net.connect(injectSocketPath());
    } catch {
      return done({ failed: 'no-daemon' });
    }
    const arm = (ms, why) => {
      clearTimeout(timer);
      timer = setTimeout(() => { conn.destroy(); done({ failed: why }); }, ms);
    };
    arm(SOCKET_CONNECT_TIMEOUT_MS, 'no-daemon');
    conn.on('connect', () => {
      connected = true;
      arm(SOCKET_RESPONSE_TIMEOUT_MS, 'daemon-timeout');
      // Decode as a stream: a multi-byte character split across chunks stays whole.
      conn.setEncoding('utf8');
      conn.write(JSON.stringify({ prompt, cwd, session_id: sessionId, ...meta }) + '\n');
      let buf = '';
      conn.on('data', (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let res;
          try {
            res = JSON.parse(line);
          } catch {
            conn.destroy();
            return done({ failed: 'daemon-error' });
          }
          if (res && res.warming) {
            arm(SOCKET_WARMING_TIMEOUT_MS, 'daemon-timeout');
            continue;
          }
          conn.destroy();
          if (!res || !res.ok) return done({ failed: 'daemon-error' });
          return done({
            context: String(res.context ?? ''),
            ledgerKeys: Array.isArray(res.ledger_keys) ? res.ledger_keys.filter((k) => typeof k === 'string') : [],
          });
        }
      });
    });
    conn.on('error', () => done({ failed: connected ? 'daemon-error' : 'no-daemon' }));
    // After an answer or a timeout `done` has already run; this only catches a hang-up.
    conn.on('close', () => done({ failed: connected ? 'daemon-closed' : 'no-daemon' }));
  });
}

/**
 * Print the block, then mark its facts as shown for this session — only once
 * the write has gone through to the hook host's pipe. A host that already left
 * (EPIPE) received nothing, and recording those facts would keep them out of
 * every later prompt in the session. Both paths deliver through here, so the
 * order is the same everywhere: print first, record second.
 */
function deliver(context, sessionId, ledgerKeys) {
  return new Promise((resolve) => {
    if (!context) return resolve();
    process.stdout.on('error', () => { /* host gone — the write callback sees it */ });
    process.stdout.write(context + '\n', (err) => {
      if (!err && ledgerKeys.length > 0) appendLedger(sessionId, loadLedger(sessionId), ledgerKeys);
      resolve();
    });
  });
}

/**
 * A hook envelope passed as text: { ok: true, prompt, cwd, session_id, turn_id }
 * for a usable UserPromptSubmit envelope, { ok: false } for any other envelope
 * (wrong event, non-string prompt) — never search one of those as a query —
 * and null for an ordinary prompt, including JSON that is not an envelope.
 */
function parseHookEnvelope(text) {
  const t = (text || '').trimStart();
  if (t[0] !== '{') return null;
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !('hook_event_name' in j)) return null;
  if (j.hook_event_name !== 'UserPromptSubmit' || typeof j.prompt !== 'string') return { ok: false };
  return {
    ok: true,
    prompt: j.prompt,
    cwd: typeof j.cwd === 'string' ? j.cwd : '',
    session_id: typeof j.session_id === 'string' ? j.session_id : '',
    turn_id: j.turn_id,
  };
}

async function main() {
  // Parse hook input: stdin JSON first, env fallback (manual runs).
  const raw = await readStdin();
  let prompt = '';
  let cwd = '';
  let sessionId = '';
  // Hook host for the inject log. The wrappers export MEMORY_BANK_CLIENT; when
  // they don't (older Codex wrapper, manual run) infer it from the envelope:
  // Codex adds turn_id, Claude Code sends transcript_path without it.
  let client = process.env.MEMORY_BANK_CLIENT || '';
  let invalidEnvelope = false;
  if (raw) {
    try {
      const j = JSON.parse(raw);
      prompt = String(j.prompt ?? '');
      cwd = String(j.cwd ?? '');
      sessionId = String(j.session_id ?? ''); // 세션 dedup 원장 키 (hook stdin 계약)
      if (!client) client = j.turn_id ? 'codex' : j.transcript_path ? 'claude-code' : '';
    } catch {
      prompt = raw; // plain-text stdin = the prompt itself
    }
  }
  if (!prompt) {
    prompt = process.env.USER_PROMPT || '';
    // The Codex wrapper (~/.codex/hooks/memory-bank/inject-context.sh) reads the
    // whole hook envelope into USER_PROMPT and leaves stdin empty, so the
    // "prompt" was JSON: it was embedded as the search query, and with no
    // session id there was no dedup (174 of 175 multi-injection Codex sessions
    // re-injected the same facts, measured 2026-10-03). That wrapper is
    // hash-pinned inside the Codex harness; this script ships with the plugin,
    // so the envelope is unwrapped here.
    const envelope = parseHookEnvelope(prompt);
    if (envelope && envelope.ok) {
      prompt = envelope.prompt;
      if (!cwd && envelope.cwd) cwd = envelope.cwd;
      if (!sessionId && envelope.session_id) sessionId = envelope.session_id;
      // Only wrappers and manual runs use this path; Claude Code pipes stdin.
      if (!client) client = envelope.turn_id ? 'codex' : 'manual';
    } else if (envelope) {
      invalidEnvelope = true;
    }
  }
  if (!cwd) cwd = process.env.CWD || process.cwd();
  if (!sessionId) sessionId = process.env.SESSION_ID || '';
  const meta = {
    client: client || 'manual',
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || undefined,
    req_id: randomUUID(), // same id on the daemon's log line and on a fallback line
  };

  // Harness-generated prompts (task notifications, slash-command expansions …)
  // and very short ones are not worth a search. Logged here so skips stay
  // measurable — they used to return silently before any log line.
  const skipReason = invalidEnvelope ? 'hook-envelope' : injectionQuery(prompt).reason;
  if (skipReason) {
    appendInjectLog({
      status: 'skipped', reason: skipReason, project: cwd, prompt_len: prompt.length,
      via: 'client', has_session: Boolean(sessionId), ...meta,
    });
    return;
  }

  // FAST PATH — warm daemon inside a running MCP server.
  const answer = await askDaemon(prompt, cwd, sessionId, meta);
  if (!answer.failed) {
    await deliver(answer.context, sessionId, answer.ledgerKeys);
    return;
  }

  // COLD FALLBACK — compute locally (heavy imports load only here).
  try {
    const { computeInjectResult } = await import(path.join(__dirname, '../dist/inject-core.js'));
    const { context, ledgerKeys } = await computeInjectResult(prompt, cwd, 'fallback', sessionId || undefined,
      { ...meta, fallback_reason: answer.failed });
    await deliver(context, sessionId, ledgerKeys);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inject-context: error: ${msg}\n`);
    // deps 누락(plugin update 미설치 / cc-sync 로 받은 캐시)이면 1회 자가치유
    if (/Cannot find (package|module)|ERR_MODULE_NOT_FOUND/.test(msg)) {
      selfHealDeps(path.join(__dirname, '..'), 'inject-context');
    }
  }
}

main();
