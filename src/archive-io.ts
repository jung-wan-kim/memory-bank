import fs from 'fs';
import path from 'path';
import { Readable, Transform, pipeline } from 'stream';
import * as zlib from 'node:zlib';
import readline from 'readline';

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

/**
 * Delete every summary, plain or compressed, under the archive's project dirs
 * (rebuild). Returns how many were removed.
 */
export function removeAllSummaries(archiveDir: string): number {
  let removed = 0;
  if (!fs.existsSync(archiveDir)) return removed;
  for (const project of fs.readdirSync(archiveDir)) {
    const projectPath = path.join(archiveDir, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    // A compressed summary left behind still counts as "has a summary", and
    // the conversation would never be summarized again.
    for (const name of fs.readdirSync(projectPath).filter(isSummaryFileName)) {
      fs.unlinkSync(path.join(projectPath, name));
      removed++;
    }
  }
  return removed;
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

/**
 * Where the zstd frames of a `.zst` file lie, and what is wrong with it.
 *
 * Node's decoder (22.x) does not tell: handed an input that ends inside a
 * frame it returns what it had decoded — nothing, or the first blocks — with no
 * error, and it stops after the first frame whatever follows. A compressor
 * interrupted while writing leaves exactly such a file, and it read as a
 * shorter conversation: verify called it healthy, a repair replaced the full
 * index rows with the head, a rebuild cleared its rows and re-created none.
 * So the frame structure is walked here (headers only, nothing is
 * decompressed — RFC 8878 §3.1), every complete frame is decoded on its own,
 * and a frame that begins but does not end is a read error.
 *
 * One thing after the frames is not an error: bytes that follow a complete
 * frame and are not the start of another one (`trailingBytes`). A cut file
 * never looks like that — what a compressor was interrupted on is the head of
 * a frame, and it begins with the frame magic. Real archives hold such files
 * (measured on one: 528 of 228,765, tails of 1 to 1,078 bytes, none beginning
 * like a frame; the frame before the tail held the whole conversation, every
 * line of it JSON). Treating them as cut made verify list 528 unreadable files
 * and `read` fail on 409 conversations that every earlier version had read.
 * They are read up to their last complete frame — as the decoder alone did —
 * and the tail is reported (archiveTrailingBytes), not dropped unseen.
 */
interface ZstdLayout {
  /** Byte ranges [start, end) of the complete zstd frames, in file order. */
  frames: Array<{ start: number; end: number }>;
  /** Start of a frame that begins but does not end, when the file stops inside one. */
  cutFrameAt: number | null;
  /** Why the file cannot be read as its frames — null when it can. */
  problem: string | null;
  /**
   * Bytes after the last complete frame that are no frame and no beginning of
   * one (0 = none). Only ever set with at least one complete frame and no
   * `problem`: the frames are the file's content, these bytes are not read.
   */
  trailingBytes: number;
}

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50; // 0x184D2A50..5F: a frame a decoder skips
/** The two magics as they lie in the file (little-endian); a skippable frame's first byte is 0x50..0x5F. */
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_SKIPPABLE_MAGIC_BYTES = [0x50, 0x2a, 0x4d, 0x18];

/**
 * Whether these bytes (the first 1-4 after a frame) are a frame magic or the
 * first bytes of one — i.e. whether what follows could be a frame that was
 * being written when the file ended.
 */
function beginsLikeFrame(head: Buffer): boolean {
  if (head.length === 0) return false;
  const isPrefixOf = (magic: number[], firstByteMask: number): boolean => {
    for (let i = 0; i < head.length && i < 4; i++) {
      if ((i === 0 ? head[i] & firstByteMask : head[i]) !== magic[i]) return false;
    }
    return true;
  };
  return isPrefixOf(ZSTD_MAGIC_BYTES, 0xff) || isPrefixOf(ZSTD_SKIPPABLE_MAGIC_BYTES, 0xf0);
}

function zstdLayout(size: number, read: (position: number, length: number) => Buffer): ZstdLayout {
  const layout: ZstdLayout = { frames: [], cutFrameAt: null, problem: null, trailingBytes: 0 };
  // Exactly `length` bytes at `position`, or null when the file ends before that.
  const take = (position: number, length: number): Buffer | null => {
    if (position + length > size) return null;
    const bytes = read(position, length);
    return bytes.length === length ? bytes : null;
  };
  if (size === 0) {
    layout.problem = 'the file is empty';
    return layout;
  }
  let pos = 0;
  while (pos < size) {
    const start = pos;
    const cut = (where: string): ZstdLayout => {
      layout.cutFrameAt = start;
      layout.problem = `it ends inside ${where} (frame ${layout.frames.length + 1} starts at byte ${start} of ${size})`;
      return layout;
    };
    if (layout.frames.length > 0) {
      // After a complete frame: another frame (whole or cut — walked below), or bytes that are none.
      const wanted = Math.min(4, size - pos);
      const head = read(pos, wanted);
      if (head.length === wanted && !beginsLikeFrame(head)) {
        layout.trailingBytes = size - start;
        return layout;
      }
    }
    const magic = take(pos, 4);
    if (!magic) return cut('a frame header');
    const magicNumber = magic.readUInt32LE(0);
    if ((magicNumber & 0xfffffff0) === ZSTD_SKIPPABLE_MAGIC) {
      const length = take(pos + 4, 4);
      if (!length) return cut('a skippable frame');
      pos += 8 + length.readUInt32LE(0);
      if (pos > size) return cut('a skippable frame');
      continue; // holds no conversation bytes
    }
    if (magicNumber !== ZSTD_MAGIC) {
      // Reached only with no complete zstd frame so far (after one, such bytes are `trailingBytes`):
      // the file holds no conversation frame at all, at most skippable ones.
      layout.problem = start === 0
        ? 'it does not start with a zstd frame'
        : `${size - start} byte(s) after its last complete frame are not a zstd frame`;
      // Not a frame at all: the decoder gets the bytes and reports them its own way.
      if (start === 0) layout.cutFrameAt = 0;
      return layout;
    }
    const descriptor = take(pos + 4, 1);
    if (!descriptor) return cut('a frame header');
    const contentSizeFlag = descriptor[0] >> 6;
    const singleSegment = (descriptor[0] >> 5) & 1;
    const hasChecksum = (descriptor[0] >> 2) & 1;
    const dictionaryIdFlag = descriptor[0] & 3;
    pos += 5
      + (singleSegment ? 0 : 1)                                           // Window_Descriptor
      + [0, 1, 2, 4][dictionaryIdFlag]                                    // Dictionary_ID
      + (contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag]); // Frame_Content_Size
    if (pos > size) return cut('a frame header');
    for (;;) {
      const blockHeader = take(pos, 3);
      if (!blockHeader) return cut('a frame, before its last block');
      const header = blockHeader[0] | (blockHeader[1] << 8) | (blockHeader[2] << 16);
      const blockType = (header >> 1) & 3;
      // Raw and compressed blocks carry Block_Size bytes; an RLE block carries one. Type 3 is reserved —
      // the decoder rejects it; here it is walked like a compressed block so the frame's end is still found.
      pos += 3 + (blockType === 1 ? 1 : header >> 3);
      if (pos > size) return cut('a block');
      if (header & 1) break; // Last_Block
    }
    if (hasChecksum) {
      pos += 4;
      if (pos > size) return cut('a frame checksum');
    }
    layout.frames.push({ start, end: pos });
  }
  return layout;
}

function incompleteZstdError(filePath: string, problem: string): Error {
  return new Error(`zstd archive is incomplete — ${problem}: ${filePath}`);
}

function requireZstdSync(): (buf: Buffer, filePath: string) => Buffer {
  const decompress = zstd.zstdDecompressSync;
  if (!decompress) {
    throw new Error(
      'Archive file is zstd-compressed but this Node runtime has no zstd support (need Node >= 22.15)',
    );
  }
  return (buf: Buffer, filePath: string) => {
    const layout = zstdLayout(buf.length, (position, length) => buf.subarray(position, position + length));
    // Bytes that are no frame at all go to the decoder, which names what it found.
    if (layout.problem && layout.cutFrameAt === 0 && layout.frames.length === 0 && buf.length >= 4
      && buf.readUInt32LE(0) !== ZSTD_MAGIC) {
      decompress(buf, { maxOutputLength: maxDecompressedBytes() });
    }
    if (layout.problem) throw incompleteZstdError(filePath, layout.problem);
    const cap = maxDecompressedBytes();
    const parts: Buffer[] = [];
    let total = 0;
    for (const frame of layout.frames) {
      if (total >= cap) throw new Error(`Decompressed archive exceeds ${cap} byte limit`);
      const part = decompress(buf.subarray(frame.start, frame.end), { maxOutputLength: cap - total });
      parts.push(part);
      total += part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
}

/** zstdLayout of a file on disk (reads the frame and block headers only). */
function zstdLayoutOfFile(filePath: string): ZstdLayout {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    return zstdLayout(size, (position, length) => {
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, position));
    });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * How many bytes follow the last complete zstd frame of an archive file
 * without being a frame or the beginning of one — bytes no reader returns
 * (see ZstdLayout). 0 for a `.zst` that is exactly its frames, for a plain
 * file, for a missing file, and for a `.zst` that is a read error (that one
 * is reported by the read itself). Reads the frame and block headers only.
 */
export function archiveTrailingBytes(filePath: string): number {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved || !resolved.endsWith(ZST_SUFFIX)) return 0;
  return zstdLayoutOfFile(resolved).trailingBytes;
}

/**
 * The decompressed bytes of a `.zst` file, frame after frame. What a damaged
 * file still holds is yielded first — a caller reading a line range inside it
 * gets its lines — and then the read fails: a consumer that reads to the end
 * never takes the head for the whole file.
 */
async function* decompressedZstdChunks(resolved: string): AsyncGenerator<Buffer> {
  const layout = zstdLayoutOfFile(resolved);
  const size = fs.statSync(resolved).size;
  const ranges = layout.cutFrameAt === null ? layout.frames : [...layout.frames, { start: layout.cutFrameAt, end: size }];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    // pipeline() carries a source error (the file swapped by the external
    // compressor between resolve and open) and a decoder error to the iterator.
    const decoded = pipeline(
      fs.createReadStream(resolved, { start: range.start, end: range.end - 1 }),
      zstd.createZstdDecompress!(),
      () => { /* the error surfaces on the iterator */ },
    );
    for await (const chunk of decoded) yield chunk as Buffer;
  }
  if (layout.problem) throw incompleteZstdError(resolved, layout.problem);
}

/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export function readArchiveFile(filePath: string): string {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) {
    throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' });
  }
  const buf = fs.readFileSync(resolved);
  if (resolved.endsWith(ZST_SUFFIX)) {
    return requireZstdSync()(buf, resolved).toString('utf-8');
  }
  return buf.toString('utf-8');
}

/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface. A `.zst` that ends
 * inside a frame (or holds no frame) ends in an 'error', after the bytes it
 * does hold; bytes after its last complete frame that begin no frame are not
 * read and are no error (archiveTrailingBytes counts them).
 */
export function createArchiveReadStream(filePath: string): Readable {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) {
    // Match fs.createReadStream semantics: surface ENOENT to stream consumers.
    return fs.createReadStream(filePath);
  }
  if (resolved.endsWith(ZST_SUFFIX)) {
    if (zstd.createZstdDecompress) {
      // pipeline() propagates errors to the returned stream — bare .pipe()
      // would leave them unhandled and crash. The byte limiter enforces the
      // same decompression-bomb cap as the sync path, over all frames together
      // (stream constructors ignore maxOutputLength).
      const limiter = createByteLimit(maxDecompressedBytes());
      pipeline(Readable.from(decompressedZstdChunks(resolved), { objectMode: false }), limiter,
        () => { /* error surfaces on the returned stream */ });
      return limiter;
    }
    // Fallback: decompress in memory (capped via maxOutputLength)
    const content = requireZstdSync()(fs.readFileSync(resolved), resolved);
    return Readable.from([content]);
  }
  return fs.createReadStream(resolved);
}

export interface ArchiveLineRange {
  /** The requested lines, each with its 1-indexed physical line number (the numbering parser.ts records). */
  lines: Array<{ line: number; text: string }>;
  /** Lines in the whole file — known only when the stream was read to its end, otherwise null. */
  totalLines: number | null;
  /** Collection stopped before the requested end because `maxChars` was reached. */
  stoppedEarly: boolean;
}

/**
 * Read lines `startLine`..`endLine` (1-indexed, inclusive, plus `lookahead` more) of an archive file as a
 * stream, plain or `.zst`. Only the requested lines are kept and the stream is closed as soon as the last one
 * is seen, so the cost follows the range and not the file: a file larger than a JS string can hold
 * (readArchiveFile fails on those) is readable, and so is the head of a `.zst` whose full size is over the
 * decompression cap. `maxChars` bounds what is collected (at least one line is always returned).
 * A stream error — missing file, decompression cap, bad or incomplete zstd frame — rejects; it never yields a
 * short result. (A range that ends before the damaged part of a `.zst` is still read: the stream is closed there.)
 */
export function readArchiveLineRange(
  filePath: string,
  opts: { startLine?: number; endLine?: number; lookahead?: number; maxChars?: number } = {},
): Promise<ArchiveLineRange> {
  const startLine = opts.startLine ?? 1;
  const lastWanted = opts.endLine === undefined ? Infinity : opts.endLine + (opts.lookahead ?? 0);
  const maxChars = opts.maxChars ?? Infinity;

  return new Promise((resolve, reject) => {
    const stream = createArchiveReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines: ArchiveLineRange['lines'] = [];
    let lineNumber = 0;
    let chars = 0;
    let settled = false;

    const settle = (error: Error | null, result?: ArchiveLineRange): void => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      if (error) reject(error);
      else resolve(result!);
    };

    // The listener stays attached after settling: the decompressor may still fail on bytes it had already
    // buffered when the range ended, and an 'error' event with no listener would take the process down.
    stream.on('error', (error) => settle(error));
    // readline re-emits an input error on the interface; with no listener there it is thrown as uncaught.
    rl.on('error', (error) => settle(error as Error));
    rl.on('line', (text) => {
      if (settled) return; // readline can emit already-buffered lines after close()
      lineNumber++;
      if (lineNumber < startLine) return;
      lines.push({ line: lineNumber, text });
      chars += text.length;
      if (lineNumber >= lastWanted) settle(null, { lines, totalLines: null, stoppedEarly: false });
      else if (chars >= maxChars) settle(null, { lines, totalLines: null, stoppedEarly: true });
    });
    rl.on('close', () => settle(null, { lines, totalLines: lineNumber, stoppedEarly: false }));
  });
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

/**
 * Read exactly this file as UTF-8 (decompressing a `.zst`), without choosing
 * between the plain and compressed variants again. For a caller that has
 * already resolved and checked the path (read-guard.ts): readArchiveFile()
 * would pick the newer variant by itself, which may be a file the caller never
 * checked.
 */
export function readResolvedArchiveFile(exactPath: string): string {
  const buf = fs.readFileSync(exactPath);
  if (exactPath.endsWith(ZST_SUFFIX)) {
    return requireZstdSync()(buf, exactPath).toString('utf-8');
  }
  return buf.toString('utf-8');
}
