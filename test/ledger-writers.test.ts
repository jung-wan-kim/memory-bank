import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 세션 원장을 쓰는 곳의 전수 목록 (2026-10-03, v1.7.4 독립 검토 지적).
 *
 * 「원장은 블록을 출력한 쪽이, 출력에 성공한 뒤에만 쓴다」는 서술이 1.7.2·1.7.3·1.7.4 세
 * 릴리스 연속으로 고쳐졌다 — 매번 서술 밖의 기록자가 남아 있었다. 산문 대신 호출부를
 * 열거해 고정한다. 새 기록자를 넣으려면 이 목록과 그 기록자의 출력 성공 조건을 함께 바꿔야 한다.
 */

const REPO = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(rel);
    return /\.(ts|js|mjs|cjs)$/.test(e.name) ? [rel] : [];
  });
}

describe('세션 원장 기록자', () => {
  it('appendLedger 를 부르는 곳은 출력 성공을 확인하는 두 곳뿐이다', () => {
    const sites: Array<{ file: string; text: string; before: string }> = [];
    for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
      const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bappendLedger\s*\(/.test(line) && !/export function appendLedger/.test(line)) {
          sites.push({ file, text: line.trim(), before: lines.slice(Math.max(0, i - 2), i).join('\n') });
        }
      });
    }
    expect(sites.map((s) => s.file).sort(), JSON.stringify(sites, null, 1)).toEqual([
      'scripts/fact-consolidate-hook.js',
      'scripts/inject-context.js',
    ]);
    // 각 기록은 출력 성공 조건 안에 있다
    expect(sites.find((s) => s.file === 'scripts/inject-context.js')!.text).toMatch(/if \(!err && /);
    const hook = sites.find((s) => s.file === 'scripts/fact-consolidate-hook.js')!;
    expect(hook.before + '\n' + hook.text).toMatch(/if \(delivered && /);
  });
});
