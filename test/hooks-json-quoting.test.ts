import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * hooks.json 의 명령은 공백이 든 설치 경로에서도 돈다 (2026-11-11, 1.8.0 검수 IH-3).
 *
 * 명령 10개가 모두 `node ${CLAUDE_PLUGIN_ROOT}/scripts/…` 꼴이었다. 훅 명령은 셸(sh -c)로 실행되므로,
 * 홈 폴더나 플러그인 캐시 경로에 공백이 있으면 경로가 두 낱말로 갈라져 UserPromptSubmit 훅은 프롬프트마다
 * exit 126, SessionStart 훅들은 exit 1 로 끝났다(주입 0자). 자리표시자를 큰따옴표로 감싼다.
 *
 * 등록된 명령 문자열을 그대로 sh -c 로 실행한다. 자리표시자가 채워지는 두 방식 모두로:
 *  - 호스트가 문자열을 실행 전에 경로로 바꿔 넣는 경우
 *  - 셸이 환경변수 CLAUDE_PLUGIN_ROOT 를 펼치는 경우
 * 진짜 훅 10개를 다 돌리면 부작용이 있다(동기화 워커, 드리프트 검사의 프로세스 정리, 명령 설치). 그래서
 * 「명령 문자열이 스크립트에 닿는가」는 같은 상대 경로에 둔 기록용 스텁으로 10개 전부를 보고,
 * 부작용 없는 진짜 훅 셋은 저장소를 가리키는 공백 든 심링크로 실제로 돌린다.
 */

const REPO = path.resolve(__dirname, '..');
const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
type Hook = { type: string; command: string; async?: boolean; timeout?: number };
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher: string; hooks: Hook[] }>> };
const commands = Object.values(cfg.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
/** 명령이 가리키는 플러그인 안의 상대 경로. */
const scriptOf = (command: string) => /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/.exec(command)?.[1] ?? null;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync('/tmp/mbhq-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 등록된 문자열 그대로 sh -c. `how`: 호스트가 경로를 바꿔 넣는가(substituted), 셸이 환경변수를 펼치는가(env). */
function runRegistered(command: string, root: string, how: 'substituted' | 'env', opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const line = how === 'substituted' ? command.split(PLACEHOLDER).join(root) : command;
  const env: NodeJS.ProcessEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp, ...opts.env };
  if (how === 'env') env.CLAUDE_PLUGIN_ROOT = root;
  return spawnSync('sh', ['-c', line], { env, input: opts.input ?? '', encoding: 'utf8', timeout: 20_000 });
}

describe('hooks.json — 명령 문자열의 모양', () => {
  it('명령 10개가 모두 플러그인 안의 스크립트 하나를 가리킨다', () => {
    expect(commands).toHaveLength(10);
    for (const c of commands) {
      expect(c.split(PLACEHOLDER), c).toHaveLength(2);
      const rel = scriptOf(c);
      expect(rel, c).not.toBeNull();
      expect(fs.existsSync(path.join(REPO, rel!)), `${rel} 가 저장소에 있다`).toBe(true);
    }
  });

  it('자리표시자는 언제나 큰따옴표 안에 있다', () => {
    for (const c of commands) {
      const outsideQuotes = c.replace(/"[^"]*"/g, '');
      expect(outsideQuotes, c).not.toContain(PLACEHOLDER);
      expect(c, '작은따옴표 안에서는 셸이 변수를 펼치지 않는다').not.toMatch(/'[^']*\$\{CLAUDE_PLUGIN_ROOT\}/);
    }
  });
});

describe('hooks.json — 공백이 든 설치 경로에서 등록된 명령 문자열 그대로 실행', () => {
  /** 공백 든 폴더에, 명령들이 가리키는 상대 경로마다 「불렸다」를 파일로 남기는 스텁을 둔다. */
  function stubRoot(): { root: string; ran: (rel: string) => string[] | null } {
    const root = path.join(tmp, 'plug in root', 'memory bank');
    const marks = path.join(tmp, 'marks');
    fs.mkdirSync(marks);
    for (const c of commands) {
      const rel = scriptOf(c)!;
      const file = path.join(root, rel);
      const mark = path.join(marks, rel.replace(/\//g, '__'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rel.endsWith('.sh')
        ? `#!/bin/bash\nprintf '%s\\n' "$@" > '${mark}'\n`
        : `require('node:fs').writeFileSync(${JSON.stringify(mark)}, process.argv.slice(2).map((a) => a + '\\n').join(''));\n`);
    }
    // 스텁은 CommonJS 다 — 저장소의 package.json("type": "module") 밖이므로 .js 가 그대로 CommonJS 로 읽힌다
    return {
      root,
      ran: (rel) => {
        const mark = path.join(marks, rel.replace(/\//g, '__'));
        return fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean) : null;
      },
    };
  }

  for (const how of ['substituted', 'env'] as const) {
    it(`명령 10개가 모두 자기 스크립트에 닿고 인자도 그대로다 (${how === 'substituted' ? '호스트가 경로를 바꿔 넣음' : '셸이 환경변수를 펼침'})`, () => {
      const { root, ran } = stubRoot();
      const failed: string[] = [];
      for (const c of commands) {
        const rel = scriptOf(c)!;
        const r = runRegistered(c, root, how);
        const args = ran(rel);
        if (r.status !== 0 || args === null) { failed.push(`${rel} → exit ${r.status} ${String(r.stderr).trim().split('\n')[0] ?? ''}`.replace(tmp, '<tmp>')); continue; }
        // 스크립트 뒤의 인자 — `memory-bank.js sync --background` 하나뿐이다
        const expected = c.slice(c.indexOf(rel) + rel.length).replace(/^"/, '').trim().split(/\s+/).filter(Boolean);
        expect(args, c).toEqual(expected);
        fs.rmSync(path.join(tmp, 'marks', rel.replace(/\//g, '__')));
      }
      expect(failed, '공백 든 경로에서 실패한 명령').toEqual([]);
    });
  }

  it('진짜 훅: 프롬프트 훅 래퍼가 공백 든 플러그인 경로·설정 폴더에서 클라이언트를 부른다', () => {
    const root = path.join(tmp, 'plug in root');
    fs.symlinkSync(REPO, root);
    const fakebin = path.join(tmp, 'fakebin');
    fs.mkdirSync(fakebin);
    fs.writeFileSync(path.join(fakebin, 'node'), '#!/bin/sh\nprintf \'NODE %s\\n\' "$1"\n');
    fs.chmodSync(path.join(fakebin, 'node'), 0o755);
    const command = cfg.hooks.UserPromptSubmit.flatMap((g) => g.hooks)[0].command;
    for (const how of ['substituted', 'env'] as const) {
      const r = runRegistered(command, root, how, {
        env: { PATH: `${fakebin}:/usr/bin:/bin`, MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'config dir'), MEMORY_BANK_NATIVE_CLIENT: path.join(tmp, 'absent') },
        input: JSON.stringify({ prompt: '공백이 든 설치 경로에서 훅이 도는지 확인한다', cwd: '/tmp/proj', session_id: 'sess-space-01', hook_event_name: 'UserPromptSubmit' }),
      });
      expect(r.status, `${how}: ${r.stderr}`).toBe(0);
      expect(r.stdout.trim(), how).toBe(`NODE ${root}/hooks/../scripts/inject-context.js`);
    }
  });

  it('진짜 훅: 네이티브 빌드 훅(bash)과 원장 초기화 훅(node)이 공백 든 경로에서 exit 0 으로 제 일을 한다', () => {
    const root = path.join(tmp, 'plug in root');
    fs.symlinkSync(REPO, root);
    const config = path.join(tmp, 'config dir');
    const all = Object.values(cfg.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    const build = all.find((c) => c.includes('scripts/build-native-client.sh'))!;
    const reset = all.find((c) => c.includes('scripts/ledger-reset-hook.js'))!;
    const env = { MEMORY_BANK_CONFIG_DIR: config, MEMORY_BANK_CARGO: 'none', MEMORY_BANK_DRIFT_SWEEP: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    for (const how of ['substituted', 'env'] as const) {
      const b = runRegistered(build, root, how, { env });
      expect(b.status, `${how}: ${b.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(config, 'conversation-index', 'logs', 'native-build.log'), 'utf8'), '빌드 훅이 자기 로그를 남겼다').toMatch(/cargo 없음|up to date/);

      const ledger = path.join(config, 'conversation-index', 'state', 'inject-ledger', 'sess-space-02.json');
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.writeFileSync(ledger, '["k1","k2"]');
      const r = runRegistered(reset, root, how, { env, input: JSON.stringify({ session_id: 'sess-space-02', source: 'compact', hook_event_name: 'SessionStart' }) });
      expect(r.status, `${how}: ${r.stderr}`).toBe(0);
      expect(fs.existsSync(ledger), '원장 초기화 훅이 그 세션의 원장을 비웠다').toBe(false);
    }
  });
});
