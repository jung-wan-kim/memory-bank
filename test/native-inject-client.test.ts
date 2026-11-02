import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { injectSocketPathIn } from '../src/version-guard.js';
import { lineDaemon, scriptedDaemon, closeAll, readInjectLog, readLedger, shortTmpDir, waitFor } from './helpers/fake-inject-daemon.js';

/**
 * The native thin client (native/inject-client) against the JS one (scripts/inject-context.js) — plan
 * docs/plans/2026-11-02-native-inject-client.md AC-001/002/003/005, TC-NEG-001/003, A-001/A-002. Both run as real
 * processes under the same MEMORY_BANK_CONFIG_DIR against the same fake daemons; what is compared is what the
 * hook host sees (stdout bytes), what the daemon receives, and what lands on disk (ledger, inject log).
 */

const REPO = path.resolve(__dirname, '..');
const CRATE = path.join(REPO, 'native', 'inject-client');
const SRC_HASH = fs.readFileSync(path.join(CRATE, 'SRC_HASH'), 'utf8').trim();
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const BIN = path.join(CRATE, 'target', 'release', 'memory-bank-inject-client');

function findCargo(): string | null {
  for (const c of [...(process.env.PATH || '').split(':').map((d) => path.join(d, 'cargo')), path.join(os.homedir(), '.cargo', 'bin', 'cargo'), '/opt/homebrew/bin/cargo']) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}
const cargo = findCargo();
if (!cargo) console.log('cargo 없음 — 네이티브 클라이언트 테스트 미실행 (node 경로만 검증됨)');

const PROMPT = '프롬프트 훅의 네이티브 클라이언트가 JS 클라이언트와 같은지 확인한다';
const servers: net.Server[] = [];
let tmp: string;
const ci = () => path.join(tmp, 'conversation-index');
const sock = () => injectSocketPathIn(ci(), VERSION);

type Run = { stdout: string; stderr: string; status: number | null; ms: number };
function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Scrub the hook/wrapper variables of the test process first; `extra` then sets (or, with undefined, unsets) on top —
  // the first version scrubbed after spreading `extra`, so a USER_PROMPT handed in for the Codex-wrapper cases was
  // dropped and both clients just logged skipped/empty (parity held, but the Codex path was never exercised).
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_PLUGIN_ROOT: REPO, MEMORY_BANK_CLIENT: '' };
  delete env.CLAUDE_CODE_ENTRYPOINT; delete env.USER_PROMPT; delete env.CWD; delete env.SESSION_ID;
  delete env.MEMORY_BANK_INJECT_DAEMON_FAILED; delete env.MEMORY_BANK_INJECT_REQ_ID; delete env.MEMORY_BANK_INJECT_FALLBACK_REASON;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}
/** Runs a client as a child process while this process's event loop keeps serving the fake daemon — a synchronous
 *  spawn would block the loop, so an in-process daemon could never answer and every client run would end in daemon-timeout. */
function runChild(cmd: string, args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string | undefined, timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (status) => { clearTimeout(timer); resolve({ stdout, stderr, status, ms: performance.now() - t0 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function runNative(input: string, extra: Record<string, string | undefined> = {}): Promise<Run> {
  return runChild(BIN, [], input, baseEnv(extra), undefined, 30_000);
}
function runNode(input: string, extra: Record<string, string | undefined> = {}): Promise<Run> {
  return runChild(process.execPath, ['scripts/inject-context.js'], input, baseEnv(extra), REPO, 60_000);
}
const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', session_id: 'sess-native-01', hook_event_name: 'UserPromptSubmit', transcript_path: '/tmp/t.jsonl', ...over });

/** A fake `node` on PATH that records what the native client hands to the fallback instead of running it. */
function fakeNode(): { pathEnv: string; read: () => { args: string; env: Record<string, string>; stdin: string } | null } {
  const dir = path.join(tmp, 'fakebin'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(tmp, 'fallback');
  fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\nprintf '%s' "$*" > "${out}.args"\nenv | grep '^MEMORY_BANK_INJECT_' | sort > "${out}.env"\ncat > "${out}.stdin"\n`);
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  return {
    pathEnv: `${dir}:/usr/bin:/bin`,
    read: () => {
      if (!fs.existsSync(`${out}.args`)) return null;
      const env: Record<string, string> = {};
      for (const l of fs.readFileSync(`${out}.env`, 'utf8').split('\n').filter(Boolean)) { const i = l.indexOf('='); env[l.slice(0, i)] = l.slice(i + 1); }
      return { args: fs.readFileSync(`${out}.args`, 'utf8'), env, stdin: fs.readFileSync(`${out}.stdin`, 'utf8') };
    },
  };
}
const logFields = (l: Record<string, unknown>) => ({ status: l.status, reason: l.reason, via: l.via, client: l.client, has_session: l.has_session, project: l.project, prompt_len: l.prompt_len });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!cargo)('native inject client ≡ JS client', () => {
  beforeAll(() => {
    execFileSync(cargo!, ['build', '--release', '--quiet'], { cwd: CRATE, env: { ...process.env, MEMORY_BANK_INJECT_CLIENT_SRC_HASH: SRC_HASH }, stdio: 'inherit' });
    expect(execFileSync(BIN, ['--src-hash'], { encoding: 'utf8' }).trim()).toBe(SRC_HASH);
  }, 600_000);
  beforeEach(() => { tmp = shortTmpDir('/tmp/mbnc-'); });
  afterEach(async () => { await closeAll(servers); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('AC-001 (a) immediate ok: same stdout bytes, same ledger file, same request keys; client_impl tells them apart', async () => {
    const received: Array<Record<string, unknown>> = [];
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: '## 관련 결정\n- CTX-A 한 줄\n- 둘째 줄 🙂', ledger_keys: ['k1', 'k2', 't:abc'] }) + '\n'), servers, received);
    const js = await runNode(envelope({ session_id: 'sess-js-a' }));
    const rs = await runNative(envelope({ session_id: 'sess-rs-a' }));
    expect(rs.status).toBe(0);
    expect(rs.stdout).toBe(js.stdout);
    expect(rs.stdout).toBe('## 관련 결정\n- CTX-A 한 줄\n- 둘째 줄 🙂\n');
    expect(await waitFor(() => readLedger(tmp, 'sess-rs-a') !== null)).toBe(true);
    expect(readLedger(tmp, 'sess-rs-a')).toBe(readLedger(tmp, 'sess-js-a'));
    expect(readLedger(tmp, 'sess-rs-a')).toBe('["k1","k2","t:abc"]');
    expect(received).toHaveLength(2);
    const [jsReq, rsReq] = received;
    expect(Object.keys(rsReq)).toEqual(Object.keys(jsReq));
    expect(Object.keys(rsReq)).toEqual(['prompt', 'cwd', 'session_id', 'client', 'req_id', 'client_impl']);
    expect(rsReq).toMatchObject({ prompt: PROMPT, cwd: '/tmp/proj', session_id: 'sess-rs-a', client: 'claude-code', client_impl: 'native' });
    expect(jsReq).toMatchObject({ client: 'claude-code', client_impl: 'node' });
    expect(String(rsReq.req_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('AC-001 (b) warming then ok: both wait past the 3s answer limit and deliver', async () => {
    await lineDaemon(sock(), (_req, c) => { c.write(JSON.stringify({ warming: true }) + '\n'); setTimeout(() => c.end(JSON.stringify({ ok: true, context: 'LATE', ledger_keys: ['l1'] }) + '\n'), 3500); }, servers);
    const rs = await runNative(envelope({ session_id: 'sess-rs-b' }));
    expect(rs.stdout).toBe('LATE\n');
    expect(await waitFor(() => readLedger(tmp, 'sess-rs-b') === '["l1"]')).toBe(true);
    const js = await runNode(envelope({ session_id: 'sess-js-b' }));
    expect(js.stdout).toBe(rs.stdout);
  }, 60_000);

  it('AC-001 (c)(d) + AC-003: ok:false and a hang-up hand the prompt to node with the JS fallback reasons, the same req_id and the raw stdin', async () => {
    const cases: Array<[string, (c: net.Socket) => void]> = [
      ['daemon-error', (c) => c.end(JSON.stringify({ ok: false }) + '\n')],
      ['daemon-closed', (c) => c.destroy()],
    ];
    for (const [reason, script] of cases) {
      const received: Array<Record<string, unknown>> = [];
      await lineDaemon(sock(), (_req, c) => script(c), servers, received);
      const fake = fakeNode();
      const input = envelope({ session_id: `sess-${reason}` });
      const rs = await runNative(input, { PATH: fake.pathEnv });
      expect(rs.status).toBe(0);
      expect(rs.stdout).toBe('');
      const got = fake.read();
      expect(got, reason).not.toBeNull();
      expect(got!.args).toBe(path.join(REPO, 'scripts', 'inject-context.js'));
      expect(got!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe(reason);
      expect(got!.env.MEMORY_BANK_INJECT_REQ_ID).toBe(received[0].req_id);
      expect(got!.stdin).toBe(input);
      await closeAll(servers);
      fs.rmSync(path.join(tmp, 'fallback.args'), { force: true });
    }
    // no daemon at all → 'no-daemon'
    const fake = fakeNode();
    await runNative(envelope(), { PATH: fake.pathEnv });
    expect(fake.read()!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe('no-daemon');
  });

  it('AC-003: without node on PATH the client says so once on stderr, exits 0, prints nothing', async () => {
    const rs = await runNative(envelope(), { PATH: '/usr/bin:/bin' });
    expect(rs.status).toBe(0);
    expect(rs.stdout).toBe('');
    expect(rs.stderr.trim().split('\n')).toHaveLength(1);
    expect(rs.stderr).toMatch(/node not found/);
  });

  it('AC-002: the prompt gate skips the same inputs with the same log fields, and searches the same text', async () => {
    const skipped = [
      '<task-notification>\n<task-id>b9ex41zdi</task-id>\n<status>completed</status>',
      '<command-message>workflow-authoring</command-message>\n<command-name>/workflow</command-name>',
      '<command-name>/model</command-name>\n<command-args>opus</command-args>',
      '<local-command-stdout>Set model to Opus 5.5 (1M context)</local-command-stdout>',
      '<cross-session-message from="worker">빌드 끝났습니다, 결과 확인 부탁</cross-session-message>',
      '<teammate-message teammate_id="qa">테스트 전부 통과했습니다 — 증거 첨부</teammate-message>',
      '<system-reminder>The user opened a file in the IDE</system-reminder>',
      '<system-reminder>x</system-reminder>\n응',
      '짧다',
      '',
    ];
    for (const p of skipped) {
      const js = await runNode(envelope({ prompt: p }));
      const before = readInjectLog(tmp).length;
      const rs = await runNative(envelope({ prompt: p }));
      expect(rs.status, p).toBe(0);
      expect(rs.stdout, p).toBe('');
      expect(js.stdout, p).toBe('');
      const lines = readInjectLog(tmp);
      expect(lines.length).toBe(before + 1);
      const [jsLine, rsLine] = [lines[before - 1], lines[before]];
      expect(logFields(rsLine), p).toEqual(logFields(jsLine));
      expect(rsLine.status).toBe('skipped');
      expect(rsLine.client_impl).toBe('native');
      expect(jsLine.client_impl).toBe('node');
      // the JS line's key order is the contract: ts first, then the status fields, then the client meta
      expect(Object.keys(rsLine)).toEqual(Object.keys(jsLine));
    }
    // searched inputs: the daemon must receive the same prompt text from both clients
    const received: Array<Record<string, unknown>> = [];
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 'X' }) + '\n'), servers, received);
    const searched = [
      '<command-message>qa-cycle</command-message>\n<command-name>/qa-cycle</command-name>\n<command-args>결제 페이지 환불 버그를 재현하고 원인을 찾아줘</command-args>',
      '<system-reminder>The user opened src/a.ts in the IDE</system-reminder>\n이 파일의 인증 흐름이 왜 두 번 도는지 설명해줘',
      PROMPT,
    ];
    for (const p of searched) {
      await runNode(envelope({ prompt: p })); await runNative(envelope({ prompt: p }));
      const [a, b] = received.splice(0, 2);
      expect(b.prompt).toBe(a.prompt);
      expect(b.prompt).toBe(p);
    }
    // Codex wrapper: the whole envelope in USER_PROMPT, stdin empty — both unwrap it and tag the client 'codex'
    const codexEnv = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT, cwd: '/tmp/codex-proj', session_id: 'sess-codex-01', turn_id: 'turn-1' });
    await runNode('', { USER_PROMPT: codexEnv }); await runNative('', { USER_PROMPT: codexEnv });
    const [a, b] = received.splice(0, 2);
    expect(b).toMatchObject({ prompt: PROMPT, cwd: '/tmp/codex-proj', session_id: 'sess-codex-01', client: 'codex' });
    expect(a).toMatchObject({ prompt: PROMPT, cwd: '/tmp/codex-proj', session_id: 'sess-codex-01', client: 'codex' });
    // a non-UserPromptSubmit envelope in USER_PROMPT is never searched
    const before = readInjectLog(tmp).length;
    await runNode('', { USER_PROMPT: JSON.stringify({ hook_event_name: 'SessionStart', prompt: PROMPT }) });
    await runNative('', { USER_PROMPT: JSON.stringify({ hook_event_name: 'SessionStart', prompt: PROMPT }) });
    const lines = readInjectLog(tmp).slice(before);
    expect(lines.map((l) => l.reason)).toEqual(['hook-envelope', 'hook-envelope']);
    expect(logFields(lines[1])).toEqual(logFields(lines[0]));
  }, 120_000);

  it('TC-NEG-003: empty stdin and no USER_PROMPT → exit 0, no output, one skipped/empty line like JS', async () => {
    const js = await runNode('');
    const rs = await runNative('');
    expect(rs.status).toBe(0); expect(rs.stdout).toBe(''); expect(js.stdout).toBe('');
    const lines = readInjectLog(tmp);
    expect(lines).toHaveLength(2);
    expect(logFields(lines[1])).toEqual(logFields(lines[0]));
    expect(lines[1]).toMatchObject({ status: 'skipped', reason: 'empty', via: 'client', client: 'manual', has_session: false, client_impl: 'native' });
  });

  it('TC-NEG-001: an ok line followed by an immediate hang-up prints the block exactly once and never falls back', async () => {
    await lineDaemon(sock(), (_req, c) => { c.write(JSON.stringify({ ok: true, context: 'ONCE', ledger_keys: ['o1'] }) + '\n'); c.destroy(); }, servers);
    const fake = fakeNode();
    const rs = await runNative(envelope({ session_id: 'sess-once' }), { PATH: fake.pathEnv });
    expect(rs.stdout).toBe('ONCE\n');
    expect(fake.read()).toBeNull();
    expect(await waitFor(() => readLedger(tmp, 'sess-once') === '["o1"]')).toBe(true);
  });

  it('AC-005: with a warm fake daemon the native client is ≤ 25ms end to end and under half the JS client', async () => {
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 'FAST' }) + '\n'), servers);
    const rsMs: number[] = []; const jsMs: number[] = [];
    await runNative(envelope()); await runNode(envelope()); // warm the page cache for both
    for (let i = 0; i < 7; i += 1) { rsMs.push((await runNative(envelope())).ms); jsMs.push((await runNode(envelope())).ms); }
    const rs = median(rsMs); const js = median(jsMs);
    console.log(`AC-005 end-to-end median (7 runs, fake daemon): native=${rs.toFixed(1)}ms node=${js.toFixed(1)}ms`);
    fs.mkdirSync(path.join(REPO, '.qa-artifacts'), { recursive: true }); // gitignored — absent on a fresh clone
    fs.writeFileSync(path.join(REPO, '.qa-artifacts', 'ac-005-timing.json'), JSON.stringify({ native_median_ms: rs, node_median_ms: js, native_ms: rsMs, node_ms: jsMs, measured_at: new Date().toISOString() }, null, 2));
    expect(rs).toBeLessThanOrEqual(25);
    expect(rs).toBeLessThan(js / 2);
  }, 120_000);

  it('A-001: hostile daemon answers never crash the client — non-JSON → daemon-error, non-string context like JS, non-string ledger keys dropped, 1MB line delivered', async () => {
    const fake = fakeNode();
    await scriptedDaemon(sock(), (c) => c.end('not json at all\n'), servers);
    let rs = await runNative(envelope(), { PATH: fake.pathEnv });
    expect(rs.status).toBe(0); expect(rs.stdout).toBe(''); expect(fake.read()!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe('daemon-error');
    await closeAll(servers);
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 12345, ledger_keys: ['s1', 7, null, { x: 1 }, 's2'] }) + '\n'), servers);
    const js = await runNode(envelope({ session_id: 'sess-hostile-js' }));
    rs = await runNative(envelope({ session_id: 'sess-hostile-rs' }));
    expect(rs.stdout).toBe(js.stdout);
    expect(rs.stdout).toBe('12345\n');
    expect(await waitFor(() => readLedger(tmp, 'sess-hostile-rs') !== null)).toBe(true);
    expect(readLedger(tmp, 'sess-hostile-rs')).toBe(readLedger(tmp, 'sess-hostile-js'));
    expect(readLedger(tmp, 'sess-hostile-rs')).toBe('["s1","s2"]');
    await closeAll(servers);
    const big = 'B'.repeat(1_100_000);
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: big }) + '\n'), servers);
    rs = await runNative(envelope());
    expect(rs.status).toBe(0);
    expect(rs.stdout.length).toBe(big.length + 1);
  }, 60_000);

  it('A-001 (e): a daemon that only ever says warming holds neither client past 20s — both give up with daemon-timeout, one request each', async () => {
    const received: Array<Record<string, unknown>> = [];
    await lineDaemon(sock(), (_req, c) => { const iv = setInterval(() => { try { c.write(JSON.stringify({ warming: true }) + '\n'); } catch { clearInterval(iv); } }, 300); c.on('close', () => clearInterval(iv)); }, servers, received);
    const fake = fakeNode();
    const [rs, js] = await Promise.all([runNative(envelope({ session_id: 'sess-warm-rs' }), { PATH: fake.pathEnv }), runNode(envelope({ session_id: 'sess-warm-js' }))]);
    expect(rs.status).toBe(0); expect(rs.stdout).toBe('');
    expect(rs.ms).toBeGreaterThan(19_500); expect(rs.ms).toBeLessThan(28_000);
    expect(fake.read()!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe('daemon-timeout');
    expect(js.status).toBe(0);
    expect(js.ms).toBeGreaterThan(19_500); expect(js.ms).toBeLessThan(40_000);
    const jsLine = readInjectLog(tmp).find((l) => l.client_impl === 'node');
    expect(jsLine?.fallback_reason ?? jsLine?.reason).toBe('daemon-timeout');
    expect(received.length).toBe(2);
  }, 90_000);

  it('parity on edge envelopes and prompts: non-object JSON, numeric/boolean prompt, BOM, CRLF, U+0085, FEFF — same searched text or same skipped fields', async () => {
    const received: Array<Record<string, unknown>> = [];
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 'X' }) + '\n'), servers, received);
    const LONG = '충분히 긴 본문이 뒤에 이어져서 게이트의 20자 기준을 넘긴다';
    // [name, stdin, extra env, expected outcome, expected skipped reason / prompt_len] — the expectation column keeps
    // the comparison from passing when both clients are wrong the same way (round-2 critique L3)
    const cases: Array<[string, string, Record<string, string | undefined>, 'searched' | 'skipped', string | number]> = [
      ['stdin null', 'null', {}, 'skipped', 'short'],                     // JSON.parse('null').prompt throws → raw text 'null' (4 chars)
      ['stdin array', '[1,2]', {}, 'skipped', 'empty'],
      ['stdin number', '123', {}, 'skipped', 'empty'],
      ['stdin string literal', '"just a string"', {}, 'skipped', 'empty'],
      ['numeric prompt', '{"prompt":123}', {}, 'skipped', 'short'],
      ['float prompt 1.0', '{"prompt":1.0,"session_id":"s"}', {}, 'skipped', 1],     // String(1.0) === '1' → prompt_len 1
      ['float prompt 1.5', '{"prompt":1.5}', {}, 'skipped', 3],
      ['boolean prompt', '{"prompt":true}', {}, 'skipped', 4],
      ['BOM before JSON', '\uFEFF' + envelope({ prompt: LONG }), {}, 'searched', 0],   // JSON.parse fails → the raw text is the prompt
      ['CRLF inside prompt', envelope({ prompt: 'first line\r\nsecond line ' + LONG }), {}, 'searched', 0],
      ['U+0085 before a machine tag', envelope({ prompt: '\u0085<task-notification>x</task-notification> ' + LONG }), {}, 'searched', 0], // U+0085 is not JS whitespace → not a tag
      ['FEFF before a machine tag', envelope({ prompt: '\uFEFF<task-notification>x</task-notification>' }), {}, 'skipped', 'task-notification'],
      ['FEFF before the USER_PROMPT envelope', '', { USER_PROMPT: '\uFEFF' + JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: LONG, cwd: '/tmp/c', session_id: 's-feff', turn_id: 't' }) }, 'searched', 0],
      ['non-UserPromptSubmit envelope with BOM', '', { USER_PROMPT: '\uFEFF' + JSON.stringify({ hook_event_name: 'SessionStart', prompt: LONG }) }, 'skipped', 'hook-envelope'],
      ['lone surrogate escape inside the stdin envelope', '{"prompt":"' + LONG + ' \\ud83d","cwd":"/tmp/sur","session_id":"sess-sur-env","hook_event_name":"UserPromptSubmit","transcript_path":"/t"}', {}, 'searched', 0], // JSON.parse accepts it; the native client must still parse the envelope (not treat it as text)
    ];
    for (const [name, input, extra, expected, detail] of cases) {
      const run = async (f: typeof runNative) => {
        const before = readInjectLog(tmp).length; const n0 = received.length;
        const r = await f(input, extra);
        return { r, req: received.length > n0 ? received[received.length - 1] : null, log: readInjectLog(tmp).slice(before) };
      };
      const js = await run(runNode); const rs = await run(runNative);
      expect(rs.r.status, name).toBe(0);
      expect(rs.r.stdout, name).toBe(js.r.stdout);
      const fold = (p: unknown) => String(p ?? '').replace(/[\uD800-\uDFFF]/g, '\uFFFD'); // a lone surrogate JS keeps is U+FFFD on the wire from the native side
      expect(fold(rs.req?.prompt), name).toBe(fold(js.req?.prompt));
      expect(rs.req?.client ?? null, name).toBe(js.req?.client ?? null);
      expect(rs.req?.session_id ?? null, name).toBe(js.req?.session_id ?? null);
      expect(rs.log.length, name).toBe(js.log.length);
      if (js.log.length) expect(logFields(rs.log[0]), name).toEqual(logFields(js.log[0]));
      // the expectation column
      expect(js.req !== null ? 'searched' : 'skipped', name).toBe(expected);
      if (expected === 'skipped') {
        if (typeof detail === 'string') expect(js.log[0]?.reason, name).toBe(detail); else expect(js.log[0]?.prompt_len, name).toBe(detail);
      }
    }
  }, 120_000);

  it('a lone surrogate escape in the daemon block prints the same bytes from both clients (U+FFFD), and the ledger is written', async () => {
    await lineDaemon(sock(), (_req, c) => c.end('{"ok":true,"context":"a\\ud83d b \\ud83d\\ude00","ledger_keys":["k1"]}\n'), servers);
    const js = await runNode(envelope({ session_id: 'sess-sur-js' }));
    const rs = await runNative(envelope({ session_id: 'sess-sur-rs' }));
    expect(rs.stdout).toBe(js.stdout);
    expect(rs.stdout).toBe('a\uFFFD b 😀\n');
    expect(await waitFor(() => readLedger(tmp, 'sess-sur-rs') === '["k1"]')).toBe(true);
  });

  it('warming and the answer arriving in ONE chunk are both handled; a backslash before a non-ASCII byte is daemon-error in both, never a crash', async () => {
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ warming: true }) + '\n' + JSON.stringify({ ok: true, context: 'ONE-CHUNK', ledger_keys: ['c1'] }) + '\n'), servers);
    const js = await runNode(envelope({ session_id: 'sess-chunk-js' })); const rs = await runNative(envelope({ session_id: 'sess-chunk-rs' }));
    expect(rs.stdout).toBe('ONE-CHUNK\n'); expect(js.stdout).toBe(rs.stdout);
    expect(await waitFor(() => readLedger(tmp, 'sess-chunk-rs') === '["c1"]')).toBe(true);
    await closeAll(servers);
    // `\é` inside the JSON line: invalid JSON for JSON.parse and for serde — round-2 critique N1 (the sanitizer sliced inside the 2-byte char)
    await lineDaemon(sock(), (_req, c) => c.end(Buffer.concat([Buffer.from('{"ok":true,"context":"'), Buffer.from([0x5c]), Buffer.from('é"}\n')])), servers);
    const fake = fakeNode();
    const rs2 = await runNative(envelope({ session_id: 'sess-bs-rs' }), { PATH: fake.pathEnv });
    expect(rs2.status).toBe(0); expect(rs2.stdout).toBe(''); expect(fake.read()!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe('daemon-error');
    const js2 = await runNode(envelope({ session_id: 'sess-bs-js' }));
    expect(js2.status).toBe(0);
    expect(readInjectLog(tmp).find((l) => l.client_impl === 'node' && l.fallback_reason)?.fallback_reason).toBe('daemon-error');
  }, 60_000);

  it('the per-session ledger keeps at most 800 keys in both clients — oldest out first, same file bytes', async () => {
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 'CAP', ledger_keys: ['n1', 'n2', 'k5'] }) + '\n'), servers);
    const dir = path.join(ci(), 'state', 'inject-ledger'); fs.mkdirSync(dir, { recursive: true });
    const seed = JSON.stringify(Array.from({ length: 799 }, (_, i) => `k${i + 1}`));
    fs.writeFileSync(path.join(dir, 'sess-cap-js.json'), seed); fs.writeFileSync(path.join(dir, 'sess-cap-rs.json'), seed);
    await runNode(envelope({ session_id: 'sess-cap-js' })); await runNative(envelope({ session_id: 'sess-cap-rs' }));
    expect(await waitFor(() => readLedger(tmp, 'sess-cap-rs') !== seed && readLedger(tmp, 'sess-cap-js') !== seed)).toBe(true);
    const rsL = JSON.parse(readLedger(tmp, 'sess-cap-rs')!) as string[]; const jsL = JSON.parse(readLedger(tmp, 'sess-cap-js')!) as string[];
    expect(rsL).toEqual(jsL);
    expect(rsL.length).toBe(800); expect(rsL[0]).toBe('k2'); expect(rsL.slice(-2)).toEqual(['n1', 'n2']); expect(rsL.filter((k) => k === 'k5').length).toBe(1);
  }, 60_000);

  it('a prompt the native client hands to node keeps client_impl native on the fallback log line (fallback rate stays measurable)', async () => {
    const rs = await runNative(envelope({ session_id: 'sess-fb-tag' })); // no daemon listening, real node on PATH
    expect(rs.status).toBe(0);
    const line = readInjectLog(tmp).find((l) => l.fallback_reason === 'no-daemon');
    expect(line).toBeDefined();
    expect(line!.client_impl).toBe('native');
    expect(String(line!.req_id)).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  it('a daemon trickling bytes without a newline hits the same 3s answer deadline in both clients (deadlines are absolute, not per read)', async () => {
    const received: Array<Record<string, unknown>> = [];
    await lineDaemon(sock(), (_req, c) => { const iv = setInterval(() => { try { c.write('x'); } catch { clearInterval(iv); } }, 700); c.on('close', () => clearInterval(iv)); }, servers, received);
    const fake = fakeNode();
    const [rs, js] = await Promise.all([runNative(envelope({ session_id: 'sess-trickle-rs' }), { PATH: fake.pathEnv }), runNode(envelope({ session_id: 'sess-trickle-js' }))]);
    expect(rs.status).toBe(0); expect(rs.stdout).toBe('');
    expect(rs.ms).toBeGreaterThan(2_800); expect(rs.ms).toBeLessThan(7_000);
    expect(fake.read()!.env.MEMORY_BANK_INJECT_DAEMON_FAILED).toBe('daemon-timeout');
    expect(js.ms).toBeGreaterThan(2_800); expect(js.ms).toBeLessThan(20_000);
    expect(readInjectLog(tmp).find((l) => l.client_impl === 'node')?.fallback_reason).toBe('daemon-timeout');
    expect(received.length).toBe(2);
  }, 60_000);

  it('A-002: a session id with path characters never leaves the ledger directory — same file name rule as JS', async () => {
    await lineDaemon(sock(), (_req, c) => c.end(JSON.stringify({ ok: true, context: 'L', ledger_keys: ['k'] }) + '\n'), servers);
    for (const sid of ['../../etc/x', 'a/b', '   ', 'abc', 'x'.repeat(200), 'good-session_01']) {
      await runNode(envelope({ session_id: sid })); await runNative(envelope({ session_id: sid }));
    }
    await waitFor(() => fs.existsSync(path.join(ci(), 'state', 'inject-ledger')));
    const dir = path.join(ci(), 'state', 'inject-ledger');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    expect(files).toEqual(['etcx.json', 'good-session_01.json', `${'x'.repeat(80)}.json`]);
    expect(fs.existsSync(path.join(tmp, 'etc'))).toBe(false);
    expect(fs.existsSync('/tmp/etc/x.json')).toBe(false);
  }, 60_000);
});
