#!/usr/bin/env node

/**
 * Detached worker spawned by fact-extract-hook.js.
 *
 * Environment:
 *   SESSION_ID - session to extract facts from (required)
 *   CWD        - project path used for fact scoping (canonical: absolute path)
 *
 * Logs to <index-dir>/fact-extract.log so extraction is observable
 * (the parent hook runs with stdio ignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { runFactExtraction, classifyExtractionFailure, FAILURE_REPORT } from '../dist/fact-extractor.js';
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

async function main() {
  const sessionId = process.env.SESSION_ID;
  const project = process.env.CWD || process.cwd();

  if (!sessionId) {
    log('worker: SESSION_ID not set, exiting');
    process.exit(0);
  }

  log(`worker: extracting session=${sessionId} project=${project}`);

  let db;
  try {
    db = initDatabase();
    const result = await runFactExtraction(db, sessionId, project);
    // skipped 를 무시하면 claim 미획득·보류가 'extracted=0 saved=0' 정상 처리와
    // 구분되지 않아 DB 장애가 무경보로 남는다(R19 — backfill 에서 닫은 결함이
    // 이쪽에 그대로 있었다).
    if (result.skipped) {
      log(`worker: SKIPPED (${result.skipped}) session=${sessionId} — 처리하지 않음`);
    } else {
      log(`worker: session=${sessionId} extracted=${result.extracted} saved=${result.saved}`);
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
      log(
        `worker: ${rep.label} (${cls}) session=${sessionId}: `
        + `${error instanceof Error ? error.message : error} — ${rep.note}`,
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
