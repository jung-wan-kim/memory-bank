import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LLM_WORKDIR_BASENAME, getProjectsDir } from './paths.js';
import { classifyLlmError, EmptyLlmResponseError, LlmRefusalError } from './llm-error-class.js';
import { noteSdkFailure } from './deps-heal.js';

// Isolated working directory for headless Agent SDK sessions. The CLI that
// query() spawns persists a transcript under ~/.claude/projects/<cwd-slug>/;
// running it from the caller's cwd drops worker transcripts into that
// project's dir, where a user `claude --resume` can pick one up as their own
// session (observed 2026-07-05). A dedicated cwd keeps them in their own slug.
const LLM_WORKDIR = path.join(os.tmpdir(), LLM_WORKDIR_BASENAME);

/**
 * Default model for every headless call (fact extraction, consolidation,
 * classification, summaries, translation). A full model id, not the 'haiku'
 * alias: the alias resolves per bundled CLI version — Agent SDK 0.1.77 maps it
 * to claude-haiku-4-5-20251001, 0.3.293 to claude-haiku-5-5 (measured
 * 2026-10-08) — so the model changed with whatever SDK an install carried.
 */
export const DEFAULT_LLM_MODEL = 'claude-haiku-5-5';

/**
 * Isolation every headless query() shares (callHaiku, summarizer, translate).
 *  - settingSources: [] — no user settings/plugins, so the spawned session's own
 *    SessionStart/End hooks can't re-spawn workers (cascade prevention).
 *  - tools: [] — these are text-in/text-out calls; the bundled CLI otherwise
 *    sends every built-in tool definition with each request.
 *  - strictMcpConfig — settingSources: [] does NOT stop the CLI from loading the
 *    user's MCP servers, so each call also carried (and started) them.
 * Measured on SDK 0.3.288 / CLI 2.1.288 (2026-10-03), one "pong" call:
 * default ≈ 32,500 prompt tokens, tools: [] ≈ 3,300, both ≈ 390.
 */
export const ISOLATED_QUERY_OPTIONS = {
  settingSources: [] as never[],
  tools: [] as string[],
  strictMcpConfig: true,
};
export function llmWorkdir(): string {
  try {
    fs.mkdirSync(LLM_WORKDIR, { recursive: true });
  } catch {
    /* fall through — SDK will spawn in process cwd */
  }
  pruneLlmTranscripts();
  return LLM_WORKDIR;
}

// ---------------------------------------------------------------------------
// Transcript pruning — the one-shot sessions above each persist a transcript
// (session .jsonl + agent-*.jsonl) that nothing ever deletes; observed
// accumulation: 11,573 files / 99MB (2026-07-08). Prune files older than a
// TTL, throttled to at most once per hour per process tree via a marker file.
// Scope is strictly our reserved namespace: directories under
// ~/.claude/projects whose name ends with '-memory-bank-llm' (covers the
// current fixed workdir slug and legacy mkdtemp variants on any machine).
// ---------------------------------------------------------------------------
const PRUNE_MARKER = path.join(LLM_WORKDIR, '.last-transcript-prune');
const PRUNE_THROTTLE_MS = 60 * 60 * 1000; // at most hourly

function transcriptTtlMs(): number {
  const raw = process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS;
  const hours = raw != null && /^\d+$/.test(raw) ? parseInt(raw, 10) : 24;
  // Floor of 1h so an in-flight session's freshly-written transcript can
  // never be deleted from under the CLI that is still appending to it.
  return Math.max(1, hours) * 60 * 60 * 1000;
}

export function pruneLlmTranscripts(now: number = Date.now()): void {
  try {
    // Throttle: mtime of the marker is the last prune time.
    try {
      const markerAge = now - fs.statSync(PRUNE_MARKER).mtimeMs;
      if (markerAge >= 0 && markerAge < PRUNE_THROTTLE_MS) return;
    } catch {
      /* no marker yet — proceed */
    }
    try {
      fs.writeFileSync(PRUNE_MARKER, new Date(now).toISOString());
    } catch {
      /* marker write failed — still prune, worst case we prune more often */
    }

    const projectsDir = getProjectsDir();
    const ttl = transcriptTtlMs();
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir);
    } catch {
      return; // no projects dir — nothing to prune
    }

    for (const entry of entries) {
      if (entry !== LLM_WORKDIR_BASENAME && !entry.endsWith(`-${LLM_WORKDIR_BASENAME}`)) continue;
      const dir = path.join(projectsDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue; // never follow symlinks

      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        // Only transcript artifacts; leave anything else untouched.
        if (!file.endsWith('.jsonl') && !file.endsWith('-summary.txt')) continue;
        const filePath = path.join(dir, file);
        try {
          const fstat = fs.lstatSync(filePath);
          if (fstat.isFile() && now - fstat.mtimeMs > ttl) fs.unlinkSync(filePath);
        } catch {
          /* skip file on any error */
        }
      }
      // Drop the directory once empty (rmdir refuses non-empty dirs — safe).
      try {
        fs.rmdirSync(dir);
      } catch {
        /* not empty or in use — fine */
      }
    }
  } catch {
    /* pruning is best-effort housekeeping — never break the LLM call */
  }
}

/** 재시도 횟수(= 총 시도 - 1). 0 이면 재시도 없음. 상한 5 — 무한 폭주 방지. */
function retryBudget(): number {
  const raw = process.env.MEMORY_BANK_LLM_RETRIES;
  if (raw != null && /^\d+$/.test(raw.trim())) return Math.min(5, parseInt(raw.trim(), 10));
  return 2; // 기본 총 3회 시도
}

/**
 * 지수 백오프(500ms → 1500ms …). 테스트는 MEMORY_BANK_LLM_RETRY_BASE_MS=0 으로 즉시.
 * base 와 결과 모두 상한을 둔다 — 오타 하나(예: 500000)로 워커가 사실상 정지하는
 * 것을 막기 위해서다 (Codex 리뷰 MEDIUM 2026-07-17).
 */
const MAX_BACKOFF_BASE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
function backoffMs(attempt: number): number {
  const raw = process.env.MEMORY_BANK_LLM_RETRY_BASE_MS;
  const parsed = raw != null && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : 500;
  const base = Math.min(parsed, MAX_BACKOFF_BASE_MS);
  return Math.min(base * Math.pow(3, attempt), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 단발 호출 — Agent SDK 우선, 실패 시(그리고 키가 있을 때만) Anthropic SDK 폴백. */
async function callOnce(systemPrompt: string, userMessage: string, maxTokens: number): Promise<string> {
  const model = process.env.MEMORY_BANK_FACT_MODEL || DEFAULT_LLM_MODEL;

  // The result is judged after the try: a refusal or an error turn thrown inside
  // it would land in the API-key fallback below and re-send a request that
  // already failed on the same model.
  let result: SDKResultMessage | null = null;
  let refused = false;
  let refusalCategory: string | null = null;

  // Try Claude Agent SDK first (works inside Claude Code without API key)
  try {
    for await (const message of query({
      prompt: `${systemPrompt}\n\n${userMessage}`,
      options: {
        model,
        max_tokens: maxTokens,
        systemPrompt,
        // One-shot classification calls: no tools/turn loops needed, and the
        // spawned session must NOT load user settings/plugins — otherwise its
        // own SessionStart/End hooks re-spawn sync/backfill workers and every
        // LLM call cascades into more sessions (observed as a proxy flood).
        maxTurns: 1,
        ...ISOLATED_QUERY_OPTIONS,
        cwd: llmWorkdir(),
      } as any,
    })) {
      if (message.type === 'system' && message.subtype === 'model_refusal_no_fallback') {
        // The SDK's structured refusal signal; the result's stop_reason may not carry it.
        refused = true;
        refusalCategory = message.api_refusal_category ?? null;
      } else if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
        // The answer that follows came from another model, not the one asked for.
        console.error(`callHaiku: ${message.original_model} refused; answered by ${message.fallback_model}`);
      } else if (message.type === 'result') {
        result = message;
        break;
      }
    }
  } catch (agentSdkError) {
    noteSdkFailure(agentSdkError, 'memory-bank llm');
    // Fallback to direct Anthropic SDK if agent SDK fails (standalone mode)
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.MEMORY_BANK_API_TOKEN;
    if (!apiKey) {
      // 키 없음 = 폴백 불가. 원인 에러를 그대로 전파해야 분류기가 transient/deterministic
      // 을 읽을 수 있다 (문자열로 감싸면 status 등 구조가 소실된다).
      throw agentSdkError;
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const baseURL = process.env.MEMORY_BANK_API_BASE_URL;
    const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      // Haiku 5.5 thinks by default and thinking counts toward max_tokens, but
      // callers size maxTokens for the answer alone (256 for a relation verdict),
      // so thinking could use up the cap before any text. Run without it, as
      // Haiku 4.5 did here. Default model only: Opus 5.5 / Sonnet 5.5 reject 'disabled'.
      ...(model === DEFAULT_LLM_MODEL ? { thinking: { type: 'disabled' as const } } : {}),
    });

    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(response.stop_details?.category ?? null);
    }
    const textBlock = response.content.find((b: any) => b.type === 'text');
    const text = (textBlock as any)?.text || '';
    // The cap ran out: a thinking model under an answer-sized cap. That is a
    // setting to fix, not this request's fault, so an empty answer stays an
    // empty (transient) response — deferred, not dropped for good. Logged either
    // way, since a cut-off answer usually fails to parse.
    if (response.stop_reason === 'max_tokens') {
      console.error(`callHaiku: ${model} hit max_tokens (${maxTokens}) — ${text ? 'answer cut off' : 'no answer text'}`);
    }
    return text;
  }

  // 스트림이 result 메시지 없이 끝남 — 호출 실패이지 "빈 답변"이 아니다.
  if (!result) return '';
  return agentResultText(result, refused, refusalCategory);
}

/**
 * Text of a finished Agent SDK turn. A turn that ended on an API error still
 * arrives as subtype 'success' with is_error and the error text in `result`;
 * returning that text made callers parse an error message as the answer (no
 * JSON → batch silently empty). Throw instead, so classifyLlmError can read it
 * ("API Error: 500 …" → transient, "… 400 …" → deterministic).
 */
function agentResultText(result: SDKResultMessage, refused: boolean, refusalCategory: string | null): string {
  if (refused || result.stop_reason === 'refusal') throw new LlmRefusalError(refusalCategory);
  if ('errors' in result) {
    throw new Error(`Agent SDK turn ended with ${result.subtype}: ${result.errors.join('; ')}`);
  }
  if (result.is_error) throw new Error(result.result || 'Agent SDK turn ended with an error');
  return result.result || '';
}

/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code —
 * billed to the local subscription, NOT a metered API key).
 * Falls back to direct Anthropic SDK only if ANTHROPIC_API_KEY is set
 * (standalone use outside Claude Code).
 *
 * 복구 계약 (2026-07-17 — 사용자 피드백 "에러나거나 0바이트인데 재시도·복구가 없다"):
 *  - **빈 응답('')도 실패**다. 모든 호출자가 JSON 을 요구하므로 빈 본문은 유효한 답이
 *    될 수 없는데, 예전엔 '' 를 반환해 호출자가 "정상적으로 아무것도 없음"으로 소비했다
 *    (consolidator 는 verdict 'none' 으로 확정+예산 소모, fact-extractor 는 배치를 조용히
 *    버리고 세션을 extraction_log 에 완료 기록 → 그 대화의 fact 영구 손실).
 *  - transient(빈 응답·429/5xx/네트워크/타임아웃)와 unknown 은 **유한 재시도**(기본 2회,
 *    지수 백오프)로 일회성 flake 를 흡수한다. 같은 파일 계열의 임베딩 경로는 이미
 *    probe+재시도로 flake 를 흡수하고 있었고(ontology-classifier), LLM 경로만 없었다.
 *  - deterministic(400/413/max_tokens 등 이 요청 자체가 잘못됨)은 **재시도하지 않는다** —
 *    같은 입력은 같은 결과이고 재시도는 예산 낭비다.
 *  - 재시도를 소진하면 '' 가 아니라 **throw** 한다. 그래야 호출자의 3분류(transient 는
 *    보류·재시도, deterministic 은 attempt 소모)가 비로소 작동한다 (fail-loud).
 * 호출자 계약: 성공 반환값은 **비어있지 않음이 보장**된다.
 */
export async function callHaiku(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
): Promise<string> {
  const retries = retryBudget();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callOnce(systemPrompt, userMessage, maxTokens);
      if (text && text.trim() !== '') return text;
      lastError = new EmptyLlmResponseError(
        `LLM returned an empty response (attempt ${attempt + 1}/${retries + 1})`,
      );
    } catch (error) {
      lastError = error;
      // 이 요청 자체가 잘못된 경우는 재시도해도 동일 — 즉시 표면화.
      if (classifyLlmError(error) === 'deterministic') throw error;
    }
    if (attempt < retries) {
      console.error(
        `callHaiku: attempt ${attempt + 1}/${retries + 1} failed (${lastError instanceof Error ? lastError.message : lastError}) — retrying`,
      );
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Parse the JSON in an LLM reply. `expect: 'array'` is for callers that need a
 * list (fact extraction, batch classification): a reply that wraps the list in
 * an object ({"facts": [...]}) yields that list when it is the object's only
 * array — the old array-first regex unwrapped this by accident.
 */
export function parseJsonResponse<T>(text: string, expect?: 'array'): T | null {
  const value = parseJsonValue(text);
  if (expect !== 'array' || value === null || Array.isArray(value) || typeof value !== 'object') {
    return value as T | null;
  }
  const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray);
  if (arrays.length === 1) return arrays[0] as T;
  console.error(`parseJsonResponse: expected a JSON array, got an object with ${arrays.length} array fields:`, text.substring(0, 200));
  return value as T;
}

function parseJsonValue(text: string): unknown {
  // The whole reply first: Haiku 5.5 answers with bare JSON, no fence. The
  // fallbacks below search inside text, and a bare object whose string values
  // hold brackets ("[ ] checklist item") used to come back as the inner "[ ]"
  // → [] (measured on a real fact pair; Haiku 4.5 fenced its JSON, hiding this).
  const whole = text.trim();
  if (whole.startsWith('{') || whole.startsWith('[')) {
    try {
      return JSON.parse(whole);
    } catch {
      /* not one JSON value — fall through to extraction */
    }
  }
  // A fenced block wins. In prose, try object / array in the order they start —
  // not always the array — and move on to the other if the first doesn't parse.
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidates = fenced
    ? [fenced]
    : [text.match(/(\[[\s\S]*\])/), text.match(/(\{[\s\S]*\})/)]
      .filter((m): m is RegExpMatchArray => m !== null)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (candidates.length === 0) {
    console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
    return null;
  }

  let firstError: Error | null = null;
  for (const match of candidates) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      firstError ??= e as Error;
    }
  }
  console.error('parseJsonResponse: invalid JSON:', firstError?.message, candidates[0][1].substring(0, 200));
  return null;
}
