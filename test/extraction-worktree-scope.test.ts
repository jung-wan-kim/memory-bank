import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * worktree 에서 끝난 세션의 사실 범위 (2026-11-10).
 *
 * scope_project 는 세션이 끝난 순간의 cwd 였다. worktree 에서 끝난 세션의 사실은
 * worktree 경로에 묶이고, 그 폴더가 지워진 뒤에는 어느 저장소에서도 보이지 않았다
 * (운영 DB 읽기 전용 조회: 활성 project 사실 24,544건 중 worktree 보관 폴더 경로에 묶인
 * 것 2,296건·152개 경로, 그 가운데 폴더가 이미 없는 것 1,602건·120개 경로).
 * 추출 시점에는 폴더가 있어 본 저장소를 알 수 있으므로, 그때 저장소 루트로 저장한다.
 * 판정은 project-family.ts 의 resolveRepoRoots(.git 파일의 역참조까지 확인).
 */

let reply: unknown[] = [];
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => JSON.stringify(reply),
}));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
}));

let root: string;
let R: string;        // 본 저장소
let W: string;        // R 안의 linked worktree
let E: string;        // R 밖의 linked worktree
let PLAIN: string;    // 저장소가 아닌 폴더

/** git 이 남기는 모양의 저장소 루트: HEAD 가 든 `.git/`. */
function makeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

function linkWorktree(worktreeTop: string, repo: string, name: string): void {
  const admin = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/wt\n');
  fs.mkdirSync(worktreeTop, { recursive: true });
  fs.writeFileSync(path.join(worktreeTop, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(worktreeTop, '.git')}\n`);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-wt-scope-')));
  R = path.join(root, 'proj', 'app');
  makeRepo(R);
  fs.mkdirSync(path.join(R, 'docs'), { recursive: true });
  W = path.join(R, '.claude', 'worktrees', 'signup');
  linkWorktree(W, R, 'signup');
  fs.mkdirSync(path.join(W, 'src'), { recursive: true });
  E = path.join(root, 'elsewhere', 'wt');
  linkWorktree(E, R, 'ext');
  PLAIN = path.join(root, 'plain');
  fs.mkdirSync(PLAIN, { recursive: true });
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

let tmp: string;
let db: import('better-sqlite3').Database;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-wt-scope-db-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  process.env.BACKFILL_EXCLUDE_PROJECTS = path.join(root, 'no-such-excluded-repo');
  (await import('../src/project-family.js')).clearRepoRootCache();
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
  const ins = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  for (let i = 0; i < 2; i++) {
    ins.run(`wt-${i}`, '-proj-app', `2026-10-01T0${i}:00:00.000Z`,
      '가입 흐름에서 이메일 인증을 필수로 할지 결정해 주세요. 근거도 알려주세요.',
      '이메일 인증을 필수로 합니다. 결제 분쟁 때 본인 확인 근거가 필요하기 때문입니다.',
      `/tmp/wt-${i}.jsonl`, 1, 10, 'S-wt', W);
  }
  reply = [
    { fact: 'Signup requires a verified email address.', category: 'decision', scope_type: 'project', confidence: 0.9 },
    { fact: 'User wants reasons stated with every decision.', category: 'preference', scope_type: 'global', confidence: 0.9 },
  ];
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  delete process.env.BACKFILL_EXCLUDE_PROJECTS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const scopes = () => db.prepare('SELECT scope_type, scope_project FROM facts ORDER BY rowid').all() as
  Array<{ scope_type: string; scope_project: string | null }>;

describe('extractionScopeProject', () => {
  it('linked worktree(안·밖, 하위 폴더 포함)는 본 저장소 루트로 읽는다', async () => {
    const { extractionScopeProject } = await import('../src/fact-extractor.js');
    expect(extractionScopeProject(W)).toBe(R);
    expect(extractionScopeProject(path.join(W, 'src'))).toBe(R);
    expect(extractionScopeProject(E)).toBe(R);
  });

  it('worktree 가 아니면 받은 경로 그대로다 — 저장소 루트, 그 하위 폴더, 저장소 아닌 폴더, 없는 경로', async () => {
    const { extractionScopeProject } = await import('../src/fact-extractor.js');
    expect(extractionScopeProject(R)).toBe(R);
    expect(extractionScopeProject(path.join(R, 'docs'))).toBe(path.join(R, 'docs'));
    expect(extractionScopeProject(PLAIN)).toBe(PLAIN);
    // 지워진 worktree: 어느 저장소였는지 디스크에 남은 것이 없다 — 추측하지 않는다.
    const gone = path.join(R, '.claude', 'worktrees', 'gone');
    expect(extractionScopeProject(gone)).toBe(gone);
    expect(extractionScopeProject('unknown')).toBe('unknown');
  });
});

describe('worktree 에서 끝난 세션의 추출', () => {
  it('project 사실은 본 저장소 루트 범위로 저장되고, global 사실은 범위가 없다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-wt', W);

    expect(result.saved).toBe(2);
    expect(scopes()).toEqual([
      { scope_type: 'project', scope_project: R },
      { scope_type: 'global', scope_project: null },
    ]);
    expect(result.scopeProject, '어디로 옮겨 저장했는지 결과에 남는다').toBe(R);
  });

  it('저장소 루트에서 끝난 세션은 예전과 같다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-wt', R);
    expect(scopes()[0]).toEqual({ scope_type: 'project', scope_project: R });
    expect(result.scopeProject).toBeUndefined();
  });

  it('본 저장소가 추출 제외 목록에 있으면 옮기지 않는다 — 제외된 범위에 사실을 넣지 않는다', async () => {
    process.env.BACKFILL_EXCLUDE_PROJECTS = R;
    const { runFactExtraction, extractionScopeProject } = await import('../src/fact-extractor.js');
    expect(extractionScopeProject(E)).toBe(E);

    // 저장소 밖의 worktree: 추출 여부는 예전과 같고(추출됨) 범위도 예전 그대로다.
    const result = await runFactExtraction(db, 'S-wt', E);
    expect(result.skipped).toBeUndefined();
    expect(scopes()[0]).toEqual({ scope_type: 'project', scope_project: E });
    expect(result.scopeProject).toBeUndefined();
    expect(scopes().filter((s) => s.scope_project === R)).toEqual([]);
  });

  it('제외된 저장소 안의 worktree 는 예전처럼 추출하지 않는다', async () => {
    process.env.BACKFILL_EXCLUDE_PROJECTS = R;
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-wt', W);
    expect(result.skipped).toBe('excluded_project');
    expect(scopes()).toEqual([]);
  });
});
