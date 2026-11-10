import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import readline from 'readline';
import {
  canonicalArchiveName,
  resolveArchiveFile,
  archiveFileExists,
  readArchiveFile,
  readArchiveLineRange,
  readResolvedArchiveFile,
  createArchiveReadStream,
  statArchiveFile,
  isSummaryFileName,
  removeAllSummaries,
} from '../src/archive-io.js';

const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined =
  (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';

describe('archive-io', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-bank-archive-io-'));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('canonicalArchiveName', () => {
    it('strips trailing .zst', () => {
      expect(canonicalArchiveName('abc.jsonl.zst')).toBe('abc.jsonl');
      expect(canonicalArchiveName('abc.jsonl')).toBe('abc.jsonl');
      expect(canonicalArchiveName('abc-summary.txt.zst')).toBe('abc-summary.txt');
    });
  });

  // rebuild deletes summaries by this test; it once matched only the plain name,
  // and a compressed summary left behind kept the conversation from ever being
  // summarized again.
  describe('isSummaryFileName', () => {
    it('matches plain and compressed summaries, not conversations', () => {
      expect(isSummaryFileName('abc-summary.txt')).toBe(true);
      expect(isSummaryFileName('abc-summary.txt.zst')).toBe(true);
      expect(isSummaryFileName('abc.jsonl')).toBe(false);
      expect(isSummaryFileName('abc.jsonl.zst')).toBe(false);
      expect(isSummaryFileName('abc-summary.txt.bak')).toBe(false);
    });
  });

  describe('removeAllSummaries (rebuild)', () => {
    it('deletes plain and compressed summaries in every project dir, and nothing else', () => {
      const root = mkdtempSync(join(tmpdir(), 'mb-rebuild-'));
      try {
        const proj = join(root, '-p');
        mkdirSync(proj);
        for (const f of ['a-summary.txt', 'b-summary.txt.zst', 'a.jsonl', 'b.jsonl.zst', 'notes.txt']) writeFileSync(join(proj, f), 'x');
        writeFileSync(join(root, 'stray-summary.txt'), 'x'); // not in a project dir

        expect(removeAllSummaries(root)).toBe(2);
        expect(readdirSync(proj).sort()).toEqual(['a.jsonl', 'b.jsonl.zst', 'notes.txt']);
        expect(existsSync(join(root, 'stray-summary.txt'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('resolveArchiveFile', () => {
    it('returns the plain path when it exists', () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain, '{}');
      expect(resolveArchiveFile(plain)).toBe(plain);
    });

    it('falls back to the .zst variant', () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain + '.zst', 'compressed-bytes');
      expect(resolveArchiveFile(plain)).toBe(plain + '.zst');
    });

    it('resolves a .zst path to the plain variant when only plain exists', () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain, '{}');
      expect(resolveArchiveFile(plain + '.zst')).toBe(plain);
    });

    it('returns null when neither variant exists', () => {
      expect(resolveArchiveFile(join(testDir, 'missing.jsonl'))).toBeNull();
      expect(archiveFileExists(join(testDir, 'missing.jsonl'))).toBe(false);
    });

    it('prefers the newer variant when both exist', () => {
      const plain = join(testDir, 'conv.jsonl');
      const zst = plain + '.zst';
      writeFileSync(plain, 'old');
      writeFileSync(zst, 'new-compressed');
      const past = new Date(Date.now() - 60_000);
      const now = new Date();

      // zst newer → zst wins
      utimesSync(plain, past, past);
      utimesSync(zst, now, now);
      expect(resolveArchiveFile(plain)).toBe(zst);

      // plain newer → plain wins
      utimesSync(plain, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      expect(resolveArchiveFile(plain)).toBe(plain);
    });
  });

  describe('readArchiveFile', () => {
    it('reads plain files', () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain, 'line1\nline2');
      expect(readArchiveFile(plain)).toBe('line1\nline2');
    });

    it.runIf(hasZstd)('transparently decompresses .zst files', () => {
      const plain = join(testDir, 'conv.jsonl');
      const content = 'line1\nline2\n한국어 내용';
      writeFileSync(plain + '.zst', zstdCompressSync!(Buffer.from(content, 'utf-8')));
      // Read via the canonical .jsonl path — the .zst variant is resolved
      expect(readArchiveFile(plain)).toBe(content);
    });

    it('throws ENOENT-coded error for missing files', () => {
      try {
        readArchiveFile(join(testDir, 'missing.jsonl'));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });
  });

  describe('createArchiveReadStream', () => {
    async function readLines(filePath: string): Promise<string[]> {
      const rl = readline.createInterface({
        input: createArchiveReadStream(filePath),
        crlfDelay: Infinity,
      });
      const lines: string[] = [];
      for await (const line of rl) lines.push(line);
      return lines;
    }

    it('streams plain files line by line', async () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain, '{"a":1}\n{"b":2}\n');
      expect(await readLines(plain)).toEqual(['{"a":1}', '{"b":2}']);
    });

    it.runIf(hasZstd)('streams compressed files line by line', async () => {
      const plain = join(testDir, 'conv.jsonl');
      const content = '{"a":1}\n{"b":2}\n{"c":3}\n';
      writeFileSync(plain + '.zst', zstdCompressSync!(Buffer.from(content, 'utf-8')));
      expect(await readLines(plain)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });
  });

  describe('decompression bomb cap', () => {
    afterEach(() => {
      delete process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES;
    });

    it.runIf(hasZstd)('readArchiveFile rejects content beyond the byte cap', () => {
      const plain = join(testDir, 'bomb.jsonl');
      // 1KB of highly-compressible content, cap set to 64 bytes
      writeFileSync(plain + '.zst', zstdCompressSync!(Buffer.from('a'.repeat(1024), 'utf-8')));
      process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES = '64';
      expect(() => readArchiveFile(plain)).toThrow();
    });

    it.runIf(hasZstd)('createArchiveReadStream errors instead of streaming beyond the cap', async () => {
      const plain = join(testDir, 'bomb-stream.jsonl');
      writeFileSync(plain + '.zst', zstdCompressSync!(Buffer.from('b'.repeat(4096), 'utf-8')));
      process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES = '128';

      const rl = readline.createInterface({
        input: createArchiveReadStream(plain),
        crlfDelay: Infinity,
      });
      await expect((async () => {
        for await (const line of rl) void line;
      })()).rejects.toThrow(/byte limit/);
    });

    it.runIf(hasZstd)('content under the cap streams normally', async () => {
      const plain = join(testDir, 'small.jsonl');
      writeFileSync(plain + '.zst', zstdCompressSync!(Buffer.from('ok-line\n', 'utf-8')));
      process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES = '1024';
      const rl = readline.createInterface({
        input: createArchiveReadStream(plain),
        crlfDelay: Infinity,
      });
      const lines: string[] = [];
      for await (const line of rl) lines.push(line);
      expect(lines).toEqual(['ok-line']);
    });
  });

  // Node's zstd decoder does not report an input that ends inside a frame: it returns what it had decoded
  // (nothing, or the first blocks) as if that were the file. A compressor interrupted while writing leaves
  // exactly such a file, and every reader then took the head of a conversation for the whole of it.
  describe.runIf(hasZstd)('a .zst that is not complete zstd frames is a read error, never a shorter file', () => {
    // 600 lines of hex — incompressible enough to span several zstd blocks (a block holds at most 128KB).
    const LINES = Array.from({ length: 600 }, (_, i) => `{"line":${i + 1},"text":"${randomBytes(160).toString('hex')}"}`);
    const CONTENT = LINES.join('\n') + '\n';
    const whole = () => zstdCompressSync!(Buffer.from(CONTENT, 'utf-8'));

    async function drain(filePath: string): Promise<{ lines: string[]; error: Error | null }> {
      const lines: string[] = [];
      try {
        const rl = readline.createInterface({ input: createArchiveReadStream(filePath), crlfDelay: Infinity });
        for await (const line of rl) lines.push(line);
        return { lines, error: null };
      } catch (error) {
        return { lines, error: error as Error };
      }
    }
    const put = (name: string, bytes: Buffer): string => {
      const plain = join(testDir, name);
      writeFileSync(plain + '.zst', bytes);
      return plain;
    };

    it('the control: the complete file reads whole, as a stream and at once', async () => {
      const plain = put('whole.jsonl', whole());
      expect(await drain(plain)).toEqual({ lines: LINES, error: null });
      expect(readArchiveFile(plain)).toBe(CONTENT);
    });

    for (const [name, cut] of [
      ['its last 10 bytes missing', (b: Buffer) => b.subarray(0, b.length - 10)],
      ['its last byte missing', (b: Buffer) => b.subarray(0, b.length - 1)],
      ['cut at three quarters', (b: Buffer) => b.subarray(0, Math.floor(b.length * 0.75))],
      ['cut at 60 bytes', (b: Buffer) => b.subarray(0, 60)],
      ['cut inside the frame header', (b: Buffer) => b.subarray(0, 5)],
      ['zero bytes long', () => Buffer.alloc(0)],
    ] as Array<[string, (b: Buffer) => Buffer]>) {
      it(`a file with ${name}: the stream ends in an error and the whole-file read throws`, async () => {
        const plain = put('cut.jsonl', cut(whole()));
        const streamed = await drain(plain);
        expect(streamed.error?.message).toMatch(/incomplete/);
        expect(streamed.lines.length).toBeLessThan(LINES.length);
        expect(() => readArchiveFile(plain)).toThrow(/incomplete/);
        expect(() => readResolvedArchiveFile(plain + '.zst')).toThrow(/incomplete/);
      });
    }

    it('what a cut file still holds is delivered before the error, and a range inside it can be read', async () => {
      const plain = put('cut.jsonl', whole().subarray(0, Math.floor(whole().length * 0.75)));
      const streamed = await drain(plain);
      expect(streamed.error?.message).toMatch(/incomplete/);
      expect(streamed.lines.length).toBeGreaterThan(10);
      expect(streamed.lines.slice(0, 10)).toEqual(LINES.slice(0, 10));

      const head = await readArchiveLineRange(plain, { startLine: 2, endLine: 4 });
      expect(head.lines.map((l) => l.text)).toEqual(LINES.slice(1, 4));
      // a range that runs to the end of the file is not answered with the part that could be read
      await expect(readArchiveLineRange(plain, { startLine: 2 })).rejects.toThrow(/incomplete/);
      await expect(readArchiveLineRange(plain, { startLine: 590, endLine: 600 })).rejects.toThrow(/incomplete/);
    });

    it('bytes after the last complete frame are an error too (the decoder ignores them)', async () => {
      const plain = put('junk.jsonl', Buffer.concat([whole(), Buffer.from('not a frame')]));
      const streamed = await drain(plain);
      expect(streamed.error?.message).toMatch(/incomplete/);
      expect(streamed.lines).toEqual(LINES); // everything the complete frame holds, then the error
      expect(() => readArchiveFile(plain)).toThrow(/incomplete/);
    });

    it('a file of several frames is read to its last frame, and a cut in its last frame is an error', async () => {
      const second = ['{"line":"second frame, 1"}', '{"line":"second frame, 2"}'];
      const secondFrame = zstdCompressSync!(Buffer.from(second.join('\n') + '\n', 'utf-8'));
      const plain = put('two.jsonl', Buffer.concat([whole(), secondFrame]));
      expect(await drain(plain)).toEqual({ lines: [...LINES, ...second], error: null });
      expect(readArchiveFile(plain)).toBe(CONTENT + second.join('\n') + '\n');

      const cut = put('two-cut.jsonl', Buffer.concat([whole(), secondFrame.subarray(0, secondFrame.length - 3)]));
      const streamed = await drain(cut);
      expect(streamed.error?.message).toMatch(/incomplete/);
      expect(streamed.lines.slice(0, LINES.length)).toEqual(LINES);
      expect(() => readArchiveFile(cut)).toThrow(/incomplete/);
    });

    it('the decompression cap counts every frame together', async () => {
      const frame = zstdCompressSync!(Buffer.from('c'.repeat(600), 'utf-8'));
      const plain = put('frames-over-cap.jsonl', Buffer.concat([frame, frame]));
      process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES = '1000';
      try {
        expect((await drain(plain)).error?.message).toMatch(/byte limit/);
        expect(() => readArchiveFile(plain)).toThrow();
      } finally {
        delete process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES;
      }
    });

    it('corrupt bytes in the middle are still an error', async () => {
      const bytes = Buffer.from(whole());
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      const plain = put('flipped.jsonl', bytes);
      expect((await drain(plain)).error).not.toBeNull();
      expect(() => readArchiveFile(plain)).toThrow();
    });
  });

  describe('statArchiveFile', () => {
    it('stats the resolved variant', () => {
      const plain = join(testDir, 'conv.jsonl');
      writeFileSync(plain + '.zst', 'xxxx');
      const stats = statArchiveFile(plain);
      expect(stats).not.toBeNull();
      expect(stats!.size).toBe(4);
    });

    it('returns null for missing files', () => {
      expect(statArchiveFile(join(testDir, 'missing.jsonl'))).toBeNull();
    });
  });
});
