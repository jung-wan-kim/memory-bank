import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as zlib from 'node:zlib';
import readline from 'readline';
import {
  canonicalArchiveName,
  resolveArchiveFile,
  archiveFileExists,
  readArchiveFile,
  createArchiveReadStream,
  statArchiveFile,
  isSummaryFileName,
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
