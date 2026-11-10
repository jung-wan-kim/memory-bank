import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
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
 * 데몬 소켓의 소유권 재획득과 죽은 소켓 정리 (2026-11-10, 감사 INJ-08 · STG-17 의 소켓 몫).
 *
 * 데몬은 MCP 서버가 뜰 때 한 번만 소켓을 잡으려 했다. 이미 다른 서버가 잡고 있으면 그대로 포기하고
 * 다시 시도하지 않아, 소유 서버가 끝난 뒤에는 살아 있는 서버가 열 몇 개 있어도 새 세션이 뜰 때까지
 * 아무도 받지 않았다(그동안 프롬프트마다 콜드 경로 1.2~13.5초). 강제 종료된 소유자의 소켓 파일은
 * 지우는 주체가 없어 옛 버전 것이 쌓였다(실측 8개 중 7개가 죽은 파일).
 *  - 잡지 못한 서버는 주기적으로 다시 본다: 파일이 없으면 바로 잡고, 죽은 파일이면 치우고 잡는다
 *  - 소켓을 잡은 서버는 다른 버전의 죽은 소켓 파일을 치운다 — 살아 있는 것·방금 생긴 것은 그대로
 *    (죽었다는 판정은 1초 간격의 두 번 — test/inject-daemon-retry.test.ts)
 *  - 자기 소켓 파일이 사라지면(이름으로 지워짐) 다시 잡는다
 *
 * 실제 유닉스 소켓을 쓴다. 「강제 종료된 소유자」는 자식 프로세스를 SIGKILL 해서 만든다(파일이 남는다).
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const TICK_MS = 120;
const prevEnv = { ...process.env };
const servers: net.Server[] = [];
const kids: ChildProcess[] = [];
let daemonMod: typeof import('../src/inject-daemon.js');
type Handle = ReturnType<typeof daemonMod.startInjectDaemon>;
const handles: Handle[] = [];
let tmp: string;
const ci = () => path.join(tmp, 'conversation-index');
const ownSock = () => injectSocketPathIn(ci(), VERSION);

const start = (): Handle => { const h = daemonMod.startInjectDaemon(); handles.push(h); return h; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 「같은 소켓 파일인가」 — inode 번호는 재사용될 수 있어(ext4) 변경 시각을 함께 본다. utimes 도 변경 시각을 바꾸니 age() 뒤에 잰다. */
const ident = (p: string) => { const st = fs.lstatSync(p); return `${st.ino}:${st.ctimeMs}`; };
/** 소켓 파일을 오래된 것으로 만든다 — 「방금 생긴 소켓」 보호(바인드와 리슨 사이의 서버일 수 있다)를 지나가게. */
const age = (p: string, seconds: number) => { const t = Date.now() / 1000 - seconds; fs.utimesSync(p, t, t); };

/** 소켓에 요청 한 줄을 보내고 답을 받는다. 연결하지 못하면 null. */
function ask(sock: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); resolve(null); }, 2000);
    c.on('connect', () => c.write(JSON.stringify({ prompt: 'hi', cwd: '/tmp/proj' }) + '\n')); // 짧은 프롬프트 — 검색 없이 빈 답
    c.on('data', (d) => { buf += d.toString('utf8'); });
    c.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    c.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

/** 소켓을 잡은 채 SIGKILL 로 죽는 프로세스 — 죽은 소켓 파일을 남긴다(libuv 가 이름을 지울 틈이 없다). */
async function deadSocket(sockPath: string): Promise<void> {
  const child = await liveChildOwner(sockPath);
  const gone = new Promise<void>((r) => child.on('exit', () => r()));
  child.kill('SIGKILL');
  await gone;
  expect(fs.existsSync(sockPath), '강제 종료 뒤 소켓 파일이 남는다').toBe(true);
  expect(await ask(sockPath), '남은 파일은 받는 쪽이 없다').toBeNull();
}
/** 소켓을 잡고 살아 있는 별도 프로세스. */
function liveChildOwner(sockPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      "require('net').createServer((c) => c.on('data', () => c.end(JSON.stringify({ ok: true, context: 'FROM-CHILD' }) + '\\n'))).listen(process.argv[1], () => console.log('up'))",
      sockPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    kids.push(child);
    child.stdout!.once('data', () => resolve(child));
    child.on('error', reject);
  });
}

beforeAll(async () => {
  process.env.MEMORY_BANK_INJECT_RECLAIM_MS = String(TICK_MS); // 모듈이 처음 읽힐 때 정해진다
  daemonMod = await import('../src/inject-daemon.js');
});
beforeEach(() => {
  tmp = shortTmpDir('/tmp/mbrc-');
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await closeAll(servers);
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => { process.env = prevEnv; });

describe('소유권 재획득', () => {
  it('소유 서버가 끝나면(소켓 파일이 사라짐) 기다리던 서버가 주기 안에 소켓을 잡고 요청에 답한다', async () => {
    const a = start();
    expect(await waitFor(() => a.owning())).toBe(true);
    const b = start();
    await sleep(TICK_MS * 4);
    expect(b.owning(), '살아 있는 소유자가 있는 동안에는 잡지 않는다').toBe(false);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });

    const aId = ident(ownSock());
    await a.close(); // MCP 서버 종료와 같다 — libuv 가 소켓 파일을 이름으로 지운다
    // close() 가 돌아오기 전에 b 가 이미 새 소켓을 만들었을 수 있다 — a 의 파일이 남아 있지 않다는 것만 본다
    const stillAs = fs.existsSync(ownSock()) && ident(ownSock()) === aId;
    expect(stillAs, 'a 의 소켓 파일은 사라졌다').toBe(false);
    expect(await waitFor(() => b.owning(), 3000), '예전에는 여기서 영영 아무도 받지 않았다').toBe(true);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });
    expect(fs.statSync(ownSock()).mode & 0o777, '소켓은 본인만').toBe(0o600);
  });

  it('소유 프로세스가 강제 종료돼 죽은 소켓 파일이 남으면, 기다리던 서버가 그 파일을 치우고 잡는다', async () => {
    const owner = await liveChildOwner(ownSock());
    const b = start();
    await sleep(TICK_MS * 3);
    expect(b.owning()).toBe(false);
    expect(await ask(ownSock())).toEqual({ ok: true, context: 'FROM-CHILD' });

    const gone = new Promise<void>((r) => owner.on('exit', () => r()));
    owner.kill('SIGKILL');
    await gone;
    age(ownSock(), 30);
    const staleId = ident(ownSock());
    expect(await waitFor(() => b.owning(), 3000)).toBe(true);
    expect(ident(ownSock()), '죽은 파일이 아니라 새로 만든 소켓이다').not.toBe(staleId);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });
  });

  it('살아 있는 소유자의 소켓은 몇 주기가 지나도 건드리지 않는다', async () => {
    await fakeDaemon(ownSock(), 'FROM-LIVE-OWNER', servers);
    age(ownSock(), 3600); // 오래됐어도 살아 있으면 소유자다
    const id = ident(ownSock());
    const b = start();
    await sleep(TICK_MS * 6);
    expect(b.owning()).toBe(false);
    expect(ident(ownSock())).toBe(id);
    expect(await ask(ownSock())).toEqual({ ok: true, context: 'FROM-LIVE-OWNER' });
  });

  it('방금 생긴 죽은 소켓은 바로 치우지 않는다(바인드와 리슨 사이의 서버일 수 있다) — 나이가 차면 치우고 잡는다', async () => {
    await deadSocket(ownSock());
    const id = ident(ownSock());
    const b = start();
    await sleep(TICK_MS * 5);
    expect(b.owning(), '2초가 안 된 소켓 파일').toBe(false);
    expect(ident(ownSock()), '그대로 있다').toBe(id);
    age(ownSock(), 10);
    expect(await waitFor(() => b.owning(), 3000)).toBe(true);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });
  });

  it('두 서버가 같은 죽은 소켓을 동시에 되찾으려 해도 하나만 잡고, 그 소켓이 요청에 답한다', async () => {
    await deadSocket(ownSock());
    age(ownSock(), 30);
    const a = start();
    const b = start();
    const c = start();
    expect(await waitFor(() => [a, b, c].filter((h) => h.owning()).length === 1, 3000)).toBe(true);
    await sleep(TICK_MS * 4);
    expect([a, b, c].filter((h) => h.owning()), '주기가 더 지나도 소유자는 하나').toHaveLength(1);
    // 나중 서버가 먼저 잡은 서버의 새 소켓 파일을 지우고 잡으면, 먼저 잡은 쪽은 닿을 수 없는 소켓을 듣는
    // 유령이 되고 종료할 때 남의 파일을 이름으로 지운다 — 듣고 있는 서버도 하나여야 한다
    expect([a, b, c].filter((h) => h.listening()), '유령 서버 없음').toHaveLength(1);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });
  });

  it('자기 소켓 파일이 이름으로 지워지면(유령이 된 서버의 종료 등) 다시 잡는다', async () => {
    const a = start();
    expect(await waitFor(() => a.owning())).toBe(true);
    fs.unlinkSync(ownSock());
    expect(await ask(ownSock()), '파일이 없으면 클라이언트는 닿지 못한다').toBeNull();
    expect(await waitFor(() => fs.existsSync(ownSock()), 3000)).toBe(true);
    expect(await waitFor(() => a.owning(), 3000)).toBe(true);
    expect(await ask(ownSock())).toEqual({ ok: true, context: '', ledger_keys: [] });
  });

  it('close() 뒤에는 다시 잡지 않고 소켓 파일도 남기지 않는다', async () => {
    const a = start();
    expect(await waitFor(() => a.owning())).toBe(true);
    await a.close();
    await sleep(TICK_MS * 4);
    expect(a.owning()).toBe(false);
    expect(fs.existsSync(ownSock())).toBe(false);
  });
});

describe('죽은 소켓 파일 정리', () => {
  it('소켓을 잡으면 다른 버전의 죽은 소켓 파일을 치운다 — 살아 있는 것, 방금 생긴 것, 소켓이 아닌 파일은 그대로', async () => {
    const p = (name: string) => path.join(ci(), name);
    await deadSocket(p('inject-daemon-1.6.0.sock')); age(p('inject-daemon-1.6.0.sock'), 3600);
    await deadSocket(p('inject-daemon.sock')); age(p('inject-daemon.sock'), 3600);             // 버전 이름이 없던 시절의 소켓
    await deadSocket(p('inject-daemon-1.6.2.sock'));                                            // 죽었지만 방금 생김
    await fakeDaemon(p('inject-daemon-1.6.1.sock'), 'FROM-OLD-LIVE', servers); age(p('inject-daemon-1.6.1.sock'), 3600);
    fs.writeFileSync(p('inject-daemon-9.9.9.sock'), 'not a socket');                            // 이름만 같은 일반 파일
    age(p('inject-daemon-9.9.9.sock'), 3600);
    fs.writeFileSync(p('inject-daemon-notes.txt'), 'keep');

    const a = start();
    expect(await waitFor(() => a.owning())).toBe(true);
    // 죽은 파일 하나마다 1초 간격으로 두 번 살펴본 뒤 지운다(하나씩 차례로) — 두 개면 2초 남짓
    expect(await waitFor(() => !fs.existsSync(p('inject-daemon-1.6.0.sock')) && !fs.existsSync(p('inject-daemon.sock')), 8000)).toBe(true);
    await sleep(TICK_MS * 3);
    expect(fs.readdirSync(ci()).filter((f) => f.startsWith('inject-daemon')).sort()).toEqual([
      'inject-daemon-1.6.1.sock', 'inject-daemon-1.6.2.sock', 'inject-daemon-9.9.9.sock', `inject-daemon-${VERSION}.sock`, 'inject-daemon-notes.txt',
    ].sort());
    expect(await ask(p('inject-daemon-1.6.1.sock')), '살아 있는 옛 버전 데몬은 그대로 답한다').toEqual({ ok: true, context: 'FROM-OLD-LIVE' });
    expect(fs.readFileSync(p('inject-daemon-9.9.9.sock'), 'utf8')).toBe('not a socket');
  });

  it('소켓을 잡지 못한 서버는 아무것도 치우지 않는다', async () => {
    const p = (name: string) => path.join(ci(), name);
    await deadSocket(p('inject-daemon-1.6.0.sock')); age(p('inject-daemon-1.6.0.sock'), 3600);
    await fakeDaemon(ownSock(), 'FROM-LIVE-OWNER', servers);
    const b = start();
    await sleep(TICK_MS * 5);
    expect(b.owning()).toBe(false);
    expect(fs.existsSync(p('inject-daemon-1.6.0.sock'))).toBe(true);
  });
});

describe('reclaimIntervalMs — MEMORY_BANK_INJECT_RECLAIM_MS', () => {
  it('양의 유한수만 받고 그 밖에는 45초', () => {
    expect(daemonMod.reclaimIntervalMs('120')).toBe(120);
    for (const bad of [undefined, '', '0', '-5', 'abc', 'Infinity']) expect(daemonMod.reclaimIntervalMs(bad), String(bad)).toBe(45_000);
  });
});
