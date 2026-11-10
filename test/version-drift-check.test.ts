import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * SessionStart 버전 드리프트 점검 (2026-11-10, 감사 REL-02).
 *
 * 이 훅은 `async` 로 등록돼 있다. Claude Code 는 비동기 훅의 출력 가운데 JSON 응답의
 * additionalContext·systemMessage 만 전달하므로(훅 문서 "How async hooks execute"), 평문으로
 * 찍던 알림은 어디에도 닿지 않았다(실제 기록: stdout 은 있었고 response 는 '{}').
 * 비교 대상도 「이미 받은 캐시 폴더」뿐이라 아직 받지 않은 새 버전은 볼 수 없었다.
 *  - 알릴 내용은 SessionStart 훅 규격의 JSON 한 줄로 낸다
 *  - 캐시 폴더 + 마켓플레이스 클론의 package.json + 원격 태그(하루 1회 캐시·3초 제한)
 *  - 원격을 확인하지 못하면 「확인 못 함」으로 기록하고, 최신이라고 하지 않는다
 *
 * 스크립트는 가짜 HOME 의 캐시 폴더에 복사해 거기서 실행한다(설치된 모양 그대로).
 * 프로세스 정리(ps → kill)는 가짜 `ps` 가 내놓는 목록에만 작동한다 — 실제 프로세스는 보지 않는다.
 */

const REPO = path.resolve(__dirname, '..');
const MP = 'memory-bank-dev';
let tmp: string;
let home: string;
let cfg: string;
let bin: string;
const children: ChildProcess[] = [];

const pluginsDir = () => path.join(home, '.claude', 'plugins');
const cacheDir = (v: string) => path.join(pluginsDir(), 'cache', MP, 'memory-bank', v);
const marketplaceDir = () => path.join(pluginsDir(), 'marketplaces', MP);
const logLines = (): Array<Record<string, any>> => {
  const f = path.join(cfg, 'conversation-index', 'logs', 'version-drift.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const remoteState = () => JSON.parse(fs.readFileSync(path.join(cfg, 'conversation-index', 'state', 'version-remote.json'), 'utf8'));

/** 설치된 플러그인 한 벌: 스크립트와 그것이 읽는 dist 조각을 그대로 복사하고 package.json 의 버전만 바꾼다. */
function installVersion(v: string, deps: Record<string, string> = { a: '1' }) {
  const dir = cacheDir(v);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  for (const f of ['version-drift-check.js', 'live-apply.js']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(dir, 'scripts', f));
  for (const f of ['version-guard.js', 'paths.js']) fs.copyFileSync(path.join(REPO, 'dist', f), path.join(dir, 'dist', f));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'memory-bank', version: v, type: 'module', dependencies: deps,
    repository: { type: 'git', url: 'https://example.invalid/never-contacted.git' },
  }));
  return dir;
}
function marketplaceClone(v: string) {
  fs.mkdirSync(marketplaceDir(), { recursive: true });
  fs.writeFileSync(path.join(marketplaceDir(), 'package.json'), JSON.stringify({ name: 'memory-bank', version: v }));
}
/** PATH 맨 앞의 가짜 실행 파일. */
function fakeBin(name: string, script: string) {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`);
  fs.chmodSync(path.join(bin, name), 0o755);
}
/** ls-remote 호출을 세고 정해진 태그 목록을 내놓는 가짜 git. */
function fakeGitTags(tags: string[]) {
  const out = tags.map((t, i) => `${String(i).padStart(40, '0')}\trefs/tags/${t}`).join('\n');
  fakeBin('git', `echo "$*" >> "${path.join(tmp, 'git-calls.log')}"\ncat <<'TAGS'\n${out}\nTAGS`);
}
/** 스크립트가 git 에 넘기는 인자의 앞부분 — 저속 제한은 스크립트가 먼저 죽었을 때 git 이 스스로 그만두게 하는 값이다. */
const LS_REMOTE = '-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 ls-remote --tags --refs';
const gitCalls = () => (fs.existsSync(path.join(tmp, 'git-calls.log')) ? fs.readFileSync(path.join(tmp, 'git-calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

type Run = { stdout: string; stderr: string; status: number | null; ms: number };
const HOOK_INPUT = JSON.stringify({ session_id: 'drift-0001', cwd: '/tmp/proj', hook_event_name: 'SessionStart', source: 'startup' });
const scriptOf = (from: string) => path.join(cacheDir(from), 'scripts', 'version-drift-check.js');
const checkEnv = (env: Record<string, string>) => ({
  ...process.env, HOME: home, USERPROFILE: home, MEMORY_BANK_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  PATH: `${bin}:${process.env.PATH}`,
  MEMORY_BANK_DRIFT_SWEEP: '0',      // 기본: 프로세스 정리 끔 (켜는 테스트는 가짜 ps 를 둔다)
  MEMORY_BANK_DRIFT_REMOTE: 'off',   // 기본: 원격 조회 끔 (켜는 테스트는 가짜 git 을 둔다)
  ...env,
});
function runCheck(from: string, env: Record<string, string> = {}): Run {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [scriptOf(from)], { encoding: 'utf8', timeout: 60_000, input: HOOK_INPUT, env: checkEnv(env) });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, ms: Date.now() - t0 };
}
/** 이 프로세스의 이벤트 루프를 막지 않고 실행한다 — 테스트가 띄운 자식이 죽었을 때 거둬들일 수 있어야 할 때. */
function runCheckAsync(from: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [scriptOf(from)], { env: checkEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('close', (status) => resolve({ stdout, stderr, status, ms: Date.now() - t0 }));
    child.stdin.end(HOOK_INPUT);
  });
}
/** stdout 은 비었거나, JSON 한 줄이어야 한다. */
function hookJson(run: Run): { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } } {
  const lines = run.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toHaveLength(1);
  return JSON.parse(lines[0]);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-drift-')));
  home = path.join(tmp, 'home');
  cfg = path.join(tmp, 'cfg');
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // 안전망: 스위치가 어떻게 되든 이 테스트의 스크립트는 실제 프로세스 목록도 실제 원격도 보지 못한다.
  // (실제 ps 를 보면 이 기기에 설치된 옛 버전 작업자를 끝낼 수 있다.)
  fakeBin('ps', 'exit 0');
  fakeBin('git', `echo "$*" >> "${path.join(tmp, 'git-calls.log')}"\nexit 128`);
});
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('version-drift-check — 알림은 SessionStart 훅 규격의 JSON 한 줄', () => {
  it('캐시 1.7.7 + 마켓플레이스 클론 1.7.9 → stdout 이 1.7.9 를 담은 JSON 한 줄', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.9');
    const run = runCheck('1.7.7');
    expect(run.status).toBe(0);
    const out = hookJson(run);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(typeof out.systemMessage).toBe('string');
    expect(out.systemMessage).toContain('1.7.9');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('v1.7.9');
    expect(ctx).toContain('v1.7.7');
    expect(ctx).toContain(`claude plugin update memory-bank@${MP}`);
    expect(run.stdout.endsWith('\n')).toBe(true);
    expect(logLines().at(-1)).toMatchObject({ version: '1.7.7', cache_newest: '1.7.7', marketplace_version: '1.7.9', remote_status: 'off' });
    expect(gitCalls(), 'MEMORY_BANK_DRIFT_REMOTE=off 면 git 을 부르지 않는다').toEqual([]);
  });

  it('같은 상황이면 문구가 글자 그대로 같다 (Claude Code 는 바뀐 문구만 다시 전달한다)', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.9');
    const a = runCheck('1.7.7').stdout;
    const b = runCheck('1.7.7').stdout;
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a);
  });

  it('어긋남이 없으면 아무것도 출력하지 않는다 (최신이라는 문구도 내지 않는다)', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    const run = runCheck('1.7.9');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(logLines().at(-1)).toMatchObject({ version: '1.7.9', cache_newest: '1.7.9', marketplace_version: '1.7.9', remote_status: 'off', notices: [] });
  });

  it('더 새 버전이 캐시에 이미 설치돼 있으면 세션 재시작을 안내한다 (예전 평문 알림의 JSON 판)', () => {
    installVersion('1.7.7');
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    const out = hookJson(runCheck('1.7.7'));
    expect(out.hookSpecificOutput.additionalContext).toMatch(/this session runs v1\.7\.7 but v1\.7\.9 is installed/);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Restart the session/);
  });

  it('마켓플레이스 클론이 없으면(읽을 수 없으면) 그 비교만 빠지고 로그에 null 로 남는다', () => {
    installVersion('1.7.9');
    const run = runCheck('1.7.9');
    expect(run.stdout).toBe('');
    expect(logLines().at(-1)).toMatchObject({ marketplace_version: null });
  });

  it('live-apply 알림도 JSON 으로 나간다 — 옛 캐시 폴더에 새 코드를 옮겼을 때', () => {
    installVersion('1.7.7');
    installVersion('1.7.9');
    const out = hookJson(runCheck('1.7.9'));
    expect(out.hookSpecificOutput.additionalContext).toMatch(/live-applied v1\.7\.9 to 1 older cache dir\(s\): 1\.7\.7\(1\.7\.7→1\.7\.9\)/);
    expect(JSON.parse(fs.readFileSync(path.join(cacheDir('1.7.7'), 'package.json'), 'utf8')).version).toBe('1.7.9');
  });
});

describe('version-drift-check — 원격 태그', () => {
  it('원격 태그가 클론보다 새로우면 그 버전과 마켓플레이스 갱신 명령을 알린다', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.7');
    fakeGitTags(['v1.7.6', 'v1.8.0', 'v1.7.9', 'nightly', 'v2.0.0-rc.1']);
    const run = runCheck('1.7.7', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' });
    const out = hookJson(run);
    expect(out.systemMessage).toContain('1.8.0');
    expect(out.hookSpecificOutput.additionalContext).toContain('v1.8.0');
    expect(out.hookSpecificOutput.additionalContext).toContain(`claude plugin marketplace update ${MP}`);
    expect(out.hookSpecificOutput.additionalContext, '사전 릴리스 태그는 버전으로 세지 않는다').not.toContain('2.0.0');
    expect(gitCalls()).toEqual([`${LS_REMOTE} https://example.invalid/fake.git`]);
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'ok', remote_latest: '1.8.0' });
  });

  it('하루 1회: 두 번째 실행은 git 을 부르지 않고 저장된 결과를 쓴다', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.7');
    fakeGitTags(['v1.8.0']);
    const env = { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' };
    const first = runCheck('1.7.7', env);
    const checkedAt = remoteState().checked_at;
    fakeBin('git', `echo "$*" >> "${path.join(tmp, 'git-calls.log')}"\nexit 128`); // 다시 부르면 실패한다
    const second = runCheck('1.7.7', env);
    expect(gitCalls()).toHaveLength(1);
    expect(second.stdout).toBe(first.stdout);
    expect(remoteState().checked_at).toBe(checkedAt);
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'cached', remote_latest: '1.8.0' });
  });

  it('저장된 결과가 하루를 넘겼거나 원격 주소가 바뀌었으면 다시 조회한다', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.7');
    fakeGitTags(['v1.8.0']);
    const env = { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' };
    runCheck('1.7.7', env);
    const stateFile = path.join(cfg, 'conversation-index', 'state', 'version-remote.json');
    fs.writeFileSync(stateFile, JSON.stringify({ ...remoteState(), checked_at: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    fakeGitTags(['v1.8.0', 'v1.8.1']);
    expect(hookJson(runCheck('1.7.7', env)).systemMessage).toContain('1.8.1');
    expect(gitCalls()).toHaveLength(2);
    runCheck('1.7.7', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/moved.git' });
    expect(gitCalls().at(-1)).toBe(`${LS_REMOTE} https://example.invalid/moved.git`);
    expect(gitCalls()).toHaveLength(3);
  });

  it('원격 조회가 실패하면 「확인 못 함」으로 기록하고 최신이라고 하지 않는다 — 다른 알림은 그대로 낸다', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.9');
    fakeBin('git', 'echo "fatal: unable to access" >&2\nexit 128');
    const run = runCheck('1.7.7', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' });
    const out = hookJson(run);
    expect(out.hookSpecificOutput.additionalContext).toContain('v1.7.9');
    expect(run.stdout).not.toMatch(/up[- ]to[- ]date|latest version|is current/i);
    const line = logLines().at(-1)!;
    expect(line).toMatchObject({ remote_status: 'unknown', remote_latest: null });
    expect(String(line.remote_error)).toContain('unable to access');
    expect(remoteState()).toMatchObject({ latest: null });
  });

  it('원격 조회만 실패하고 다른 어긋남이 없으면 출력은 없고 기록은 unknown 이다', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fakeBin('git', 'exit 128');
    const run = runCheck('1.7.9', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' });
    expect(run.stdout).toBe('');
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'unknown', remote_latest: null, notices: [] });
  });

  it('실패한 조회는 1시간 안에는 다시 하지 않고, 그동안도 unknown 으로 남는다', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fakeBin('git', `echo "$*" >> "${path.join(tmp, 'git-calls.log')}"\nexit 128`);
    const env = { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' };
    runCheck('1.7.9', env);
    runCheck('1.7.9', env);
    expect(gitCalls()).toHaveLength(1);
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'unknown', remote_latest: null });
  });

  it('3초 제한: 응답 없는 원격은 기다리지 않고 unknown 으로 끝낸다', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fakeBin('git', 'exec sleep 30');
    const run = runCheck('1.7.9', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/slow.git' });
    expect(run.status).toBe(0);
    expect(run.ms, `소요 ${run.ms}ms`).toBeLessThan(12_000);
    expect(run.ms).toBeGreaterThanOrEqual(2_900);
    const line = logLines().at(-1)!;
    expect(line).toMatchObject({ remote_status: 'unknown', remote_latest: null });
    expect(String(line.remote_error)).toMatch(/timed out after 3000ms/);
  });

  it('버전 태그가 하나도 없는 응답은 unknown 이다 (빈 목록을 「새 버전 없음」으로 읽지 않는다)', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fakeGitTags(['nightly', 'docs']);
    runCheck('1.7.9', { MEMORY_BANK_DRIFT_REMOTE: 'https://example.invalid/fake.git' });
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'unknown', remote_latest: null });
  });

  it('주소를 주지 않으면 package.json 의 repository 를 쓴다', () => {
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fakeGitTags(['v1.7.9']);
    const run = runCheck('1.7.9', { MEMORY_BANK_DRIFT_REMOTE: '' });
    expect(run.stdout).toBe('');
    expect(gitCalls()).toEqual([`${LS_REMOTE} https://example.invalid/never-contacted.git`]);
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'ok', remote_latest: '1.7.9' });
  });

  const gitPath = (() => { try { return execFileSync('which', ['git'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  it.skipIf(!gitPath)('실제 git ls-remote 출력에서 태그를 읽는다 (로컬 저장소)', () => {
    installVersion('1.7.7');
    marketplaceClone('1.7.7');
    const repo = path.join(tmp, 'upstream');
    const git = (...args: string[]) => execFileSync(gitPath, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
      '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home } });
    fs.mkdirSync(repo, { recursive: true });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('tag', 'v1.7.9'); git('tag', 'v1.10.0'); git('tag', '-a', 'v1.9.0', '-m', 'annotated');
    fs.unlinkSync(path.join(bin, 'git')); // 이 테스트만 PATH 의 실제 git 을 쓴다 (대상은 위 로컬 저장소)
    const out = hookJson(runCheck('1.7.7', { MEMORY_BANK_DRIFT_REMOTE: repo }));
    expect(out.systemMessage, '1.10.0 > 1.9.0 (숫자 비교)').toContain('1.10.0');
    expect(logLines().at(-1)).toMatchObject({ remote_status: 'ok', remote_latest: '1.10.0' });
  });
});

/**
 * 원격 조회를 끊을 때 git 이 띄운 도우미까지 끝낸다 (2026-11-11, 1.8.0 검수 IH-4).
 * 3초 제한은 git 본체만 SIGKILL 했다. HTTP 원격이면 git 은 `git remote-http` → `git-remote-http` 를 띄우는데,
 * 이 둘은 PID 1 밑으로 옮겨져 원격이 답하거나 연결이 끊길 때까지 남았다(느린·막힌 네트워크에서 세션 시작마다 한 쌍).
 *
 * 연결은 받되 답하지 않는 로컬 서버를 원격으로 주고, 진짜 git 으로 돌린다. 남은 프로세스는 진짜 ps 에서
 * 그 서버의 주소가 든 명령줄로 찾는다(스크립트가 쓰는 PATH 의 ps 는 가짜다).
 */
describe('version-drift-check — 원격 조회를 끊으면 git 의 도우미 프로세스도 남지 않는다', () => {
  const realGit = (() => { try { return execFileSync('which', ['git'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const conns = new Set<net.Socket>();
  let hang: net.Server;
  let remote: string;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** 그 원격을 명령줄에 든 프로세스들(git 본체와 도우미). */
  const gitProcs = (): string[] => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .filter((l) => l.includes(remote)).map((l) => l.trim().replace(/\s+/g, ' '));
  const waitProcs = async (pred: (n: number) => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred(gitProcs().length)) return true; await sleep(100); }
    return pred(gitProcs().length);
  };
  /**
   * '전제: git 과 도우미가 떠 있다'를 기다리는 시간. 훅이 뜨는 데(node 시작) 부하 때 2.5초를 넘길 수 있어 넉넉히 둔다 —
   * 보이는 즉시 돌아오므로 평소에는 느려지지 않는다. '남은 프로세스 0' 쪽 1.5초는 넓히지 않는다: git 의 저속 제한이 5초라
   * (3초 제한 + 그 이상을 기다리면) 끝내 주는 코드가 없어도 도우미가 스스로 끝나 단언이 판별력을 잃는다.
   */
  const PREMISE_WAIT_MS = 10_000;
  /** 훅을 띄워 두고 프로세스를 돌려준다(끝나기를 기다리지 않는다). */
  const startCheck = (from: string): ChildProcess => {
    const child = spawn(process.execPath, [scriptOf(from)], { env: checkEnv({ MEMORY_BANK_DRIFT_REMOTE: remote }), stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(child);
    child.stdin!.end(HOOK_INPUT);
    return child;
  };

  beforeEach(async () => {
    hang = net.createServer((s) => { conns.add(s); s.on('error', () => {}); s.on('close', () => conns.delete(s)); });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    remote = `http://127.0.0.1:${(hang.address() as net.AddressInfo).port}/x.git`;
    installVersion('1.7.9');
    marketplaceClone('1.7.9');
    fs.unlinkSync(path.join(bin, 'git')); // 진짜 git — 대상은 위 로컬 서버뿐이다
  });
  afterEach(async () => {
    for (const l of gitProcs()) { try { process.kill(Number(l.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } }
    for (const s of conns) s.destroy();
    await new Promise((r) => hang.close(() => r(null)));
  });

  it.skipIf(!realGit)('3초 제한으로 끊은 뒤: git 본체도, 그것이 띄운 도우미도 남지 않는다', async () => {
    const run = await runCheckAsync('1.7.9', { MEMORY_BANK_DRIFT_REMOTE: remote });
    expect(run.status).toBe(0);
    expect(String(logLines().at(-1)!.remote_error), '전제: git 이 답을 기다리다 3초 제한에 걸렸다').toMatch(/timed out after 3000ms/);
    expect(await waitProcs((n) => n === 0, 1500), `남은 프로세스: ${gitProcs().join(' | ')}`).toBe(true);
  }, 30_000);

  it.skipIf(!realGit)('조회 중에 훅이 SIGTERM 을 받으면: git 과 도우미를 끝내고 그 신호로 끝난다', async () => {
    const child = startCheck('1.7.9');
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_code, signal) => r(signal)));
    expect(await waitProcs((n) => n >= 2, PREMISE_WAIT_MS), '전제: git 과 도우미가 떠 있다').toBe(true);
    child.kill('SIGTERM');
    expect(await exited, '기본 동작 그대로 — 신호로 끝난다').toBe('SIGTERM');
    expect(await waitProcs((n) => n === 0, 1500), `남은 프로세스: ${gitProcs().join(' | ')}`).toBe(true);
  }, 30_000);

  it.skipIf(!realGit)('조회 중에 훅이 SIGKILL 로 죽어도: git 이 저속 제한으로 스스로 그만둔다 (몇 초 안)', async () => {
    const child = startCheck('1.7.9');
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    expect(await waitProcs((n) => n >= 2, PREMISE_WAIT_MS), '전제: git 과 도우미가 떠 있다').toBe(true);
    child.kill('SIGKILL');
    await exited;
    expect(gitProcs().length, '훅이 죽은 직후에는 아직 떠 있다(끝내 줄 프로세스가 없다)').toBeGreaterThan(0);
    expect(await waitProcs((n) => n === 0, 12_000), `남은 프로세스: ${gitProcs().join(' | ')}`).toBe(true);
  }, 30_000);
});

describe('version-drift-check — 옛 버전 작업자 정리 알림', () => {
  it('가짜 ps 가 내놓은 옛 버전 작업자를 끝내고 그 사실을 JSON 으로 알린다', async () => {
    installVersion('1.7.5');
    installVersion('1.7.9', { a: '2' }); // 의존성이 달라 live-apply 는 건너뛴다 → 옛 폴더가 옛 버전으로 남는다
    // 실제 작업자 대신 이 테스트가 띄운 프로세스 하나 — 가짜 ps 목록에는 이것만 있다
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(victim);
    const exited = new Promise<void>((resolve) => victim.on('exit', () => resolve()));
    fakeBin('ps', `echo "${victim.pid} node ${cacheDir('1.7.5')}/scripts/fact-extract-worker.js"`);
    // 동기 실행이면 이 프로세스가 막혀 죽은 자식을 거두지 못하고(좀비), 스크립트는 「종료 실패」로 본다
    const run = await runCheckAsync('1.7.9', { MEMORY_BANK_DRIFT_SWEEP: '1' });
    await exited;
    const out = hookJson(run);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/swept 1 stale-version worker\(s\) \(running < v1\.7\.9\)/);
    expect(victim.signalCode ?? victim.exitCode).not.toBeNull();
  });

  it('MEMORY_BANK_DRIFT_SWEEP=0 이면 ps 를 부르지 않는다', () => {
    installVersion('1.7.9');
    fakeBin('ps', `echo called >> "${path.join(tmp, 'ps-calls.log')}"`);
    runCheck('1.7.9', { MEMORY_BANK_DRIFT_SWEEP: '0' });
    expect(fs.existsSync(path.join(tmp, 'ps-calls.log'))).toBe(false);
    runCheck('1.7.9', { MEMORY_BANK_DRIFT_SWEEP: '1' });
    expect(fs.existsSync(path.join(tmp, 'ps-calls.log')), '양성 대조: 켜면 부른다').toBe(true);
  });
});

describe('hooks.json — 버전 점검 훅', () => {
  it('SessionStart 의 startup|resume 묶음에 비동기로 등록돼 있다 (원격 조회가 세션 시작을 막지 않는다)', () => {
    const cfgJson = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));
    const hooks = (cfgJson.hooks.SessionStart as Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>)
      .filter((g) => /^(?:startup\|resume)$/.test(g.matcher)).flatMap((g) => g.hooks)
      .filter((h) => String(h.command).includes('scripts/version-drift-check.js'));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].async).toBe(true);
  });
});
