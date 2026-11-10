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
 *
 * The bundle (dist/mcp-server.js) inlines third-party packages, and
 * package-lock.json is not tracked: a fresh `npm install` resolves other
 * versions and a rebuild differs in bytes. So the bundle is judged by the
 * stamp `npm run bundle` writes into it (scripts/stamp-bundle.mjs), not by
 * comparing bytes — REL-3: the check must pass on a fresh clone and still fail
 * when a source changed and dist/ was not rebuilt.
 *
 * Runs against a small project in a temp dir, built with this repository's own
 * tsc and esbuild. The project has its own node_modules/fake-dep, the stand-in
 * for an inlined third-party package.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'scripts', 'check-dist-fresh.mjs');
const STAMP = path.join(REPO, 'scripts', 'stamp-bundle.mjs');
const ESBUILD = 'esbuild src/mcp-server.ts --bundle --platform=node --format=esm --outfile=dist/mcp-server.js';
const BUNDLE = `${ESBUILD} && node scripts/stamp-bundle.mjs`;
const STAMP_LINE = /\n\/\/ memory-bank-bundle-stamp v1 inputs=[0-9a-f]{64} body=[0-9a-f]{64}\n$/;

let project: string;

function bin(name: string): string {
  return path.join(REPO, 'node_modules', '.bin', name);
}

function at(...parts: string[]): string {
  return path.join(project, ...parts);
}

function runTsc(): void {
  const tsc = spawnSync(bin('tsc'), ['-p', at('tsconfig.json')], { cwd: project, encoding: 'utf8' });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
}

function runEsbuild(): void {
  const esbuild = spawnSync(bin('esbuild'), [...ESBUILD.split(' ').slice(1), '--log-level=warning'], { cwd: project, encoding: 'utf8' });
  expect(esbuild.status, esbuild.stdout + esbuild.stderr).toBe(0);
}

function stamp(args: string[] = ['--root', project], script = STAMP) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** What `npm run build` does: tsc, the esbuild bundle, the stamp. */
function build(): void {
  runTsc();
  runEsbuild();
  const r = stamp();
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

function check(args: string[] = ['--root', project]) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd: REPO, encoding: 'utf8' });
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

function writePackageJson(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(at('package.json'), JSON.stringify({
    name: 'fixture', type: 'module', scripts: { bundle: BUNDLE }, dependencies: { 'fake-dep': '^1.0.0' }, ...overrides,
  }));
}

/** Installs "another version" of the inlined third-party package, as a later `npm install` of the same range would. */
function installFakeDep(version: string): void {
  const dir = at('node_modules', 'fake-dep');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-dep', version, type: 'module', main: 'index.js', types: 'index.d.ts' }));
  fs.writeFileSync(path.join(dir, 'index.d.ts'), `export declare const depVersion: string;\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), `export const depVersion = ${JSON.stringify(version)};\n`);
}

const GREETING = `export const greeting: string = 'hello';\n`;

beforeAll(() => {
  // realpath: os.tmpdir() is a symlink on macOS, and the scripts compare real paths.
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dist-check-')));
  fs.mkdirSync(at('src'));
  writePackageJson();
  fs.writeFileSync(at('tsconfig.json'), fs.readFileSync(path.join(REPO, 'tsconfig.json')));
  fs.writeFileSync(at('src', 'greeting.ts'), GREETING);
  // Compiled by tsc, but not part of the bundle.
  fs.writeFileSync(at('src', 'cli-only.ts'), `export const cliOnly: number = 1;\n`);
  fs.writeFileSync(at('src', 'mcp-server.ts'),
    `import { depVersion } from 'fake-dep';\nimport { greeting } from './greeting.js';\nconsole.log(greeting, depVersion);\n`);
  installFakeDep('1.0.0');
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
    // Compared byte for byte: greeting.js/.d.ts, cli-only.js/.d.ts, mcp-server.d.ts. The bundle: by its stamp.
    expect(r.stdout).toContain('dist is fresh (5 compiled files match');
    expect(r.stdout).toContain("the bundle's stamp matches its 2 first-party sources");
    expect(fingerprint()).toBe(before);
  }, 120_000);

  it('fails with the files that differ after a source edit, and still writes nothing', () => {
    fs.writeFileSync(at('src', 'greeting.ts'), `export const greeting: string = 'changed';\n`);
    const before = fingerprint();
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist is stale');
    expect(r.stderr).toContain('npm run build');
    // The compiled module, and the bundle that inlines it; the declaration is unchanged.
    expect(r.stderr).toMatch(/differs from a build of the current sources \(1\): greeting\.js\n/);
    expect(r.stderr).toContain('the bundle dist/mcp-server.js was built from other sources');
    expect(fingerprint()).toBe(before);

    build();
    expect(check().status).toBe(0);
    fs.writeFileSync(at('src', 'greeting.ts'), GREETING);
    build();
  }, 120_000);

  it('REL-3: stays fresh when the installed third-party packages differ from the ones the bundle was built with', () => {
    const committed = fs.readFileSync(at('dist', 'mcp-server.js'));
    expect(committed.toString('utf8')).toContain('"1.0.0"');
    try {
      // A fresh clone: same package.json, no lock file — `npm install` brings a newer fake-dep.
      installFakeDep('1.0.7');
      // A rebuild here really is other bytes (what the byte comparison used to call stale)…
      const rebuilt = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dist-rebuilt-'));
      try {
        const esbuild = spawnSync(bin('esbuild'),
          ['src/mcp-server.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${path.join(rebuilt, 'mcp-server.js')}`, '--log-level=warning'],
          { cwd: project, encoding: 'utf8' });
        expect(esbuild.status, esbuild.stdout + esbuild.stderr).toBe(0);
        const local = fs.readFileSync(path.join(rebuilt, 'mcp-server.js'), 'utf8');
        expect(local).toContain('"1.0.7"');
        expect(committed.toString('utf8').startsWith(local)).toBe(false);
      } finally {
        fs.rmSync(rebuilt, { recursive: true, force: true });
      }
      // …and the tracked dist is still a build of the current sources.
      const r = check();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.readFileSync(at('dist', 'mcp-server.js')).equals(committed)).toBe(true);

      // With those other packages installed, a source edit is still caught.
      fs.writeFileSync(at('src', 'greeting.ts'), `export const greeting: string = 'edited on the fresh clone';\n`);
      const stale = check();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('the bundle dist/mcp-server.js was built from other sources');
    } finally {
      fs.writeFileSync(at('src', 'greeting.ts'), GREETING);
      installFakeDep('1.0.0');
    }
    expect(check().status).toBe(0);
  }, 120_000);

  it('fails when tsc ran after a source edit but the bundle was not rebuilt', () => {
    const bundle = fs.readFileSync(at('dist', 'mcp-server.js'));
    fs.writeFileSync(at('src', 'greeting.ts'), `export const greeting: string = 'tsc only';\n`);
    try {
      runTsc();
      // tsc alone leaves its unbundled module where the bundle belongs: no stamp.
      const unbundled = check();
      expect(unbundled.status).toBe(1);
      expect(unbundled.stderr).not.toContain('differs from a build of the current sources');
      expect(unbundled.stderr).toContain('the bundle dist/mcp-server.js has no build stamp');

      // The old bundle put back: every compiled file is current, only the bundle is behind.
      fs.writeFileSync(at('dist', 'mcp-server.js'), bundle);
      const behind = check();
      expect(behind.status).toBe(1);
      expect(behind.stderr).not.toContain('differs from a build of the current sources');
      expect(behind.stderr).toContain('the bundle dist/mcp-server.js was built from other sources');
    } finally {
      fs.writeFileSync(at('src', 'greeting.ts'), GREETING);
      build();
    }
    expect(check().status).toBe(0);
  }, 120_000);

  it('does not involve the bundle when a source outside it changes', () => {
    fs.writeFileSync(at('src', 'cli-only.ts'), `export const cliOnly: number = 2;\n`);
    try {
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/differs from a build of the current sources \(1\): cli-only\.js\n/);
      expect(r.stderr).not.toContain('the bundle');
    } finally {
      fs.writeFileSync(at('src', 'cli-only.ts'), `export const cliOnly: number = 1;\n`);
    }
  }, 120_000);

  it('fails when the bundle bytes are not the stamped ones', () => {
    const file = at('dist', 'mcp-server.js');
    const good = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.concat([Buffer.from('// edited by hand\n'), good]));
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the bundle dist/mcp-server.js was changed after it was built');
    } finally {
      fs.writeFileSync(file, good);
    }
  }, 120_000);

  it('fails when a dependency range changed and the bundle was not rebuilt', () => {
    writePackageJson({ dependencies: { 'fake-dep': '^2.0.0' } });
    try {
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the bundle dist/mcp-server.js was built from other sources, bundle arguments or dependency ranges');
    } finally {
      writePackageJson();
    }
  }, 120_000);

  it('fails when the bundle is missing', () => {
    const file = at('dist', 'mcp-server.js');
    const good = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the bundle dist/mcp-server.js missing');
    } finally {
      fs.writeFileSync(file, good);
    }
  }, 120_000);

  it('fails when a compiled file is missing from dist', () => {
    fs.rmSync(at('dist', 'greeting.d.ts'));
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing from dist \(1\): greeting\.d\.ts/);
    build();
    expect(check().status).toBe(0);
  }, 120_000);

  it('refuses a fresh bundle that was built where node_modules is a link to another folder (it carries that machine\'s paths)', () => {
    // A git worktree whose node_modules points at another checkout: esbuild names each inlined
    // module by its real path, which leaves the project — `// ../<elsewhere>/node_modules/fake-dep/…`.
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-dist-elsewhere-')));
    const portable = fs.readFileSync(at('dist', 'mcp-server.js'));
    expect(portable.toString('utf8')).toContain('// node_modules/fake-dep/index.js');
    try {
      fs.renameSync(at('node_modules'), path.join(elsewhere, 'node_modules'));
      fs.symlinkSync(path.join(elsewhere, 'node_modules'), at('node_modules'));

      // The bundle built in the real checkout is still fine here: nothing is judged by this machine's rebuild.
      const committed = check();
      expect(committed.stderr).toBe('');
      expect(committed.status).toBe(0);

      // Built here, it works and is stamped — with a warning…
      runTsc();
      runEsbuild();
      const stamped = stamp();
      expect(stamped.status, stamped.stderr).toBe(0);
      expect(stamped.stderr).toContain('warning — dist/mcp-server.js names 1 modules by a path outside the project');
      expect(fs.readFileSync(at('dist', 'mcp-server.js'), 'utf8')).toMatch(/^\/\/ \.\.\/.*\/node_modules\/fake-dep\/index\.js$/m);

      // …and the check refuses it, saying it is not staleness (a rebuild here changes nothing).
      const r = check();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('dist matches the current sources, but it must not be committed as it is');
      expect(r.stderr).toContain('names 1 modules by a path outside the project');
      expect(r.stderr).toContain('a checkout with its own node_modules');
      expect(r.stderr).not.toContain('dist is stale');
    } finally {
      fs.rmSync(at('node_modules'), { recursive: true, force: true });
      fs.renameSync(path.join(elsewhere, 'node_modules'), at('node_modules'));
      fs.rmSync(elsewhere, { recursive: true, force: true });
      fs.writeFileSync(at('dist', 'mcp-server.js'), portable);
    }
    expect(check().status).toBe(0);
  }, 120_000);

  it('reports a file left over from a deleted source without failing', () => {
    fs.writeFileSync(at('dist', 'removed-module.js'), 'export {};\n');
    const r = check();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('removed-module.js');
    fs.rmSync(at('dist', 'removed-module.js'));
  }, 120_000);

  it('exits 2 when the sources do not compile — neither fresh nor stale is known', () => {
    const file = at('src', 'greeting.ts');
    fs.writeFileSync(file, `export const greeting: string = 42;\n`);
    try {
      const r = check();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('tsc failed');
    } finally {
      fs.writeFileSync(file, GREETING);
    }
  }, 120_000);

  it('exits 2 when package.json "bundle" is not the esbuild command followed by the stamp step', () => {
    writePackageJson({ scripts: { bundle: ESBUILD } });
    try {
      const r = check();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('package.json "bundle" is not');
    } finally {
      writePackageJson();
    }
  }, 120_000);

  it('rejects an unknown argument', () => {
    const r = check(['--fix']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown argument "--fix"');
  });

  it('is what `npm test` runs first, and the build stamps the bundle it makes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts.pretest).toBe('node scripts/check-dist-fresh.mjs');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.build).toBe('tsc && npm run bundle');
    expect(pkg.scripts.bundle).toMatch(/^esbuild src\/mcp-server\.ts .*--outfile=dist\/mcp-server\.js.* && node scripts\/stamp-bundle\.mjs$/);
  });
});

describe('scripts/stamp-bundle.mjs', () => {
  it('writes the stamp as the last line of the bundle, and stamping again changes nothing', () => {
    const file = at('dist', 'mcp-server.js');
    const once = fs.readFileSync(file, 'utf8');
    expect(once).toMatch(STAMP_LINE);
    expect(once.match(/memory-bank-bundle-stamp/g)).toHaveLength(1);
    const r = stamp();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('dist/mcp-server.js stamped (2 first-party source files)');
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  }, 120_000);

  it('does not stamp a bundle that is not what the current sources build to', () => {
    const file = at('dist', 'mcp-server.js');
    const good = fs.readFileSync(file);
    fs.writeFileSync(at('src', 'greeting.ts'), `export const greeting: string = 'changed after bundling';\n`);
    try {
      const r = stamp();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is not what the current sources bundle to');
      expect(fs.readFileSync(file).equals(good)).toBe(true);
    } finally {
      fs.writeFileSync(at('src', 'greeting.ts'), GREETING);
    }
  }, 120_000);

  it('stamps when started through a symlink to the script (not a silent no-op)', () => {
    const file = at('dist', 'mcp-server.js');
    const stamped = fs.readFileSync(file);
    const links = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-stamp-link-'));
    try {
      const link = path.join(links, 'stamp-link.mjs');
      fs.symlinkSync(STAMP, link);
      runEsbuild(); // a bundle fresh from esbuild: no stamp yet
      expect(fs.readFileSync(file, 'utf8')).not.toContain('memory-bank-bundle-stamp');
      const r = stamp(['--root', project], link);
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readFileSync(file).equals(stamped)).toBe(true);
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails without a bundle to stamp, and on an unknown argument', () => {
    const file = at('dist', 'mcp-server.js');
    const good = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const missing = stamp();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('dist/mcp-server.js does not exist');
    } finally {
      fs.writeFileSync(file, good);
    }
    const unknown = stamp(['--force']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown argument "--force"');
  }, 120_000);
});
