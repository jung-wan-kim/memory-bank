import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { injectSocketPathIn, ownPackageVersion } from '../src/version-guard.js';

vi.mock('../src/embeddings.js', async (orig) => ({
  ...(await orig<typeof import('../src/embeddings.js')>()),
  initEmbeddings: vi.fn(async () => {}), // the daemon pre-warms the model on bind — not needed here
}));

/**
 * 버전별 데몬 소켓 (2026-10-03).
 *
 * 1.7.0 을 만들 때 소켓을 잡고 있던 MCP 서버는 전부 1.5.0 이었다. 소켓 이름이
 * 버전 공통이라 새 세션의 훅 클라이언트가 옛 데몬의 옛 주입 로직으로 답을 받았을
 * 것이다. 소켓을 넘겨받는 방식은 안 된다 — libuv 는 서버가 닫힐 때(프로세스 종료
 * 포함) 소켓 파일을 이름으로 지우므로 옛 주인이 나가면서 새 주인의 파일을 지운다(실측).
 * 아래는 실제 소켓으로 "옛 이름에 옛 데몬이 살아 있는" 상태를 만든다.
 */

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const servers: net.Server[] = [];
let tmp: string;

function fakeDaemon(sockPath: string, context: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => {
      c.on('data', () => c.end(JSON.stringify({ ok: true, context }) + '\n'));
    });
    s.on('error', reject);
    s.listen(sockPath, () => { servers.push(s); resolve(s); });
  });
}

function runClient(input: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['scripts/inject-context.js'], {
      cwd: REPO, timeout: 20_000,
      env: { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_CLIENT: '' },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(JSON.stringify(input));
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

beforeEach(() => {
  // Short base: a unix socket path must fit in 104 bytes (os.tmpdir() on macOS is too deep)
  tmp = fs.mkdtempSync('/tmp/mbsk-');
  fs.mkdirSync(path.join(tmp, 'conversation-index'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('injectSocketPathIn', () => {
  it('버전마다 다른 파일', () => {
    expect(injectSocketPathIn('/x/ci', '1.7.0')).toBe('/x/ci/inject-daemon-1.7.0.sock');
    expect(injectSocketPathIn('/x/ci', '1.5.0')).not.toBe(injectSocketPathIn('/x/ci', '1.7.0'));
  });

  it('쓸 수 없는 버전 문자열·너무 긴 경로는 예전 이름', () => {
    expect(injectSocketPathIn('/x/ci', null)).toBe('/x/ci/inject-daemon.sock');
    expect(injectSocketPathIn('/x/ci', '../../etc/x')).toBe('/x/ci/inject-daemon.sock');
    const deep = '/' + 'd'.repeat(80);
    expect(injectSocketPathIn(deep, '1.7.0')).toBe(path.join(deep, 'inject-daemon.sock'));
  });

  it('ownPackageVersion 은 package.json 의 버전', () => {
    expect(ownPackageVersion()).toBe(VERSION);
  });
});

describe('클라이언트는 자기 버전의 데몬에만 묻는다', () => {
  it('예전 이름 소켓에 옛 데몬이 살아 있어도 그 답을 쓰지 않는다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    await fakeDaemon(path.join(ci, 'inject-daemon.sock'), 'FROM-OLD-DAEMON');
    await fakeDaemon(injectSocketPathIn(ci, VERSION), 'FROM-SAME-VERSION-DAEMON');
    const out = await runClient({
      prompt: '배포 파이프라인을 Vercel 프리뷰로 바꾸는 방법을 정리해 줘',
      cwd: '/tmp/proj', session_id: 'sess-socket-01', hook_event_name: 'UserPromptSubmit',
    });
    expect(out).toContain('FROM-SAME-VERSION-DAEMON');
    expect(out).not.toContain('FROM-OLD-DAEMON');
  });
});

describe('데몬 응답 프로토콜 — 준비 중 신호와 원장 기록', () => {
  const PROMPT = { prompt: '배포 파이프라인을 Vercel 프리뷰로 바꾸는 방법을 정리해 줘', cwd: '/tmp/proj', session_id: 'sess-proto-01', hook_event_name: 'UserPromptSubmit' };
  const ledgerFile = () => path.join(tmp, 'conversation-index', 'state', 'inject-ledger', 'sess-proto-01.json');

  function scriptedDaemon(sockPath: string, script: (c: net.Socket) => void): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const s = net.createServer((c) => { c.once('data', () => script(c)); });
      s.on('error', reject);
      s.listen(sockPath, () => { servers.push(s); resolve(s); });
    });
  }

  it('준비 중 신호를 받으면 응답 한도(3초)를 넘겨도 기다리고, 받은 블록을 출력한 뒤 원장에 기록한다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    await scriptedDaemon(injectSocketPathIn(ci, VERSION), (c) => {
      c.write(JSON.stringify({ warming: true }) + '\n');
      setTimeout(() => c.end(JSON.stringify({ ok: true, context: 'WARM-BLOCK', ledger_keys: ['fact-1', 't:abc'] }) + '\n'), 3500);
    });
    const out = await runClient(PROMPT);
    expect(out).toContain('WARM-BLOCK');
    expect(fs.existsSync(ledgerFile()), '전달한 블록의 원장').toBe(true);
    expect(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))).toEqual(['fact-1', 't:abc']);
  }, 30_000);

  it('응답이 한도 안에 오지 않으면 그 블록은 버리고 원장에도 남기지 않는다 (대체 경로 사유 기록)', async () => {
    const ci = path.join(tmp, 'conversation-index');
    await scriptedDaemon(injectSocketPathIn(ci, VERSION), (c) => {
      setTimeout(() => { try { c.end(JSON.stringify({ ok: true, context: 'LATE-BLOCK', ledger_keys: ['late-1'] }) + '\n'); } catch { /* client gone */ } }, 4000);
    });
    const out = await runClient(PROMPT);
    expect(out).not.toContain('LATE-BLOCK');
    const ledger = fs.existsSync(ledgerFile()) ? JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) : [];
    expect(ledger).not.toContain('late-1');
    const log = fs.readFileSync(path.join(tmp, 'conversation-index', 'logs', 'inject-context.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ via: 'fallback', fallback_reason: 'daemon-timeout' });
  }, 60_000);
});

describe('데몬은 옛 버전 소켓과 무관하게 자기 소켓에 붙는다', () => {
  it('예전 이름에 살아 있는 서버가 있어도 버전 소켓을 바인드하고, 예전 파일은 그대로 둔다', async () => {
    const prev = process.env.MEMORY_BANK_CONFIG_DIR;
    process.env.MEMORY_BANK_CONFIG_DIR = tmp;
    try {
      const ci = path.join(tmp, 'conversation-index');
      const legacy = path.join(ci, 'inject-daemon.sock');
      await fakeDaemon(legacy, 'FROM-OLD-DAEMON');
      const { startInjectDaemon } = await import('../src/inject-daemon.js');
      startInjectDaemon();
      const mine = injectSocketPathIn(ci, VERSION);
      expect(await waitFor(() => fs.existsSync(mine)), '버전 소켓이 바인드됐다').toBe(true);

      const reply = await new Promise<string>((resolve, reject) => {
        const c = net.connect(mine);
        let buf = '';
        c.on('connect', () => c.write(JSON.stringify({ prompt: 'hi', cwd: '/tmp/proj' }) + '\n'));
        c.on('data', (d) => { buf += d.toString('utf8'); });
        c.on('end', () => resolve(buf));
        c.on('error', reject);
      });
      expect(JSON.parse(reply)).toEqual({ ok: true, context: '', ledger_keys: [] });
      expect(fs.existsSync(legacy), '옛 데몬의 소켓 파일은 건드리지 않는다').toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
      else process.env.MEMORY_BANK_CONFIG_DIR = prev;
    }
  });
});
