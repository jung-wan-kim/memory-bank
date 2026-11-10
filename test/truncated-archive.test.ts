import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

/**
 * 압축 도중 끊긴 `.zst` 보관 파일(끝이 잘린 파일)은 "더 짧은 대화"가 아니라 읽을 수 없는 파일이다.
 *
 * Node 의 zstd 해제기는 프레임 중간에서 끝난 입력에 오류를 내지 않고 그때까지 푼 만큼만 돌려준다.
 * 그래서 verify 는 이런 파일을 정상이라 했고, repair 는 온전한 색인 행을 앞부분만 담은 행으로
 * 바꿨으며, rebuild 는 그 대화의 행을 비운 뒤 되살리지 못한 채 성공으로 끝났다(검수 LSO-3).
 */

const calls = { embeddings: 0 };
vi.mock('../src/summarizer.js', () => ({
  REFUSED_SUMMARY: '[No summary: the model declined to summarize this conversation.]',
  summarizeConversation: async () => 'A summary.',
}));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => { calls.embeddings++; return new Array(384).fill(0.01); },
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});

const zstdCompressSync = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';

const EMB = new Array(384).fill(0.01);
const line = (type: 'user' | 'assistant', content: string) =>
  JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-11-01T00:00:00Z' });
/** 여러 zstd 블록에 걸치도록 잘 압축되지 않는 답을 가진 대화(턴 `turns` 개). */
const bigConversation = (turns: number) => Array.from({ length: turns }, (_, i) =>
  [line('user', `question ${i + 1}`), line('assistant', `answer ${i + 1} ${randomBytes(2000).toString('hex')}`)]).flat().join('\n') + '\n';

let testDir: string;
let archiveDir: string;
let dbPath: string;
let restoreConsole: () => void;
const outerConfigDir = process.env.MEMORY_BANK_CONFIG_DIR;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-truncated-'));
  archiveDir = path.join(testDir, 'archive');
  dbPath = path.join(testDir, 'db.sqlite');
  fs.mkdirSync(path.join(archiveDir, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'projects'), { recursive: true });
  process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  process.env.TEST_DB_PATH = dbPath;
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(testDir, 'cfg');
  calls.embeddings = 0;
  restoreConsole = suppressConsole();
});
afterEach(() => {
  restoreConsole();
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  if (outerConfigDir === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
  else process.env.MEMORY_BANK_CONFIG_DIR = outerConfigDir;
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** 보관 파일을 쓰고 색인한 뒤(요약 파일도 둔다), 압축본으로 바꾼다. `keep` 이 1 보다 작으면 그 비율에서 자른다. */
async function archiveAndIndex(name: string, content: string, keep = 1): Promise<{ file: string; turns: number }> {
  const { initDatabase, insertExchange } = await import('../src/db.js');
  const { parseConversation } = await import('../src/parser.js');
  const file = path.join(archiveDir, 'proj', name);
  fs.writeFileSync(file, content);
  fs.writeFileSync(file.replace('.jsonl', '-summary.txt'), 'A summary.');
  const db = initDatabase();
  let turns = 0;
  try {
    for (const ex of await parseConversation(file, 'proj', file)) {
      insertExchange(db, { ...ex, toolCalls: [{ id: `${ex.id}:0`, exchangeId: ex.id, toolName: 'Read', isError: false, timestamp: 't' }] }, EMB);
      turns++;
    }
  } finally {
    db.close();
  }
  const compressed = zstdCompressSync!(Buffer.from(content, 'utf-8'));
  fs.writeFileSync(file + '.zst', compressed.subarray(0, Math.floor(compressed.length * keep)));
  fs.unlinkSync(file);
  return { file, turns };
}

const state = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify({
      rows: db.prepare('SELECT id, archive_path, line_start, line_end, length(assistant_message) AS n, last_indexed FROM exchanges ORDER BY archive_path, line_start').all(),
      tools: (db.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n,
      vectors: (db.prepare('SELECT count(*) AS n FROM vec_exchanges_rowids').get() as { n: number }).n,
    });
  } finally {
    db.close();
  }
};
const rowsOf = (file: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM exchanges WHERE archive_path = ?').get(file) as { n: number }).n;
  } finally {
    db.close();
  }
};

describe.runIf(hasZstd)('끝이 잘린 .zst 보관 파일', () => {
  it('parseGuarded 는 앞부분만 읽은 결과를 돌려주지 않고 거부한다', async () => {
    const { parseGuarded } = await import('../src/conversation-guard.js');
    const { file, turns } = await archiveAndIndex('cut.jsonl', bigConversation(120), 0.6);
    expect(turns).toBe(120);
    await expect(parseGuarded(file, 'proj', file)).rejects.toThrow(/incomplete/);
  });

  it('verify 는 손상으로 보고하고, repair 는 그 대화의 색인 행을 건드리지 않는다', async () => {
    const { verifyIndex, repairIndex } = await import('../src/verify.js');
    const cut = await archiveAndIndex('cut.jsonl', bigConversation(120), 0.6);
    const fine = await archiveAndIndex('fine.jsonl', bigConversation(3));
    // 잘린 파일이 색인보다 나중에 쓰인 것처럼(예전에는 '오래됨'으로 잡혀 앞부분만으로 다시 색인됐다)
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(cut.file + '.zst', later, later);
    const before = state();

    const issues = await verifyIndex();
    expect(issues.corrupted.map((c) => c.path)).toEqual([cut.file]);
    expect(issues.corrupted[0].error).toMatch(/incomplete/);
    expect(issues.outdated).toEqual([]);
    expect(issues.notIndexed).toEqual([]);
    expect(issues.orphaned).toEqual([]);

    const outcome = await repairIndex(issues, { noSummaries: true });
    expect(outcome.reindexedFiles).toBe(0);
    expect(state()).toBe(before);
    expect(rowsOf(cut.file)).toBe(120);
    expect(rowsOf(fine.file)).toBe(3);
  });

  it('rebuild 는 읽을 수 없는 파일의 행을 되살릴 수 없는 행으로 세고, 아무것도 바꾸지 않은 채 거부한다', async () => {
    const { rebuildConversationIndex, RebuildWouldLoseIndexError } = await import('../src/rebuild.js');
    const cut = await archiveAndIndex('cut.jsonl', bigConversation(120), 0.6);
    await archiveAndIndex('fine.jsonl', bigConversation(3));
    const before = state();

    let thrown: unknown;
    try { await rebuildConversationIndex({ yes: true }); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(RebuildWouldLoseIndexError);
    const err = thrown as InstanceType<typeof RebuildWouldLoseIndexError>;
    expect(err.reach.unreachable).toEqual({ exchanges: 120, files: 1 });
    expect(err.reach.unreadable).toEqual({ exchanges: 120, files: 1 });
    expect(err.reach.unreachablePaths).toEqual([cut.file]);
    expect(err.message).toMatch(/120 indexed exchange\(s\) from 1 file\(s\) cannot be re-created/);
    expect(err.message).toMatch(/cannot be read to the end/);
    expect(state()).toBe(before);
    expect(fs.existsSync(path.join(testDir, 'cfg', 'conversation-index', 'backups'))).toBe(false);
    expect(calls.embeddings).toBe(0);
  });

  it('--allow-index-loss 를 주면 그 행을 먼저 백업하고 진행한다', async () => {
    const { rebuildConversationIndex } = await import('../src/rebuild.js');
    const cut = await archiveAndIndex('cut.jsonl', bigConversation(120), 0.6);
    const fine = await archiveAndIndex('fine.jsonl', bigConversation(3));

    const result = await rebuildConversationIndex({ yes: true, allowIndexLoss: true });

    expect(result.reach.unreadable).toEqual({ exchanges: 120, files: 1 });
    expect(result.lostExchangesBackupPath).not.toBeNull();
    const bak = new Database(result.lostExchangesBackupPath!, { readonly: true });
    try {
      expect(bak.prepare('SELECT count(*) AS n, count(DISTINCT archive_path) AS files FROM exchanges WHERE archive_path = ?').get(cut.file))
        .toEqual({ n: 120, files: 1 });
      expect(bak.prepare('SELECT count(*) AS n FROM tool_calls').get()).toEqual({ n: 120 });
    } finally {
      bak.close();
    }
    expect(rowsOf(cut.file)).toBe(0);  // 받아들인 손실 — 백업에 있다
    expect(rowsOf(fine.file)).toBe(3); // 읽을 수 있는 대화는 다시 색인됐다
    expect(result.reindex.failed).toEqual([]);
  });

  it('확인(--yes) 없이는 예전처럼 미리 보기만 하고 파일을 끝까지 읽지 않는다', async () => {
    const { rebuildConversationIndex, RebuildNotConfirmedError } = await import('../src/rebuild.js');
    await archiveAndIndex('cut.jsonl', bigConversation(120), 0.6);
    const before = state();
    await expect(rebuildConversationIndex({})).rejects.toBeInstanceOf(RebuildNotConfirmedError);
    expect(state()).toBe(before);
  });

  /**
   * 온전한 프레임 뒤에 프레임이 아닌 바이트가 붙은 `.zst` 는 잘린 파일이 아니다(검수 STORE2-01).
   *
   * 실제 보관 폴더에 이런 파일이 528개 있었다(꼬리 1~1,078바이트, 프레임 매직으로 시작하는 꼬리 0개) — 첫 프레임이
   * 대화 전부다. 잘린 파일을 막는 검사가 이 파일들까지 읽기 오류로 만들어 verify 가 528개를 읽을 수 없는 파일로
   * 나열했고, rebuild 는 그 대화의 행을 되살릴 수 없는 행으로 셌다.
   */
  describe('온전한 프레임 뒤에 꼬리 바이트가 붙은 파일은 잘린 파일이 아니다', () => {
    const appendTail = (file: string, tail: Buffer) => fs.appendFileSync(file + '.zst', tail);
    /** verifyIndex 를 돌리며 그동안 찍힌 줄을 모은다. */
    async function verifyAndCapture() {
      const { verifyIndex } = await import('../src/verify.js');
      const printed: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')); });
      try {
        return { issues: await verifyIndex(), printed };
      } finally {
        log.mockRestore();
      }
    }
    const tailLines = (printed: string[]) => printed.filter((l) => /after their last complete zstd frame/.test(l));

    it('parseGuarded 는 온전한 프레임까지 읽는다(턴 전부)', async () => {
      const { parseGuarded } = await import('../src/conversation-guard.js');
      const { file, turns } = await archiveAndIndex('tail.jsonl', bigConversation(120));
      appendTail(file, Buffer.from([0xde, 0xbf, 0x15, 0xa2, 0x07]));
      const parsed = await parseGuarded(file, 'proj', file);
      expect(parsed.exchanges.length).toBe(turns);
    });

    it('verify 는 읽을 수 없는 파일로 세지 않고 꼬리 바이트 파일로 따로 한 줄 알린다; repair 는 색인을 건드리지 않는다', async () => {
      const { repairIndex } = await import('../src/verify.js');
      const five = await archiveAndIndex('five.jsonl', bigConversation(120));
      const one = await archiveAndIndex('one.jsonl', bigConversation(4));
      const fine = await archiveAndIndex('fine.jsonl', bigConversation(3));
      appendTail(five.file, Buffer.from([0xde, 0xbf, 0x15, 0xa2, 0x07]));
      appendTail(one.file, Buffer.from([0x1c]));
      const before = state();

      const { issues, printed } = await verifyAndCapture();

      expect(issues.corrupted).toEqual([]);
      expect(issues.outdated).toEqual([]);
      expect(issues.notIndexed).toEqual([]);
      expect(issues.orphaned).toEqual([]);
      expect([...issues.trailingBytes].sort((a, b) => a.bytes - b.bytes)).toEqual([
        { path: one.file, bytes: 1 },
        { path: five.file, bytes: 5 },
      ]);
      // 한 줄: 파일 수와 꼬리 길이 범위
      expect(tailLines(printed)).toHaveLength(1);
      expect(tailLines(printed)[0]).toMatch(/: 2 \(1 to 5 bytes each\)/);

      const outcome = await repairIndex(issues, { noSummaries: true });
      expect(outcome.reindexedFiles).toBe(0);
      expect(outcome.failed).toEqual([]);
      expect(state()).toBe(before);
      expect(rowsOf(five.file)).toBe(120);
      expect(rowsOf(fine.file)).toBe(3);
    });

    it('꼬리 바이트 파일이 없으면 그 줄을 찍지 않는다', async () => {
      await archiveAndIndex('fine.jsonl', bigConversation(3));
      const { issues, printed } = await verifyAndCapture();
      expect(issues.trailingBytes).toEqual([]);
      expect(tailLines(printed)).toEqual([]);
    });

    it('온전한 프레임 뒤에 매직으로 시작하는 미완 프레임이 붙은 파일은 여전히 읽을 수 없는 파일이다', async () => {
      const cut = await archiveAndIndex('unfinished.jsonl', bigConversation(6));
      const next = zstdCompressSync!(Buffer.from(bigConversation(2), 'utf-8'));
      appendTail(cut.file, next.subarray(0, Math.floor(next.length / 2)));
      const { issues, printed } = await verifyAndCapture();
      expect(issues.corrupted.map((c) => c.path)).toEqual([cut.file]);
      expect(issues.corrupted[0].error).toMatch(/incomplete/);
      expect(issues.trailingBytes).toEqual([]);
      expect(tailLines(printed)).toEqual([]);
    });

    it('rebuild 는 꼬리 바이트 파일의 행을 되살릴 수 있는 행으로 보고, 거부하지 않고 다시 색인한다', async () => {
      const { rebuildConversationIndex } = await import('../src/rebuild.js');
      const tail = await archiveAndIndex('tail.jsonl', bigConversation(12));
      const fine = await archiveAndIndex('fine.jsonl', bigConversation(3));
      appendTail(tail.file, Buffer.from([0x7f, 0x2b, 0x44, 0x01, 0x00, 0x09]));

      const result = await rebuildConversationIndex({ yes: true });

      expect(result.reach.unreadable).toEqual({ exchanges: 0, files: 0 });
      expect(result.reach.unreachable).toEqual({ exchanges: 0, files: 0 });
      expect(result.lostExchangesBackupPath).toBeNull();
      expect(result.reindex.failed).toEqual([]);
      expect(rowsOf(tail.file)).toBe(12);
      expect(rowsOf(fine.file)).toBe(3);
    });
  });
});
