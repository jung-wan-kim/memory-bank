import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..');
const SRC_HASH = fs.readFileSync(path.join(REPO, 'native', 'inject-client', 'SRC_HASH'), 'utf8').trim();
let tmp: string;

/** A fake binary: writes its marker to stdout and a file (so "was it run" is a fact, not an absence of output). */
function fakeBin(name: string, hash: string | null, opts: { exec?: boolean } = {}): string {
  const bin = path.join(tmp, name);
  fs.writeFileSync(bin, `#!/bin/sh\necho NATIVE\necho ran > "${tmp}/${name}.ran"\n`);
  if (opts.exec !== false) fs.chmodSync(bin, 0o755);
  if (hash !== null) fs.writeFileSync(`${bin}.srchash`, hash + '\n');
  return bin;
}

/** PATH with a fake node that prints NODE — the wrapper's node path must be observable without running the real client. */
function fakeNodePath(): string {
  const dir = path.join(tmp, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho NODE\n');
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  return `${dir}:/usr/bin:/bin`;
}

function runWrapper(nativeBin: string): { stdout: string; status: number | null; errLog: string } {
  // The registered command string is `bash ${CLAUDE_PLUGIN_ROOT}/hooks/inject-context.sh` — run exactly that.
  const r = spawnSync('bash', [path.join(REPO, 'hooks', 'inject-context.sh')], {
    input: JSON.stringify({ prompt: '프롬프트 훅 래퍼의 바이너리 선택 규칙을 확인한다', cwd: '/tmp/proj', session_id: 'sess-wrap-01', hook_event_name: 'UserPromptSubmit' }),
    env: { PATH: fakeNodePath(), HOME: tmp, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_NATIVE_CLIENT: nativeBin },
    encoding: 'utf8', timeout: 10_000,
  });
  const errLog = path.join(tmp, 'conversation-index', 'logs', 'inject-context.err.log');
  return { stdout: r.stdout, status: r.status, errLog: fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '' };
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-wrap-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('hooks/inject-context.sh picks the native client only when it is safe to (AC-004)', () => {
  it('executable binary whose .srchash equals SRC_HASH → native', () => {
    const r = runWrapper(fakeBin('client', SRC_HASH));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('NATIVE');
    expect(fs.existsSync(path.join(tmp, 'client.ran'))).toBe(true);
  });

  it('hash mismatch → node, and the binary is not run (TC-NEG-002)', () => {
    const r = runWrapper(fakeBin('client', 'deadbeefdeadbeef'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('NODE');
    expect(fs.existsSync(path.join(tmp, 'client.ran'))).toBe(false);
  });

  it('no .srchash file → node (TC-NEG-002)', () => {
    const r = runWrapper(fakeBin('client', null));
    expect(r.stdout.trim()).toBe('NODE');
    expect(fs.existsSync(path.join(tmp, 'client.ran'))).toBe(false);
  });

  it('binary missing → node; not executable → node', () => {
    expect(runWrapper(path.join(tmp, 'absent')).stdout.trim()).toBe('NODE');
    const r = runWrapper(fakeBin('noexec', SRC_HASH, { exec: false }));
    expect(r.stdout.trim()).toBe('NODE');
    expect(fs.existsSync(path.join(tmp, 'noexec.ran'))).toBe(false);
  });

  it('A-003: a directory, or a symlink to a file without a matching hash, is never executed', () => {
    const dir = path.join(tmp, 'adir'); fs.mkdirSync(dir); fs.writeFileSync(`${dir}.srchash`, SRC_HASH + '\n');
    expect(runWrapper(dir).stdout.trim()).toBe('NODE');
    const target = fakeBin('target', null);
    const link = path.join(tmp, 'link'); fs.symlinkSync(target, link);
    expect(runWrapper(link).stdout.trim()).toBe('NODE');
    expect(fs.existsSync(path.join(tmp, 'target.ran'))).toBe(false);
  });

  it('H-002: a crashing native binary still leaves the hook at exit 0 with stderr in the error log', () => {
    const bin = path.join(tmp, 'crash');
    fs.writeFileSync(bin, '#!/bin/sh\necho boom >&2\nexit 3\n'); fs.chmodSync(bin, 0o755); fs.writeFileSync(`${bin}.srchash`, SRC_HASH + '\n');
    const r = runWrapper(bin);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.errLog).toContain('boom');
  });
});
