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

const SOURCE_DIRS = ['src', 'scripts', 'cli', 'ui', 'hooks'].filter((d) => fs.existsSync(path.join(REPO, d)));
const LEDGER_MODULE = 'src/inject-ledger.ts';

function scan(pattern: RegExp): Array<{ file: string; line: number; text: string; before: string }> {
  const hits: Array<{ file: string; line: number; text: string; before: string }> = [];
  for (const file of SOURCE_DIRS.flatMap(sourceFiles)) {
    if (file === LEDGER_MODULE) continue;
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim(), before: lines.slice(Math.max(0, i - 2), i).join('\n') });
    });
  }
  return hits;
}

describe('세션 원장 기록자', () => {
  it('appendLedger 라는 이름이 나오는 곳은 두 스크립트의 import 와 호출 한 번씩뿐이다', () => {
    // 호출 형태가 아니라 이름 자체를 센다 — 별칭 import(`appendLedger as record`), `?.(`, `.call` 도 이름이 나온다
    const hits = scan(/\bappendLedger\b/);
    const byFile = new Map<string, string[]>();
    for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.text]);
    expect([...byFile.keys()].sort(), JSON.stringify(hits, null, 1)).toEqual([
      'scripts/fact-consolidate-hook.js',
      'scripts/inject-context.js',
    ]);
    for (const [file, lines] of byFile) {
      expect(lines.filter((l) => /^import\b/.test(l)), `${file}: import 한 줄`).toHaveLength(1);
      expect(lines.filter((l) => !/^import\b/.test(l)), `${file}: 호출 한 줄`).toHaveLength(1);
    }
    // 각 호출은 출력 성공 조건 안에 있다
    const call = (file: string) => hits.find((h) => h.file === file && !/^import\b/.test(h.text))!;
    expect(call('scripts/inject-context.js').text).toMatch(/if \(!err && /);
    const hook = call('scripts/fact-consolidate-hook.js');
    expect(hook.before + '\n' + hook.text).toMatch(/if \(delivered && /);
  });

  it('원장 폴더(ledgerDir)에 직접 쓰는 코드는 원장 모듈 밖에 없다', () => {
    expect(scan(/\bledgerDir\b|inject-ledger['"/]/).filter((h) => !/^import\b/.test(h.text))).toEqual([]);
    expect(scan(/state[\\/]inject-ledger|'inject-ledger'/)).toEqual([]);
  });
});
