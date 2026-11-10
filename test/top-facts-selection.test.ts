import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact, getTopFacts, topFactsGlobalMax, TOP_FACTS_GLOBAL_MAX } from '../src/fact-db.js';
import { clearRepoRootCache } from '../src/project-family.js';
import { suppressConsole } from './test-utils.js';

/**
 * 세션 시작 'Project Key Facts' 선정 순서 (2026-11-10, 감사 INJ-03).
 *
 * 예전 점수는 확인 횟수의 로그가 지배했다. 그 횟수는 「독립 확인」이 아니라 「중복 병합」 횟수라
 * 매 세션 컨텍스트에 실리는 전역 사실일수록 커지고(메모리 파일 유래 25회 등), 1회짜리 프로젝트
 * 사실은 최대 13점이라 15.5점 이상인 전역 상위를 이길 수 없었다. 프로젝트 사실 96.6% 가 1회라
 * 프로젝트 몫은 동점 중 임의였고(정렬 보조 키 없음), 조회가 scope_project 정확 일치라 하위 폴더·
 * worktree 세션은 저장소의 사실을 못 받았다.
 *  - 프로젝트(저장소 가족 scope) 사실이 먼저, 전역 사실은 뒤에 최대 TOP_FACTS_GLOBAL_MAX 건
 *  - 확인 횟수의 점수 기여에 상한
 *  - 동점은 최근 갱신 → id 순으로 고정
 */

const restoreConsole = suppressConsole();
const REPO_ROOT = path.resolve(__dirname, '..');
let tmp: string;
let dbPath: string;
let db: Database.Database;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

type Seed = { fact: string; scope?: string | null; count?: number; updatedMsAgo?: number; id?: string; active?: boolean };
/** 사실 하나를 넣고, 필요한 열(횟수·갱신 시각·id·활성)을 결정론 값으로 덮어쓴다. 반환: 최종 id. */
function seed(s: Seed): string {
  const scope = s.scope === undefined ? null : s.scope;
  let id = insertFact(db, {
    fact: s.fact, category: 'knowledge', scope_type: scope ? 'project' : 'global', scope_project: scope,
    source_exchange_ids: [], embedding: null,
  });
  if (s.id) { db.prepare('UPDATE facts SET id = ? WHERE id = ?').run(s.id, id); id = s.id; }
  db.prepare('UPDATE facts SET consolidated_count = ?, updated_at = ?, is_active = ? WHERE id = ?')
    .run(s.count ?? 1, iso(s.updatedMsAgo ?? HOUR), s.active === false ? 0 : 1, id);
  return id;
}

/** `.git/HEAD` 를 가진 폴더 = 저장소 루트 (project-family.ts 는 디스크만 읽는다). */
function makeRepo(dir: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-top-facts-')));
  dbPath = path.join(tmp, 'test.db');
  process.env.TEST_DB_PATH = dbPath;
  db = initDatabase();
  clearRepoRootCache();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getTopFacts — 프로젝트 우선·전역 칸 상한', () => {
  it('전역 사실의 확인 횟수가 훨씬 높아도 프로젝트 사실이 앞 7칸을 차지하고 전역은 뒤 3칸뿐이다', () => {
    // 감사가 본 라이브 모양: 전역 25회·22회·20회 … 대 프로젝트 전부 1회
    for (let i = 0; i < 8; i++) seed({ fact: `Global memory note ${i}`, count: 25 - i, updatedMsAgo: HOUR });
    for (let i = 0; i < 12; i++) seed({ fact: `Project fact ${i}`, scope: '/proj', count: 1, updatedMsAgo: (i + 1) * HOUR });

    const top = getTopFacts(db, '/proj', 10);
    expect(top).toHaveLength(10);
    expect(top.map((f) => f.scope_type)).toEqual([...Array(7).fill('project'), ...Array(3).fill('global')]);
    expect(TOP_FACTS_GLOBAL_MAX).toBe(3);
    // 프로젝트 몫(전부 1회·최근 7일 안 = 같은 점수)은 최근 갱신 순
    expect(top.slice(0, 7).map((f) => f.fact)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `Project fact ${i}`));
    expect(top.slice(7).every((f) => f.fact.startsWith('Global memory note'))).toBe(true);
  });

  it('프로젝트 사실이 모자라도 전역 사실이 그 자리를 채우지 않는다 (상한은 상한이다)', () => {
    for (let i = 0; i < 8; i++) seed({ fact: `Global note ${i}`, count: 10 });
    seed({ fact: 'Only project fact A', scope: '/proj' });
    seed({ fact: 'Only project fact B', scope: '/proj' });
    const top = getTopFacts(db, '/proj', 10);
    expect(top.map((f) => f.scope_type)).toEqual(['project', 'project', 'global', 'global', 'global']);
  });

  it('전역 사실이 상한보다 적으면 남는 칸은 프로젝트 사실이 쓴다', () => {
    seed({ fact: 'The one global fact', count: 30 });
    for (let i = 0; i < 12; i++) seed({ fact: `Project fact ${i}`, scope: '/proj', updatedMsAgo: (i + 1) * HOUR });
    const top = getTopFacts(db, '/proj', 10);
    expect(top.map((f) => f.scope_type)).toEqual([...Array(9).fill('project'), 'global']);
  });

  it('globalMax 로 전역 칸 수를 바꾼다 (0 = 전역 없음, limit 보다 크면 limit)', () => {
    for (let i = 0; i < 12; i++) seed({ fact: `Global note ${i}`, count: 10, updatedMsAgo: (i + 1) * HOUR });
    for (let i = 0; i < 12; i++) seed({ fact: `Project fact ${i}`, scope: '/proj', updatedMsAgo: (i + 1) * HOUR });
    expect(getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.scope_type)).toEqual(Array(10).fill('project'));
    expect(getTopFacts(db, '/proj', 10, { globalMax: 5 }).filter((f) => f.scope_type === 'global')).toHaveLength(5);
    expect(getTopFacts(db, '/proj', 4, { globalMax: 99 }).map((f) => f.scope_type)).toEqual(Array(4).fill('global'));
  });

  it('다른 프로젝트·비활성 사실은 어느 칸에도 들어오지 않는다', () => {
    seed({ fact: 'Mine', scope: '/proj' });
    seed({ fact: 'Other project fact', scope: '/other', count: 50 });
    seed({ fact: 'Retired project fact', scope: '/proj', count: 50, active: false });
    seed({ fact: 'Retired global fact', count: 50, active: false });
    seed({ fact: 'Live global fact' });
    expect(getTopFacts(db, '/proj', 10).map((f) => f.fact)).toEqual(['Mine', 'Live global fact']);
  });
});

describe('getTopFacts — 확인 횟수 기여 상한', () => {
  it('횟수가 상한을 넘으면 더 올라가지 않는다 — 25회 옛 사실이 4회 최근 사실을 이기지 못한다', () => {
    // 둘 다 최근 7일 안(최근성 동점): 횟수 기여가 상한에서 같아지고 최근 갱신이 가른다
    const old25 = seed({ fact: 'Merged 25 times', scope: '/proj', count: 25, updatedMsAgo: 3 * DAY });
    const new4 = seed({ fact: 'Merged 4 times', scope: '/proj', count: 4, updatedMsAgo: HOUR });
    expect(getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.id)).toEqual([new4, old25]);
  });

  it('상한 아래에서는 횟수가 여전히 순위를 가른다 (2회 > 1회, 같은 최근성)', () => {
    const once = seed({ fact: 'Seen once', scope: '/proj', count: 1, updatedMsAgo: HOUR });
    const twice = seed({ fact: 'Seen twice', scope: '/proj', count: 2, updatedMsAgo: 2 * DAY });
    expect(getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.id)).toEqual([twice, once]);
  });

  it('최근성이 횟수 상한을 이긴다 — 100일 전 25회 사실보다 어제의 1회 사실이 앞이다', () => {
    const stale = seed({ fact: 'Old and merged often', scope: '/proj', count: 25, updatedMsAgo: 100 * DAY });
    const fresh = seed({ fact: 'New and seen once', scope: '/proj', count: 1, updatedMsAgo: DAY });
    expect(getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.id)).toEqual([fresh, stale]);
  });
});

describe('getTopFacts — 결정론적 동률 처리', () => {
  it('점수가 같으면 최근 갱신이 먼저, 갱신 시각까지 같으면 id 오름차순 — 넣은 순서와 무관하다', () => {
    const same = iso(5 * HOUR);
    // 일부러 뒤섞어 넣는다 (rowid 순서 ≠ 기대 순서)
    const ids = {
      c: seed({ fact: 'tie c', scope: '/proj', id: 'cccccccc-0000-4000-8000-000000000000' }),
      newest: seed({ fact: 'newest', scope: '/proj', updatedMsAgo: HOUR }),
      a: seed({ fact: 'tie a', scope: '/proj', id: 'aaaaaaaa-0000-4000-8000-000000000000' }),
      older: seed({ fact: 'older', scope: '/proj', updatedMsAgo: 2 * DAY }),
      b: seed({ fact: 'tie b', scope: '/proj', id: 'bbbbbbbb-0000-4000-8000-000000000000' }),
    };
    for (const id of [ids.a, ids.b, ids.c]) db.prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run(same, id);

    const expected = [ids.newest, ids.a, ids.b, ids.c, ids.older];
    const first = getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.id);
    expect(first).toEqual(expected);
    // 같은 입력에 같은 순서 — 다시 불러도, 연결을 새로 열어도
    expect(getTopFacts(db, '/proj', 10, { globalMax: 0 }).map((f) => f.id)).toEqual(expected);
    const again = new Database(dbPath, { readonly: true });
    try { expect(getTopFacts(again, '/proj', 10, { globalMax: 0 }).map((f) => f.id)).toEqual(expected); } finally { again.close(); }
  });

  it('동점이 limit 보다 많아도 잘리는 경계가 고정이다 (97건 동점이던 프로젝트 몫)', () => {
    const same = iso(HOUR);
    const all: string[] = [];
    for (let i = 0; i < 30; i++) all.push(seed({ fact: `tied ${i}`, scope: '/proj' }));
    db.prepare("UPDATE facts SET updated_at = ? WHERE scope_project = '/proj'").run(same);
    const expected = [...all].sort().slice(0, 7);
    expect(getTopFacts(db, '/proj', 7, { globalMax: 0 }).map((f) => f.id)).toEqual(expected);
  });

  it('전역 몫의 동점도 같은 규칙이다', () => {
    const same = iso(HOUR);
    const g: string[] = [];
    for (let i = 0; i < 9; i++) g.push(seed({ fact: `global tied ${i}`, count: 30 }));
    db.prepare("UPDATE facts SET updated_at = ? WHERE scope_type = 'global'").run(same);
    expect(getTopFacts(db, '/nowhere', 10).map((f) => f.id)).toEqual([...g].sort().slice(0, 3));
  });
});

describe('getTopFacts — 저장소 가족 scope', () => {
  it('하위 폴더·연결된 worktree 세션이 저장소의 프로젝트 사실을 받고, 저장소 세션은 그 안 worktree 의 사실을 받는다', () => {
    const R = path.join(tmp, 'proj', 'app');
    makeRepo(R);
    fs.mkdirSync(path.join(R, 'docs'), { recursive: true });
    const W = path.join(R, '.claude', 'worktrees', 'feat-1');
    const admin = path.join(R, '.git', 'worktrees', 'feat-1');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/feat-1\n');
    fs.mkdirSync(W, { recursive: true });
    fs.writeFileSync(path.join(W, '.git'), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(W, '.git')}\n`);

    const repoFact = seed({ fact: 'Repo decision', scope: R, updatedMsAgo: 2 * HOUR });
    const wtFact = seed({ fact: 'Worktree finding', scope: W, updatedMsAgo: 3 * HOUR });
    seed({ fact: 'Sibling repo fact', scope: path.join(tmp, 'proj', 'app-extra') });

    // 예전(정확 일치)에는 하위 폴더 세션이 프로젝트 사실 0건이었다
    expect(getTopFacts(db, path.join(R, 'docs'), 10, { globalMax: 0 }).map((f) => f.id)).toEqual([repoFact, wtFact]);
    // cwd 자신의 scope 가 같은 가족의 다른 scope 보다 앞이다
    expect(getTopFacts(db, W, 10, { globalMax: 0 }).map((f) => f.id)).toEqual([wtFact, repoFact]);
    expect(getTopFacts(db, R, 10, { globalMax: 0 }).map((f) => f.id)).toEqual([repoFact, wtFact]);
  });

  it('저장소가 아닌 경로(없는 경로 포함)는 예전처럼 정확히 같은 scope 만 본다', () => {
    const mine = seed({ fact: 'Exact scope fact', scope: '/tmp/mb-no-such-dir/x' });
    seed({ fact: 'Child path fact', scope: '/tmp/mb-no-such-dir/x/sub' });
    expect(getTopFacts(db, '/tmp/mb-no-such-dir/x', 10, { globalMax: 0 }).map((f) => f.id)).toEqual([mine]);
  });
});

describe('topFactsGlobalMax — MEMORY_BANK_KEY_FACTS_GLOBAL_MAX', () => {
  it('0 이상의 정수만 받고, 그 밖의 값은 기본값(3)이다', () => {
    expect(topFactsGlobalMax(undefined)).toBe(3);
    expect(topFactsGlobalMax('')).toBe(3);
    expect(topFactsGlobalMax('0')).toBe(0);
    expect(topFactsGlobalMax('5')).toBe(5);
    expect(topFactsGlobalMax(' 2 ')).toBe(2);
    for (const bad of ['-1', '1.5', 'many', '3x', 'NaN', 'Infinity']) expect(topFactsGlobalMax(bad), bad).toBe(3);
  });
});

describe('SessionStart 훅 — 블록에 실리는 순서', () => {
  function runHook(env: Record<string, string> = {}): string {
    return execFileSync(process.execPath, ['scripts/fact-consolidate-hook.js'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ session_id: 'top-facts-0001', cwd: '/tmp/mb-top-facts-proj', hook_event_name: 'SessionStart', source: 'startup' }),
      env: {
        ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_SESSION_START_SPAWN: '0',
        MEMORY_BANK_SESSION_CONTINUITY: '', MEMORY_BANK_INTENT_PROFILE: '', MEMORY_BANK_KEY_FACTS_GLOBAL_MAX: '', ...env,
      },
    });
  }
  const factLines = (out: string) => out.split('\n').filter((l) => l.startsWith('- ['));

  it('프로젝트 사실이 블록 맨 위, 횟수 높은 전역 사실은 그 뒤 3줄까지', () => {
    for (let i = 0; i < 6; i++) seed({ fact: `Global memory note number ${i}`, count: 25 - i });
    for (let i = 0; i < 4; i++) seed({ fact: `Project decision number ${i}`, scope: '/tmp/mb-top-facts-proj', updatedMsAgo: (i + 1) * HOUR });
    const lines = factLines(runHook());
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 4).map((l) => /Project decision number (\d)/.exec(l)?.[1])).toEqual(['0', '1', '2', '3']);
    expect(lines.slice(4).every((l) => l.includes('Global memory note number'))).toBe(true);
  });

  it('MEMORY_BANK_KEY_FACTS_GLOBAL_MAX 로 전역 줄 수를 바꾼다', () => {
    for (let i = 0; i < 6; i++) seed({ fact: `Global memory note number ${i}`, count: 25 - i });
    seed({ fact: 'Project decision number 0', scope: '/tmp/mb-top-facts-proj' });
    expect(factLines(runHook({ MEMORY_BANK_KEY_FACTS_GLOBAL_MAX: '0' }))).toHaveLength(1);
    expect(factLines(runHook({ MEMORY_BANK_KEY_FACTS_GLOBAL_MAX: '5' }))).toHaveLength(6);
  });
});
