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
 * else: a variable off the list would be read as "unset" by a shared server and as its real value by a
 * session-local one — and a variable on the session-only list would be another session's value.
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

  it('every variable it reads by name is one a shared server gets', async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const reads = namedReads(closure);
    expect(reads.length).toBeGreaterThanOrEqual(20);
    expect(reads.map((r) => r.name)).toEqual(expect.arrayContaining(['MEMORY_BANK_DB_PATH', 'MEMORY_BANK_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'TEST_ARCHIVE_DIR']));
    const outside = reads.filter((r) => serverEnvKind(r.name) === null).map((r) => `${rel(r.file)}: ${r.name}`);
    expect(outside).toEqual([]);
  });

  it('the whole environment is used only where it is passed on as an argument, and a computed name is a constant on the list', async () => {
    const { serverEnvKind } = await import('../src/shared-identity.js');
    const guard = await import('../src/test-guard.js');
    const hits = findInSources(closure, WHOLE_OR_COMPUTED).map((h) => `${rel(h.file)}: ${h.text}`);
    expect(hits.sort()).toEqual([
      // passed on: the function reads named variables of whatever it is given (those names are checked above)
      'src/inject-host-skip.ts: env: Record<string, string | undefined> = process.env,',
      'src/paths.ts: return ensureDir(indexDirOf(process.env));',
      'src/paths.ts: return ensureDir(superpowersDirOf(process.env));',
      'src/test-guard.ts: export function assertNotLiveDbUnderTest(dbPath: string, env: NodeJS.ProcessEnv = process.env): void {',
      'src/test-guard.ts: export function liveConfigRoots(env: NodeJS.ProcessEnv = process.env): string[] {',
      // computed name: the two constants below
      'src/test-guard.ts: const extra = env[TEST_GUARD_EXTRA_ROOT_ENV];',
      "src/test-guard.ts: if (env[TEST_GUARD_ENV] !== '1') return;",
      // the allow-list filter itself: every name it copies went through serverEnvKind / the passthrough list
      'src/shared-identity.ts: const value = env[name];',
      'src/shared-identity.ts: const value = env[name];',
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
      ].join('\n'));
      const fake = moduleClosure([path.join(dir, 'root.ts')]);
      const outside = namedReads(fake).filter((r) => serverEnvKind(r.name) === null).map((r) => r.name);
      expect(outside).toEqual(['CLAUDE_CODE_SESSION_ID', 'SOME_SHELL_SECRET', 'CLAUDE_PROJECT_DIR']);
      expect(findInSources(fake, WHOLE_OR_COMPUTED).map((h) => h.line)).toEqual([5, 6]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
