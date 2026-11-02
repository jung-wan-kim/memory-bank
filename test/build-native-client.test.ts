import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..');
const SRC_HASH = fs.readFileSync(path.join(REPO, 'native', 'inject-client', 'SRC_HASH'), 'utf8').trim();
let tmp: string;
const idx = () => path.join(tmp, 'conversation-index');
const bin = () => path.join(idx(), 'bin', 'memory-bank-inject-client');
const log = () => { const f = path.join(idx(), 'logs', 'native-build.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };

function run(env: Record<string, string>) {
  return spawnSync('bash', [path.join(REPO, 'scripts', 'build-native-client.sh')], {
    env: { PATH: '/usr/bin:/bin', HOME: tmp, MEMORY_BANK_CONFIG_DIR: tmp, ...env }, encoding: 'utf8', timeout: 20_000,
  });
}

/** A fake cargo: "builds" a shell script that answers --src-hash with the pin it was compiled with. */
function fakeCargo(): string {
  const dir = path.join(tmp, 'fakecargo'); fs.mkdirSync(dir, { recursive: true });
  const cargo = path.join(dir, 'cargo');
  fs.writeFileSync(cargo, `#!/bin/bash
# args: build --release --quiet --manifest-path X --target-dir T
while [ $# -gt 0 ]; do case "$1" in --target-dir) T="$2"; shift;; esac; shift; done
mkdir -p "$T/release"
printf '#!/bin/sh\\n[ "$1" = "--src-hash" ] && echo %s\\n' "$MEMORY_BANK_INJECT_CLIENT_SRC_HASH" > "$T/release/memory-bank-inject-client"
chmod 755 "$T/release/memory-bank-inject-client"
`);
  fs.chmodSync(cargo, 0o755);
  return cargo;
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-build-')); fs.mkdirSync(idx(), { recursive: true }); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('scripts/build-native-client.sh (AC-006)', () => {
  it('no cargo → one stderr line, exit 0, nothing written', () => {
    const r = run({ MEMORY_BANK_CARGO: 'none' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('cargo 없음 — node 경로 유지');
    expect(fs.existsSync(bin())).toBe(false);
    expect(log()).toContain('cargo 없음');
  });

  it('binary already at SRC_HASH → no rebuild, files untouched', () => {
    fs.mkdirSync(path.dirname(bin()), { recursive: true });
    fs.writeFileSync(bin(), '#!/bin/sh\n'); fs.chmodSync(bin(), 0o755); fs.writeFileSync(`${bin()}.srchash`, SRC_HASH + '\n');
    const before = fs.statSync(bin()).mtimeMs;
    const r = run({ MEMORY_BANK_CARGO: fakeCargo() });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('up to date');
    expect(fs.statSync(bin()).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(idx(), 'native-build'))).toBe(false);
  });

  it('hash differs → builds, installs binary + .srchash atomically, logs one line', () => {
    fs.mkdirSync(path.dirname(bin()), { recursive: true });
    fs.writeFileSync(bin(), '#!/bin/sh\necho OLD\n'); fs.chmodSync(bin(), 0o755); fs.writeFileSync(`${bin()}.srchash`, 'oldhash0000000000\n');
    const r = run({ MEMORY_BANK_CARGO: fakeCargo() });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(`${bin()}.srchash`, 'utf8').trim()).toBe(SRC_HASH);
    expect(fs.readFileSync(bin(), 'utf8')).not.toContain('OLD');
    expect(spawnSync(bin(), ['--src-hash'], { encoding: 'utf8' }).stdout.trim()).toBe(SRC_HASH);
    expect(fs.readdirSync(path.dirname(bin())).filter((f) => f.includes('.tmp.'))).toEqual([]);
    expect(log().trim().split('\n').filter((l) => l.includes('built'))).toHaveLength(1);
  });

  it('a build whose binary does not carry the pin is not installed (H-001)', () => {
    const dir = path.join(tmp, 'badcargo'); fs.mkdirSync(dir);
    const cargo = path.join(dir, 'cargo');
    fs.writeFileSync(cargo, `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in --target-dir) T="$2"; shift;; esac; shift; done\nmkdir -p "$T/release"\nprintf '#!/bin/sh\\necho otherhash\\n' > "$T/release/memory-bank-inject-client"\nchmod 755 "$T/release/memory-bank-inject-client"\n`);
    fs.chmodSync(cargo, 0o755);
    const r = run({ MEMORY_BANK_CARGO: cargo });
    expect(r.status).toBe(0);
    expect(fs.existsSync(bin())).toBe(false);
    expect(r.stderr).toContain('해시 불일치');
  });

  it('cargo build fails → exit 0, reason logged, nothing installed (H-001)', () => {
    const dir = path.join(tmp, 'failcargo'); fs.mkdirSync(dir);
    const cargo = path.join(dir, 'cargo'); fs.writeFileSync(cargo, '#!/bin/sh\necho "error: could not download crate" >&2\nexit 101\n'); fs.chmodSync(cargo, 0o755);
    const r = run({ MEMORY_BANK_CARGO: cargo });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('cargo build 실패');
    expect(r.stderr).toContain('could not download crate');
    expect(fs.existsSync(bin())).toBe(false);
  });
});
