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

/**
 * 실패한 빌드를 기억한다 (2026-11-11, 1.8.0 검수 IH-6).
 * cargo 는 있는데 crates.io 에 닿지 못하는 기계(프록시·방화벽)에서는 SessionStart 마다 cargo 가 자체 재시도와
 * 시간 제한을 다 쓰고 실패했다(실측 131초). 실패 기록이 로그 한 줄뿐이라 다음 세션 시작에서 처음부터 다시 했다.
 *  - 실패하면 <색인 폴더>/state/native-build-failed 에 그때의 SRC_HASH 와 시각을 남기고,
 *    같은 SRC_HASH 로는 6시간 동안 cargo 를 부르지 않는다 (플러그인이 갱신돼 해시가 바뀌면 바로 다시 한다)
 *  - cargo 의 네트워크 재시도를 1회, 요청 시간 제한을 10초로 준다 (사용자가 정한 값이 있으면 그 값)
 */
describe('scripts/build-native-client.sh — 실패한 빌드를 세션마다 되풀이하지 않는다', () => {
  const mark = () => path.join(idx(), 'state', 'native-build-failed');
  const SIX_HOURS_S = 6 * 3600;
  /** 실패하는 cargo — 불린 횟수와 받은 네트워크 설정을 남긴다. */
  function failingCargo(): { cargo: string; calls: () => string[] } {
    const dir = path.join(tmp, 'failcargo'); fs.mkdirSync(dir, { recursive: true });
    const cargo = path.join(dir, 'cargo');
    const callsFile = path.join(tmp, 'cargo-calls.log');
    fs.writeFileSync(cargo, `#!/bin/sh\necho "retry=$CARGO_NET_RETRY timeout=$CARGO_HTTP_TIMEOUT" >> "${callsFile}"\necho "error: download of config.json failed" >&2\nexit 101\n`);
    fs.chmodSync(cargo, 0o755);
    return { cargo, calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : []) };
  }
  const writeMark = (hash: string, ageSeconds: number) => {
    fs.mkdirSync(path.dirname(mark()), { recursive: true });
    fs.writeFileSync(mark(), `${hash} ${Math.floor(Date.now() / 1000) - ageSeconds}\n`);
  };

  it('cargo build 가 실패하면 기록을 남기고, 다음 세션 시작에서는 cargo 를 부르지 않는다', () => {
    const { cargo, calls } = failingCargo();
    const first = run({ MEMORY_BANK_CARGO: cargo });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('cargo build 실패');
    expect(calls()).toHaveLength(1);
    const [hash, ts] = fs.readFileSync(mark(), 'utf8').trim().split(' ');
    expect(hash).toBe(SRC_HASH);
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);

    const second = run({ MEMORY_BANK_CARGO: cargo });
    expect(second.status).toBe(0);
    expect(calls(), '예전에는 세션 시작마다 다시 빌드했다').toHaveLength(1);
    expect(second.stderr).toContain('다시 시도하지 않음');
    expect(second.stderr, '바로 다시 하는 방법').toContain(mark());
    expect(log().trim().split('\n').at(-1)).toContain('다시 시도하지 않음');
    expect(fs.existsSync(bin())).toBe(false);
  });

  it('기록이 6시간을 넘겼으면 다시 시도하고, 그 직전까지는 하지 않는다', () => {
    const { cargo, calls } = failingCargo();
    writeMark(SRC_HASH, SIX_HOURS_S - 120);
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls(), '5시간 58분 전의 실패').toHaveLength(0);
    writeMark(SRC_HASH, SIX_HOURS_S + 120);
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls(), '6시간 2분 전의 실패').toHaveLength(1);
    const [, ts] = fs.readFileSync(mark(), 'utf8').trim().split(' ');
    expect(Math.abs(Number(ts) - Date.now() / 1000), '다시 실패하면 기록의 시각이 새로 찍힌다').toBeLessThan(60);
  });

  it('SRC_HASH 가 다른 기록(플러그인 갱신 전의 실패)은 막지 않는다', () => {
    const { cargo, calls } = failingCargo();
    writeMark('0123456789abcdef', 60);
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls()).toHaveLength(1);
  });

  it('읽을 수 없는 기록·미래 시각의 기록은 없는 것으로 본다 (빌드를 영영 막지 않는다)', () => {
    const { cargo, calls } = failingCargo();
    fs.mkdirSync(path.dirname(mark()), { recursive: true });
    fs.writeFileSync(mark(), 'garbage');
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls()).toHaveLength(1);
    fs.writeFileSync(mark(), `${SRC_HASH} not-a-number\n`);
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls()).toHaveLength(2);
    writeMark(SRC_HASH, -3600); // 시계가 뒤로 간 기계
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls()).toHaveLength(3);
  });

  it('빌드에 성공하면 실패 기록을 지운다', () => {
    writeMark(SRC_HASH, SIX_HOURS_S + 120);
    const r = run({ MEMORY_BANK_CARGO: fakeCargo() });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(`${bin()}.srchash`, 'utf8').trim()).toBe(SRC_HASH);
    expect(fs.existsSync(mark())).toBe(false);
  });

  it('바이너리가 이미 맞으면 실패 기록이 있어도 「up to date」 — 기록은 빌드를 막을 뿐이다', () => {
    writeMark(SRC_HASH, 60);
    fs.mkdirSync(path.dirname(bin()), { recursive: true });
    fs.writeFileSync(bin(), '#!/bin/sh\n'); fs.chmodSync(bin(), 0o755); fs.writeFileSync(`${bin()}.srchash`, SRC_HASH + '\n');
    expect(run({ MEMORY_BANK_CARGO: fakeCargo() }).stderr).toContain('up to date');
  });

  it('cargo 에 네트워크 재시도 1회·시간 제한 10초를 준다 — 사용자가 정한 값이 있으면 그 값을 둔다', () => {
    const { cargo, calls } = failingCargo();
    run({ MEMORY_BANK_CARGO: cargo });
    expect(calls()).toEqual(['retry=1 timeout=10']);
    fs.rmSync(mark());
    run({ MEMORY_BANK_CARGO: cargo, CARGO_NET_RETRY: '5', CARGO_HTTP_TIMEOUT: '60' });
    expect(calls().at(-1)).toBe('retry=5 timeout=60');
  });
});
