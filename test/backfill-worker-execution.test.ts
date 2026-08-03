import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * backfill 워커 **실행** 회귀 (Codex R15 MEDIUM).
 *
 * 리뷰어가 증명한 구멍: 기존 워커 테스트는 소스 문자열만 봤고, **수정 전(결함) 소스가
 * assertion 7/7 을 전부 통과**했다 — 즉 R14 수정을 되돌려도 스위트는 완전 초록인 채
 * 경보만 조용히 죽는다. 문자열 검사로는 "워커가 표를 어떻게 읽는가"를 검증할 수 없다.
 *
 * 그래서 여기서는 워커를 **자식 프로세스로 실제 실행**한다. 의존 dist 모듈을 스텁으로
 * 대체해 실패 경로를 결정론적으로 재현하고, 표준출력의 요약줄을 계약으로 고정한다.
 *  - 정상 표: handoff/transient/budget 로 정확히 라우팅 + INTERNAL 경보
 *  - 구버전 표(label/note 만): 필드가 없어도 경보가 **살아남아야** 한다(R14 수정의 핵심)
 */

let sandbox: string;

/** 워커가 import 하는 dist 모듈을 최소 스텁으로 만든다. */
function writeStubs(opts: { staleTable: boolean }): void {
  const dist = path.join(sandbox, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'index'), { recursive: true });

  // 실패 4종을 한 번씩 만들어내는 가짜 파이프라인.
  const table = opts.staleTable
    ? `{
        handoff: { label: 'HANDOFF', note: '구버전' },
        provider_transient: { label: 'ERROR', note: '구버전' },
        provider_deterministic: { label: 'ERROR', note: '구버전' },
        internal: { label: 'ERROR', note: '구버전' },
      }`
    : `{
        handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
        provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
        provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
        internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
      }`;

  fs.writeFileSync(path.join(dist, 'fact-extractor.js'), `
const KINDS = ['handoff', 'provider_transient', 'provider_deterministic', 'internal'];
let n = 0;
export async function runFactExtraction() { throw new Error('KIND:' + KINDS[n++ % KINDS.length]); }
export function classifyExtractionFailure(err) { return String(err.message).replace('KIND:', ''); }
export const FAILURE_REPORT = ${table};
`);
  fs.writeFileSync(path.join(dist, 'db.js'), `
export function initDatabase() {
  return {
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    transaction: (fn) => fn,
    close: () => {},
    pragma: () => {},
  };
}
`);
  // 세션 4개를 pending 으로 반환 → 실패 4종이 한 번씩 발생한다.
  fs.writeFileSync(path.join(dist, 'pending-extraction.js'), `
export function getExtractionConfig() { return { minExchanges: 2, excludeProjects: [] }; }
export function pendingExtractionCoreQuery() { return { sql: 'SELECT 1', params: [] }; }
`);
  fs.writeFileSync(path.join(dist, 'project-canon.js'), `export function canonicalizeProject(_d, p) { return p; }\n`);
  fs.writeFileSync(path.join(dist, 'paths.js'), `export function getIndexDir() { return ${JSON.stringify(path.join(sandbox, 'index'))}; }\n`);

  // 워커 원본을 그대로 복사 — 검증 대상은 **실제 소스**여야 한다.
  const original = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backfill-extract-worker.js'), 'utf8');
  // 치환 앵커가 사라지면 조용히 '다른 것'을 테스트하게 된다 — 명시적으로 실패시킨다.
  for (const anchor of [
    'return db.prepare(`${sql} ORDER BY ts DESC LIMIT ?`).all(...params, limit);',
    'const seeded = seedFromExistingFacts(db);',
  ]) {
    if (!original.includes(anchor)) throw new Error(`스텁 앵커 소실 — 테스트를 갱신하세요: ${anchor}`);
  }
  const worker = original
    // pendingSessions 가 스텁 DB 로도 4세션을 내놓게 최소 치환(쿼리 결과만 대체).
    .replace(
      'return db.prepare(`${sql} ORDER BY ts DESC LIMIT ?`).all(...params, limit);',
      "return [{sid:'s1'},{sid:'s2'},{sid:'s3'},{sid:'s4'}];",
    )
    // seed 단계는 이 테스트의 관심사가 아니다 — 함수 본문이 아니라 **호출부**만 치환한다
    // (본문을 주석으로 감싸면 구문이 깨진다).
    .replace('const seeded = seedFromExistingFacts(db);', 'const seeded = 0;');
  fs.writeFileSync(path.join(sandbox, 'scripts', 'backfill-extract-worker.js'), worker);
}

/**
 * 워커를 실행하고 stdout+stderr 와 **종료 코드**를 함께 돌려준다.
 * 종료 코드를 삼키면 "정상 요약을 찍고 나서 종료 단계에서 죽는" 워커도 초록이 된다
 * (Codex R16 재현: exitCode=1 주입 시 4개 토큰 단언이 전건 통과).
 */
function runWorker(): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ['scripts/backfill-extract-worker.js'], {
      cwd: sandbox, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, BACKFILL_CONCURRENCY: '1' },
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-backfill-exec-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('backfill 워커 실행 계약', () => {
  it('정상 표: 4분류가 각 버킷으로 라우팅되고 INTERNAL 경보가 뜬다', () => {
    writeStubs({ staleTable: false });
    const { out, code } = runWorker();
    expect(code, '워커가 비정상 종료하면 요약이 맞아도 실패다').toBe(0);
    expect(out, 'handoff 집계').toMatch(/handoff 1/);
    expect(out, 'transient 집계').toMatch(/transient-deferred 1/);
    expect(out, 'budget 집계(deterministic+internal)').toMatch(/budget-burned 2/);
    expect(out, '운영 에스컬레이션 신호').toMatch(/INTERNAL failures 1/);
  });

  it('구버전 표(필드 누락)에서도 INTERNAL 경보가 살아남는다 (R14 수정의 회귀 보호)', () => {
    writeStubs({ staleTable: true });
    const { out, code } = runWorker();
    expect(code, '구버전 표에서도 워커는 정상 종료해야 한다').toBe(0);
    // 수정 전 소스는 rep.bucket/rep.escalate 가 undefined 라 유령 버킷에 집계되고
    // 경보가 통째로 사라졌다 — 그때 이 단언이 실패한다.
    expect(out, '필드 누락 시 경보가 무음으로 사라지면 안 된다').toMatch(/INTERNAL failures/);
    expect(out, '미지 버킷은 budget 으로 흡수돼야 한다').toMatch(/budget-burned/);
    expect(out, '유령 버킷 키가 노출되면 안 된다').not.toMatch(/undefined/);
  });

  it('R16: 세션 1건의 DB 오류가 배치 전체를 죽이지 않는다 (요약·경보 생존)', () => {
    writeStubs({ staleTable: false });
    // 이 테스트의 유일한 실패는 **선점 이전 DB 오류**여야 한다 — 추출은 성공시킨다.
    // (다른 실패가 섞이면 budget-burned 가 그쪽에서 나와 단언이 무의미해진다.)
    fs.writeFileSync(path.join(sandbox, 'dist', 'fact-extractor.js'), `
export async function runFactExtraction() { return { extracted: 0, saved: 0 }; }
export function classifyExtractionFailure() { return 'internal'; }
export const FAILURE_REPORT = {
  handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
  provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
  provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
  internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
    // 2번째 세션의 sessionProject 조회에서 SQLITE_BUSY 를 던지게 만든다.
    const dbStub = path.join(sandbox, 'dist', 'db.js');
    fs.writeFileSync(dbStub, `
let getCalls = 0;
export function initDatabase() {
  return {
    prepare: (sql) => ({
      all: () => [],
      get: () => {
        // sessionProject 의 cwd 조회에서만 던진다(2번째 세션).
        if (String(sql).includes('cwd')) { getCalls++; if (getCalls === 2) throw new Error('database is locked'); }
        return undefined;
      },
      run: () => ({ changes: 0 }),
    }),
    transaction: (fn) => fn, close: () => {}, pragma: () => {},
  };
}
`);
    const { out, code } = runWorker();
    // 수정 전에는 여기서 'FATAL database is locked' 만 남고 요약줄이 통째로 사라졌다.
    expect(code, '한 세션 오류로 워커가 비정상 종료하면 안 된다').toBe(0);
    expect(out, '요약줄이 사라지면 무슨 일이 있었는지 알 수 없다').toMatch(/done this run/);
    expect(out, '나머지 세션은 계속 처리돼야 한다').toMatch(/sessions 4/);
    expect(out, '일회성 흡수 시 경보 없음').not.toMatch(/INTERNAL failures/);
    // 🚨 이 단언은 세 번 틀렸었다: budget(거짓 회계 R17) → transient 무기한(기아 R18)
    // → 'unknown' 진행(영구 오귀속 R19).
    // **일회성** SQLITE_BUSY 는 유계 재시도가 흡수하는 것이 정답이다 — 세션은 정상
    // 처리되고 아무 실패도 보고되지 않는다. (지속 실패는 별도 테스트가 덮는다.)
    expect(out, '일회성 락은 재시도로 흡수 — 오귀속도 실패 보고도 없어야').not.toMatch(/project_lookup/);
    expect(out, "'unknown' 오귀속 금지").not.toMatch(/WARN project 조회 실패/);
    expect(out, '일회성 락은 예산 대상이 아니다').not.toMatch(/budget-burned/);
  });

  // ⚠️ 이 테스트는 **기아를 검증하지 않는다.** runWorker 스텁이 pendingSessions 반환을
  //    4세션으로 하드코딩 치환하므로 run 간 재선정이 일어나지 않는다 — 기아로는 실패할
  //    수 없다(Codex R20 이 vacuous 로 지적). 검증하는 것은 "지속 실패 시 잘못된 귀속을
  //    남기지 않는가" 하나다. 기아 특성(실패셋이 MAX_SESSIONS 를 포화할 때만 발생하며
  //    그 조건은 DB 전역 고장이고 매 run 경보가 뜬다)은 리뷰어가 다중 run 으로 실측했다.
  it('R18: 지속 실패해도 잘못된 귀속을 남기지 않는다 (기아 검증 아님 — 위 주석 참조)', () => {
    writeStubs({ staleTable: false });
    // project 조회가 **항상** 실패하는 DB. 예전 구현이면 이 세션들이 마커 없이 매 run
    // 재선정돼(ORDER BY ts DESC LIMIT) 오래된 세션이 영원히 진입하지 못했다.
    fs.writeFileSync(path.join(sandbox, 'dist', 'db.js'), `
export function initDatabase() {
  return {
    prepare: (sql) => ({
      all: () => [],
      get: () => { if (String(sql).includes('cwd')) throw new Error('database is locked'); return undefined; },
      run: () => ({ changes: 0 }),
    }),
    transaction: (fn) => fn, close: () => {}, pragma: () => {},
  };
}
`);
    // 추출은 성공시킨다 — 실패 사유는 project 조회뿐이어야 한다.
    fs.writeFileSync(path.join(sandbox, 'dist', 'fact-extractor.js'), `
export async function runFactExtraction() { return { extracted: 0, saved: 0 }; }
export function classifyExtractionFailure() { return 'internal'; }
export const FAILURE_REPORT = {
  handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
  provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
  provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
  internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
    const { out, code } = runWorker();
    expect(code).toBe(0);
    // 🚨 핵심 계약: **일시 오류가 영구 오귀속을 만들지 않는다.** 'unknown' 으로 진행하면
    // fact 가 가짜 프로젝트에 영구 귀속되고 완료 마커가 재시도까지 막는다(R19 HIGH).
    expect(out, "'unknown' 으로 진행하면 안 된다").not.toMatch(/WARN project 조회 실패/);
    expect(out, '전용 사유로 건너뛴다').toMatch(/project_lookup/);
    expect(out, '경보로 표면화').toMatch(/INTERNAL failures 4/);
    // 마커를 안 남기므로 다음 run 에 그대로 재시도된다(손실 없음).
    expect(out, '예산을 태우면 안 된다').not.toMatch(/budget-burned/);
    // 이 스텁은 run 간 재선정을 재현하지 못하므로 기아 여부는 여기서 주장하지 않는다.
  });

  it('R19: 정상 제외(excluded_project)를 실패로 오보고하지 않는다', () => {
    writeStubs({ staleTable: false });
    fs.writeFileSync(path.join(sandbox, 'dist', 'fact-extractor.js'), `
export async function runFactExtraction() { return { extracted: 0, saved: 0, skipped: 'excluded_project' }; }
export function classifyExtractionFailure() { return 'internal'; }
export const FAILURE_REPORT = {
  handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
  provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
  provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
  internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
    const { out, code } = runWorker();
    expect(code).toBe(0);
    // 영구 마커가 써진 정상 흐름이다 — 재시도 주장도 INTERNAL 경보도 거짓이 된다.
    expect(out, '정상 제외는 재시도 대상이 아니다').not.toMatch(/transient-deferred/);
    expect(out, '정상 제외는 운영 경보가 아니다').not.toMatch(/INTERNAL failures/);
    expect(out, '제외 사실 자체는 남아야 한다').toMatch(/excluded_project/);
  });

  it('R18: claim 미획득을 정상 처리로 계상하지 않는다 (무경보 기아 방지)', () => {
    writeStubs({ staleTable: false });
    // runFactExtraction 이 skipped 를 돌려주는 상황(다른 러너가 선점).
    fs.writeFileSync(path.join(sandbox, 'dist', 'fact-extractor.js'), `
export async function runFactExtraction() { return { extracted: 0, saved: 0, skipped: 'claim_not_acquired' }; }
export function classifyExtractionFailure() { return 'internal'; }
export const FAILURE_REPORT = {
  handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
  provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
  provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
  internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
};
`);
    const { out, code } = runWorker();
    expect(code).toBe(0);
    // 구분하지 않으면 done++ 만 되고 요약에 아무 신호가 없다(detached 는 stdout 도 버린다).
    expect(out, 'claim 미획득이 요약에 보여야 한다').toMatch(/handoff 4/);
    expect(out, '세션별로도 남아야 한다').toMatch(/claim_not_acquired/);
  });

  it('R17: 격리된 예외가 요약에서 사라지지 않는다 (과소계상 방지)', () => {
    writeStubs({ staleTable: false });
    // 분류기 자체가 던지게 만들어 fn 의 자체 격리를 뚫는다 → runPool 이중 catch 경로.
    const fe = path.join(sandbox, 'dist', 'fact-extractor.js');
    fs.writeFileSync(fe, `
export async function runFactExtraction() { throw new Error('boom'); }
export function classifyExtractionFailure() { throw new Error('classifier exploded'); }
export const FAILURE_REPORT = {};
`);
    const { out, code } = runWorker();
    expect(code, '격리 경로에서도 정상 종료').toBe(0);
    // 삼키면 done 에도 buckets 에도 안 잡혀 "sessions 0" 으로 조용히 끝난다.
    expect(out, '격리 건수가 표면화돼야 한다').toMatch(/isolated-exceptions 4/);
  });
});
