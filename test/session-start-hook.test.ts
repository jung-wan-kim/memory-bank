import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { factTextKey } from '../src/fact-text.js';
import Database from 'better-sqlite3';

/**
 * SessionStart 훅 회귀 (2026-10-03).
 *  - hooks.json 에서 async 가 빠져야 Claude Code 가 출력(핵심 fact)을 세션에 넣는다
 *  - 훅은 출력만 하고 느린 대기 작업 확인은 분리된 스크립트로 넘긴다
 *  - 지난 세션 이어가기·사용 패턴은 슬러그 비교를 고쳤지만 기본 꺼짐
 *  - 동기 훅이라 첫 응답을 막는다: 쓰기 잠금을 기다리지 않고(읽기 전용), 임베딩 모델을
 *    불러오지 않으며, 출력한 fact 는 세션 원장에 남겨 첫 프롬프트에서 다시 싣지 않는다
 */

const REPO = path.resolve(__dirname, '..');
const PROJECT = '/tmp/mb-ss-proj_a';
const SLUG = '-tmp-mb-ss-proj-a';
let tmp: string;

const hookEnv = (env: Record<string, string> = {}) => ({
  ...process.env,
  MEMORY_BANK_CONFIG_DIR: tmp,
  MEMORY_BANK_DB_PATH: path.join(tmp, 't.sqlite'),
  MEMORY_BANK_SESSION_START_SPAWN: '0', // 픽스처 DB 로 LLM 워커를 띄우지 않는다
  MEMORY_BANK_SESSION_CONTINUITY: '',
  MEMORY_BANK_INTENT_PROFILE: '',
  ...env,
});
const ledgerPath = (sid: string) => path.join(tmp, 'conversation-index', 'state', 'inject-ledger', `${sid}.json`);

function runHook(env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ['scripts/fact-consolidate-hook.js'], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ session_id: 'ss-test-0001', cwd: PROJECT, hook_event_name: 'SessionStart' }),
    env: hookEnv(env),
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-session-start-'));
  const prev = process.env.TEST_DB_PATH;
  process.env.TEST_DB_PATH = path.join(tmp, 't.sqlite');
  try {
    const db = initDatabase();
    insertFact(db, {
      fact: 'Release notes are written in Korean and attached to the GitHub release',
      category: 'decision', scope_type: 'project', scope_project: PROJECT,
      source_exchange_ids: [], embedding: null,
    });
    insertExchange(db, {
      id: 'ss-ex-1', project: SLUG, timestamp: '2026-09-30T10:00:00Z',
      userMessage: '지난번 릴리즈 노트 작업 이어서 하자', assistantMessage: '릴리즈 노트 초안을 CHANGELOG 에 반영했습니다 — 다음은 태그 생성',
      archivePath: '/archive/ss.jsonl', lineStart: 1, lineEnd: 2, sessionId: 'prev-session-1', cwd: PROJECT,
    }, new Array(384).fill(0.01));
    db.close();
  } finally {
    if (prev === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = prev;
  }
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('SessionStart 훅', () => {
  it('hooks.json 의 fact-consolidate-hook 은 동기 실행이다 (async 면 Claude Code 에 출력이 안 들어간다)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));
    const entries = cfg.hooks.SessionStart.flatMap((g: { hooks: Array<Record<string, unknown>> }) => g.hooks);
    const hook = entries.find((h: Record<string, unknown>) => String(h.command).includes('fact-consolidate-hook.js'));
    expect(hook, 'fact-consolidate-hook 등록').toBeDefined();
    expect(hook.async, 'async 금지').toBeUndefined();
    expect(Number(hook.timeout)).toBeGreaterThan(0);
    expect(Number(hook.timeout), '첫 응답을 막는 최대 시간(초)').toBeLessThanOrEqual(5);
  });

  it('핵심 fact 를 평문으로 출력하고, 연속성·사용 패턴은 기본으로 끈다', () => {
    const out = runHook();
    expect(out).toContain('# Project Key Facts (auto-recalled)');
    expect(out).toContain('Release notes are written in Korean');
    expect(out.trimStart().startsWith('{'), 'JSON 으로 해석되면 평문 문맥이 버려진다').toBe(false);
    expect(out).not.toContain('지난번 릴리즈 노트');
  });

  it('MEMORY_BANK_SESSION_CONTINUITY=1 이면 cwd 절대경로로 슬러그 교환의 지난 세션을 찾는다', () => {
    const out = runHook({ MEMORY_BANK_SESSION_CONTINUITY: '1' });
    expect(out).toContain('지난번 릴리즈 노트');
  });

  it('출력한 fact 는 id 와 본문 키로 세션 원장에 남는다', () => {
    runHook();
    const ledgerFile = path.join(tmp, 'conversation-index', 'state', 'inject-ledger', 'ss-test-0001.json');
    expect(fs.existsSync(ledgerFile), '세션 원장 파일이 생겼다').toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const db = new Database(path.join(tmp, 't.sqlite'), { readonly: true });
    const row = db.prepare("SELECT id, fact FROM facts WHERE fact LIKE 'Release notes%'").get() as { id: string; fact: string };
    db.close();
    expect(ledger).toContain(row.id);
    expect(ledger).toContain(factTextKey(row));
  });

  it('출력을 받는 쪽이 파이프를 닫아 전달에 실패하면 원장에 기록하지 않는다', async () => {
    // 위 테스트가 양성 대조다 — 같은 DB·같은 훅에서 전달되면 원장이 생긴다.
    const sid = 'ss-test-epipe';
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ['scripts/fact-consolidate-hook.js'], {
        cwd: REPO, env: hookEnv(), stdio: ['pipe', 'pipe', 'ignore'],
      });
      child.stdout!.destroy(); // 받는 쪽(Claude Code)이 먼저 떠났다
      child.on('exit', () => resolve());
      child.stdin!.end(JSON.stringify({ session_id: sid, cwd: PROJECT, hook_event_name: 'SessionStart' }));
    });
    expect(fs.existsSync(ledgerPath(sid)), '전달되지 않은 핵심 fact 가 「이미 실음」으로 남으면 그 세션 내내 주입되지 않는다').toBe(false);
  });

  it('다른 프로세스가 쓰기 잠금을 쥐고 있어도 기다리지 않고 fact 를 출력한다', () => {
    const writer = new Database(path.join(tmp, 't.sqlite'));
    writer.pragma('journal_mode = WAL');
    writer.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      const out = runHook();
      const ms = Date.now() - t0;
      expect(out).toContain('Release notes are written in Korean');
      // 열 때마다 쓰기(중복 DELETE)를 하던 initDatabase 는 busy_timeout 5초를 다 기다린 뒤 실패했다
      expect(ms, `훅 소요 ${ms}ms`).toBeLessThan(3000);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('정적 import 사슬에 임베딩 모델(@xenova/transformers)이 없다', () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf8');
      // static imports only — `await import(...)` inside opt-in branches is lazy by design
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (spec.startsWith('../dist/')) walk(path.join(REPO, 'src', spec.slice('../dist/'.length).replace(/\.js$/, '.ts')));
        else if (spec.startsWith('./')) walk(path.join(path.dirname(file), spec.replace(/\.js$/, '.ts')));
        else bare.add(spec);
      }
    };
    walk(path.join(REPO, 'scripts', 'fact-consolidate-hook.js'));
    expect(seen.size, '사슬을 실제로 따라갔다').toBeGreaterThan(4);
    expect([...bare]).not.toContain('@xenova/transformers');
    expect([...seen].map((f) => path.basename(f))).not.toContain('embeddings.ts');
  });

  it('대기 작업 확인 질의는 훅이 아니라 분리된 유지보수 스크립트에 있다', () => {
    const hookSrc = fs.readFileSync(path.join(REPO, 'scripts', 'fact-consolidate-hook.js'), 'utf8');
    const maintSrc = fs.readFileSync(path.join(REPO, 'scripts', 'session-start-maintenance.js'), 'utf8');
    for (const probe of ['buildReembedPending', 'pendingExtractionCoreQuery', 'ontology_category_id IS NULL']) {
      expect(hookSrc.includes(probe), `훅에 ${probe} 가 남아 첫 응답을 늦춘다`).toBe(false);
      expect(maintSrc.includes(probe), `유지보수 스크립트에 ${probe} 없음`).toBe(true);
    }
    expect(hookSrc).toContain("'session-start-maintenance.js'");
  });

  it('유지보수 스크립트가 dist 를 실제로 로드하고 끝난다', () => {
    // 빈 DB — 대기 작업이 없으니 아무 워커도 띄우지 않고 종료해야 한다
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-maint-'));
    try {
      execFileSync(process.execPath, ['scripts/session-start-maintenance.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: empty, MEMORY_BANK_DB_PATH: path.join(empty, 't.sqlite') },
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
