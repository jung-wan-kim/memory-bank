import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi, type MockInstance } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { injectSocketPathIn } from '../src/version-guard.js';
import { fakeDaemon, closeAll, shortTmpDir, waitFor } from './helpers/fake-inject-daemon.js';

vi.mock('../src/embeddings.js', async (orig) => ({
  ...(await orig<typeof import('../src/embeddings.js')>()),
  initEmbeddings: vi.fn(async () => {}), // the daemon pre-warms the model on bind — not needed here
}));

/**
 * 소켓을 묶지 못한 데몬의 다시 묶기 (2026-11-11, 1.8.0 검수 UPG-2 의 재시도 몫).
 *
 * EADDRINUSE 처리는 「이름에 아무것도 없으면 주인이 방금 떠난 것」으로 보고 곧바로 다시 묶었다. 묶기가 계속
 * EADDRINUSE 인데 이름에는 아무것도 보이지 않는 상태(OS 가 자른 이름에 남은 파일이 그랬다)에서는 이 왕복이
 * nextTick 과 마이크로태스크로만 이어져 이벤트 루프가 돌지 못했다 — MCP 서버가 입력을 읽지 못한다.
 * 곧바로 다시 묶는 것은 한 번까지고, 그 뒤는 주기 타이머가 맡는다.
 *
 * 묶기 실패는 listen 을 바꿔치기해 만든다(같은 프로세스에서 실제로 멈추게 두면 이 러너가 멈춘다):
 * 바꿔치기한 listen 은 호출 수를 세고, 상한을 넘으면 실패를 그만 낸다.
 *
 * 같은 날, 검수 IH-2 · F6 — 넘겨받기와 죽은 소켓 정리:
 *  - 소켓을 못 잡은 서버는 주기마다 `server.listen(path, onListen)` 을 불렀고, 실패한 시도의 listening 리스너가
 *    지워지지 않아 주기마다 하나씩 쌓였다(45초에 하나, 8시간이면 640개). 넘겨받는 순간 그 수만큼 onListen 이
 *    돌고, 각자 다른 버전 소켓에 동시에 연결을 보냈다.
 *  - macOS 는 accept 대기열이 찬 살아 있는 서버에도 ECONNREFUSED 를 준다. 정리는 ECONNREFUSED 한 번을
 *    「듣는 쪽 없는 죽은 파일」로 읽어 살아 있는 다른 버전 데몬의 소켓 파일을 지웠다(v1.7.x 서버는 다시 묶지
 *    않는다 — 그 세션은 끝까지 프롬프트마다 느린 경로).
 * 이제 리스너는 한 번만 등록하고, 정리는 프로세스 안에서 한 번에 하나만 돌며, 죽었다는 판정은 간격을 둔 두 번이다.
 *
 * 「대기열이 찬 살아 있는 서버」는 대기열 1짜리 서버를 자식 프로세스로 띄우고, 깃발 파일이 생길 때까지
 * 이벤트 루프를 붙잡게 해서 만든다(그동안 accept 하지 않는다).
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const TICK_MS = 150;
const prevEnv = { ...process.env };
let daemonMod: typeof import('../src/inject-daemon.js');
type Handle = ReturnType<typeof daemonMod.startInjectDaemon>;
const handles: Handle[] = [];
const servers: net.Server[] = [];
const kids: ChildProcess[] = [];
let tmp: string;
const ci = () => path.join(tmp, 'conversation-index');
const ownSock = () => injectSocketPathIn(ci(), VERSION)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 소켓 파일을 오래된 것으로 만든다 — 「방금 생긴 소켓」 보호를 지나가게. */
const age = (p: string, seconds: number) => { const t = Date.now() / 1000 - seconds; fs.utimesSync(p, t, t); };

// 이 파일의 시험용 연결은 net.createConnection 으로 연다 — 데몬이 쓰는 net.connect 만 지켜보기 위해서다.

/** 연결을 한 번 시도한다: 'connect', 오류 코드, 또는 0.5초 안에 아무 일도 없으면 'timeout'. */
function tryConnect(sock: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    const t = setTimeout(() => { c.destroy(); resolve('timeout'); }, 500);
    c.on('connect', () => { clearTimeout(t); c.destroy(); resolve('connect'); });
    c.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); resolve(String(e.code)); });
  });
}
/** 소켓에 요청 한 줄을 보내고 답을 받는다. 연결하지 못하면 null. */
function ask(sock: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); resolve(null); }, 3000);
    c.on('connect', () => c.write(JSON.stringify({ prompt: 'hi', cwd: '/tmp/proj' }) + '\n'));
    c.on('data', (d) => { buf += d.toString('utf8'); });
    c.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    c.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

/**
 * 다른 버전의 살아 있는 데몬 — accept 대기열 1. `block()` 뒤로는 `release()` 까지 이벤트 루프를 붙잡아
 * 들어온 연결을 accept 하지 않는다(임베딩 추론·sqlite 검색 같은 동기 구간을 길게 늘인 것).
 */
async function busyOtherVersionDaemon(sockPath: string): Promise<{ block: () => Promise<void>; release: () => Promise<void> }> {
  const flag = `${sockPath}.release`;
  const child = spawn(process.execPath, ['-e', `
    const net = require('net'), fs = require('fs');
    const [sock, flag] = process.argv.slice(1);
    net.createServer((c) => { c.on('error', () => {}); c.on('data', () => c.end(JSON.stringify({ ok: true, context: 'FROM-OTHER-VERSION' }) + '\\n')); })
      .listen({ path: sock, backlog: 1 }, () => {
        process.stdout.write('up\\n');
        process.stdin.once('data', () => {
          process.stdout.write('blocked\\n');
          while (!fs.existsSync(flag)) { /* accept 하지 않는다 */ }
          process.stdout.write('released\\n');
        });
      });`, sockPath, flag], { stdio: ['pipe', 'pipe', 'inherit'] });
  kids.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  const said = async (word: string) => { expect(await waitFor(() => out.includes(word), 5000), `자식 프로세스: ${word}`).toBe(true); };
  await said('up');
  return {
    block: async () => { child.stdin!.write('block\n'); await said('blocked'); },
    release: async () => { fs.writeFileSync(flag, ''); await said('released'); },
  };
}

/** 데몬이 `target` 소켓에 보낸 연결 시도(net.connect)와 그 결과를 순서대로 모은다. */
function watchProbes(target: string): { started: () => number; results: string[] } {
  const real = net.connect.bind(net) as (...a: unknown[]) => net.Socket;
  const results: string[] = [];
  let started = 0;
  vi.spyOn(net, 'connect').mockImplementation(((...args: unknown[]) => {
    const sock = real(...args);
    if (args[0] === target) {
      started++;
      sock.once('connect', () => results.push('connect'));
      sock.once('error', (e: NodeJS.ErrnoException) => results.push(String(e.code)));
    }
    return sock;
  }) as typeof net.connect);
  return { started: () => started, results };
}

/** startInjectDaemon 이 만드는 서버를 붙잡는다 — 만들어진 직후 `prepare` 로 손볼 수 있다. */
function startCapturing(prepare: (s: net.Server) => void = () => {}): { handle: Handle; server: net.Server } {
  const real = net.createServer.bind(net);
  let server: net.Server | null = null;
  const spy = vi.spyOn(net, 'createServer').mockImplementation(((...args: unknown[]) => {
    server = (real as (...a: unknown[]) => net.Server)(...args);
    prepare(server);
    return server;
  }) as typeof net.createServer);
  try {
    const handle = daemonMod.startInjectDaemon();
    handles.push(handle);
    return { handle, server: server! };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  process.env.MEMORY_BANK_INJECT_RECLAIM_MS = String(TICK_MS); // 모듈이 처음 읽힐 때 정해진다
  daemonMod = await import('../src/inject-daemon.js');
});
beforeEach(() => {
  tmp = shortTmpDir('/tmp/mbrt-');
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await closeAll(servers);
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => { process.env = prevEnv; });

describe('묶기가 EADDRINUSE 로 실패하는데 이름에는 아무것도 없을 때', () => {
  it('곧바로 다시 묶는 것은 한 번까지 — 한 주기에 listen 은 두 번을 넘지 않고, 이벤트 루프가 돈다', async () => {
    const SPIN_GUARD = 60; // 고치기 전 코드는 여기까지 쉬지 않고 온다 — 그 뒤로는 실패를 내지 않아 러너가 멈추지 않는다
    let listens = 0;
    const { handle, server } = startCapturing((s) => {
      s.listen = ((..._args: unknown[]) => {
        listens++;
        if (listens <= SPIN_GUARD) process.nextTick(() => s.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
        return s;
      }) as typeof s.listen;
    });
    expect(server).toBeDefined();
    expect(fs.existsSync(ownSock()), '이름에는 아무것도 없다').toBe(false);

    let beats = 0;
    const beat = setInterval(() => { beats++; }, 10);
    await sleep(TICK_MS / 2);
    expect(listens, '첫 주기: 첫 시도 + 곧바로 한 번').toBe(2);
    await sleep(TICK_MS * 3);
    clearInterval(beat);
    expect(listens, '주기마다 두 번까지').toBeLessThanOrEqual(2 + 2 * 4);
    expect(listens, '주기 타이머는 계속 묻는다').toBeGreaterThan(2);
    expect(beats, '그동안 이 프로세스의 타이머가 돈다').toBeGreaterThan(10);
    expect(handle.owning()).toBe(false);
  });
});

describe('소켓을 못 잡은 서버의 다시 묶기와 넘겨받기', () => {
  it('열 번 넘게 다시 시도해도 listening 리스너는 하나를 넘지 않는다', async () => {
    await fakeDaemon(ownSock(), 'FROM-LIVE-OWNER', servers);
    let listenSpy: MockInstance | null = null;
    const { handle: b, server } = startCapturing((s) => { listenSpy = vi.spyOn(s, 'listen'); });
    expect(await waitFor(() => listenSpy!.mock.calls.length >= 12, 10_000), '묶기 시도 12회').toBe(true);
    expect(b.owning(), '살아 있는 소유자가 있는 동안에는 잡지 않는다').toBe(false);
    expect(server.listenerCount('listening'), '예전에는 시도마다 하나씩 쌓였다').toBeLessThanOrEqual(1);
  }, 30_000);

  it('넘겨받을 때 onListen 은 한 번만 돌고, 바쁜(대기열 1) 다른 버전 데몬의 살아 있는 소켓을 지우지 않는다', async () => {
    const other = path.join(ci(), 'inject-daemon-1.6.1.sock');
    const otherDaemon = await busyOtherVersionDaemon(other);
    age(other, 3600); // 오래된 소켓 — 「방금 생긴 것」 보호 밖이다
    await fakeDaemon(ownSock(), 'FROM-LIVE-OWNER', servers);
    let listenSpy: MockInstance | null = null;
    const { handle: b } = startCapturing((s) => { listenSpy = vi.spyOn(s, 'listen'); });
    expect(await waitFor(() => listenSpy!.mock.calls.length >= 12, 10_000), '소켓 없이 기다린 12주기').toBe(true);

    await otherDaemon.block();
    const probes = watchProbes(other);
    const chmod = vi.spyOn(fs, 'chmodSync');
    await closeAll(servers); // 소유 세션이 끝났다
    expect(await waitFor(() => b.owning(), 5000), '기다리던 서버가 넘겨받는다').toBe(true);
    expect(await waitFor(() => probes.results.length >= 1, 5000), '다른 버전 소켓을 한 번 살펴본다').toBe(true);
    await sleep(1500); // 쌓인 리스너가 있었다면 이 사이에 동시 연결이 나가고 파일이 지워졌다

    expect(chmod.mock.calls.filter((c) => c[0] === ownSock()), '넘겨받기 한 번에 onListen 한 번').toHaveLength(1);
    expect(probes.started(), '다른 버전 소켓에 보낸 연결은 하나 (예전에는 쌓인 리스너 수만큼 동시에)').toBe(1);
    expect(probes.results).toEqual(['connect']);
    expect(fs.existsSync(other), '살아 있는 다른 버전 데몬의 소켓 파일').toBe(true);
    await otherDaemon.release();
    expect(await ask(other), '그 데몬은 계속 답한다').toEqual({ ok: true, context: 'FROM-OTHER-VERSION' });
  }, 30_000);

  it('ECONNREFUSED 한 번으로는 죽었다고 보지 않는다 — 대기열이 잠깐 찬 살아 있는 서버는 간격을 둔 두 번째에 답한다', async () => {
    const other = path.join(ci(), 'inject-daemon-1.6.1.sock');
    const otherDaemon = await busyOtherVersionDaemon(other);
    age(other, 3600);
    await fakeDaemon(ownSock(), 'FROM-LIVE-OWNER', servers);
    const { handle: b } = startCapturing();
    await sleep(TICK_MS * 2);
    expect(b.owning()).toBe(false);

    await otherDaemon.block();
    const filler = net.createConnection(other); // 대기열의 한 자리를 채운다(accept 되지 않은 채)
    filler.on('error', () => {});
    await new Promise((r) => filler.once('connect', r));
    if ((await tryConnect(other)) !== 'ECONNREFUSED') {
      // 대기열이 찼을 때 연결을 거절하지 않고 기다리게 하는 플랫폼(리눅스) — 이 상황을 만들 수 없다
      filler.destroy();
      await otherDaemon.release();
      return;
    }

    const probes = watchProbes(other);
    await closeAll(servers); // 소유 세션이 끝났다 → b 가 넘겨받고 다른 버전 소켓을 살펴본다
    expect(await waitFor(() => b.owning(), 5000)).toBe(true);
    expect(await waitFor(() => probes.results.length >= 1, 5000)).toBe(true);
    expect(probes.results[0], '첫 번째: 대기열이 차 있어 거절당한다').toBe('ECONNREFUSED');
    expect(fs.existsSync(other), '거절 한 번으로 지우지 않는다 (예전에는 여기서 지웠다)').toBe(true);

    filler.destroy();
    await otherDaemon.release(); // 동기 구간이 끝났다 — 다시 accept 한다
    expect(await waitFor(() => probes.results.length >= 2, 5000), '간격을 두고 한 번 더 본다').toBe(true);
    expect(probes.results[1]).toBe('connect');
    await sleep(200);
    expect(fs.existsSync(other), '살아 있는 다른 버전 데몬의 소켓 파일').toBe(true);
    expect(await ask(other)).toEqual({ ok: true, context: 'FROM-OTHER-VERSION' });
  }, 30_000);

  it('대조: 정말 죽은 다른 버전 소켓(두 번 모두 거절)은 치운다', async () => {
    const other = path.join(ci(), 'inject-daemon-1.6.0.sock');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up'))", other], { stdio: ['ignore', 'pipe', 'inherit'] });
      kids.push(child);
      child.stdout!.once('data', () => { child.on('exit', () => resolve()); child.kill('SIGKILL'); });
      child.on('error', reject);
    });
    age(other, 3600);
    const probes = watchProbes(other);
    const { handle: a } = startCapturing();
    expect(await waitFor(() => a.owning(), 3000)).toBe(true);
    expect(await waitFor(() => !fs.existsSync(other), 6000), '죽은 파일은 사라진다').toBe(true);
    expect(probes.results, '두 번 살펴보고 지웠다').toEqual(['ECONNREFUSED', 'ECONNREFUSED']);
  }, 30_000);
});
