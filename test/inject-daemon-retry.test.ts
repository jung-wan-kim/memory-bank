import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { injectSocketPathIn } from '../src/version-guard.js';
import { shortTmpDir } from './helpers/fake-inject-daemon.js';

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
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const TICK_MS = 150;
const prevEnv = { ...process.env };
let daemonMod: typeof import('../src/inject-daemon.js');
type Handle = ReturnType<typeof daemonMod.startInjectDaemon>;
const handles: Handle[] = [];
let tmp: string;
const ownSock = () => injectSocketPathIn(path.join(tmp, 'conversation-index'), VERSION)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
