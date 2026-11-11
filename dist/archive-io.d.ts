import fs from 'fs';
import { Readable } from 'stream';
/** Strip a trailing `.zst` so archive filenames compare in canonical form. */
export declare function canonicalArchiveName(fileName: string): string;
/**
 * Resolve the on-disk file for an archive path, trying both the plain and
 * `.zst`-compressed variants. When both exist the NEWER one wins (an active
 * session may have re-synced a plain copy after compression, or the
 * compressor may have refreshed the `.zst` after a stale plain copy).
 * Returns null when neither exists.
 */
export declare function resolveArchiveFile(filePath: string): string | null;
/** Whether a file name is a conversation summary, plain or compressed. */
export declare function isSummaryFileName(fileName: string): boolean;
/**
 * Delete every summary, plain or compressed, under the archive's project dirs
 * (rebuild). Returns how many were removed.
 */
export declare function removeAllSummaries(archiveDir: string): number;
/** Remove an archive file in both its plain and compressed forms (either may be absent). */
export declare function removeArchiveFile(filePath: string): void;
/** Whether an archive file exists in either plain or compressed form. */
export declare function archiveFileExists(filePath: string): boolean;
/**
 * How many bytes follow the last complete zstd frame of an archive file
 * without being a frame or the beginning of one — bytes no reader returns
 * (see ZstdLayout). 0 for a `.zst` that is exactly its frames, for a plain
 * file, for a missing file, and for a `.zst` that is a read error (that one
 * is reported by the read itself). Reads the frame and block headers only.
 */
export declare function archiveTrailingBytes(filePath: string): number;
/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export declare function readArchiveFile(filePath: string): string;
/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface. A `.zst` that ends
 * inside a frame (or holds no frame) ends in an 'error', after the bytes it
 * does hold; bytes after its last complete frame that begin no frame are not
 * read and are no error (archiveTrailingBytes counts them).
 */
export declare function createArchiveReadStream(filePath: string): Readable;
export interface ArchiveLineRange {
    /** The requested lines, each with its 1-indexed physical line number (the numbering parser.ts records). */
    lines: Array<{
        line: number;
        text: string;
    }>;
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
export declare function readArchiveLineRange(filePath: string, opts?: {
    startLine?: number;
    endLine?: number;
    lookahead?: number;
    maxChars?: number;
}): Promise<ArchiveLineRange>;
/** stat() the resolved archive file (plain or compressed), null if missing. */
export declare function statArchiveFile(filePath: string): fs.Stats | null;
/**
 * Read exactly this file as UTF-8 (decompressing a `.zst`), without choosing
 * between the plain and compressed variants again. For a caller that has
 * already resolved and checked the path (read-guard.ts): readArchiveFile()
 * would pick the newer variant by itself, which may be a file the caller never
 * checked.
 */
export declare function readResolvedArchiveFile(exactPath: string): string;
