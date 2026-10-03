import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
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

const clientEnv = () => ({ ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_CLIENT: '' });

/** 클라이언트 stdout. 20초 안에 끝나지 않아 강제 종료돼도 받은 만큼 돌려준다 — 판정은 단언이 한다. */
function runClient(input: object): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['scripts/inject-context.js'], {
      cwd: REPO, timeout: 20_000, env: clientEnv(),
    }, (_err, stdout) => resolve(String(stdout ?? '')));
    child.stdin!.end(JSON.stringify(input));
  });
}

function readInjectLog(): Array<Record<string, unknown>> {
  const f = path.join(tmp, 'conversation-index', 'logs', 'inject-context.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

  /** 요청 줄을 끝까지 읽어 파싱한 뒤 script 에 넘기는 가짜 데몬. */
  function lineDaemon(sockPath: string, script: (req: Record<string, unknown>, c: net.Socket) => void): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const s = net.createServer((c) => {
        c.setEncoding('utf8');
        let buf = '';
        let handled = false;
        c.on('data', (d: string) => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (handled || nl < 0) return;
          handled = true;
          script(JSON.parse(buf.slice(0, nl)), c);
        });
      });
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
    expect(readInjectLog().at(-1)).toMatchObject({ via: 'fallback', fallback_reason: 'daemon-timeout' });
  }, 60_000);

  it('준비 중 신호 뒤 데몬이 답 없이 연결을 닫으면 대기 한도(20초)를 기다리지 않고 바로 대체 경로로 간다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    let sentReqId: unknown = null;
    await lineDaemon(injectSocketPathIn(ci, VERSION), (req, c) => {
      sentReqId = req.req_id;
      c.write(JSON.stringify({ warming: true }) + '\n');
      setTimeout(() => c.end(), 100);
    });
    const t0 = Date.now();
    await runClient(PROMPT);
    const last = readInjectLog().at(-1);
    expect(last, '연결 종료를 듣지 않으면 20초 뒤 daemon-timeout').toMatchObject({ via: 'fallback', fallback_reason: 'daemon-closed' });
    expect(Date.now() - t0).toBeLessThan(15_000);
    // 데몬이 계산해 로그를 남긴 뒤 버려진 블록과, 이 대체 경로 줄을 같은 요청으로 묶는 열쇠
    expect(String(sentReqId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(last!.req_id).toBe(sentReqId);
  }, 60_000);

  it('응답이 다바이트 문자 가운데서 쪼개져 와도 블록을 그대로 출력한다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    const BLOCK = '📌 관련 과거 결정:\n- [decision] 배포는 Vercel 프리뷰로 확인한 뒤 병합한다';
    const reply = Buffer.from(JSON.stringify({ ok: true, context: BLOCK, ledger_keys: [] }) + '\n');
    const k = reply.findIndex((b) => b >= 0xe0) + 1; // 첫 다바이트 글자의 가운데
    await scriptedDaemon(injectSocketPathIn(ci, VERSION), (c) => {
      c.write(reply.subarray(0, k));
      setTimeout(() => c.end(reply.subarray(k)), 80);
    });
    const out = await runClient(PROMPT);
    expect(out).toContain(BLOCK);
  }, 30_000);

  it('훅 입력이 여러 조각으로 읽혀도 다바이트 문자를 깨지 않는다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    await lineDaemon(injectSocketPathIn(ci, VERSION), (req, c) => {
      const p = String(req.prompt);
      c.end(JSON.stringify({ ok: true, context: `LEN:${p.length}:${p.includes('\uFFFD')}`, ledger_keys: [] }) + '\n');
    });
    // 훅 입력을 이모지 가운데서 끊어 두 번에 나눠 보낸다(간격을 둬서 클라이언트가 따로 읽게).
    // 파이프 버퍼 크기에 기대지 않는다 — 조각 경계를 테스트가 정한다.
    const prompt = '배포 파이프라인 정리 \u{1F600}\u{1F680} 프리뷰 확인 순서';
    const buf = Buffer.from(JSON.stringify({ ...PROMPT, prompt }));
    const k = buf.indexOf(Buffer.from('\u{1F600}')) + 2; // 4바이트 이모지의 가운데
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['scripts/inject-context.js'], { cwd: REPO, env: clientEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => { stdout += d; });
      child.on('close', () => resolve(stdout));
      child.stdin!.write(buf.subarray(0, k));
      setTimeout(() => child.stdin!.end(buf.subarray(k)), 150);
    });
    expect(out).toContain(`LEN:${prompt.length}:false`);
  }, 30_000);

  it('출력을 받는 쪽이 파이프를 닫아 전달에 실패하면 원장에 기록하지 않는다', async () => {
    const ci = path.join(tmp, 'conversation-index');
    await scriptedDaemon(injectSocketPathIn(ci, VERSION), (c) => {
      setTimeout(() => c.end(JSON.stringify({ ok: true, context: 'UNDELIVERED-BLOCK', ledger_keys: ['f-undelivered'] }) + '\n'), 300);
    });
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ['scripts/inject-context.js'], { cwd: REPO, env: clientEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout!.destroy(); // 받는 쪽(훅 호스트)이 먼저 떠났다
      child.on('exit', () => resolve());
      child.stdin!.end(JSON.stringify(PROMPT));
    });
    const ledger = fs.existsSync(ledgerFile()) ? JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) : [];
    expect(ledger, '전달되지 않은 블록의 fact').not.toContain('f-undelivered');
  }, 30_000);
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
