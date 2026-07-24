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
});
