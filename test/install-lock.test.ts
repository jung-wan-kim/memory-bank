import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireInstallLock, releaseInstallLock, depsPresent } from '../src/install-lock.js';

describe('install lock (obra #161 concept)', () => {
  let root: string;
  const lockDir = () => path.join(root, '.npm-install.lock');

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-lock-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('a second acquire fails while a live holder has it, and succeeds after release', () => {
    expect(acquireInstallLock(root)).toBe(true);
    expect(acquireInstallLock(root)).toBe(false);
    releaseInstallLock(root);
    expect(acquireInstallLock(root)).toBe(true);
  });

  it('reclaims a lock whose holder is dead', () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), '999999');
    expect(acquireInstallLock(root)).toBe(true);
    expect(fs.readFileSync(path.join(lockDir(), 'pid'), 'utf8')).toBe(String(process.pid));
  });

  it('depsPresent needs every declared dependency, not just a node_modules folder', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { a: '1', b: '1' } }));
    fs.mkdirSync(path.join(root, 'node_modules', 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'a', 'package.json'), '{}');
    expect(depsPresent(root)).toBe(false); // the 2026-10-30 half tree
    fs.mkdirSync(path.join(root, 'node_modules', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'b', 'package.json'), '{}');
    expect(depsPresent(root)).toBe(true);
  });
});

describe('install lock ownership', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-own-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('release leaves a lock that another process now holds', () => {
    const lockDir = path.join(root, '.npm-install.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.ppid)); // a live pid that is not ours
    releaseInstallLock(root);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(acquireInstallLock(root)).toBe(false);
  });
});

describe('dead holder with npm still running', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-orphan-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('is not reclaimed while node_modules is still changing, and is once it settles', () => {
    const lockDir = path.join(root, '.npm-install.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '999999'); // holder killed mid-install
    fs.mkdirSync(path.join(root, 'node_modules'));         // its npm just wrote here
    expect(acquireInstallLock(root)).toBe(false);
    const settled = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(root, 'node_modules'), settled, settled);
    expect(acquireInstallLock(root)).toBe(true);
  });
});
