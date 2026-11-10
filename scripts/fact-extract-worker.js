#!/usr/bin/env node

/**
 * Detached worker spawned by fact-extract-hook.js.
 *
 * Environment:
 *   SESSION_ID         - session to extract facts from (required)
 *   CWD                - project path used for fact scoping (canonical: absolute path)
 *   SESSION_END_REASON - the SessionEnd hook's `reason`, logged only
 *
 * Order: index this session's transcript, then extract. Conversations are
 * otherwise indexed only by the SessionStart sync, so at SessionEnd the index
 * usually does not hold this session yet.
 *
 * When that indexing fails, the index may hold only the first part of the
 * session (a sync that ran while it was in progress). Extracting that part
 * writes a completion marker, and a session with a marker is never picked by
 * backfill — the rest was not extracted until the session ended again. So a
 * session backfill will pick is left alone (no extraction, no marker: backfill
 * takes the whole session once it is indexed), and only a session nothing else
 * would pick is extracted from what is indexed, with a warning.
 *
 * One worker per session at a time: SessionEnd often arrives twice for the same
 * session within a minute, and the second worker would redo the indexing only
 * to find the session claimed.
 *
 * Logs to <index-dir>/fact-extract.log so extraction is observable
 * (the parent hook runs with stdio ignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initDatabase } from '../dist/db.js';
import { runFactExtraction, classifyExtractionFailure, FAILURE_REPORT } from '../dist/fact-extractor.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';
import { preindexSession } from '../dist/session-preindex.js';
import { getIndexDir } from '../dist/paths.js';

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-extract.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 세션당 워커 하나 ---------------------------------------------------------
// 중복 추출을 막는 것은 DB 의 claim 이다(runFactExtraction). 이 잠금은 그 앞 단계 —
// 같은 세션의 두 번째 워커가 색인(임베딩)을 통째로 다시 하는 일 — 을 막는다.
// 그래서 잠금을 쓸 수 없는 환경에서는 잠금 없이 진행한다(로그에 남긴다).

/** 한 세션의 추출이 이보다 오래 걸리지는 않는다 — 넘으면 pid 가 재사용된 것으로 본다. */
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** 잠금 파일이 생겼지만 내용이 아직 안 쓰인 틈. 이 안의 "내용 없음"은 주인 미상이지 stale 이 아니다. */
const LOCK_WRITE_GRACE_MS = 60 * 1000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * @returns {{ held: false, release: () => void, note?: string } | { held: true, pid: number | null }}
 */
function acquireSessionLock(sessionId) {
  let file;
  try {
    const dir = path.join(getIndexDir(), 'extract-locks');
    fs.mkdirSync(dir, { recursive: true });
    // 세션 id 는 훅 입력에서 온 값이라 파일 이름에 그대로 쓰지 않는다.
    file = path.join(dir, `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.lock`);
  } catch (e) {
    return { held: false, release: () => {}, note: `lock unavailable (${e instanceof Error ? e.message : e})` };
  }
  const release = () => {
    try {
      if (parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.unlinkSync(file);
    } catch { /* 이미 없거나 남의 것 */ }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n${sessionId}\n`, { flag: 'wx' });
      return { held: false, release };
    } catch (e) {
      if (e?.code !== 'EEXIST') {
        return { held: false, release: () => {}, note: `lock unavailable (${e instanceof Error ? e.message : e})` };
      }
    }
    // 누가 쥐고 있다 — 살아 있는 주인이면 양보하고, 죽은 주인의 것만 치운다.
    let ageMs;
    let pid = NaN;
    try {
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
      pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
    } catch {
      continue; // 그사이 주인이 풀었다 — 다시 시도
    }
    const hasPid = Number.isInteger(pid) && pid > 0;
    if (hasPid && pidAlive(pid) && ageMs < LOCK_MAX_AGE_MS) return { held: true, pid };
    if (!hasPid && ageMs < LOCK_WRITE_GRACE_MS) return { held: true, pid: null };
    try { fs.unlinkSync(file); } catch { /* 다른 워커가 먼저 치웠다 */ }
  }
  // 치우고 다시 만드는 사이 다른 워커가 거듭 잡았다 — 그쪽이 처리한다.
  return { held: true, pid: null };
}

// ---- DB 열기 -------------------------------------------------------------------
// 선점 전의 실패다: 마커도 재시도 예산도 건드리지 않았으므로 실패 분류표(선점 이후의
// 실패를 전제로 '예산 소모'라고 적는다)에 넘기지 않고 따로 보고한다.
const DB_OPEN_ATTEMPTS = 3;
const DB_OPEN_RETRY_MS = 400;

async function openDatabase() {
  let lastError;
  for (let attempt = 1; attempt <= DB_OPEN_ATTEMPTS; attempt++) {
    try {
      return { db: initDatabase() };
    } catch (e) {
      lastError = e;
      if (attempt < DB_OPEN_ATTEMPTS) await sleep(DB_OPEN_RETRY_MS * attempt);
    }
  }
  return { error: lastError };
}

/**
 * 이 세션을 backfill 이 집는가. 훅 경로에는 자체 재시도 예약이 없고, 마커가 없는 세션만
 * backfill 이 집는다(주 교환 수 조건 포함). 그 조건을 backfill 과 같은 술어로 묻는다 —
 * 조용함 조건만 뺀다(지금 막 끝난 세션이므로). 확인하지 못하면 예외를 던진다.
 *
 * 세션을 술어에 넘겨 그 세션의 교환만 읽게 한다. 전체 목록을 만들고 바깥에서만 거르면
 * 모든 세션을 집계한다(실DB 복제본 73,498세션에서 한 번에 14~22초 — 그동안 이 워커가
 * 세션 잠금을 쥔다). 바깥의 `sid = ?` 는 그대로 둔다: 답은 이 조건이 정하고, 안쪽 조건은
 * 빠르게만 한다(세션 인자를 모르는 옛 dist 와 짝이 되어도 답은 같다).
 */
function backfillWillPick(db, sessionId) {
  const { sql, params } = pendingExtractionCoreQuery({ ...getExtractionConfig(), quietMinutes: 0 }, { sessionId });
  return Boolean(db.prepare(`SELECT 1 FROM (${sql}) WHERE sid = ? LIMIT 1`).get(...params, sessionId));
}

/** 공급자 일시 실패 뒤 이 세션이 다시 시도될 경로가 있는가(backfillWillPick). */
function retryPathNote(db, sessionId) {
  try {
    return backfillWillPick(db, sessionId)
      ? '공급자 일시 실패 — 예산 미소모, 마커 없음: 세션이 조용해지면 backfill 이 다시 처리'
      : '공급자 일시 실패 — 예산 미소모. backfill 대상이 아님(주 교환 수 미달이거나 이전 마커가 복원됨): '
        + '이 세션의 다음 SessionEnd 전에는 다시 시도되지 않음';
  } catch (e) {
    return `공급자 일시 실패 — 예산 미소모. backfill 대상 여부는 확인하지 못함(${e instanceof Error ? e.message : e})`;
  }
}

/**
 * 선색인이 실패한 세션을 지금 추출할지. 색인에 이 세션의 앞부분만 있을 수 있다 —
 * 그것만 추출하면 완료 마커가 남아 뒷부분은 세션이 다시 끝나기 전에는 추출되지 않는다.
 *  - backfill 이 집을 세션: 추출하지 않는다(마커도 쓰지 않는다). 색인된 뒤 backfill 이 전체를 처리한다.
 *  - 그 밖(이전 마커가 있거나 주 교환 수 미달, 또는 확인 실패): 다른 경로가 없으므로 색인된 만큼 추출한다.
 * @returns {{ extract: boolean, line: string }}
 */
function afterFailedPreindex(db, sessionId) {
  let picked;
  try {
    picked = backfillWillPick(db, sessionId);
  } catch (e) {
    return {
      extract: true,
      line: `worker: WARN (preindex_failed) session=${sessionId} — backfill 대상 여부를 확인하지 못해(${e instanceof Error ? e.message : e}) `
        + '색인된 만큼만 추출: 색인이 이 세션의 일부만 담고 있으면 나머지는 이 세션의 다음 SessionEnd 에서 추출',
    };
  }
  if (picked) {
    return {
      extract: false,
      line: `worker: SKIPPED (preindex_failed) session=${sessionId} — 색인이 이 세션의 일부만 담고 있을 수 있어 추출하지 않음, `
        + '완료 마커를 쓰지 않음: 색인된 뒤 backfill 이 세션 전체를 처리',
    };
  }
  return {
    extract: true,
    line: `worker: WARN (preindex_failed) session=${sessionId} — backfill 대상이 아니라(이전 마커가 있거나 주 교환 수 미달) `
      + '색인된 만큼만 추출: 색인이 이 세션의 일부만 담고 있으면 나머지는 이 세션의 다음 SessionEnd 에서 추출',
  };
}

async function main() {
  const sessionId = process.env.SESSION_ID;
  const project = process.env.CWD || process.cwd();
  // 같은 세션에 SessionEnd 가 두 번 오는 원인을 가르기 위한 기록(종료 사유가 다른 두 이벤트인지).
  const rawReason = process.env.SESSION_END_REASON || '';
  const reason = /^[A-Za-z0-9_-]{1,40}$/.test(rawReason) ? rawReason : 'unknown';

  if (!sessionId) {
    log('worker: SESSION_ID not set, exiting');
    process.exit(0);
  }

  const lock = acquireSessionLock(sessionId);
  if (lock.held) {
    log(
      `worker: SKIPPED (already_running) session=${sessionId} reason=${reason} — `
      + `같은 세션의 워커${lock.pid ? `(pid ${lock.pid})` : ''}가 처리 중`,
    );
    return;
  }
  process.on('exit', lock.release);

  log(`worker: extracting session=${sessionId} project=${project} reason=${reason}`);
  if (lock.note) log(`worker: ${lock.note} session=${sessionId} — 잠금 없이 진행(중복 추출은 DB claim 이 막는다)`);

  // 추출보다 색인이 먼저다. 색인은 SessionStart 의 sync 에서만 일어나므로, 이 단계가
  // 없으면 방금 끝난 세션은 색인 DB 에 교환이 0개이거나 일부만 있는 채로 추출된다.
  // 색인이 실패했을 때 추출할지는 DB 를 연 뒤 정한다(afterFailedPreindex).
  let pre;
  try {
    pre = await preindexSession(sessionId);
  } catch (e) {
    pre = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  log(`worker: preindex session=${sessionId} status=${pre?.status}${pre?.error ? ` — ${pre.error}` : ''}`);

  const opened = await openDatabase();
  if (!opened.db) {
    const e = opened.error;
    log(
      `worker: ERROR (db_open_failed) session=${sessionId}: ${e instanceof Error ? e.message : e} — `
      + `DB 를 열지 못함(${DB_OPEN_ATTEMPTS}회 시도). 선점 전이라 마커·재시도 예산은 그대로: `
      + '마커가 없는 세션이면 backfill 이 처리',
    );
    return;
  }
  const db = opened.db;

  try {
    if (pre?.status === 'failed') {
      const decision = afterFailedPreindex(db, sessionId);
      log(decision.line);
      if (!decision.extract) return;
    }
    const result = await runFactExtraction(db, sessionId, project);
    // skipped 를 무시하면 claim 미획득·보류가 'extracted=0 saved=0' 정상 처리와
    // 구분되지 않아 DB 장애가 무경보로 남는다(R19 — backfill 에서 닫은 결함이
    // 이쪽에 그대로 있었다).
    if (result.skipped === 'not_indexed') {
      log(
        `worker: SKIPPED (not_indexed) session=${sessionId} — 색인된 대화 0건(preindex=${pre?.status}), `
        + '완료 마커를 쓰지 않음: 색인된 뒤 backfill 이 처리',
      );
    } else if (result.skipped === 'no_new_exchanges') {
      log(`worker: SKIPPED (no_new_exchanges) session=${sessionId} — 지난 추출 뒤 새 대화 없음, 다시 추출하지 않음`);
    } else if (result.skipped) {
      log(`worker: SKIPPED (${result.skipped}) session=${sessionId} — 처리하지 않음`);
    } else {
      // truncated: 세션 상한 때문에 저장 대상에서 빠진 후보 수.
      // rejected_secret: 자격증명 모양 문자열이 들어 있어 버린 사실 수.
      // rejected_invalid: 저장 검사가 거부한 사실(사유×건수 — 템플릿 잔여물·프롬프트 예시·환경 상용구).
      // scope_project: worktree 에서 끝난 세션이라 project 사실을 본 저장소 루트에 묶었을 때 그 루트.
      // 넷 다 없으면 적지 않는다(scope_project 는 경로에 공백이 있을 수 있어 줄 끝에 둔다).
      const invalid = Object.entries(result.rejectedInvalid ?? {}).map(([reason, n]) => `${reason}×${n}`).join(',');
      log(
        `worker: session=${sessionId} extracted=${result.extracted} saved=${result.saved}`
        + (result.truncated > 0 ? ` truncated=${result.truncated}` : '')
        + (result.rejectedSecrets > 0 ? ` rejected_secret=${result.rejectedSecrets}` : '')
        + (invalid ? ` rejected_invalid=${invalid}` : '')
        + (result.scopeProject ? ` scope_project=${result.scopeProject}` : ''),
      );
    }
  } catch (error) {
    // 이양(handoff)은 실패가 아니다 — 다른 러너가 같은 세션을 인수한 정상 경로다.
    // 🚨 불변식 우선: 어떤 로깅 실패도 훅 실패로 표면화되면 안 된다. 표 역참조보다
    // exitCode 를 먼저 확정하고, dist↔scripts 스큐로 표가 비어도 죽지 않게 방어한다
    // (구 삼항 분기에는 없던 신규 취약면 — Codex R13 LOW).
    process.exitCode = 0; // extraction failure must never surface as hook failure
    try {
      const cls = classifyExtractionFailure(error);
      // 필드 단위 방어 — 구버전 표는 키가 있어도 필드가 빠질 수 있다(R14).
      const raw = FAILURE_REPORT?.[cls];
      const rep = { label: raw?.label ?? 'ERROR', note: raw?.note ?? '분류 표가 불완전합니다(dist 재빌드 필요)' };
      // 표의 '다음 run 재시도'는 backfill 의 말이다. 훅 경로에는 다음 run 이 없으므로
      // 일시 실패는 이 세션이 실제로 다시 집힐 수 있는지를 확인해 적는다.
      const note = cls === 'provider_transient' ? retryPathNote(db, sessionId) : rep.note;
      log(
        `worker: ${rep.label} (${cls}) session=${sessionId}: `
        + `${error instanceof Error ? error.message : error} — ${note}`,
      );
    } catch (logErr) {
      log(`worker: ERROR session=${sessionId}: ${error instanceof Error ? error.message : error} (분류 실패: ${logErr})`);
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// 최상위 rejection 도 훅 실패로 새지 않게 한다.
main().catch((e) => {
  try { log(`worker: FATAL ${e instanceof Error ? e.message : e}`); } catch { /* ignore */ }
  process.exitCode = 0;
});
