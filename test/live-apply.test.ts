import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { liveApply } from '../scripts/live-apply.js';

let marketplace: string; // parent of the versions base (backups land here)
let base: string; // .../memory-bank (contains version dirs)

function mkVersion(name: string, version: string, code: string, deps: Record<string, string>) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'x.js'), code);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version, dependencies: deps }));
  return dir;
}

beforeEach(() => {
  marketplace = fs.mkdtempSync(path.join(os.tmpdir(), 'live-apply-'));
  base = path.join(marketplace, 'memory-bank');
  fs.mkdirSync(base);
});

afterEach(() => {
  fs.rmSync(marketplace, { recursive: true, force: true });
});

describe('liveApply', () => {
  it('moves native/ (the inject client sources + SRC_HASH pin) together with hooks and scripts, so code and pin never split', () => {
    const old = mkVersion('1.7.9', '1.7.9', 'OLD', { a: '1' });
    fs.mkdirSync(path.join(old, 'native', 'inject-client', 'src'), { recursive: true });
    fs.writeFileSync(path.join(old, 'native', 'inject-client', 'SRC_HASH'), 'oldhash0000000000\n');
    fs.writeFileSync(path.join(old, 'native', 'inject-client', 'src', 'main.rs'), '// old\n');
    const self = mkVersion('1.8.0', '1.8.0', 'NEW', { a: '1' });
    fs.mkdirSync(path.join(self, 'native', 'inject-client', 'src'), { recursive: true });
    fs.writeFileSync(path.join(self, 'native', 'inject-client', 'SRC_HASH'), 'newhash1111111111\n');
    fs.writeFileSync(path.join(self, 'native', 'inject-client', 'src', 'main.rs'), '// new\n');

    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([{ dir: '1.7.9', from: '1.7.9', to: '1.8.0' }]);
    expect(fs.readFileSync(path.join(old, 'native', 'inject-client', 'SRC_HASH'), 'utf8').trim()).toBe('newhash1111111111');
    expect(fs.readFileSync(path.join(old, 'native', 'inject-client', 'src', 'main.rs'), 'utf8')).toBe('// new\n');
  });

  it('propagates code into older-content dirs, with backup, never touching node_modules', () => {
    mkVersion('1.0.0', '1.0.0', 'OLD', { a: '1' });
    fs.writeFileSync(path.join(base, '1.0.0', 'node_modules', 'keep.txt'), 'native');
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });

    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([{ dir: '1.0.0', from: '1.0.0', to: '2.0.0' }]);
    expect(fs.readFileSync(path.join(base, '1.0.0', 'dist', 'x.js'), 'utf8')).toBe('NEW');
    expect(JSON.parse(fs.readFileSync(path.join(base, '1.0.0', 'package.json'), 'utf8')).version).toBe('2.0.0');
    // node_modules untouched
    expect(fs.readFileSync(path.join(base, '1.0.0', 'node_modules', 'keep.txt'), 'utf8')).toBe('native');
    // backup of the original code exists outside the version listing
    const backup = path.join(marketplace, '.live-apply-backup', '1.0.0-1.0.0');
    expect(fs.readFileSync(path.join(backup, 'dist', 'x.js'), 'utf8')).toBe('OLD');
  });

  it('is idempotent: a second run is a no-op', () => {
    mkVersion('1.0.0', '1.0.0', 'OLD', { a: '1' });
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    liveApply(self, () => {});
    const r2 = liveApply(self, () => {});
    expect(r2.applied).toEqual([]);
    expect(r2.skipped.map((s: { reason: string }) => s.reason)).toContain('same-or-newer-content');
  });

  it('skips dirs whose dependency set differs (native binaries must stay known-good)', () => {
    mkVersion('0.9.0', '0.9.0', 'OLD', { a: '2' });
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([{ dir: '0.9.0', reason: 'deps-differ' }]);
    expect(fs.readFileSync(path.join(base, '0.9.0', 'dist', 'x.js'), 'utf8')).toBe('OLD');
  });

  it('never downgrades a same-or-newer dir', () => {
    mkVersion('3.0.0', '3.0.0', 'FUTURE', { a: '1' });
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([]);
    expect(fs.readFileSync(path.join(base, '3.0.0', 'dist', 'x.js'), 'utf8')).toBe('FUTURE');
  });

  it('refuses to run outside a versioned cache layout (dev checkout safety)', () => {
    const dev = path.join(marketplace, 'dev-checkout');
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const r = liveApply(dev, () => {});
    expect(r.applied).toEqual([]);
    expect(r.reason).toBe('not-a-versioned-cache-dir');
  });

  it('skips a symlinked version dir instead of writing through it (MEDIUM 7)', () => {
    const outside = path.join(marketplace, 'outside');
    fs.mkdirSync(path.join(outside, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'dist', 'x.js'), 'OUTSIDE');
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: { a: '1' } }));
    fs.symlinkSync(outside, path.join(base, '1.0.0'));
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([]);
    expect(r.skipped.some((s: { reason: string }) => s.reason === 'symlink')).toBe(true);
    // the symlink target outside the cache is untouched
    expect(fs.readFileSync(path.join(outside, 'dist', 'x.js'), 'utf8')).toBe('OUTSIDE');
  });

  it('repairs a dir whose package.json was lost to a crashed prior release (HIGH 3)', () => {
    const broken = mkVersion('1.0.0', '1.0.0', 'OLD', { a: '1' });
    fs.rmSync(path.join(broken, 'package.json')); // simulate crash after pkg moved away
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([{ dir: '1.0.0', from: null, to: '2.0.0' }]);
    expect(fs.readFileSync(path.join(base, '1.0.0', 'dist', 'x.js'), 'utf8')).toBe('NEW');
    expect(JSON.parse(fs.readFileSync(path.join(base, '1.0.0', 'package.json'), 'utf8')).version).toBe('2.0.0');
  });

  it('defers when the base lock is already held by a live process', () => {
    mkVersion('1.0.0', '1.0.0', 'OLD', { a: '1' });
    const self = mkVersion('2.0.0', '2.0.0', 'NEW', { a: '1' });
    // Simulate a live holder: lock dir with our own (alive) pid.
    const lockDir = path.join(base, '.live-apply.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    const r = liveApply(self, () => {});
    expect(r.reason).toBe('lock-held');
    expect(r.applied).toEqual([]);
    // OLD dir untouched — no downgrade/clobber while lock held
    expect(fs.readFileSync(path.join(base, '1.0.0', 'dist', 'x.js'), 'utf8')).toBe('OLD');
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  /** Writes files (path relative to the version dir → content). */
  function put(dir: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  }
  const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

  it('moves ui/ and prompts/ too: the dashboard of an older-named dir must not keep serving old code (COMPAT-07)', () => {
    const old = mkVersion('1.7.7', '1.7.7', 'OLD', { a: '1' });
    put(old, { 'ui/server.cjs': 'OLD UI', 'ui/removed-in-new.cjs': 'gone', 'prompts/search-agent.md': 'old prompt' });
    const self = mkVersion('1.8.0', '1.8.0', 'NEW', { a: '1' });
    put(self, { 'ui/server.cjs': 'NEW UI', 'ui/server-guards.cjs': 'GUARDS', 'prompts/search-agent.md': 'new prompt' });

    const r = liveApply(self, () => {});
    expect(r.applied).toEqual([{ dir: '1.7.7', from: '1.7.7', to: '1.8.0' }]);
    expect(read(old, 'ui/server.cjs')).toBe('NEW UI');
    // The new server requires its guards file: the two must arrive together.
    expect(read(old, 'ui/server-guards.cjs')).toBe('GUARDS');
    expect(fs.existsSync(path.join(old, 'ui', 'removed-in-new.cjs'))).toBe(false);
    expect(read(old, 'prompts/search-agent.md')).toBe('new prompt');
    // The code it replaced is in the backup.
    expect(read(path.join(marketplace, '.live-apply-backup', '1.7.7-1.7.7'), 'ui/server.cjs')).toBe('OLD UI');
  });

  it('leaves a locally generated ui/relations/data.json where it is: not taken from the newer dir, not dropped, not copied to the backup', () => {
    // data.json is made on the machine from the user's own facts (gitignored) — it is not part of a release.
    const withData = mkVersion('1.7.7', '1.7.7', 'OLD', { a: '1' });
    put(withData, { 'ui/relations/app.js': 'old app', 'ui/relations/data.json': 'DATA OF 1.7.7' });
    const without = mkVersion('1.7.8', '1.7.8', 'OLD', { a: '1' });
    put(without, { 'ui/relations/app.js': 'old app' });
    const noUi = mkVersion('1.7.9', '1.7.9', 'OLD', { a: '1' });
    const self = mkVersion('1.8.0', '1.8.0', 'NEW', { a: '1' });
    put(self, { 'ui/relations/app.js': 'new app', 'ui/relations/data.json': 'DATA OF 1.8.0' });

    const r = liveApply(self, () => {});
    expect(r.applied.map((a: { dir: string }) => a.dir).sort()).toEqual(['1.7.7', '1.7.8', '1.7.9']);
    for (const dir of [withData, without, noUi]) expect(read(dir, 'ui/relations/app.js')).toBe('new app');
    expect(read(withData, 'ui/relations/data.json')).toBe('DATA OF 1.7.7');
    expect(fs.existsSync(path.join(without, 'ui', 'relations', 'data.json'))).toBe(false);
    expect(fs.existsSync(path.join(noUi, 'ui', 'relations', 'data.json'))).toBe(false);
    expect(read(self, 'ui/relations/data.json')).toBe('DATA OF 1.8.0');
    const backup = path.join(marketplace, '.live-apply-backup', '1.7.7-1.7.7');
    expect(read(backup, 'ui/relations/app.js')).toBe('old app');
    expect(fs.existsSync(path.join(backup, 'ui', 'relations', 'data.json'))).toBe(false);
  });
});
