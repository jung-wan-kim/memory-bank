import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativeSrcHash } from '../scripts/native-src-hash.mjs';

const REPO = path.resolve(__dirname, '..');
const CRATE = path.join(REPO, 'native', 'inject-client');

// TC-HASH-001 — the committed pin is what the sources hash to; the wrapper and the build script both read it.
describe('native client source hash pin (TC-HASH-001)', () => {
  it('SRC_HASH equals the hash of Cargo.toml + src/**', () => {
    const committed = fs.readFileSync(path.join(CRATE, 'SRC_HASH'), 'utf8').trim();
    expect(committed).toMatch(/^[0-9a-f]{16}$/);
    expect(nativeSrcHash()).toBe(committed);
    const out = execFileSync(process.execPath, ['scripts/native-src-hash.mjs', '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(out.trim()).toBe(committed);
  });

  it('runs as a script behind a symlinked path too (H-004: /tmp → /private/tmp made the main check a silent no-op)', () => {
    const link = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-link-'));
    fs.symlinkSync(REPO, path.join(link, 'repo'));
    const out = execFileSync(process.execPath, [path.join(link, 'repo', 'scripts', 'native-src-hash.mjs'), '--check'], { encoding: 'utf8' });
    expect(out.trim()).toBe(fs.readFileSync(path.join(CRATE, 'SRC_HASH'), 'utf8').trim());
    fs.rmSync(link, { recursive: true, force: true });
  });

  it('a one-byte source change changes the hash (so an old binary is never selected for new sources)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-crate-'));
    fs.cpSync(CRATE, tmp, { recursive: true, filter: (src) => !src.includes(`${path.sep}target`) });
    expect(nativeSrcHash(tmp)).toBe(nativeSrcHash());
    fs.appendFileSync(path.join(tmp, 'src', 'gate.rs'), '\n// x\n');
    expect(nativeSrcHash(tmp)).not.toBe(nativeSrcHash());
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
