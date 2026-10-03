/**
 * inject-ledger — 세션당 "이미 주입한 fact id" 원장 (bounded, TTL).
 *
 * 왜: UserPromptSubmit 주입에 세션 dedup 이 없어서 같은 fact 가 한 세션에서
 * 반복 주입됐다 (실측: 주입률 74%, 평균 5.5~8건/프롬프트 × fact 평균 140자
 * ≈ ~470 tok/프롬프트, 30-프롬프트 세션 ≈ 10k tok — 상당분이 동일 fact 반복).
 * 이미 대화 컨텍스트에 들어간 fact 의 재주입은 순수 토큰 낭비다.
 *
 * 설계 (bounded-constant-memory-injection):
 *  - 세션당 파일 1개: <indexDir>/state/inject-ledger/<session_id>.json
 *  - bounded: 키 800개 상한 — 초과 시 oldest evict (삽입순 배열 유지).
 *    키는 fact id 와 본문 키('t:' + 정규화 본문 해시)를 함께 담는다 — id 가 다른
 *    같은 본문(중복 저장된 fact)의 재주입도 막기 위해서다 (2026-10-03).
 *  - TTL: 저장 시 7일 지난 원장 파일 정리 (디렉토리 소형 — 나열 비용 무시 가능)
 *  - 원자적 쓰기: tmp + rename (부분 쓰기 파일이 다음 로드를 깨지 않게)
 *  - session_id 는 파일명이 되므로 화이트리스트 sanitize (path traversal 차단)
 *  - 모든 실패는 best-effort: 원장이 깨져도 주입 자체를 막지 않는다
 *    (dedup 은 최적화지 정합성 요건이 아님 — fail-open 이 옳다)
 */
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from './paths.js';

const MAX_IDS = 800;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function ledgerDir(): string {
  return path.join(getIndexDir(), 'state', 'inject-ledger');
}

/** 파일명 안전화: uuid/영숫자/dash/underscore 외 전부 제거. 빈 결과면 null. */
export function sanitizeSessionId(sessionId: string | undefined | null): string | null {
  if (!sessionId) return null;
  const clean = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return clean.length >= 4 ? clean : null;
}

function ledgerPath(cleanId: string): string {
  return path.join(ledgerDir(), cleanId + '.json');
}

/** 세션의 기존 주입 id 집합. 없거나 깨졌으면 빈 집합 (fail-open). */
export function loadLedger(sessionId: string | undefined | null): Set<string> {
  const id = sanitizeSessionId(sessionId);
  if (!id) return new Set();
  try {
    const raw = fs.readFileSync(ledgerPath(id), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
  } catch { /* absent/corrupt → empty */ }
  return new Set();
}

/**
 * 신규 주입 id 를 원장에 추가 저장. 삽입순 유지 + 400 상한(oldest evict).
 * 저장 시 7일 지난 다른 세션 원장을 opportunistic 정리.
 */
export function appendLedger(
  sessionId: string | undefined | null,
  existing: Set<string>,
  newIds: string[],
): void {
  const id = sanitizeSessionId(sessionId);
  if (!id || newIds.length === 0) return;
  try {
    const dir = ledgerDir();
    fs.mkdirSync(dir, { recursive: true });
    // 삽입순 배열: 기존(로드순) + 신규. Set 은 삽입순 이터레이션이라 순서 보존.
    const ordered = [...existing, ...newIds.filter((n) => !existing.has(n))];
    const bounded = ordered.length > MAX_IDS ? ordered.slice(ordered.length - MAX_IDS) : ordered;
    const p = ledgerPath(id);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(bounded));
    fs.renameSync(tmp, p);
    pruneOldLedgers(dir);
  } catch { /* best-effort */ }
}

/** 7일 넘은 원장 파일 정리 — 세션 원장은 세션과 함께 죽는 상태이지 지식이 아니다. */
function pruneOldLedgers(dir: string): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > TTL_MS) fs.unlinkSync(fp);
      } catch { /* race — fine */ }
    }
  } catch { /* best-effort */ }
}
