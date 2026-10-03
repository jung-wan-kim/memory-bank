import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-ledger-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 동적 import: MEMORY_BANK_CONFIG_DIR 설정 후 로드 (paths 는 호출 시 평가라 순서 무관하지만 명시)
async function ledger() {
  return await import('../src/inject-ledger.js');
}

describe('inject-ledger (세션 dedup 원장)', () => {
  it('빈 세션은 빈 집합, append 후 재로드 시 유지', async () => {
    const { loadLedger, appendLedger } = await ledger();
    const sid = 'sess-abc-123';
    expect(loadLedger(sid).size).toBe(0);
    appendLedger(sid, loadLedger(sid), ['f1', 'f2']);
    const l2 = loadLedger(sid);
    expect(l2.has('f1')).toBe(true);
    expect(l2.has('f2')).toBe(true);
    expect(l2.size).toBe(2);
  });

  it('세션 간 격리: 다른 session_id 는 독립 원장', async () => {
    const { loadLedger, appendLedger } = await ledger();
    appendLedger('sess-A111', new Set(), ['fa']);
    expect(loadLedger('sess-B222').has('fa')).toBe(false);
    expect(loadLedger('sess-A111').has('fa')).toBe(true);
  });

  it('bounded: 800 상한 초과 시 oldest evict (fact id + 본문 키를 함께 담는다)', async () => {
    const { loadLedger, appendLedger } = await ledger();
    const sid = 'sess-cap-test';
    const first = Array.from({ length: 750 }, (_, i) => 'old' + i);
    appendLedger(sid, new Set(), first);
    const more = Array.from({ length: 100 }, (_, i) => 'new' + i);
    appendLedger(sid, loadLedger(sid), more);
    const l = loadLedger(sid);
    expect(l.size).toBe(800);
    expect(l.has('old0')).toBe(false);   // oldest 50 evicted
    expect(l.has('old49')).toBe(false);
    expect(l.has('old50')).toBe(true);
    expect(l.has('new99')).toBe(true);   // 최신 유지
  });

  it('session_id sanitize: path traversal 무력화 + 비정상 id 는 no-op', async () => {
    const { loadLedger, appendLedger, sanitizeSessionId, ledgerDir } = await ledger();
    expect(sanitizeSessionId('../../etc/passwd')).toBe('etcpasswd'); // 구분자 제거
    expect(sanitizeSessionId('ab')).toBe(null);                      // 너무 짧음
    expect(sanitizeSessionId(undefined)).toBe(null);
    appendLedger('../../evil', new Set(), ['x']);
    // 원장 디렉토리 밖에 파일이 생기지 않아야 함
    const outside = path.join(tmpDir, 'conversation-index', 'state', 'evil.json');
    expect(fs.existsSync(outside)).toBe(false);
    // sanitize 된 이름으로만 생성됨
    const files = fs.existsSync(ledgerDir()) ? fs.readdirSync(ledgerDir()) : [];
    for (const f of files) expect(f).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    // session_id 없으면 로드는 빈 집합 (fail-open)
    expect(loadLedger(null).size).toBe(0);
  });

  it('깨진 원장 파일은 빈 집합으로 fail-open (주입을 막지 않는다)', async () => {
    const { loadLedger, appendLedger, ledgerDir } = await ledger();
    const sid = 'sess-corrupt1';
    appendLedger(sid, new Set(), ['f1']); // 디렉토리 생성
    fs.writeFileSync(path.join(ledgerDir(), sid + '.json'), '{not json');
    expect(loadLedger(sid).size).toBe(0);
    // 그 위에 다시 append 가능 (자가 치유)
    appendLedger(sid, loadLedger(sid), ['f2']);
    expect(loadLedger(sid).has('f2')).toBe(true);
  });

  it('TTL: 7일 지난 원장은 다음 저장 때 정리', async () => {
    const { appendLedger, ledgerDir } = await ledger();
    appendLedger('sess-old-111', new Set(), ['x']);
    const oldFile = path.join(ledgerDir(), 'sess-old-111.json');
    const past = Date.now() / 1000 - 8 * 24 * 3600;
    fs.utimesSync(oldFile, past, past);
    appendLedger('sess-new-222', new Set(), ['y']); // save 가 prune 트리거
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(path.join(ledgerDir(), 'sess-new-222.json'))).toBe(true);
  });
});
