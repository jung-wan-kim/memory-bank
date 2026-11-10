import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectSocketPathIn, MAX_UNIX_SOCKET_PATH_BYTES } from '../src/version-guard.js';

/**
 * scripts/e2e-native-inject-live.mjs 는 홈 폴더의 색인 폴더에서 주입 데몬 소켓 경로를 구한다.
 * 그 경로 함수는 이제 어떤 소켓 이름도 유닉스 소켓 한도에 들지 않으면 null 을 돌려준다
 * (홈 폴더 경로가 긴 기기). 스크립트는 null 을 path.basename 에 넘겨 TypeError 로 죽었다 —
 * 왜 못 도는지 알 수 없는 스택만 남는다. 그런 기기에서는 데몬이 뜨지 않으므로 잴 것이
 * 없다는 이유를 알리고, 빌드·서버 실행 전에 끝나야 한다.
 *
 * 이 테스트는 HOME 을 임시 폴더로 바꿔 스크립트를 띄운다 — 소켓 경로 판정은 첫 단계(빌드)
 * 보다 앞이라 실제 홈 폴더·실제 데몬에는 닿지 않는다.
 */

const REPO = path.resolve(__dirname, '..');

describe('e2e-native-inject-live: 소켓 경로가 한도를 넘는 홈 폴더', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-e2e-sock-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('TypeError 대신 이유를 알리고 exit 1 로 끝난다 — 아무것도 띄우지 않는다', () => {
    const home = path.join(tmp, 'h'.repeat(130));
    fs.mkdirSync(home);
    const index = path.join(home, '.config/superpowers/conversation-index');
    // 전제: 이 홈 폴더에서는 버전 이름도 옛 이름도 한도를 넘는다
    expect(injectSocketPathIn(index, '1.8.0')).toBeNull();

    const r = spawnSync(process.execPath, ['scripts/e2e-native-inject-live.mjs'], {
      cwd: REPO, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const out = r.stdout + r.stderr;

    expect(out).not.toMatch(/TypeError/);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    expect(r.status, out).toBe(1);
    expect(r.stdout).toMatch(/^ABORT: no inject-daemon socket name fits under /m);
    expect(r.stdout).toContain(index);
    expect(r.stdout).toContain(`${MAX_UNIX_SOCKET_PATH_BYTES} bytes`);
    expect(r.stdout).toContain('socket-path-too-long');
    // 첫 단계(빌드) 전에 끝났다: 단계 출력이 없고 홈 폴더에 아무것도 생기지 않았다
    expect(r.stdout).not.toMatch(/step1 build/);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
