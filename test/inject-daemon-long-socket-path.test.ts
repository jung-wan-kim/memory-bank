import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { injectSocketPathIn, maxUnixSocketPathBytes, MAX_UNIX_SOCKET_PATH_BYTES } from '../src/version-guard.js';
import { suppressConsole } from './test-utils.js';

/**
 * 유닉스 소켓에 들어가지 않는 경로의 주입 데몬 (2026-11-11, 1.8.0 검수 UPG-2 · COMPAT-01 · SEC-1 · F1 · REL-12).
 *
 * 소켓 이름은 `<색인 폴더>/inject-daemon-<버전>.sock` 이고, 길면 예전 이름(inject-daemon.sock)으로 물러난다.
 * 그 예전 이름의 길이는 아무도 보지 않았다. 설정 폴더가 깊어 예전 이름까지 한도(103바이트)를 넘으면
 *  - 서버는 OS 가 자른 이름에 묶였고(색인 폴더 밖의 엉뚱한 파일),
 *  - 그 잘린 이름에 파일이 이미 있으면(다른 세션, 강제 종료된 서버) EADDRINUSE → 「원래 경로에는 파일이 없다」를
 *    「주인이 떠났다」로 읽고 쉬지 않고 다시 묶으려 해, MCP 서버가 initialize 에 답하지 못한 채 CPU 를 태웠고,
 *  - 훅 클라이언트는 같은 잘린 이름으로 붙어 남의 데몬 답을 받았다.
 * 이제 들어가지 않는 경로에서는 데몬을 켜지 않고(한 줄 남김), 훅은 데몬에 묻지 않고 직접 계산한다.
 *
 * 서버가 멈추는 경우는 자식 프로세스로 본다 — 같은 프로세스에서 돌리면 이 테스트 러너의 이벤트 루프가 멈춘다.
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const SERVER = path.join(REPO, 'dist', 'mcp-server.js');
const LEGACY = 'inject-daemon.sock';
const kids: ChildProcess[] = [];
const servers: net.Server[] = [];
const bases: string[] = [];

/** 색인 폴더가 110바이트인 설정 폴더 — 예전 이름으로도 129바이트. */
function longBase(): { base: string; cfg: string; index: string } {
  const base = fs.mkdtempSync('/tmp/mbls-');
  bases.push(base);
  const cfg = path.join(base, 'a'.repeat(70), 'cfg');
  const index = path.join(cfg, 'conversation-index');
  fs.mkdirSync(index, { recursive: true });
  fs.mkdirSync(path.join(base, 'home'));
  expect(Buffer.byteLength(path.join(index, LEGACY))).toBeGreaterThan(MAX_UNIX_SOCKET_PATH_BYTES);
  return { base, cfg, index };
}

/** 폴더 아래의 소켓 파일 — `경로#inode`. */
function socketsUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSocket()) found.push(`${p}#${fs.lstatSync(p).ino}`);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * 긴 경로로 묶었다가 강제 종료된 서버가 남긴 소켓 파일. OS 가 이름을 자르므로 파일은 다른 이름에 남는다.
 * 긴 경로로는 아예 묶지 못하는 플랫폼이면 null — 그때는 남은 파일 없이 본다.
 */
function staleSocketOfKilledServer(longPath: string, base: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e',
      "const s = require('net').createServer(); s.on('error', () => process.exit(3)); s.listen(process.argv[1], () => console.log('up'))",
      longPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.push(child);
    child.stdout!.once('data', () => child.kill('SIGKILL'));
    child.on('exit', () => resolve(socketsUnder(base)[0] ?? null));
  });
}

interface Server { child: ChildProcess; stderr: () => string; ready: Promise<boolean>; initialize: () => Promise<number | null> }
function startServer(cfg: string, base: string): Server {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: path.join(base, 'home'), MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: path.join(base, 'db.sqlite'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', MEMORY_BANK_DRIFT_SWEEP: '0', MEMORY_BANK_CARGO: 'none',
  };
  for (const k of ['TEST_DB_PATH', 'PERSONAL_SUPERPOWERS_DIR', 'XDG_CONFIG_HOME', 'MEMORY_BANK_INJECT_RECLAIM_MS', 'MEMORY_BANK_TEST_GUARD']) delete env[k];
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  kids.push(child);
  let stderr = ''; let stdout = '';
  child.stderr!.on('data', (d) => { stderr += d; });
  child.stdout!.on('data', (d) => { stdout += d; });
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return pred();
  };
  return {
    child, stderr: () => stderr,
    ready: until(() => stderr.includes('running via stdio'), 20_000),
    /** initialize 를 보내고 답이 올 때까지 걸린 ms — 4초 안에 답이 없으면 null. */
    initialize: async () => {
      const t0 = Date.now();
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'long-socket-path-test', version: '0' } } }) + '\n');
      return (await until(() => /"id":1[,}]/.test(stdout), 4_000)) ? Date.now() - t0 : null;
    },
  };
}

/** 프로세스가 지금까지 쓴 CPU 시간(초) — ps 의 [[시:]분:]초.백분의일초. */
function cpuSeconds(pid: number): number {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) throw new Error(`ps time: ${t}`);
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

afterEach(async () => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true });
});

describe('injectSocketPathIn — 유닉스 소켓에 들어가지 않는 경로', () => {
  const dirOfBytes = (n: number) => '/' + 'd'.repeat(n - 1);
  const legacyOf = (dir: string) => `${dir}/${LEGACY}`; // 이름 몫 19바이트

  it('한도는 sun_path 에서 끝의 NUL 을 뺀 값: 리눅스 107, macOS·BSD 103 — 네이티브 클라이언트도 같은 수를 쓴다', () => {
    expect(maxUnixSocketPathBytes('linux')).toBe(107);
    for (const p of ['darwin', 'freebsd', 'openbsd']) expect(maxUnixSocketPathBytes(p), p).toBe(103);
    expect(MAX_UNIX_SOCKET_PATH_BYTES, '이 기계의 한도').toBe(maxUnixSocketPathBytes(process.platform));
    const rs = fs.readFileSync(path.join(REPO, 'native', 'inject-client', 'src', 'paths.rs'), 'utf8');
    expect(rs, '네이티브 클라이언트의 한도 상수').toContain('const MAX_UNIX_SOCKET_PATH_BYTES: usize = if cfg!(target_os = "linux") { 107 } else { 103 };');
  });

  it('버전 이름이 들어가면 버전 이름, 버전 이름만 넘치면 예전 이름', () => {
    expect(injectSocketPathIn(dirOfBytes(60), '1.8.0')).toBe(`${dirOfBytes(60)}/inject-daemon-1.8.0.sock`);
    expect(injectSocketPathIn(dirOfBytes(80), '1.8.0', 103)).toBe(legacyOf(dirOfBytes(80)));
  });

  // 이름 몫이 19바이트이므로 폴더가 (한도 − 19)바이트일 때 예전 이름이 꼭 한도에 닿는다
  for (const [platform, max] of [['macOS·BSD', 103], ['리눅스', 107]] as const) {
    it(`${platform}: 예전 이름이 꼭 ${max}바이트면 그 이름, ${max + 1}바이트부터는 경로를 주지 않는다`, () => {
      const edge = dirOfBytes(max - 19);
      const over = dirOfBytes(max - 18);
      expect(Buffer.byteLength(legacyOf(edge))).toBe(max);
      expect(injectSocketPathIn(edge, '1.8.0', max)).toBe(legacyOf(edge));
      expect(injectSocketPathIn(edge, null, max)).toBe(legacyOf(edge));
      expect(injectSocketPathIn(over, '1.8.0', max)).toBeNull();
      expect(injectSocketPathIn(over, null, max), '버전을 못 읽어 예전 이름을 쓰는 경우도 같다').toBeNull();
      expect(injectSocketPathIn(dirOfBytes(300), '1.8.0', max)).toBeNull();
    });
  }

  it('리눅스에서는 104~107바이트 경로가 예전처럼 쓰인다 (그 길이는 리눅스에서 늘 묶였다)', () => {
    const dir = dirOfBytes(86); // 예전 이름 105바이트
    expect(injectSocketPathIn(dir, '1.8.0', maxUnixSocketPathBytes('linux'))).toBe(legacyOf(dir));
    expect(injectSocketPathIn(dir, '1.8.0', maxUnixSocketPathBytes('darwin'))).toBeNull();
  });

  it('길이는 글자 수가 아니라 바이트로 잰다 (한글 폴더 이름)', () => {
    const dir = '/' + '가'.repeat(30); // 31자, 91바이트 → 예전 이름까지 110바이트
    expect(legacyOf(dir).length).toBeLessThan(103);
    expect(injectSocketPathIn(dir, '1.8.0')).toBeNull();
  });
});

describe('소켓 경로가 한도를 넘는 설정 폴더의 MCP 서버 (dist/mcp-server.js, stdio)', () => {
  it('잘린 이름에 남은 소켓 파일이 있어도 initialize 에 2초 안에 답하고, CPU 를 태우지 않고, 소켓을 만들지 않는다', async () => {
    const { base, cfg, index } = longBase();
    const stale = await staleSocketOfKilledServer(path.join(index, LEGACY), base);
    const before = socketsUnder(base);
    if (stale !== null) expect(before, '강제 종료된 서버가 남긴 파일 하나 — 색인 폴더의 소켓 이름이 아니다').toEqual([stale]);

    const server = startServer(cfg, base);
    expect(await server.ready, server.stderr()).toBe(true);
    const ms = await server.initialize();
    expect(ms, 'initialize 응답 (예전에는 영영 답이 없었다)').not.toBeNull();
    expect(ms!).toBeLessThan(2000);

    const c0 = cpuSeconds(server.child.pid!);
    await new Promise((r) => setTimeout(r, 1500));
    expect(cpuSeconds(server.child.pid!) - c0, '1.5초 동안 쓴 CPU 시간(초) — 예전에는 한 코어를 다 썼다').toBeLessThan(0.5);

    expect(socketsUnder(base), '남은 파일은 그대로, 새 소켓은 없다').toEqual(before);
    expect(server.stderr()).not.toContain('MaxListenersExceededWarning');
    const notes = server.stderr().split('\n').filter((l) => l.includes('inject daemon off'));
    expect(notes, '데몬을 켜지 않은 이유 한 줄').toHaveLength(1);
    expect(notes[0]).toContain(`${MAX_UNIX_SOCKET_PATH_BYTES} bytes`);
  }, 60_000);

  it('남은 파일이 없어도 잘린 이름으로 소켓을 만들지 않는다 (예전에는 색인 폴더 밖에 소켓 파일이 생겼다)', async () => {
    const { base, cfg } = longBase();
    const server = startServer(cfg, base);
    expect(await server.ready, server.stderr()).toBe(true);
    expect(await server.initialize()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300)); // 묶는다면 서버가 뜨는 즉시 묶는다
    expect(socketsUnder(base)).toEqual([]);
  }, 60_000);

  it('대조: 한도 안의 설정 폴더에서는 버전 소켓에 묶는다', async () => {
    const base = fs.mkdtempSync('/tmp/mbls-');
    bases.push(base);
    const cfg = path.join(base, 'cfg');
    fs.mkdirSync(path.join(cfg, 'conversation-index'), { recursive: true });
    fs.mkdirSync(path.join(base, 'home'));
    const server = startServer(cfg, base);
    expect(await server.ready, server.stderr()).toBe(true);
    expect(await server.initialize()).not.toBeNull();
    const own = injectSocketPathIn(path.join(cfg, 'conversation-index'), VERSION)!;
    const end = Date.now() + 5000;
    while (Date.now() < end && !fs.existsSync(own)) await new Promise((r) => setTimeout(r, 25));
    expect(socketsUnder(base).map((s) => s.split('#')[0])).toEqual([own]);
    expect(server.stderr()).not.toContain('inject daemon off');
  }, 60_000);
});

describe('소켓 경로가 한도를 넘는 설정 폴더의 프롬프트 훅 (scripts/inject-context.js)', () => {
  const restoreConsole = suppressConsole();
  const FACT = 'The deploy pipeline publishes a Vercel preview for every pull request before merge';
  const PROMPT = 'How does our deploy pipeline publish Vercel previews for pull requests?';
  const prevEnv = { ...process.env };
  let dbDir: string;
  let dbPath: string;

  beforeAll(async () => {
    dbDir = fs.mkdtempSync('/tmp/mblsdb-');
    dbPath = path.join(dbDir, 't.sqlite');
    process.env.MEMORY_BANK_CONFIG_DIR = dbDir;
    process.env.TEST_DB_PATH = dbPath;
    const { initDatabase } = await import('../src/db.js');
    const { insertFact } = await import('../src/fact-db.js');
    const { initEmbeddings, generateEmbedding } = await import('../src/embeddings.js');
    await initEmbeddings();
    const db = initDatabase();
    try {
      insertFact(db, { fact: FACT, category: 'decision', scope_type: 'global', scope_project: null,
        source_exchange_ids: [], embedding: await generateEmbedding(FACT, 'passage') });
    } finally {
      db.close();
    }
  }, 120_000);
  afterAll(() => {
    process.env = prevEnv;
    restoreConsole();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function runHook(cfg: string): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/inject-context.js'], {
        cwd: REPO,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, TEST_DB_PATH: dbPath, MEMORY_BANK_CLIENT: '' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      kids.push(child);
      let out = '';
      child.stdout!.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
      child.stdin!.end(JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', session_id: 'sess-long-sock', hook_event_name: 'UserPromptSubmit' }));
    });
  }

  it('잘린 이름에서 듣고 있는 다른 서버에 붙지 않고, 데몬 없이 도는 경로로 직접 계산해 주입한다', async () => {
    const { cfg, index } = longBase();
    // 같은 긴 경로로 묶은 다른 세션의 서버 — OS 가 자른 이름에서 듣는다. 예전 클라이언트는 여기에 붙었다.
    const asked: string[] = [];
    await new Promise<void>((resolve) => {
      const s = net.createServer((c) => { c.on('error', () => {}); c.on('data', (d) => { asked.push(String(d)); c.end(JSON.stringify({ ok: true, context: 'FROM-TRUNCATED-NAME' }) + '\n'); }); });
      s.on('error', () => resolve()); // 긴 경로로 묶지 못하는 플랫폼 — 붙을 서버가 없는 채로 본다
      s.listen(path.join(index, LEGACY), () => { servers.push(s); resolve(); });
    });

    const out = await runHook(cfg);
    expect(asked, '잘린 이름의 서버는 요청을 받지 않는다').toEqual([]);
    expect(out).not.toContain('FROM-TRUNCATED-NAME');
    expect(out, '직접 계산한 블록').toContain('deploy pipeline publishes a Vercel preview');
    const log = fs.readFileSync(path.join(index, 'logs', 'inject-context.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ via: 'fallback', fallback_reason: 'socket-path-too-long', status: 'injected' });
  }, 60_000);
});
