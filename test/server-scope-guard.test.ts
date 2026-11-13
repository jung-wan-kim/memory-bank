import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findInSources, moduleClosure } from './helpers/module-closure.js';

/**
 * What the code that serves several sessions from one process may read about the process it runs in.
 *
 * A shared server's own working directory and environment belong to whichever session happened to start it.
 * Anything that reads them answers one session with another session's project, database or account. So the
 * modules a server can load are followed from their entry files, and their text is checked.
 */

const REPO = path.resolve(__dirname, '..');
const src = (name: string) => path.join(REPO, 'src', name);

/** Entry files of code that runs inside a server process (session-local or shared). */
const SERVER_ROOTS = ['shared-server.ts', 'shared-server-core.ts', 'server-core.ts', 'inject-daemon.ts'].map(src);
/**
 * A session's own process: the relay, its entry point, the mode decision, and the one module that reads a
 * process working directory. Never loaded by a server module.
 */
const SESSION_ONLY = ['own-cwd.ts', 'relay.ts', 'mcp-server.ts', 'shared-mode.ts', 'stdio-server.ts'].map(src);

const CWD_READ = /process\.(cwd|chdir)\s*\(/;

describe('TC-SCOPE-003 — a server never reads its own working directory', () => {
  const closure = moduleClosure(SERVER_ROOTS);

  it('follows the modules a server loads (not an empty list)', () => {
    expect(closure.length).toBeGreaterThanOrEqual(30);
    for (const known of ['search.ts', 'fact-db.ts', 'llm.ts', 'inject-core.ts', 'paths.ts', 'session-context.ts']) {
      expect(closure, known).toContain(src(known));
    }
  });

  it('process.cwd( and process.chdir( appear in none of them', () => {
    const hits = findInSources(closure, CWD_READ).map((h) => `${path.relative(REPO, h.file)}:${h.line} ${h.text}`);
    expect(hits).toEqual([]);
  });

  it('the module that reads a process working directory is not one of them', () => {
    for (const file of SESSION_ONLY) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(closure, path.basename(file)).not.toContain(file);
    }
    // exactly one place in the whole source tree reads a process working directory for the MCP server
    expect(findInSources(SESSION_ONLY, CWD_READ).map((h) => path.basename(h.file))).toEqual(['own-cwd.ts']);
  });

  it('the check fails on a module that does read it (the guard is not vacuous)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'root.ts'), "import { leak } from './leaf.js';\nexport const x = leak;\n");
      fs.writeFileSync(path.join(dir, 'leaf.ts'), 'export const leak = () => process.cwd();\n');
      const fake = moduleClosure([path.join(dir, 'root.ts')]);
      expect(fake.map((f) => path.basename(f))).toEqual(['leaf.ts', 'root.ts']);
      expect(findInSources(fake, CWD_READ).map((h) => path.basename(h.file))).toEqual(['leaf.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * TC-ENV-001 — a shared server is started with an allow-list environment (src/shared-identity.ts), and
 * sessions share it only when that environment is equal. That holds only if the server code reads nothing
 * else from its process: a variable off the list would be read as "unset" by a shared server and as its real
 * value by a session-local one — and a variable on the session-only list would be another session's value.
 *
 * What only a session has (its LLM account, endpoint, model and client settings) is not in that environment
 * at all. It comes with the connection and is read from the environment of the one call it belongs to.
 */
describe('TC-ENV-001 — a server reads only the variables a shared server is given', () => {
  const closure = moduleClosure(SERVER_ROOTS);
  const rel = (file: string) => path.relative(REPO, file);

  const NAMED_READ = /(?:\bprocess\.env|\benv)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"]+)['"]\])/g;
  /** process.env (or an `env` argument) used whole, or indexed by a computed name. */
  const WHOLE_OR_COMPUTED = /\bprocess\.env(?![.[\w])|\bprocess\.env\[(?!['"])|\benv\[(?!['"])/;

  function namedReads(files: string[]): Array<{ file: string; name: string }> {
    const out: Array<{ file: string; name: string }> = [];
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(NAMED_READ)) out.push({ file, name: m[1] ?? m[2] });
    }
    return out;
  }

  /** A variable read from the environment of one call (llm.ts): the server's own plus what the calling session declared. */
  const CALL_ENV_READ = /\bllmEnv\.([A-Za-z_][A-Za-z0-9_]*)/g;

  it('every variable it reads from its own process by name is one a shared server is started with', async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const reads = namedReads(closure);
    expect(reads.length).toBeGreaterThanOrEqual(20);
    expect(reads.map((r) => r.name)).toEqual(expect.arrayContaining(['MEMORY_BANK_DB_PATH', 'MEMORY_BANK_CONFIG_DIR', 'MEMORY_BANK_API_TOKEN', 'TEST_ARCHIVE_DIR']));
    // 'child' is not enough: a shared server is never given those, so reading one from the process would
    // answer "unset" there and the session's value in a session-local server.
    const outside = reads
      .filter((r) => !['identity', 'passthrough'].includes(String(serverEnvKind(r.name))))
      .map((r) => `${rel(r.file)}: ${r.name}`);
    expect(outside).toEqual([]);
  });

  it("a session's LLM settings are read from the environment of its call, in one module, and are all of the kind a session declares", async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const reads: Array<{ file: string; name: string }> = [];
    for (const file of closure) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(CALL_ENV_READ)) reads.push({ file: rel(file), name: m[1] });
    }
    expect([...new Set(reads.map((r) => r.file))]).toEqual(['src/llm.ts']);
    expect([...new Set(reads.map((r) => r.name))].sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']);
    for (const r of reads) expect(serverEnvKind(r.name), r.name).toBe('child');
  });

  it('the whole environment is used only where it is passed on as an argument, and a computed name is a constant on the list', async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const guard = await import('../src/test-guard.js');
    const hits = findInSources(closure, WHOLE_OR_COMPUTED).map((h) => `${rel(h.file)}: ${h.text}`);
    expect(hits.sort()).toEqual([
      // passed on: the function reads named variables of whatever it is given (those names are checked above)
      'src/inject-host-skip.ts: env: Record<string, string | undefined> = process.env,',
      // the environment of one LLM call: this process's own, under what the calling session declared
      'src/llm.ts: const own: Record<string, string | undefined> = process.env;',
      'src/paths.ts: return ensureDir(indexDirOf(process.env));',
      'src/paths.ts: return ensureDir(superpowersDirOf(process.env));',
      'src/test-guard.ts: export function assertNotLiveDbUnderTest(dbPath: string, env: NodeJS.ProcessEnv = process.env): void {',
      'src/test-guard.ts: export function liveConfigRoots(env: NodeJS.ProcessEnv = process.env): string[] {',
      // computed name: the two constants below
      'src/test-guard.ts: const extra = env[TEST_GUARD_EXTRA_ROOT_ENV];',
      "src/test-guard.ts: if (env[TEST_GUARD_ENV] !== '1') return;",
      // the allow-list filters themselves: every name they copy went through serverEnvKind / the passthrough list
      'src/shared-identity.ts: const value = env[name];',
      'src/shared-identity.ts: const value = env[name];',
      'src/shared-identity.ts: let value = env[name];',
      // the shared server working out its own identity from the (already filtered) environment it was given
      'src/shared-server.ts: const serverEnv = serverEnvFor(process.env, null);',
    ].sort());
    expect(serverEnvKind(guard.TEST_GUARD_ENV)).toBe('identity');
    expect(serverEnvKind(guard.TEST_GUARD_EXTRA_ROOT_ENV)).toBe('identity');
  });

  it('the check fails on a variable off the list (the guard is not vacuous)', async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'root.ts'), [
        'export const a = process.env.MEMORY_BANK_DB_PATH;',
        'export const b = process.env.CLAUDE_CODE_SESSION_ID;',
        "export const c = process.env['SOME_SHELL_SECRET'];",
        'export const d = (env: NodeJS.ProcessEnv) => env.CLAUDE_PROJECT_DIR;',
        'export const e = { ...process.env };',
        'export const f = (k: string) => process.env[k];',
        'export const g = process.env.ANTHROPIC_BASE_URL;', // a session's own: not in a shared server's process
        'export const h = process.env.LANG;',
      ].join('\n'));
      const fake = moduleClosure([path.join(dir, 'root.ts')]);
      const outside = namedReads(fake).filter((r) => !['identity', 'passthrough'].includes(String(serverEnvKind(r.name)))).map((r) => r.name);
      expect(outside).toEqual(['CLAUDE_CODE_SESSION_ID', 'SOME_SHELL_SECRET', 'CLAUDE_PROJECT_DIR', 'ANTHROPIC_BASE_URL', 'LANG']);
      expect(findInSources(fake, WHOLE_OR_COMPUTED).map((h) => h.line)).toEqual([5, 6]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * TC-SCOPE-005 — the other things a process has that a session could mistake for its own: the processes it
 * starts (they inherit its environment), its default locale, and the directory a relative path is resolved
 * against. A shared server's are nobody's, so server code takes each from the session — or not at all.
 */
describe('TC-SCOPE-005 — a server does not lend a session its own process defaults', () => {
  const closure = moduleClosure(SERVER_ROOTS);
  const rel = (file: string) => path.relative(REPO, file);
  const importers = (files: string[], re: RegExp) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel);

  const CHILD_PROCESS = /['"](?:node:)?(?:child_process|worker_threads|cluster)['"]/;
  const AGENT_SDK = /['"]@anthropic-ai\/claude-agent-sdk['"]/;
  const ANTHROPIC_SDK = /['"]@anthropic-ai\/sdk['"]/;

  it('it starts a process in two places: the dependency repair, and the LLM call — which is given the session environment', () => {
    // npm install for a broken install: it needs PATH and a home, nothing of a session
    expect(importers(closure, CHILD_PROCESS)).toEqual(['src/deps-heal.ts']);
    expect(importers(closure, AGENT_SDK)).toEqual(['src/llm.ts']);
    expect(importers(closure, ANTHROPIC_SDK)).toEqual(['src/llm.ts']);
    const llm = fs.readFileSync(src('llm.ts'), 'utf8');
    expect(llm.match(/\bquery\(\{/g), 'one place calls the Agent SDK').toHaveLength(1);
    expect(llm).toContain('...(childEnv ? { env: llmEnv } : {}),');
    expect(llm.match(/new Anthropic\(/g), 'one place makes the fallback client').toHaveLength(1);
    expect(llm).toContain('new Anthropic(fallbackClientOptions(apiKey, llmEnv, ');
  });

  it('every tool that reaches the LLM passes the session on', () => {
    const core = fs.readFileSync(src('server-core.ts'), 'utf8');
    // the callers of callHaiku inside the server: followed by hand from llm.ts (asserted, so a new one fails here)
    const callers = closure.filter((f) => /\bcallHaiku\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(callers.sort()).toEqual(['src/avatar-responder.ts', 'src/llm.ts']);
    expect(fs.readFileSync(src('avatar-responder.ts'), 'utf8')).toContain('{ childEnv: opts.childEnv ?? null }');
    expect(core.match(/\baskAvatar\(/g)).toHaveLength(1);
    // through the one check that refuses a session whose settings did not all arrive — not straight off the context
    expect(core).toContain('const llmEnv = sessionLlmEnv(ctx);');
    expect(core).toContain('askAvatar(db, params.question, project, { childEnv: llmEnv })');
    // who reads a session's LLM settings at all (comment lines aside): the check, the copy made for a new server,
    // and the two modules the checked value is handed down through
    const codeOf = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    const readers = closure.filter((f) => /\.childEnv\b/.test(codeOf(f))).map(rel).sort();
    expect(readers).toEqual(['src/avatar-responder.ts', 'src/llm.ts', 'src/server-core.ts', 'src/session-context.ts']);
    expect(codeOf(src('server-core.ts')).match(/\.childEnv\b/g)).toHaveLength(1); // the copy in createMemoryBankServer
  });

  /** A call that formats or orders text in the default locale of the process it runs in. */
  const DEFAULT_LOCALE = [
    /\.toLocale(?:String|DateString|TimeString|LowerCase|UpperCase)\(\s*\)/,
    /\.localeCompare\(\s*[^(),]+\s*\)/,
    /\bnew Intl\.\w+\(\s*\)/,
    /\bIntl\.\w+\(\s*\)\.(?:format|compare|resolvedOptions)/,
  ];
  const defaultLocaleHits = (files: string[]) =>
    [...new Set(DEFAULT_LOCALE.flatMap((re) => findInSources(files, re)).map((h) => `${rel(h.file)}:${h.line} ${h.text}`))];

  it('nothing it prints is formatted or ordered in the locale of its own process', () => {
    expect(defaultLocaleHits(closure)).toEqual([]);
    // and the calls are there, with a locale handed to them (the check above is not passing on an empty set)
    const withLocale = findInSources(closure, /\.toLocaleString\((?:caps\.)?locale\)|\.localeCompare\([^()]+, (?:opts\.)?locale\)/);
    expect(withLocale.length).toBeGreaterThanOrEqual(13);
  });

  /** path.resolve with one argument: a relative value would be read against the process working directory. */
  function singleArgumentResolve(line: string): boolean {
    const at = line.indexOf('path.resolve(');
    if (at < 0) return false;
    let depth = 0;
    for (let i = at + 'path.resolve'.length; i < line.length; i++) {
      if (line[i] === '(') depth++;
      else if (line[i] === ')') { if (--depth === 0) return true; }
      else if (line[i] === ',' && depth === 1) return false;
    }
    return true;
  }
  const singleResolves = (files: string[]) => files.flatMap((file) =>
    fs.readFileSync(file, 'utf8').split('\n').filter(singleArgumentResolve).map((line) => `${rel(file)}: ${line.trim()}`));

  it('a path is resolved against the process directory nowhere: each one-argument path.resolve gets an absolute path', () => {
    expect(singleResolves(closure).sort()).toEqual([
      // the home directory, as the OS reports it
      'src/project-family.ts: const out = [path.resolve(os.homedir())];',
      'src/project-family.ts: try { out.push(path.resolve(os.userInfo().homedir)); } catch { /* no account entry */ }',
      // a session working directory: absolute, or the session was refused (session-context.ts)
      'src/project-family.ts: const start = path.resolve(cwd);',
      // symlink resolution of a path already made absolute by the caller below
      'src/read-guard.ts: let current = path.resolve(p);',
      // the read tool: absolute as given, else against the asking session's directory (never one argument)
      'src/read-guard.ts: const resolvedPath = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(baseDir as string, requestedPath);',
      // paths from the server's own settings: a relative one is made absolute before a server starts
      // (shared-identity.ts PATH_NAMES), against the working directory of the session that set it
      'src/test-guard.ts: const literal = path.resolve(dbPath);',
      'src/test-guard.ts: if (isInside(literal, path.resolve(root)) || isInside(resolved, resolvedRoot)) {',
      'src/test-guard.ts: let current = path.resolve(p);',
    ].sort());
  });

  it('the checks fail on code that does lend them (the guard is not vacuous)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'root.ts'), [
        "import { spawn } from 'node:child_process';",
        "import { query } from '@anthropic-ai/claude-agent-sdk';",
        'export const a = (d: Date) => d.toLocaleString();',
        'export const b = (x: string, y: string) => x.localeCompare(y);',
        'export const c = () => new Intl.DateTimeFormat().format(0);',
        "export const d = (p: string) => path.resolve(p);",
        "export const ok1 = (d: Date, locale?: string) => d.toLocaleString(locale);",
        "export const ok2 = (x: string, y: string, locale?: string) => x.localeCompare(y, locale);",
        "export const ok3 = (base: string, p: string) => path.resolve(base, p);",
        'export { spawn, query };',
      ].join('\n'));
      const fake = moduleClosure([path.join(dir, 'root.ts')]);
      expect(importers(fake, CHILD_PROCESS)).toHaveLength(1);
      expect(importers(fake, AGENT_SDK)).toHaveLength(1);
      expect(defaultLocaleHits(fake).map((h) => /:(\d+) /.exec(h)![1])).toEqual(['3', '4', '5']);
      expect(singleResolves(fake)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
