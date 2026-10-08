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
/** Remove an archive file in both its plain and compressed forms (either may be absent). */
export declare function removeArchiveFile(filePath: string): void;
/** Whether an archive file exists in either plain or compressed form. */
export declare function archiveFileExists(filePath: string): boolean;
/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export declare function readArchiveFile(filePath: string): string;
/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface.
 */
export declare function createArchiveReadStream(filePath: string): Readable;
/** stat() the resolved archive file (plain or compressed), null if missing. */
export declare function statArchiveFile(filePath: string): fs.Stats | null;
