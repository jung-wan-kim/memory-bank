import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pretest` = scripts/check-dist-fresh.mjs: it must tell a dist/ that matches
 * the sources from one that does not, and must not write into the project it
 * checks (the step it replaces rebuilt the tracked dist/ on every `npm test`).
 * Runs against a two-file project in a temp dir, built with this repository's
 * own tsc and esbuild.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-dist-fresh.mjs');
const BUNDLE = 'esbuild src/mcp-server.ts --bundle --platform=node --format=esm --outfile=dist/mcp-server.js';

let project: string;

function bin(name: string): string {
  return path.join(REPO, 'node_modules', '.bin', name);
}

function build(): void {
  const tsc = spawnSync(bin('tsc'), ['-p', path.join(project, 'tsconfig.json')], { cwd: project, encoding: 'utf8' });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
  const esbuild = spawnSync(bin('esbuild'), [...BUNDLE.split(' ').slice(1), '--log-level=warning'], { cwd: project, encoding: 'utf8' });
  expect(esbuild.status, esbuild.stdout + esbuild.stderr).toBe(0);
}

function check(args: string[] = ['--root', project]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file of the project (path + content hash + mtime): what a read-only check leaves unchanged. */
function fingerprint(): string {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path.relative(project, full)} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${fs.statSync(full).mtimeMs}`);
    }
  };
  walk(project);
  return lines.sort().join('\n');
}

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dist-check-'));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { bundle: BUNDLE } }));
  fs.writeFileSync(path.join(project, 'tsconfig.json'), fs.readFileSync(path.join(REPO, 'tsconfig.json')));
  fs.writeFileSync(path.join(project, 'src', 'greeting.ts'), `export const greeting: string = 'hello';\n`);
  fs.writeFileSync(path.join(project, 'src', 'mcp-server.ts'), `import { greeting } from './greeting.js';\nconsole.log(greeting);\n`);
  build();
}, 120_000);

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('scripts/check-dist-fresh.mjs', () => {
  it('passes on a dist built from the current sources, and leaves the project untouched', () => {
    const before = fingerprint();
    const r = check();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // greeting.js, greeting.d.ts, mcp-server.js (the bundle), mcp-server.d.ts
    expect(r.stdout).toContain('dist is fresh (4 files');
    expect(fingerprint()).toBe(before);
  }, 120_000);

  it('fails with the files that differ after a source edit, and still writes nothing', () => {
    fs.writeFileSync(path.join(project, 'src', 'greeting.ts'), `export const greeting: string = 'changed';\n`);
    const before = fingerprint();
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist is stale');
    expect(r.stderr).toContain('npm run build');
    // The compiled module and the bundle that inlines it; the declaration is unchanged.
    expect(r.stderr).toMatch(/differs from a build of the current sources \(2\): greeting\.js, mcp-server\.js/);
    expect(fingerprint()).toBe(before);

    build();
    expect(check().status).toBe(0);
  }, 120_000);

  it('fails when a compiled file is missing from dist', () => {
    fs.rmSync(path.join(project, 'dist', 'greeting.d.ts'));
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing from dist \(1\): greeting\.d\.ts/);
    build();
    expect(check().status).toBe(0);
  }, 120_000);

  it('reports a file left over from a deleted source without failing', () => {
    fs.writeFileSync(path.join(project, 'dist', 'removed-module.js'), 'export {};\n');
    const r = check();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('removed-module.js');
    fs.rmSync(path.join(project, 'dist', 'removed-module.js'));
  }, 120_000);

  it('exits 2 when the sources do not compile — neither fresh nor stale is known', () => {
    const file = path.join(project, 'src', 'greeting.ts');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `export const greeting: string = 42;\n`);
    try {
      const r = check();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('tsc failed');
    } finally {
      fs.writeFileSync(file, good);
    }
  }, 120_000);

  it('rejects an unknown argument', () => {
    const r = check(['--fix']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown argument "--fix"');
  });

  it('is what `npm test` runs first', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts.pretest).toBe('node scripts/check-dist-fresh.mjs');
    expect(pkg.scripts.test).toBe('vitest run');
  });
});
