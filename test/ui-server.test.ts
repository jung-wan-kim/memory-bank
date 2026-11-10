import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The web UI server (ui/server.cjs) hands out whole conversations with no
 * login, so who can reach it is the whole security model (SEC-01):
 * loopback only by default, same-origin only, no CORS headers, no way around
 * the page-size cap, no built-in Hue OS password, and a separate listener —
 * chat routes only — for anything a tunnel points at.
 *
 * Every server here is a real child process on a free port, reading a seeded
 * database in a temp config dir (never the real one) with a temp HOME.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'ui', 'server.cjs');
const require = createRequire(import.meta.url);
const guards = require('../ui/server-guards.cjs');

const MARKER = 'FAKE_MARKER_ui_server_test';
const SEEDED_EXCHANGES = 205;
// Joined at run time: a token-shaped literal in a test file trips secret scanners.
const UI_TOKEN = ['ui', 'access', 'value', 'for', 'tests', '0123456789abcdef'].join('-');
const HUE_PASSWORD = 'correct-horse-9';
// A stored fact that tries to leave the inline <script> of the graph page, and carries
// the sequences String.replace treats specially in a replacement string.
const SCRIPT_BREAKOUT = `</script><script>window.__mb_xss_probe=1</script> & <!-- $& $' $\` \u2028`;

let tmp: string;
let configDir: string;
let fakeHome: string;
const running: ChildProcess[] = [];

interface Started { port: number; address: string; publicPort: number | null; output: () => string; stop: () => Promise<void> }
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Built from scratch: nothing of the developer's shell (HOME, config dir, tokens) reaches the server.
  return { PATH: process.env.PATH, HOME: fakeHome, MEMORY_BANK_CONFIG_DIR: configDir, PORT: '0', ...extra };
}

function startServer(extra: Record<string, string> = {}): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: serverEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    const wantPublic = extra.HUE_OS_PUBLIC_PORT !== undefined;
    let output = '';
    let settled = false;
    const stop = () => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once('exit', () => done());
      child.kill('SIGTERM');
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server did not report its listen address within 15s. Output:\n${output}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const main = /Listening on (\S+):(\d+) /.exec(output);
      const pub = /Hue OS public listener on \S+:(\d+) /.exec(output);
      if (!settled && main && (!wantPublic || pub)) {
        settled = true;
        clearTimeout(timer);
        resolve({ address: main[1], port: Number(main[2]), publicPort: pub ? Number(pub[1]) : null, output: () => output, stop });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening. Output:\n${output}`));
    });
  });
}

/** Run the server and wait for it to exit by itself (a configuration it must refuse). */
function runToExit(extra: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: serverEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server kept running; it should have refused to start. Output:\n${output}`));
    }, 15_000);
    child.stdout!.on('data', (c: Buffer) => { output += c.toString('utf8'); });
    child.stderr!.on('data', (c: Buffer) => { output += c.toString('utf8'); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

function request(port: number, urlPath: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; address?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: options.address ?? '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET',
      headers: options.headers, timeout: 20_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function postJson(port: number, urlPath: string, payload: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(port, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ui-server-'));
  configDir = path.join(tmp, 'config');
  fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  // Seed through the real schema, then close: the server opens the file read-only.
  const savedDbPath = process.env.MEMORY_BANK_DB_PATH;
  const savedTestDbPath = process.env.TEST_DB_PATH;
  delete process.env.TEST_DB_PATH;
  process.env.MEMORY_BANK_DB_PATH = path.join(configDir, 'conversation-index', 'db.sqlite');
  try {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      const insert = db.prepare(`INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, 'demo-project', ?, ?, ?, '/archive/demo/a.jsonl', ?, ?)`);
      db.transaction(() => {
        for (let i = 0; i < SEEDED_EXCHANGES; i++) {
          insert.run(`ex-${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), `question ${i} ${MARKER}`, `answer ${i}`, i * 2 + 1, i * 2 + 2);
        }
      })();
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
        VALUES ('fact-breakout', ?, 'knowledge', 'global', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(SCRIPT_BREAKOUT);
    } finally {
      db.close();
    }
  } finally {
    if (savedDbPath === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = savedDbPath;
    if (savedTestDbPath !== undefined) process.env.TEST_DB_PATH = savedTestDbPath;
  }
}, 60_000);

afterAll(async () => {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listen address', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer(); });
  afterAll(async () => { await server.stop(); });

  it('binds the loopback address by default and serves the seeded temp database', async () => {
    expect(server.address).toBe('127.0.0.1');
    expect(server.output()).toContain('this machine only');
    const stats = await request(server.port, '/api/stats');
    expect(stats.status).toBe(200);
    expect(JSON.parse(stats.body).total).toBe(SEEDED_EXCHANGES);
  });

  const lanAddress = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  // Needs a non-loopback interface to try; reported as skipped (not passed) on a machine without one.
  it.skipIf(!lanAddress)('is not reachable through a network interface of this machine', async () => {
    await expect(request(server.port, '/api/stats', { address: lanAddress })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses to start on a non-loopback address without a token, or with a short one', async () => {
    const open = await runToExit({ MEMORY_BANK_UI_HOST: '0.0.0.0' });
    expect(open.code).toBe(1);
    expect(open.output).toContain('MEMORY_BANK_UI_TOKEN');
    expect(open.output).not.toContain('Listening on');

    const weak = await runToExit({ MEMORY_BANK_UI_HOST: '0.0.0.0', MEMORY_BANK_UI_TOKEN: 'short' });
    expect(weak.code).toBe(1);
    expect(weak.output).not.toContain('Listening on');
  });

  it('refuses a port that is not a port, and a public listener without a password', async () => {
    const badPort = await runToExit({ PORT: 'abc' });
    expect(badPort.code).toBe(1);
    expect(badPort.output).toContain('PORT');

    const noPassword = await runToExit({ HUE_OS_PUBLIC_PORT: '0' });
    expect(noPassword.code).toBe(1);
    expect(noPassword.output).toContain('REPLACEMENT_OS_ACCESS_PASSWORD');
    expect(noPassword.output).not.toContain('Listening on');
  });

  it('resolveListenConfig: an explicit address plus a token is the one way to listen wider', () => {
    expect(guards.resolveListenConfig({})).toMatchObject({ host: '127.0.0.1', port: 3847, token: null, publicPort: null, localOnly: true });
    expect(guards.resolveListenConfig({ MEMORY_BANK_UI_HOST: '0.0.0.0', MEMORY_BANK_UI_TOKEN: UI_TOKEN }))
      .toMatchObject({ host: '0.0.0.0', token: UI_TOKEN, localOnly: false });
    expect(() => guards.resolveListenConfig({ MEMORY_BANK_UI_HOST: '192.168.0.10' })).toThrow(/MEMORY_BANK_UI_TOKEN/);
    expect(() => guards.resolveListenConfig({ MEMORY_BANK_UI_HOST: '::' })).toThrow(/MEMORY_BANK_UI_TOKEN/);
    expect(guards.resolveListenConfig({ MEMORY_BANK_UI_HOST: '::1' }).localOnly).toBe(true);
    expect(() => guards.resolveListenConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => guards.resolveListenConfig({ PORT: '4000', HUE_OS_PUBLIC_PORT: '4000', REPLACEMENT_OS_ACCESS_PASSWORD: HUE_PASSWORD })).toThrow(/differ/);
  });

  it('resolveDbPath follows the same precedence as src/paths.ts', async () => {
    const { getDbPath } = await import('../src/paths.js');
    const cases: Array<Record<string, string>> = [
      { MEMORY_BANK_DB_PATH: path.join(tmp, 'a', 'x.sqlite'), MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'b') },
      { TEST_DB_PATH: path.join(tmp, 'c', 'y.sqlite') },
      { MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'd'), PERSONAL_SUPERPOWERS_DIR: path.join(tmp, 'e') },
      { PERSONAL_SUPERPOWERS_DIR: path.join(tmp, 'f'), XDG_CONFIG_HOME: path.join(tmp, 'g') },
      { XDG_CONFIG_HOME: path.join(tmp, 'h') },
    ];
    const keys = ['MEMORY_BANK_DB_PATH', 'TEST_DB_PATH', 'MEMORY_BANK_CONFIG_DIR', 'PERSONAL_SUPERPOWERS_DIR', 'XDG_CONFIG_HOME'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const env of cases) {
        for (const k of keys) delete process.env[k];
        Object.assign(process.env, env);
        expect(guards.resolveDbPath(env), JSON.stringify(Object.keys(env))).toBe(getDbPath());
      }
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe('same-origin only', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer(); });
  afterAll(async () => { await server.stop(); });

  it('answers a direct local request and sends no CORS header', async () => {
    const r = await request(server.port, `/api/search?q=${MARKER}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(MARKER);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('accepts the Origin of the page it served', async () => {
    const r = await request(server.port, '/api/stats', { headers: { Host: `127.0.0.1:${server.port}`, Origin: `http://127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'same-origin' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses another origin and leaks nothing to it', async () => {
    for (const urlPath of [`/api/search?q=${MARKER}`, '/api/exchange?id=ex-1', '/api/user-prompts', '/api/projects', '/api/graph-data', '/']) {
      const r = await request(server.port, urlPath, { headers: { Origin: 'https://evil.example' } });
      expect(r.status, urlPath).toBe(403);
      expect(r.body, urlPath).not.toContain(MARKER);
      expect(r.headers['access-control-allow-origin'], urlPath).toBeUndefined();
    }
    const opaque = await request(server.port, '/api/stats', { headers: { Origin: 'null' } });
    expect(opaque.status).toBe(403);
    const crossSite = await request(server.port, `/api/search?q=${MARKER}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).not.toContain(MARKER);
  });

  it('refuses a cross-origin POST before it reaches a handler', async () => {
    const r = await postJson(server.port, '/api/translate', { texts: ['hello'] }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('cross_origin');
  });

  it('refuses a request addressed to another host name (DNS rebinding)', async () => {
    const r = await request(server.port, `/api/search?q=${MARKER}`, { headers: { Host: `evil.example:${server.port}` } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('local_only');
    expect(r.body).not.toContain(MARKER);
  });

  it('refuses a request that came through a proxy or tunnel — pages, conversation APIs and Hue OS alike', async () => {
    for (const header of ['X-Forwarded-For', 'Cf-Connecting-Ip', 'Forwarded']) {
      const r = await request(server.port, `/api/search?q=${MARKER}`, { headers: { [header]: '203.0.113.7' } });
      expect(r.status, header).toBe(403);
      expect(r.body, header).not.toContain(MARKER);
    }
    const page = await request(server.port, '/dashboard', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(page.status).toBe(403);
    const hueOs = await postJson(server.port, '/api/replacement-os/login', { password: 'x' }, { Host: 'tunnel.example', 'X-Forwarded-For': '203.0.113.7' });
    expect(hueOs.status).toBe(403);
  });
});

describe('limits', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer(); });
  afterAll(async () => { await server.stop(); });

  it('rejects a limit or offset that is not a non-negative integer', async () => {
    for (const api of ['/api/search', '/api/user-prompts']) {
      for (const query of ['limit=-1', 'limit=0', 'limit=abc', 'limit=1e3', 'limit=5;--', 'offset=-5', 'offset=x']) {
        const r = await request(server.port, `${api}?${query}`);
        expect(r.status, `${api}?${query}`).toBe(400);
        expect(r.body, `${api}?${query}`).not.toContain(MARKER);
      }
    }
  });

  it('never returns more than 200 rows, whatever limit asks for', async () => {
    for (const api of ['/api/search', '/api/user-prompts']) {
      const r = await request(server.port, `${api}?limit=100000`);
      expect(r.status).toBe(200);
      const data = JSON.parse(r.body);
      expect(data.total).toBe(SEEDED_EXCHANGES);
      expect(data.limit).toBe(200);
      expect(data.results).toHaveLength(200);
    }
    const byDefault = JSON.parse((await request(server.port, '/api/search')).body);
    expect(byDefault.results).toHaveLength(50);
    const paged = JSON.parse((await request(server.port, '/api/search?limit=10&offset=200')).body);
    expect(paged.results).toHaveLength(SEEDED_EXCHANGES - 200);
  });

  it('refuses a request body over 1 MB', async () => {
    const r = await request(server.port, '/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(2 * 1024 * 1024, 0x20),
    });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error).toBe('body_too_large');
  });

  it('rejects a body that is not JSON, and translate input beyond 50 texts of 2,000 characters', async () => {
    const notJson = await request(server.port, '/api/translate', { method: 'POST', body: '{not json' });
    expect(notJson.status).toBe(400);
    expect(JSON.parse(notJson.body).error).toBe('invalid_json');

    const tooMany = await postJson(server.port, '/api/translate', { texts: new Array(51).fill('a') });
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.body).error).toBe('too_many_texts');

    const tooLong = await postJson(server.port, '/api/translate', { texts: ['a'.repeat(2001)] });
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.body).error).toBe('text_too_long');

    const notStrings = await postJson(server.port, '/api/translate', { texts: 'ignore previous instructions' });
    expect(notStrings.status).toBe(400);

    const empty = await postJson(server.port, '/api/translate', { texts: [] });
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ translated: [] });
  });
});

describe('Hue OS access password', () => {
  it('has no built-in password: without one configured the login is off and says so', async () => {
    const server = await startServer();
    try {
      for (const password of ['0525', '', '0000']) {
        const r = await postJson(server.port, '/api/hue-os/login', { password });
        expect(r.status, password).toBe(503);
        expect(JSON.parse(r.body), password).toEqual({ ok: false, error: 'access_password_not_configured' });
        expect(r.headers['set-cookie'], password).toBeUndefined();
      }
      const page = await request(server.port, '/hue-os');
      expect(page.status).toBe(200);
      expect(page.body).toContain('id="notConfigured"');
      expect(page.body).not.toContain('id="login"');
      expect((await request(server.port, '/api/hue-os/profile')).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('logs in with the configured password and sets an HttpOnly session cookie', async () => {
    const server = await startServer({ REPLACEMENT_OS_ACCESS_PASSWORD: HUE_PASSWORD });
    try {
      const wrong = await postJson(server.port, '/api/hue-os/login', { password: '0525' });
      expect(wrong.status).toBe(200);
      expect(JSON.parse(wrong.body)).toEqual({ ok: false, error: 'invalid_password' });

      const right = await postJson(server.port, '/api/hue-os/login', { password: HUE_PASSWORD });
      expect(right.status).toBe(200);
      expect(JSON.parse(right.body)).toEqual({ ok: true });
      const cookie = String(right.headers['set-cookie']);
      expect(cookie).toMatch(/replacement_os_session=[0-9a-f]{48}; HttpOnly; SameSite=Lax/);

      const profile = await request(server.port, '/api/hue-os/profile', { headers: { Cookie: cookie.split(';')[0] } });
      expect(profile.status).toBe(200);
      expect(JSON.parse(profile.body).quota).toMatchObject({ used: 0 });
      expect((await request(server.port, '/hue-os')).body).toContain('id="login"');
    } finally {
      await server.stop();
    }
  });

  it('stops accepting logins after 5 wrong passwords — the right one included', async () => {
    const server = await startServer({ REPLACEMENT_OS_ACCESS_PASSWORD: HUE_PASSWORD });
    try {
      for (let i = 0; i < 5; i++) {
        const r = await postJson(server.port, '/api/hue-os/login', { password: `guess-${i}` });
        expect(r.status, `guess ${i}`).toBe(200);
      }
      const sixth = await postJson(server.port, '/api/hue-os/login', { password: 'guess-5' });
      expect(sixth.status).toBe(429);
      expect(JSON.parse(sixth.body).error).toBe('too_many_attempts');
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);

      const right = await postJson(server.port, '/api/hue-os/login', { password: HUE_PASSWORD });
      expect(right.status).toBe(429);
      expect(right.headers['set-cookie']).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});

describe('token mode', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer({ MEMORY_BANK_UI_TOKEN: UI_TOKEN }); });
  afterAll(async () => { await server.stop(); });

  it('requires the token on every dashboard page and API', async () => {
    for (const urlPath of [`/api/search?q=${MARKER}`, '/api/stats', '/dashboard', '/']) {
      const none = await request(server.port, urlPath);
      expect(none.status, urlPath).toBe(401);
      expect(none.body, urlPath).not.toContain(MARKER);
      const wrong = await request(server.port, urlPath, { headers: { Authorization: `Bearer ${'x'.repeat(UI_TOKEN.length)}` } });
      expect(wrong.status, urlPath).toBe(401);
    }
    const ok = await request(server.port, `/api/search?q=${MARKER}`, { headers: { Authorization: `Bearer ${UI_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain(MARKER);
    // The token does not travel in an API URL.
    expect((await request(server.port, `/api/stats?token=${UI_TOKEN}`)).status).toBe(401);
  });

  it('turns /?token= into an HttpOnly cookie and drops the token from the URL', async () => {
    const r = await request(server.port, `/dashboard?token=${UI_TOKEN}&tab=search`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/dashboard?tab=search');
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const withCookie = await request(server.port, '/api/stats', { headers: { Cookie: cookie.split(';')[0] } });
    expect(withCookie.status).toBe(200);
    expect((await request(server.port, `/dashboard?token=wrong-token-wrong-token`)).status).toBe(401);
  });

  it('still refuses another origin, token or not', async () => {
    const r = await request(server.port, '/api/stats', { headers: { Authorization: `Bearer ${UI_TOKEN}`, Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
});

describe('Hue OS public listener', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer({ HUE_OS_PUBLIC_PORT: '0', REPLACEMENT_OS_ACCESS_PASSWORD: HUE_PASSWORD }); });
  afterAll(async () => { await server.stop(); });

  const tunnel = { Host: 'tunnel.example', 'X-Forwarded-For': '203.0.113.7', Origin: 'https://hue-os.example' };

  it('listens on its own loopback port', () => {
    expect(server.publicPort).not.toBeNull();
    expect(server.publicPort).not.toBe(server.port);
    expect(server.output()).toMatch(/Hue OS public listener on 127\.0\.0\.1:\d+ /);
  });

  it('has no dashboard page and no conversation API, whatever the request claims', async () => {
    const port = server.publicPort!;
    for (const urlPath of ['/', '/graph', '/dashboard', `/api/search?q=${MARKER}`, '/api/exchange?id=ex-1', '/api/user-prompts',
      '/api/projects', '/api/project-detail?project=demo-project', '/api/graph-data', '/api/stats', '/api/translate']) {
      for (const headers of [tunnel, { Host: `localhost:${port}` }, {}]) {
        const r = await request(port, urlPath, { headers: headers as Record<string, string> });
        expect(r.status, `${urlPath} ${JSON.stringify(headers)}`).toBe(404);
        expect(r.body, urlPath).not.toContain(MARKER);
      }
    }
    const post = await postJson(port, '/api/translate', { texts: ['hello'] }, tunnel);
    expect(post.status).toBe(404);
  });

  it('serves the Hue OS login and chat routes to a tunnelled request', async () => {
    const port = server.publicPort!;
    const page = await request(port, '/hue-os', { headers: tunnel });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="login"');

    expect((await request(port, '/api/replacement-os/profile', { headers: tunnel })).status).toBe(401);
    const login = await postJson(port, '/api/replacement-os/login', { password: HUE_PASSWORD }, tunnel);
    expect(login.status).toBe(200);
    expect(JSON.parse(login.body)).toEqual({ ok: true });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const profile = await request(port, '/api/replacement-os/profile', { headers: { ...tunnel, Cookie: cookie } });
    expect(profile.status).toBe(200);
    expect(JSON.parse(profile.body).quota).toMatchObject({ used: 0 });
  });
});

describe('HTML output (SEC-09)', () => {
  let server: Started;
  beforeAll(async () => { server = await startServer(); });
  afterAll(async () => { await server.stop(); });

  it('injects live data into the graph page without letting a stored string end the script', async () => {
    const page = await request(server.port, '/');
    expect(page.status).toBe(200);
    // The stored text is on the page — as data inside the script, not as markup.
    expect(page.body).not.toContain('</script><script>window.__mb_xss_probe=1</script>');
    expect(page.body).not.toContain('<script>window.__mb_xss_probe');
    expect(page.body).toContain('\\u003c/script\\u003e\\u003cscript\\u003ewindow.__mb_xss_probe=1');

    // What the browser's JS parser would read back is the stored text, byte for byte
    // (and `$&` / `$'` did not splice parts of the page into it).
    const inline = /var R=(\{.*\});\n(?=var DOM=)/.exec(page.body);
    expect(inline, 'the live-data assignment').not.toBeNull();
    const data = JSON.parse(inline![1]);
    expect(data.facts.map((f: { id: string }) => f.id)).toEqual(['fact-breakout']);
    expect(data.facts[0].fact).toBe(SCRIPT_BREAKOUT);
    expect(data.projects[0]).toMatchObject({ project: 'demo-project', exchanges: SEEDED_EXCHANGES });
  });

  it('safeJsonForScript escapes every character that can leave a script element or a JS string', () => {
    const value = { a: '</script>', b: '<!--', c: '&amp;', d: 'line\u2028sep\u2029' };
    const out = guards.safeJsonForScript(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });

  it('the dashboard escapes quotes too — its esc() output is used inside attributes', async () => {
    const page = await request(server.port, '/dashboard');
    expect(page.status).toBe(200);
    const source = /function esc\(s\)\{.*?\}\n/.exec(page.body);
    expect(source, 'esc() in the dashboard script').not.toBeNull();
    const esc = new Function(`${source![0]}; return esc;`)() as (s: unknown) => string;
    expect(esc(`x" onmouseover="alert(1)`)).toBe('x&quot; onmouseover=&quot;alert(1)');
    expect(esc(`it's <b>&`)).toBe('it&#39;s &lt;b&gt;&amp;');
    expect(esc('')).toBe('');
    expect(esc(null)).toBe('');
    expect(esc(42)).toBe('42');
  });
});
