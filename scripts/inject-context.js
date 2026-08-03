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
 * fallback.
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Self-heal missing runtime deps (better-sqlite3 등 native 모듈).
 *
 * 왜: (a) `claude plugin update` 가 npm install 을 비결정적으로 누락한다
 * (실측: 1.4.0 캐시엔 node_modules 생성, 1.4.1 캐시엔 미생성 → 콜드 경로
 * 전체가 Cannot find package 로 사망). (b) cc-sync 는 node_modules 를
 * 제외하고 plugins/cache 를 타 머신에 실어 나르므로, 동기화로 받은 캐시는
 * 항상 deps 가 없다. 두 경우 모두 첫 프롬프트에서 감지해 1회 한정으로
 * detached npm install 을 시도한다 (marker 파일 'wx' 원자 생성으로 중복
 * 방지 — 실패해도 다음 설치 디렉토리에서만 재시도, 무한 루프 없음).
 */
function selfHealDeps(pluginRoot) {
  const marker = path.join(pluginRoot, '.deps-heal-attempted');
  try {
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' }); // 원자적 1회 게이트
  } catch {
    return false; // 이미 시도됨 (성공/실패 무관 — 재폭주 방지)
  }
  try {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      // windowsHide: 콘솔을 상속하지 않는 detached 프로세스는 Windows 에서 새 conhost
      // 창을 띄운다. 이 self-heal 은 프롬프트 주입 경로라 창이 반복해 깜빡인다.
      // (비-Windows 에서는 no-op — PR #3 이 정렬한 나머지 5개 spawn 과 동일 계약)
      cwd: pluginRoot, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    process.stderr.write('inject-context: missing deps detected — spawned background npm install (one-shot)\n');
    return true;
  } catch (e) {
    process.stderr.write(`inject-context: self-heal spawn failed: ${e && e.message}\n`);
    return false;
  }
}

const SOCKET_CONNECT_TIMEOUT_MS = 300;
const SOCKET_RESPONSE_TIMEOUT_MS = 3000;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function injectSocketPath() {
  // Mirrors paths.ts getIndexDir() without importing the heavy dist chain.
  const base = process.env.MEMORY_BANK_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'superpowers');
  return path.join(base, 'conversation-index', 'inject-daemon.sock');
}

/** Ask the warm daemon; resolve null (not reject) on ANY failure so the caller
 * falls back — the hook must never break a user prompt. */
function askDaemon(prompt, cwd, sessionId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let conn;
    try {
      conn = net.connect(injectSocketPath());
    } catch {
      return done(null);
    }
    const connectTimer = setTimeout(() => { conn.destroy(); done(null); }, SOCKET_CONNECT_TIMEOUT_MS);
    conn.on('connect', () => {
      clearTimeout(connectTimer);
      conn.setTimeout(SOCKET_RESPONSE_TIMEOUT_MS, () => { conn.destroy(); done(null); });
      conn.write(JSON.stringify({ prompt, cwd, session_id: sessionId }) + '\n');
      let buf = '';
      conn.on('data', (c) => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try {
          const res = JSON.parse(buf.slice(0, nl));
          done(res && res.ok ? String(res.context ?? '') : null);
        } catch {
          done(null);
        }
        conn.destroy();
      });
    });
    conn.on('error', () => { clearTimeout(connectTimer); done(null); });
  });
}

async function main() {
  // Parse hook input: stdin JSON first, env fallback (manual runs).
  const raw = await readStdin();
  let prompt = '';
  let cwd = '';
  let sessionId = '';
  if (raw) {
    try {
      const j = JSON.parse(raw);
      prompt = String(j.prompt ?? '');
      cwd = String(j.cwd ?? '');
      sessionId = String(j.session_id ?? ''); // 세션 dedup 원장 키 (hook stdin 계약)
    } catch {
      prompt = raw; // plain-text stdin = the prompt itself
    }
  }
  if (!prompt) prompt = process.env.USER_PROMPT || '';
  if (!cwd) cwd = process.env.CWD || process.cwd();
  if (!sessionId) sessionId = process.env.SESSION_ID || '';

  if (!prompt || prompt.length < 20) return; // not worth an injection

  // FAST PATH — warm daemon inside a running MCP server.
  const daemonContext = await askDaemon(prompt, cwd, sessionId);
  if (daemonContext !== null) {
    if (daemonContext) process.stdout.write(daemonContext + '\n');
    return;
  }

  // COLD FALLBACK — compute locally (heavy imports load only here).
  try {
    const { computeInjectContext } = await import(path.join(__dirname, '../dist/inject-core.js'));
    const context = await computeInjectContext(prompt, cwd, 'fallback', sessionId || undefined);
    if (context) process.stdout.write(context + '\n');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inject-context: error: ${msg}\n`);
    // deps 누락(plugin update 미설치 / cc-sync 로 받은 캐시)이면 1회 자가치유
    if (/Cannot find (package|module)|ERR_MODULE_NOT_FOUND/.test(msg)) {
      selfHealDeps(path.join(__dirname, '..'));
    }
  }
}

main();
