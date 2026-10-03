import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 실제 데몬의 응답 프로토콜 (2026-10-03, v1.7.1 독립 검토 지적).
 *
 * 1.7.1 의 원장·준비 중 신호 테스트는 가짜 데몬만 썼다. 가짜 데몬은 원장을 쓰지
 * 않으니, 실제 데몬이 다시 원장을 써도 실패하는 테스트가 없었고, 실제 데몬의
 * 10초 유휴 차단이 준비 중 대기(20초)를 끊는 결함도 어떤 테스트도 지나가지 않았다.
 * 여기서는 startInjectDaemon 이 띄운 진짜 소켓 서버에 바이트를 보낸다. 계산
 * (computeInjectResult)과 모델 상태만 바꿔 끼운다.
 */

const state = vi.hoisted(() => ({ ready: true }));
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  embeddingsReady: vi.fn(() => state.ready),
}));
vi.mock('../src/inject-core.js', () => ({ computeInjectResult: vi.fn() }));

const IDLE_MS = 300; // 요청 줄이 다 오기 전 유휴 한도 — 시험에서는 짧게
const prevEnv = { ...process.env };
let tmp: string;
let sock: string;
let compute: ReturnType<typeof vi.fn>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROMPT = '배포 파이프라인을 Vercel 프리뷰로 바꾸는 방법을 정리해 줘';

/** 바이트 조각들을 간격을 두고 보내고, 서버가 연결을 닫을 때까지 받은 줄을 돌려준다(오류로 끊겨도 받은 만큼). */
function exchange(writes: Array<Buffer | string>, gapMs = 60): Promise<{ raw: string; lines: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    const chunks: Buffer[] = [];
    c.on('connect', async () => {
      for (const w of writes) {
        c.write(w);
        await sleep(gapMs);
      }
    });
    c.on('data', (d) => chunks.push(d));
    c.on('error', () => { /* 서버가 끊음 — 받은 만큼으로 판정 */ });
    c.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({ raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) });
    });
  });
}

const request = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', ...extra }) + '\n';

beforeAll(async () => {
  // 짧은 기준 경로: unix 소켓 경로는 104바이트 안이어야 한다
  tmp = fs.mkdtempSync('/tmp/mbdp-');
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_INJECT_IDLE_MS = String(IDLE_MS);
  const core = await import('../src/inject-core.js');
  compute = core.computeInjectResult as unknown as ReturnType<typeof vi.fn>;
  const daemon = await import('../src/inject-daemon.js');
  daemon.startInjectDaemon();
  sock = daemon.injectSocketPath();
  const until = Date.now() + 3000;
  while (!fs.existsSync(sock) && Date.now() < until) await sleep(20);
  expect(fs.existsSync(sock), '데몬 소켓이 바인드됐다').toBe(true);
});

afterAll(() => {
  process.env = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('실제 데몬 — 요청 처리', () => {
  it('계산이 유휴 한도보다 오래 걸려도 연결을 끊지 않고 답한다 (한도는 요청이 다 오기 전까지만)', async () => {
    compute.mockImplementationOnce(async () => {
      await sleep(IDLE_MS * 3);
      return { context: 'SLOW-BLOCK', ledgerKeys: ['f-slow'] };
    });
    const { lines } = await exchange([request()]);
    expect(lines.at(-1), '유휴 차단에 걸리면 응답 없이 끊긴다').toMatchObject({ ok: true, context: 'SLOW-BLOCK', ledger_keys: ['f-slow'] });
  });

  it('원장은 쓰지 않고 키만 응답에 싣는다 — 기록은 블록을 출력한 쪽이 한다', async () => {
    compute.mockResolvedValueOnce({ context: 'BLOCK', ledgerKeys: ['f-1', 't:abc'] });
    const { lines } = await exchange([request({ session_id: 'sess-dp-ledger' })]);
    expect(lines.at(-1)).toMatchObject({ ok: true, context: 'BLOCK', ledger_keys: ['f-1', 't:abc'] });
    const ledger = path.join(tmp, 'conversation-index', 'state', 'inject-ledger', 'sess-dp-ledger.json');
    expect(fs.existsSync(ledger), '데몬이 원장을 쓰면 클라이언트가 버린 블록도 「이미 실음」이 된다').toBe(false);
  });

  it('계산이 실패하면 빈 성공이 아니라 ok:false 로 답한다 (클라이언트가 대체 경로로 가도록)', async () => {
    compute.mockResolvedValueOnce({ context: '', ledgerKeys: [], failed: true });
    const { lines } = await exchange([request()]);
    expect(lines.at(-1)).toMatchObject({ ok: false });
  });

  it('요청이 다바이트 문자 가운데서 쪼개져 와도 프롬프트를 그대로 받는다', async () => {
    compute.mockImplementationOnce(async (p: string) => ({ context: `GOT:${p}`, ledgerKeys: [] }));
    const buf = Buffer.from(request());
    const k = buf.findIndex((b) => b >= 0xe0) + 1; // 첫 한글 글자(3바이트)의 가운데
    const { lines } = await exchange([buf.subarray(0, k), buf.subarray(k)]);
    expect(lines.at(-1)).toMatchObject({ ok: true, context: `GOT:${PROMPT}` });
  });

  it('요청 줄 뒤에 바이트가 더 와도 한 번만 계산한다', async () => {
    let calls = 0;
    compute.mockImplementation(async () => {
      calls++;
      await sleep(200);
      return { context: 'ONCE', ledgerKeys: [] };
    });
    try {
      await exchange([request(), 'trailing']); // 둘째 조각은 첫 계산이 끝나기 전에 도착한다
    } finally {
      compute.mockReset();
    }
    expect(calls).toBe(1);
  });

  it('모델이 준비 중이면 검색할 프롬프트에 {"warming":true} 를 먼저 보내고, 짧은 프롬프트에는 보내지 않는다', async () => {
    state.ready = false;
    try {
      compute.mockImplementationOnce(async () => {
        await sleep(100);
        return { context: 'WARM', ledgerKeys: [] };
      });
      const warm = await exchange([request()]);
      expect(warm.lines[0]).toEqual({ warming: true });
      expect(warm.lines.at(-1)).toMatchObject({ ok: true, context: 'WARM' });

      compute.mockResolvedValueOnce({ context: '', ledgerKeys: [] });
      const short = await exchange([JSON.stringify({ prompt: 'hi', cwd: '/tmp/proj' }) + '\n']);
      expect(short.lines).toEqual([{ ok: true, context: '', ledger_keys: [] }]);
    } finally {
      state.ready = true;
    }
  });
});
