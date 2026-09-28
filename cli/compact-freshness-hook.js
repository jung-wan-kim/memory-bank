#!/usr/bin/env node

/**
 * SessionStart:compact hook.
 *
 * Index the current session in the foreground and emit exactly one freshness
 * receipt on stdout. Diagnostic indexer logs are redirected to stderr so the
 * receipt, not implementation chatter, is injected into the resumed session.
 */

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
  try { input = JSON.parse(raw); } catch { /* handled as missing session_id */ }

  // Freshness must be bound to the event's current session. An ambient
  // SESSION_ID can be stale or belong to another process, so it is not a
  // fallback for this gate.
  const sessionId = input.session_id || null;
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  let timeout;

  try {
    const freshness = await import('../dist/compact-freshness.js');
    timeout = setTimeout(() => {
      let observed = { exchangeCount: 0, frontier: null, lastIndexed: null };
      if (sessionId) {
        try { observed = freshness.readSessionIndexState(sessionId); } catch { /* no receipt evidence */ }
      }
      originalLog(freshness.formatCompactFreshnessReceipt({
        status: 'stale',
        reason: 'foreground_index_timeout',
        ...observed,
      }));
      process.exit(0);
    }, 170_000);

    const receipt = await freshness.evaluateCompactFreshness(sessionId);
    clearTimeout(timeout);
    originalLog(freshness.formatCompactFreshnessReceipt(receipt));
  } catch (error) {
    console.error('memory-bank compact freshness hook failed:', error);
    originalLog('memory-bank: stale, 마지막 색인 = 없음 (reason=hook_error, frontier=없음)');
  } finally {
    if (timeout) clearTimeout(timeout);
    console.log = originalLog;
  }
}

main();
