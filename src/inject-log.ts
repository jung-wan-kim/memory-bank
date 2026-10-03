import fs from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';

/**
 * Observability log for the UserPromptSubmit context injection pipeline.
 *
 * The injection hook historically failed silently (stderr discarded, empty
 * output indistinguishable from "no relevant facts"), which let a broken
 * install go unnoticed for months. Every run now appends one JSONL line so
 * "injection never fires" becomes measurable instead of invisible.
 *
 * Logging is strictly best-effort: it must never throw or block injection.
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate at 5MB

export interface InjectLogEntry {
  ts: string;
  /** 'deduped': 후보 전부가 이 세션에서 이미 주입됨 → 재주입 0 (토큰 절약 관측용). */
  status: 'injected' | 'no-match' | 'skipped' | 'error' | 'deduped';
  project?: string;
  prompt_len?: number;
  candidates?: number;
  injected?: number;
  /** 세션 원장 dedup 으로 걸러진 fact 수 — 절감량이 로그로 상시 측정된다. */
  deduped?: number;
  /** 실제 주입된 블록 크기(자) — 토큰 비용 관측용 (~chars/3 tok). */
  chars?: number;
  duration_ms?: number;
  error?: string;
  /**
   * Which execution path served this injection: warm MCP-server daemon, cold
   * fallback, or the thin hook client itself (prompt skipped before any search).
   */
  via?: 'daemon' | 'fallback' | 'client';
  /** status='skipped' only — why (short prompt, task notification, slash command …). */
  reason?: string;
  /** Length of the text actually searched, when it differs from the prompt (prompt-gate.ts). */
  query_len?: number;
  /** Hook host: 'claude-code' | 'codex' | 'manual' — lets the two clients be measured apart. */
  client?: string;
  /** CLAUDE_CODE_ENTRYPOINT (cli, sdk-ts …) — separates interactive sessions from automation. */
  entrypoint?: string;
  /** Whether the hook supplied a session id (no id = no per-session dedup). */
  has_session?: boolean;
  /** Stage timings (ms): embedding+baseline, fact KNN, 1-hop relations, repeat detection. */
  embed_ms?: number;
  search_ms?: number;
  related_ms?: number;
  /** Absent when repeat detection did not run (off by default — MEMORY_BANK_REPEAT_DETECT=1). */
  repeat_ms?: number;
  /** Injected facts by origin: vector hit vs 1-hop relation expansion. */
  from_vec?: number;
  from_rel?: number;
  /** Facts dropped because the same text was already in the block or the session ledger. */
  text_deduped?: number;
}

export function getInjectLogPath(): string {
  const dir = path.join(getIndexDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'inject-context.jsonl');
}

/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export function appendInjectLog(entry: Omit<InjectLogEntry, 'ts'>): void {
  try {
    const logPath = getInjectLogPath();

    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // No existing log — nothing to rotate.
    }

    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(logPath, line + '\n');
  } catch {
    // Best-effort only: observability must not break injection.
  }
}
