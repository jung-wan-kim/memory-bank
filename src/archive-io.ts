import fs from 'fs';
import { Readable, Transform, pipeline } from 'stream';
import * as zlib from 'node:zlib';

/**
 * Transparent access to archived conversation files.
 *
 * The conversation archive may be compressed out-of-band (an external job
 * rewrites `*.jsonl` → `*.jsonl.zst` to save disk). The database keeps the
 * canonical `.jsonl` paths, so every read path must resolve either variant.
 * Node >= 22.15 ships zstd support in node:zlib — no extra dependency.
 */

const ZST_SUFFIX = '.zst';

/**
 * Cap for decompressed archive bytes — a hostile high-ratio `.zst` file
 * ("compression bomb") must not be able to exhaust process memory. Real
 * conversation files decompress to a few MB. Reads fail loudly when exceeded.
 * Override (mainly for tests): MEMORY_BANK_MAX_DECOMPRESSED_BYTES.
 */
const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MiB

function maxDecompressedBytes(): number {
  const parsed = parseInt(process.env.MEMORY_BANK_MAX_DECOMPRESSED_BYTES || '', 10);
  // Only allow tightening — raising the cap would defeat the bomb protection.
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= DEFAULT_MAX_DECOMPRESSED_BYTES) {
    return parsed;
  }
  return DEFAULT_MAX_DECOMPRESSED_BYTES;
}

// Optional access: older Node runtimes don't ship zstd in node:zlib.
const zstd: {
  zstdDecompressSync?: (buf: Buffer, opts?: { maxOutputLength?: number }) => Buffer;
  createZstdDecompress?: (opts?: { maxOutputLength?: number }) => import('node:stream').Transform;
} = zlib;

/** Strip a trailing `.zst` so archive filenames compare in canonical form. */
export function canonicalArchiveName(fileName: string): string {
  return fileName.endsWith(ZST_SUFFIX) ? fileName.slice(0, -ZST_SUFFIX.length) : fileName;
}

/**
 * Resolve the on-disk file for an archive path, trying both the plain and
 * `.zst`-compressed variants. When both exist the NEWER one wins (an active
 * session may have re-synced a plain copy after compression, or the
 * compressor may have refreshed the `.zst` after a stale plain copy).
 * Returns null when neither exists.
 */
export function resolveArchiveFile(filePath: string): string | null {
  const variant = filePath.endsWith(ZST_SUFFIX)
    ? filePath.slice(0, -ZST_SUFFIX.length)
    : filePath + ZST_SUFFIX;

  const statOrNull = (p: string): fs.Stats | null => {
    try { return fs.statSync(p); } catch { return null; }
  };
  const primary = statOrNull(filePath);
  const secondary = statOrNull(variant);

  if (primary && secondary) {
    // Never pick a compressed variant this runtime cannot decompress —
    // a readable (possibly staler) plain copy beats an unreadable newer one.
    const winner = secondary.mtimeMs > primary.mtimeMs ? variant : filePath;
    if (winner.endsWith(ZST_SUFFIX) && !zstd.zstdDecompressSync) {
      return winner === filePath ? variant : filePath;
    }
    return winner;
  }
  if (primary) return filePath;
  if (secondary) return variant;
  return null;
}

/** Whether a file name is a conversation summary, plain or compressed. */
export function isSummaryFileName(fileName: string): boolean {
  return canonicalArchiveName(fileName).endsWith('-summary.txt');
}

/** Remove an archive file in both its plain and compressed forms (either may be absent). */
export function removeArchiveFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
  fs.rmSync(filePath + ZST_SUFFIX, { force: true });
}

/** Whether an archive file exists in either plain or compressed form. */
export function archiveFileExists(filePath: string): boolean {
  return resolveArchiveFile(filePath) !== null;
}

/** Pass-through Transform that aborts once total bytes exceed the cap. */
function createByteLimit(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error(`Decompressed archive exceeds ${maxBytes} byte limit`));
        return;
      }
      callback(null, chunk);
    },
  });
}

function requireZstdSync(): (buf: Buffer) => Buffer {
  const decompress = zstd.zstdDecompressSync;
  if (!decompress) {
    throw new Error(
      'Archive file is zstd-compressed but this Node runtime has no zstd support (need Node >= 22.15)',
    );
  }
  return (buf: Buffer) => decompress(buf, { maxOutputLength: maxDecompressedBytes() });
}

/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export function readArchiveFile(filePath: string): string {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) {
    throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' });
  }
  const buf = fs.readFileSync(resolved);
  if (resolved.endsWith(ZST_SUFFIX)) {
    return requireZstdSync()(buf).toString('utf-8');
  }
  return buf.toString('utf-8');
}

/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface.
 */
export function createArchiveReadStream(filePath: string): Readable {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) {
    // Match fs.createReadStream semantics: surface ENOENT to stream consumers.
    return fs.createReadStream(filePath);
  }
  if (resolved.endsWith(ZST_SUFFIX)) {
    if (zstd.createZstdDecompress) {
      // pipeline() propagates source errors (e.g. the file being swapped by
      // the external compressor between resolve and open) to the returned
      // stream — bare .pipe() would leave them unhandled and crash.
      // The byte limiter enforces the same decompression-bomb cap as the
      // sync path (stream constructors ignore maxOutputLength).
      const source = fs.createReadStream(resolved);
      const decompress = zstd.createZstdDecompress();
      const limiter = createByteLimit(maxDecompressedBytes());
      pipeline(source, decompress, limiter, () => { /* error surfaces on the returned stream */ });
      return limiter;
    }
    // Fallback: decompress in memory (capped via maxOutputLength)
    const content = requireZstdSync()(fs.readFileSync(resolved));
    return Readable.from([content]);
  }
  return fs.createReadStream(resolved);
}

/** stat() the resolved archive file (plain or compressed), null if missing. */
export function statArchiveFile(filePath: string): fs.Stats | null {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) return null;
  try {
    return fs.statSync(resolved);
  } catch {
    return null;
  }
}
