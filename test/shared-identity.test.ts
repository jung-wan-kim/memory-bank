import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  distFingerprint,
  serverEnvFor,
  serverEnvKind,
  sharedMode,
  sharedServerIdentity,
  sharedSocketPathIn,
  spawnEnvFor,
} from '../src/shared-identity.js';
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

describe('serverEnvKind — what a server process may be given', () => {
  it('names the three kinds', () => {
    expect(serverEnvKind('MEMORY_BANK_DB_PATH')).toBe('identity');
    expect(serverEnvKind('ANTHROPIC_BASE_URL')).toBe('identity');
    expect(serverEnvKind('LANG')).toBe('identity');
    expect(serverEnvKind('HOME')).toBe('identity');
    expect(serverEnvKind('PATH')).toBe('passthrough');
    expect(serverEnvKind('TMPDIR')).toBe('passthrough');
    for (const name of SESSION_ONLY) expect(serverEnvKind(name), name).toBeNull();
    expect(serverEnvKind('RANDOM_THING')).toBeNull();
  });
});

describe('serverEnvFor — the environment a shared server is started with', () => {
  it('carries the settings the server and its LLM child read, and nothing that belongs to one session', () => {
    const env = serverEnvFor(SESSION_ENV, '/Users/u/project-a')!;
    for (const name of SESSION_ONLY) expect(env, name).not.toHaveProperty(name);
    for (const name of ['HOME', 'LANG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'API_TIMEOUT_MS', 'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'MEMORY_BANK_CONFIG_DIR']) {
      expect(env[name], name).toBe(SESSION_ENV[name]);
    }
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
    ['LLM endpoint', { ANTHROPIC_BASE_URL: 'https://example.invalid' }],
    ['LLM credentials', { ANTHROPIC_AUTH_TOKEN: 'another-account' }],
    ['model alias', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'other-model' }],
    ['config dir', { MEMORY_BANK_CONFIG_DIR: '/Users/u/other-config' }],
    ['database path', { MEMORY_BANK_DB_PATH: '/Users/u/other.sqlite' }],
    ['archive dir', { TEST_ARCHIVE_DIR: '/Users/u/archive' }],
    ['embedding model', { MEMORY_BANK_EMBEDDING_MODEL: 'x' }],
    ['excluded projects', { CONVERSATION_SEARCH_EXCLUDE_PROJECTS: 'a,b' }],
    ['locale', { LANG: 'en_US.UTF-8' }],
    ['time zone', { TZ: 'UTC' }],
    ['home', { HOME: '/Users/other' }],
    ['Claude config dir', { CLAUDE_CONFIG_DIR: '/Users/u/.claude-alt' }],
  ])('a different %s is a different identity', (_what, change) => {
    expect(identityOf({ ...SESSION_ENV, ...change })).not.toBe(base);
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

  it('no readable version, Windows, source run, missing server file, relative path with no working directory', () => {
    expect(sharedMode({ entryUrl, env: baseEnv(), cwd: '/x', version: null, platform: 'darwin' })).toEqual({ kind: 'session-local', reason: 'no-version' });
    expect(sharedMode({ entryUrl, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'win32' })).toEqual({ kind: 'session-local', reason: 'windows' });
    const tsEntry = pathToFileURL(path.join(root, 'dist', 'mcp-server.ts')).href;
    expect(sharedMode({ entryUrl: tsEntry, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'darwin' })).toEqual({ kind: 'session-local', reason: 'not-built' });
    const lonely = fs.mkdtempSync('/tmp/mbsm-');
    try {
      fs.writeFileSync(path.join(lonely, 'mcp-server.js'), '// entry\n');
      expect(sharedMode({ entryUrl: pathToFileURL(path.join(lonely, 'mcp-server.js')).href, env: baseEnv(), cwd: '/x', version: '1.9.0', platform: 'darwin' }))
        .toEqual({ kind: 'session-local', reason: 'not-built' });
    } finally {
      fs.rmSync(lonely, { recursive: true, force: true });
    }
    expect(sharedMode({ entryUrl, env: { HOME: '/Users/u', MEMORY_BANK_CONFIG_DIR: 'relative-cfg' }, cwd: null, version: '1.9.0', platform: 'darwin' }))
      .toEqual({ kind: 'session-local', reason: 'relative-path' });
  });
});
