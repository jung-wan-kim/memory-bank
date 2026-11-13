import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHILD_ENV_MAX_TOTAL_BYTES,
  CHILD_ENV_MAX_VALUE_BYTES,
  childEnvFor,
  distFingerprint,
  removeOrphanStartLock,
  serverEnvFor,
  serverEnvKind,
  sharedServerIdentity,
  sharedSocketPathIn,
  spawnEnvFor,
  startLockHolder,
  validChildEnv,
} from '../src/shared-identity.js';
import { sharedMode } from '../src/shared-mode.js';
import { injectSocketPathIn } from '../src/version-guard.js';

// TC-ENV-002 · TC-ENV-003 — which sessions may share one server process, and what that process is told about
// the session that started it.

/** What a Claude Code session's MCP child sees (names measured on a live machine; values made up). */
const SESSION_ENV: Record<string, string> = {
  HOME: '/Users/u',
  PATH: '/opt/homebrew/bin:/usr/bin',
  USER: 'u',
  LOGNAME: 'u',
  SHELL: '/bin/zsh',
  TMPDIR: '/var/folders/xx/T/',
  LANG: 'ko_KR.UTF-8',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'some-model',
  API_TIMEOUT_MS: '600000',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
  MEMORY_BANK_CONFIG_DIR: '/Users/u/.config/superpowers',
  // belongs to this one session
  CLAUDE_CODE_SESSION_ID: 'sess-aaaa',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/msg-aaaa.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok-aaaa',
  CLAUDE_PROJECT_DIR: '/Users/u/project-a',
  CLAUDE_PLUGIN_ROOT: '/Users/u/.claude/plugins/cache/x/memory-bank/1.9.0',
  CLAUDE_PLUGIN_DATA: '/Users/u/.claude/plugins/data/memory-bank',
  PWD: '/Users/u/project-a',
  OLDPWD: '/Users/u',
  ITERM_SESSION_ID: 'w0t1p0:AAAA',
  TERM_SESSION_ID: 'w0t1p0:AAAA',
  // the shell's own secrets and noise
  FIGMA_API_KEY: 'figd_x',
  TELEGRAM_CHAT_ID: '1',
  SSH_AUTH_SOCK: '/tmp/ssh.sock',
  NODE_OPTIONS: '--inspect',
  // relay-only switches
  MEMORY_BANK_SHARED_SERVER: '1',
  MEMORY_BANK_RELAY_YOUNG_MS: '8000',
  MEMORY_BANK_WRAPPER_POLL_MS: '45000',
};

const SESSION_ONLY = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'PWD', 'OLDPWD', 'ITERM_SESSION_ID', 'TERM_SESSION_ID',
  'FIGMA_API_KEY', 'TELEGRAM_CHAT_ID', 'SSH_AUTH_SOCK', 'NODE_OPTIONS',
  'MEMORY_BANK_SHARED_SERVER', 'MEMORY_BANK_RELAY_YOUNG_MS', 'MEMORY_BANK_WRAPPER_POLL_MS',
];

const identityOf = (env: Record<string, string>, extra: { version?: string; fingerprint?: string } = {}) =>
  sharedServerIdentity({
    version: extra.version ?? '1.9.0',
    fingerprint: extra.fingerprint ?? 'f'.repeat(64),
    serverEnv: serverEnvFor(env, '/Users/u/project-a')!,
  });

/** What only the LLM child of a session's calls reads — the session's own, sent with its connection. */
const CHILD_OF_SESSION = [
  'LANG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'API_TIMEOUT_MS', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
];

describe('serverEnvKind — how a variable of a session reaches a shared server', () => {
  it('names the four kinds', () => {
    // the server's own settings, and what the Node runtime of that one process reads: its identity
    for (const name of ['MEMORY_BANK_DB_PATH', 'MEMORY_BANK_AGENT_SOURCES', 'TEST_DB_PATH', 'HOME', 'XDG_CONFIG_HOME', 'TZ', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) {
      expect(serverEnvKind(name), name).toBe('identity');
    }
    // the session's own, for the LLM child of its calls: never part of the server
    for (const name of [...CHILD_OF_SESSION, 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'CLAUDE_CONFIG_DIR', 'LC_ALL', 'MAX_THINKING_TOKENS', 'ENABLE_TOOL_SEARCH']) {
      expect(serverEnvKind(name), name).toBe('child');
    }
    expect(serverEnvKind('PATH')).toBe('passthrough');
    expect(serverEnvKind('TMPDIR')).toBe('passthrough');
    for (const name of SESSION_ONLY) expect(serverEnvKind(name), name).toBeNull();
    expect(serverEnvKind('RANDOM_THING')).toBeNull();
  });
});

describe('serverEnvFor — the environment a shared server is started with', () => {
  it('carries the settings the server itself reads — nothing of one session, and nothing only its LLM child reads', () => {
    const env = serverEnvFor(SESSION_ENV, '/Users/u/project-a')!;
    for (const name of SESSION_ONLY) expect(env, name).not.toHaveProperty(name);
    for (const name of CHILD_OF_SESSION) expect(env, name).not.toHaveProperty(name);
    expect(env).toEqual({ HOME: SESSION_ENV.HOME, MEMORY_BANK_CONFIG_DIR: SESSION_ENV.MEMORY_BANK_CONFIG_DIR });
    // operating variables are handed over separately (spawnEnvFor) and are not part of the identity
    expect(env).not.toHaveProperty('PATH');
    const spawned = spawnEnvFor(SESSION_ENV, env);
    expect(spawned.PATH).toBe(SESSION_ENV.PATH);
    expect(spawned.TMPDIR).toBe(SESSION_ENV.TMPDIR);
    for (const name of SESSION_ONLY) expect(spawned, name).not.toHaveProperty(name);
    expect(Object.keys(spawned).sort()).toEqual([...Object.keys(env), 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER'].sort());
  });

  it('a relative path setting becomes absolute against the session working directory', () => {
    const env = serverEnvFor({ HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: 'cfg', MEMORY_BANK_DB_PATH: './data/db.sqlite', TEST_ARCHIVE_DIR: '/abs/archive' }, '/Users/u/project-a')!;
    expect(env.MEMORY_BANK_CONFIG_DIR).toBe('/Users/u/project-a/cfg');
    expect(env.MEMORY_BANK_DB_PATH).toBe('/Users/u/project-a/data/db.sqlite');
    expect(env.TEST_ARCHIVE_DIR).toBe('/abs/archive');
  });

  it('a relative path setting with no known working directory has no answer', () => {
    expect(serverEnvFor({ HOME: '/Users/u', MEMORY_BANK_DB_PATH: 'db.sqlite' }, null)).toBeNull();
    expect(serverEnvFor({ HOME: '/Users/u', MEMORY_BANK_DB_PATH: '/abs/db.sqlite' }, null)).not.toBeNull();
  });

  it('is its own fixed point — a server recomputes it from the environment it was given', () => {
    const env = serverEnvFor(SESSION_ENV, '/Users/u/project-a')!;
    expect(serverEnvFor(spawnEnvFor(SESSION_ENV, env), null)).toEqual(env);
  });
});

describe("childEnvFor — what a session declares for the LLM child of its own calls", () => {
  it('carries the account, endpoint, model and client settings and the locale — nothing else', () => {
    const { env, dropped } = childEnvFor(SESSION_ENV, '/Users/u/project-a');
    expect(Object.keys(env).sort()).toEqual([...CHILD_OF_SESSION].sort());
    for (const name of CHILD_OF_SESSION) expect(env[name], name).toBe(SESSION_ENV[name]);
    expect(dropped).toEqual([]);
    expect(validChildEnv(env)).toBe(true);
  });

  it("a variable goes one way only: the server's environment and a session's declaration never share a name", () => {
    const server = spawnEnvFor(SESSION_ENV, serverEnvFor(SESSION_ENV, '/Users/u/project-a')!);
    const { env } = childEnvFor(SESSION_ENV, '/Users/u/project-a');
    expect(Object.keys(env).filter((name) => name in server)).toEqual([]);
    // and together they leave out exactly what belongs to this one session
    const neither = Object.keys(SESSION_ENV).filter((name) => !(name in server) && !(name in env)).sort();
    expect(neither).toEqual([...SESSION_ONLY].sort());
  });

  it('a relative path setting becomes absolute against the session working directory; without one it is dropped, and named', () => {
    const withCwd = childEnvFor({ CLAUDE_CONFIG_DIR: '.claude-alt', ANTHROPIC_BASE_URL: 'http://x' }, '/Users/u/project-a');
    expect(withCwd).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CONFIG_DIR: '/Users/u/project-a/.claude-alt' }, dropped: [] });
    const blind = childEnvFor({ CLAUDE_CONFIG_DIR: '.claude-alt', ANTHROPIC_BASE_URL: 'http://x' }, null);
    expect(blind).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://x' }, dropped: ['CLAUDE_CONFIG_DIR'] });
  });

  it('a value that cannot be carried is dropped and named — it never costs the rest', () => {
    const big = 'x'.repeat(CHILD_ENV_MAX_VALUE_BYTES + 1);
    const out = childEnvFor({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_CUSTOM_HEADERS: big, CLAUDE_X: 'a\u0000b' }, '/x');
    expect(out).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://x' }, dropped: ['ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_X'] });
    // the total is bounded too, counted as the JSON the hello carries (a value of quotes doubles in size there)
    const many: Record<string, string> = {};
    for (let i = 0; i < 12; i++) many[`CLAUDE_FILL_${String(i).padStart(2, '0')}`] = '"'.repeat(2_000);
    const bounded = childEnvFor(many, '/x');
    expect(bounded.dropped.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(bounded.env))).toBeLessThanOrEqual(CHILD_ENV_MAX_TOTAL_BYTES + 12 * 4);
    expect(validChildEnv(bounded.env)).toBe(true);
    expect(validChildEnv(many)).toBe(false);
  });

  it('validChildEnv refuses whatever a relay would not have sent', () => {
    for (const bad of [null, 'x', [], 7, { PATH: '/bin' }, { MEMORY_BANK_DB_PATH: '/x' }, { CLAUDE_CODE_SESSION_ID: 's' }, { ANTHROPIC_BASE_URL: 1 }, { ANTHROPIC_BASE_URL: 'a\u0000b' }]) {
      expect(validChildEnv(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(validChildEnv({})).toBe(true);
  });
});

describe('the start lock — a relay killed while it held it', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync('/tmp/mblock-'); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lockAt = (name: string, content: string, ageMs: number): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(file, then, then);
    return file;
  };

  it('no file: nothing to say, nothing removed', () => {
    expect(startLockHolder(path.join(dir, 'none.lock'))).toBeNull();
    expect(removeOrphanStartLock(path.join(dir, 'none.lock'))).toBe(false);
  });

  it('a lock whose holder is gone is an orphan once it is not brand new, and only then removed', () => {
    const fresh = lockAt('fresh.lock', '999999', 0);
    expect(startLockHolder(fresh)).toMatchObject({ alive: false, orphan: false });
    expect(removeOrphanStartLock(fresh)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    const old = lockAt('old.lock', '999999', 5_000);
    expect(startLockHolder(old)).toMatchObject({ alive: false, orphan: true });
    expect(removeOrphanStartLock(old)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('a lock a live process holds is never an orphan, however old; one with no pid in it is', () => {
    const held = lockAt('held.lock', String(process.pid), 600_000);
    expect(startLockHolder(held)).toMatchObject({ alive: true, orphan: false });
    expect(removeOrphanStartLock(held)).toBe(false);
    expect(fs.existsSync(held)).toBe(true);
    for (const junk of ['', 'not-a-pid', '-1', '0', '1']) {
      const file = lockAt('junk.lock', junk, 5_000);
      expect(startLockHolder(file), junk).toMatchObject({ alive: false, orphan: true });
    }
  });
});

describe('sharedServerIdentity — who may share a server', () => {
  const base = identityOf(SESSION_ENV);

  it('the same settings from another session give the same identity', () => {
    const other = {
      ...SESSION_ENV,
      CLAUDE_CODE_SESSION_ID: 'sess-bbbb', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/msg-bbbb.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'tok-bbbb',
      CLAUDE_PROJECT_DIR: '/Users/u/project-b', PWD: '/Users/u/project-b', ITERM_SESSION_ID: 'w1t0p0:BBBB',
      PATH: '/usr/local/bin:/usr/bin', TMPDIR: '/tmp/', FIGMA_API_KEY: 'other',
    };
    expect(identityOf(other)).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['config dir', { MEMORY_BANK_CONFIG_DIR: '/Users/u/other-config' }],
    ['database path', { MEMORY_BANK_DB_PATH: '/Users/u/other.sqlite' }],
    ['archive dir', { TEST_ARCHIVE_DIR: '/Users/u/archive' }],
    ['embedding model', { MEMORY_BANK_EMBEDDING_MODEL: 'x' }],
    ['conversation sources', { MEMORY_BANK_AGENT_SOURCES: 'claude-code,codex' }],
    ['excluded projects', { CONVERSATION_SEARCH_EXCLUDE_PROJECTS: 'a,b' }],
    ['time zone', { TZ: 'UTC' }],
    ['home', { HOME: '/Users/other' }],
    ['proxy', { HTTPS_PROXY: 'http://proxy.invalid:3128' }],
    ['CA bundle', { NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' }],
  ])("a different %s is a different identity (the server's own setting)", (_what, change) => {
    expect(identityOf({ ...SESSION_ENV, ...change })).not.toBe(base);
  });

  // What made 20 running sessions of one machine split into 7 servers before these moved to the connection.
  it.each([
    ['LLM endpoint', { ANTHROPIC_BASE_URL: 'https://example.invalid' }],
    ['LLM credentials', { ANTHROPIC_AUTH_TOKEN: 'another-account' }],
    ['model alias', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'other-model' }],
    ['API timeout', { API_TIMEOUT_MS: '120000' }],
    ['entry point', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }],
    ['client option', { ENABLE_TOOL_SEARCH: 'false' }],
    ['locale', { LANG: 'en_US.UTF-8' }],
    ['Claude config dir', { CLAUDE_CONFIG_DIR: '/Users/u/.claude-alt' }],
  ])("a different %s is the same identity (the session's own — it travels with the connection)", (_what, change) => {
    expect(identityOf({ ...SESSION_ENV, ...change })).toBe(base);
    // and it is what that session declares
    const changed = childEnvFor({ ...SESSION_ENV, ...change }, '/Users/u/project-a').env;
    for (const [name, value] of Object.entries(change)) expect(changed[name], name).toBe(value);
  });

  it('a different version or different code is a different identity', () => {
    expect(identityOf(SESSION_ENV, { version: '1.9.1' })).not.toBe(base);
    expect(identityOf(SESSION_ENV, { fingerprint: 'e'.repeat(64) })).not.toBe(base);
  });

  it('does not depend on the order the variables were set in', () => {
    const reversed = Object.fromEntries(Object.entries(SESSION_ENV).reverse());
    expect(identityOf(reversed)).toBe(base);
  });
});

describe('sharedSocketPathIn', () => {
  const id = 'ab12cd34' + '0'.repeat(56);

  it('names the socket by version and the first 8 characters of the identity', () => {
    expect(sharedSocketPathIn('/idx', '1.9.0', id)).toBe('/idx/mb-shared-1.9.0-ab12cd34.sock');
  });

  it('is never a name the inject daemon uses or sweeps', () => {
    const name = path.basename(sharedSocketPathIn('/idx', '1.9.0', id)!);
    expect(name).not.toMatch(/^inject-daemon(?:-[0-9A-Za-z.+-]{1,32})?\.sock$/);
    expect(sharedSocketPathIn('/idx', '1.9.0', id)).not.toBe(injectSocketPathIn('/idx', '1.9.0'));
  });

  it('null when the path does not fit a unix socket, or the version cannot be a file name', () => {
    expect(sharedSocketPathIn('/' + 'd'.repeat(90), '1.9.0', id, 103)).toBeNull();
    expect(sharedSocketPathIn('/idx', '1.9.0', id, 103)).not.toBeNull();
    expect(sharedSocketPathIn('/idx', '../evil', id)).toBeNull();
    expect(sharedSocketPathIn('/idx', '', id)).toBeNull();
  });
});

describe('distFingerprint', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync('/tmp/mbfp-');
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const a: number;\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is the same for the same code in another folder, and changes with any .js file', () => {
    const copy = fs.mkdtempSync('/tmp/mbfp-');
    try {
      for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
      const first = distFingerprint(dir);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(distFingerprint(copy)).toBe(first);
      fs.writeFileSync(path.join(copy, 'b.js'), 'export const b = 3;\n');
      expect(distFingerprint(copy)).not.toBe(first);
      fs.writeFileSync(path.join(copy, 'b.js'), 'export const b = 2;\n');
      expect(distFingerprint(copy)).toBe(first);
      fs.renameSync(path.join(copy, 'b.js'), path.join(copy, 'c.js'));
      expect(distFingerprint(copy)).not.toBe(first);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('declaration files do not count', () => {
    const before = distFingerprint(dir);
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'export declare const a: 1;\n');
    expect(distFingerprint(dir)).toBe(before);
  });

  it('throws for a folder that is not there (never a made-up fingerprint)', () => {
    expect(() => distFingerprint(path.join(dir, 'missing'))).toThrow();
  });
});

describe('sharedMode — shared server, or this session runs its own (TC-ENV-003)', () => {
  let root: string;   // a fake plugin root: <root>/dist/mcp-server.js + shared-server.js
  let config: string; // a short config dir (socket path fits)
  let entryUrl: string;
  const baseEnv = () => ({ HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: config });

  beforeAll(() => {
    root = fs.mkdtempSync('/tmp/mbsm-');
    config = fs.mkdtempSync('/tmp/mbsc-');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'mcp-server.js'), '// entry\n');
    fs.writeFileSync(path.join(root, 'dist', 'shared-server.js'), '// server\n');
    entryUrl = pathToFileURL(path.join(root, 'dist', 'mcp-server.js')).href;
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(config, { recursive: true, force: true });
  });

  it('shared: gives the socket, the identity, the server environment and the file to start', () => {
    const mode = sharedMode({ entryUrl, env: baseEnv(), cwd: '/Users/u/project-a', version: '1.9.0', platform: 'darwin' });
    expect(mode.kind).toBe('shared');
    if (mode.kind !== 'shared') return;
    expect(mode.serverEntry).toBe(path.join(root, 'dist', 'shared-server.js'));
    expect(mode.version).toBe('1.9.0');
    expect(mode.identity).toBe(sharedServerIdentity({ version: '1.9.0', fingerprint: distFingerprint(path.join(root, 'dist')), serverEnv: mode.serverEnv }));
    expect(mode.socketPath).toBe(path.join(config, 'conversation-index', `mb-shared-1.9.0-${mode.identity.slice(0, 8)}.sock`));
    expect(mode.indexDir).toBe(path.join(config, 'conversation-index'));
  });

  it('does not create the config dir just to decide', () => {
    const fresh = path.join(config, 'not-yet');
    sharedMode({ entryUrl, env: { HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: fresh }, cwd: '/x', version: '1.9.0', platform: 'darwin' });
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it.each([
    ['0'], ['false'], ['off'], ['OFF'], ['no'],
  ])('MEMORY_BANK_SHARED_SERVER=%s turns it off', (value) => {
    const mode = sharedMode({ entryUrl, env: { ...baseEnv(), MEMORY_BANK_SHARED_SERVER: value }, cwd: '/x', version: '1.9.0', platform: 'darwin' });
    expect(mode).toEqual({ kind: 'session-local', reason: 'switch-off' });
  });

  it('any other value of the switch leaves it on', () => {
    for (const value of ['1', 'true', '', 'yes']) {
      expect(sharedMode({ entryUrl, env: { ...baseEnv(), MEMORY_BANK_SHARED_SERVER: value }, cwd: '/x', version: '1.9.0', platform: 'darwin' }).kind, value).toBe('shared');
    }
  });

  it('the switch file in the index dir turns it off', () => {
    const idx = path.join(config, 'conversation-index');
    fs.mkdirSync(idx, { recursive: true });
    fs.writeFileSync(path.join(idx, 'shared-server.off'), '');
    try {
      expect(sharedMode({ entryUrl, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'darwin' })).toEqual({ kind: 'session-local', reason: 'switch-off-file' });
    } finally {
      fs.rmSync(path.join(idx, 'shared-server.off'));
    }
  });

  it('a config dir too deep for a unix socket', () => {
    const deep = path.join('/tmp', 'd'.repeat(80));
    expect(sharedMode({ entryUrl, env: { HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: deep }, cwd: '/x', version: '1.9.0', platform: 'darwin' }))
      .toEqual({ kind: 'session-local', reason: 'socket-path-too-long' });
  });

  it('session-local by design or by setting: Windows, a run from source, a relative path with no working directory', () => {
    expect(sharedMode({ entryUrl, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'win32' })).toEqual({ kind: 'session-local', reason: 'windows' });
    const tsEntry = pathToFileURL(path.join(root, 'dist', 'mcp-server.ts')).href;
    expect(sharedMode({ entryUrl: tsEntry, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'darwin' })).toEqual({ kind: 'session-local', reason: 'source-run' });
    expect(sharedMode({ entryUrl, env: { HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: 'relative-cfg' }, cwd: null, version: '1.9.0', platform: 'darwin' }))
      .toEqual({ kind: 'session-local', reason: 'relative-path' });
  });

  it('a broken install is not a reason to run some other way: no server file next to the entry, no readable version', () => {
    expect(sharedMode({ entryUrl, env: baseEnv(), cwd: '/x', version: null, platform: 'darwin' })).toEqual({ kind: 'broken', reason: 'no-version' });
    const lonely = fs.mkdtempSync('/tmp/mbsm-');
    try {
      fs.writeFileSync(path.join(lonely, 'mcp-server.js'), '// entry\n');
      expect(sharedMode({ entryUrl: pathToFileURL(path.join(lonely, 'mcp-server.js')).href, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'darwin' }))
        .toEqual({ kind: 'broken', reason: 'server-file-missing' });
      // the user's switch still wins: turning the shared server off is a choice, and it is honoured first —
      // by the variable, and by the file in the index dir
      const lonelyEntry = pathToFileURL(path.join(lonely, 'mcp-server.js')).href;
      expect(sharedMode({ entryUrl: lonelyEntry, env: { ...baseEnv(), MEMORY_BANK_SHARED_SERVER: '0' }, cwd: '/x', version: '1.9.0', platform: 'darwin' }))
        .toEqual({ kind: 'session-local', reason: 'switch-off' });
      const cfg = path.join(lonely, 'cfg');
      fs.mkdirSync(path.join(cfg, 'conversation-index'), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'conversation-index', 'shared-server.off'), '');
      const offByFile = { HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: cfg };
      expect(sharedMode({ entryUrl: lonelyEntry, env: offByFile, cwd: '/x', version: '1.9.0', platform: 'darwin' }))
        .toEqual({ kind: 'session-local', reason: 'switch-off-file' });
      expect(sharedMode({ entryUrl, env: offByFile, cwd: '/x', version: null, platform: 'darwin' }))
        .toEqual({ kind: 'session-local', reason: 'switch-off-file' });
    } finally {
      fs.rmSync(lonely, { recursive: true, force: true });
    }
  });
});
