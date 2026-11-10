import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as zlib from 'node:zlib';
import { readArchiveFile, readArchiveLineRange } from '../src/archive-io.js';
import {
  readConversationRange,
  formatConversationAsMarkdown,
  READ_MAX_OUTPUT_CHARS,
  READ_MAX_BLOCK_CHARS,
} from '../src/show.js';

const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined =
  (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

function userLine(i: number, text: string): string {
  return JSON.stringify({ uuid: `u${i}`, parentUuid: null, timestamp: ts(i), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: text } });
}
function assistantLine(i: number, text: string): string {
  return JSON.stringify({ uuid: `a${i}`, parentUuid: `u${i}`, timestamp: ts(i), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

/** `pairs` user/assistant pairs: line 2k-1 is user k, line 2k is assistant k. */
function conversation(pairs: number, bodyChars = 0): string {
  const lines: string[] = [];
  for (let k = 1; k <= pairs; k++) {
    lines.push(userLine(k, `question-${k} ${'q'.repeat(bodyChars)}`));
    lines.push(assistantLine(k, `answer-${k} ${'a'.repeat(bodyChars)}`));
  }
  return lines.join('\n') + '\n';
}

// SQ-04 — `read` loaded the whole file into one string before slicing the range: files over
// 512MB failed (ERR_STRING_TOO_LONG), a 23-line range of a 346MB file took 1GB of RSS, the
// output had no ceiling, and a range outside the file returned an empty string.
describe('readArchiveLineRange', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-range-')); });
  afterEach(() => {
    delete process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the requested lines, numbered like the parser (1-indexed physical lines)', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, ['L1', 'L2', '', 'L4', 'L5', 'L6'].join('\n') + '\n');
    const range = await readArchiveLineRange(file, { startLine: 2, endLine: 4 });
    expect(range.lines).toEqual([{ line: 2, text: 'L2' }, { line: 3, text: '' }, { line: 4, text: 'L4' }]);
    expect(range.stoppedEarly).toBe(false);
  });

  it('reads to the end and reports the total when no end is given', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, 'L1\nL2\nL3\n');
    const range = await readArchiveLineRange(file, { startLine: 2 });
    expect(range.lines.map((l) => l.line)).toEqual([2, 3]);
    expect(range.totalLines).toBe(3);
  });

  it('a range past the end returns no lines and the total line count', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, 'L1\nL2\nL3\n');
    const range = await readArchiveLineRange(file, { startLine: 10, endLine: 20 });
    expect(range.lines).toEqual([]);
    expect(range.totalLines).toBe(3);
  });

  it('returns `lookahead` extra lines after endLine', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, 'L1\nL2\nL3\nL4\nL5\n');
    const range = await readArchiveLineRange(file, { startLine: 1, endLine: 2, lookahead: 2 });
    expect(range.lines.map((l) => l.line)).toEqual([1, 2, 3, 4]);
  });

  it('stops collecting once maxChars is reached, after at least one line', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100)].join('\n') + '\n');
    const one = await readArchiveLineRange(file, { maxChars: 10 });
    expect(one.lines.map((l) => l.line)).toEqual([1]);
    expect(one.stoppedEarly).toBe(true);
    const two = await readArchiveLineRange(file, { maxChars: 150 });
    expect(two.lines.map((l) => l.line)).toEqual([1, 2]);
    expect(two.stoppedEarly).toBe(true);
  });

  it('rejects for a missing file', async () => {
    await expect(readArchiveLineRange(join(dir, 'missing.jsonl'), { startLine: 1, endLine: 2 })).rejects.toThrow(/ENOENT/);
  });

  it.runIf(hasZstd)('reads a range of a .zst archive through the canonical .jsonl path', async () => {
    const file = join(dir, 'z.jsonl');
    writeFileSync(file + '.zst', zstdCompressSync!(Buffer.from('L1\nL2\nL3\nL4\n', 'utf-8')));
    const range = await readArchiveLineRange(file, { startLine: 2, endLine: 3 });
    expect(range.lines).toEqual([{ line: 2, text: 'L2' }, { line: 3, text: 'L3' }]);
  });

  // The whole-file path cannot open this file at all; the range path never reads past what it needs.
  it.runIf(hasZstd)('reads the head of an archive the whole-file reader refuses (never materializes the file)', async () => {
    const file = join(dir, 'big.jsonl');
    const lines = Array.from({ length: 40_000 }, (_, i) => `line-${i + 1} ${'x'.repeat(100)}`);
    writeFileSync(file + '.zst', zstdCompressSync!(Buffer.from(lines.join('\n') + '\n', 'utf-8'))); // ~4.4MB decompressed
    process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES = String(1024 * 1024);

    expect(() => readArchiveFile(file)).toThrow();
    const head = await readArchiveLineRange(file, { startLine: 3, endLine: 5 });
    expect(head.lines.map((l) => l.text.split(' ')[0])).toEqual(['line-3', 'line-4', 'line-5']);
    // A range that lies beyond the decompression cap fails loudly — never an empty or partial result.
    await expect(readArchiveLineRange(file, { startLine: 39_000, endLine: 39_010 })).rejects.toThrow(/byte limit/);
  });
});

describe('readConversationRange (the `read` tool)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-tool-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('renders a small conversation exactly like the whole-file formatter', async () => {
    const file = join(dir, 'c.jsonl');
    const jsonl = conversation(3);
    writeFileSync(file, jsonl);
    expect(await readConversationRange(file)).toBe(formatConversationAsMarkdown(jsonl));
  });

  it('renders only the requested range', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, conversation(5));
    const text = await readConversationRange(file, { startLine: 3, endLine: 4 });
    expect(text).toContain('question-2');
    expect(text).toContain('answer-2');
    expect(text).not.toContain('question-1');
    expect(text).not.toContain('question-3');
    expect(text).not.toMatch(/truncated/i);
  });

  it('a range outside the file is an error that names the total line count', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, conversation(5));
    await expect(readConversationRange(file, { startLine: 999, endLine: 1010 })).rejects.toThrow(/outside the file.*10 lines/);
  });

  it('startLine after endLine is an error', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, conversation(5));
    await expect(readConversationRange(file, { startLine: 8, endLine: 3 })).rejects.toThrow(/startLine 8 is after endLine 3/);
  });

  it('an empty file is an error, not an empty string', async () => {
    const file = join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    await expect(readConversationRange(file)).rejects.toThrow(/0 lines/);
  });

  it('a range with no user/assistant message says so', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, [JSON.stringify({ type: 'system', timestamp: ts(1) }), userLine(2, 'hello there'), assistantLine(2, 'hi')].join('\n') + '\n');
    expect(await readConversationRange(file, { startLine: 1, endLine: 1 })).toMatch(/No user or assistant messages in lines 1-1/);
  });

  it('caps the output and pages without a gap or an overlap', async () => {
    const file = join(dir, 'long.jsonl');
    const pairs = 120;
    writeFileSync(file, conversation(pairs, 1500)); // ~3,000 chars per pair → ~360,000 chars rendered

    expect(READ_MAX_OUTPUT_CHARS).toBe(40_000);
    const seenQuestions: number[] = [];
    let startLine: number | undefined;
    let pages = 0;
    for (;;) {
      const text = await readConversationRange(file, { startLine });
      pages++;
      expect(text.length).toBeLessThanOrEqual(READ_MAX_OUTPUT_CHARS + 400); // + the truncation footer
      for (const m of text.matchAll(/question-(\d+) /g)) seenQuestions.push(Number(m[1]));
      const next = text.match(/Output truncated[^\n]*startLine=(\d+)/);
      if (!next) break;
      expect(Number(next[1])).toBeGreaterThan(startLine ?? 0);
      startLine = Number(next[1]);
    }
    expect(pages).toBeGreaterThan(5);
    expect(seenQuestions).toEqual(Array.from({ length: pairs }, (_, i) => i + 1));
  });

  it('a truncated page keeps the requested endLine in its continuation hint', async () => {
    const file = join(dir, 'long.jsonl');
    writeFileSync(file, conversation(60, 1500));
    const text = await readConversationRange(file, { startLine: 1, endLine: 100 });
    expect(text).toMatch(/Output truncated[^\n]*startLine=\d+, endLine=100/);
  });

  it('a single message larger than the whole budget is clipped and the next page moves past it', async () => {
    const file = join(dir, 'huge.jsonl');
    writeFileSync(file, [userLine(1, 'H'.repeat(200_000)), assistantLine(1, 'after-the-huge-one')].join('\n') + '\n');
    const first = await readConversationRange(file);
    expect(first.length).toBeLessThanOrEqual(READ_MAX_OUTPUT_CHARS + 400);
    expect(first).toMatch(/message clipped/);
    expect(first).toMatch(/startLine=2/);
    expect(await readConversationRange(file, { startLine: 2 })).toContain('after-the-huge-one');
  });

  it('clips one oversized tool result instead of spending the page on it', async () => {
    const file = join(dir, 'tool.jsonl');
    const toolUse = JSON.stringify({ uuid: 'a1', timestamp: ts(2), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat big.log' } }] } });
    const toolResult = JSON.stringify({ uuid: 'u2', timestamp: ts(3), type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'R'.repeat(30_000) }] } });
    writeFileSync(file, [userLine(1, 'run it'), toolUse, toolResult, assistantLine(4, 'done-marker')].join('\n') + '\n');

    const text = await readConversationRange(file);
    expect(text).toContain('**Result:**');
    expect(text).toMatch(new RegExp(`R{${READ_MAX_BLOCK_CHARS}}\\n…\\[\\+28000 chars not shown\\]`));
    expect(text).not.toMatch(new RegExp(`R{${READ_MAX_BLOCK_CHARS + 1}}`));
    expect(text).toContain('done-marker');
  });

  it('pairs a tool call at the end of the range with its result just past it', async () => {
    const file = join(dir, 'tool.jsonl');
    const toolUse = JSON.stringify({ uuid: 'a1', timestamp: ts(2), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } });
    const toolResult = JSON.stringify({ uuid: 'u2', timestamp: ts(3), type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result-just-past-the-range' }] } });
    writeFileSync(file, [userLine(1, 'run it'), toolUse, toolResult, assistantLine(4, 'beyond-the-range')].join('\n') + '\n');

    const text = await readConversationRange(file, { startLine: 1, endLine: 2 });
    expect(text).toContain('result-just-past-the-range');
    expect(text).not.toContain('beyond-the-range');
  });
});
