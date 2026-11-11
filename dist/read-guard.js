import fs from 'fs';
import path from 'path';
import { resolveArchiveFile } from './archive-io.js';
/**
 * Which file the `read` tool may open.
 *
 * The tool takes a path from the model, and the model takes text from
 * anywhere, so the path is confined to the conversation roots (the archive and
 * Claude Code's projects dir). Two properties beyond "is it inside":
 *
 *  - A path outside the roots gets one answer, whether or not a file is there.
 *    Checking existence first turned the tool into a probe: "File not found"
 *    vs "Access denied" told the caller whether any `*.jsonl` on the machine
 *    existed.
 *  - The function returns the exact file that passed the check (symlinks
 *    resolved, plain or `.zst` variant chosen). Read that path with
 *    readResolvedArchiveFile() — a reader that chooses the variant again can
 *    open a file this function never looked at.
 */
export const ACCESS_DENIED_MESSAGE = 'Access denied: path is outside the conversation archive';
/** The path with symlinks resolved as far as it exists; the missing tail is appended unchanged. */
function realpathOfExisting(p) {
    let current = path.resolve(p);
    const rest = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...rest);
        }
        catch {
            const parent = path.dirname(current);
            if (parent === current)
                return path.join(current, ...rest);
            rest.unshift(path.basename(current));
            current = parent;
        }
    }
}
function isInside(candidate, root) {
    return candidate === root || candidate.startsWith(root + path.sep);
}
/**
 * The real path of the conversation file to read for `requestedPath`.
 * Throws: "Invalid file type" (not .jsonl / .jsonl.zst), ACCESS_DENIED_MESSAGE
 * (outside the roots — existing or not), "File not found" (inside, absent).
 */
export function resolveReadableConversation(requestedPath, allowedRoots) {
    const resolvedPath = path.resolve(requestedPath);
    if (!resolvedPath.endsWith('.jsonl') && !resolvedPath.endsWith('.jsonl.zst')) {
        throw new Error('Invalid file type: only .jsonl files are supported');
    }
    const roots = allowedRoots.map(realpathOfExisting);
    // Where the path points, before asking whether anything is there: the directory decides.
    const realDir = realpathOfExisting(path.dirname(resolvedPath));
    if (!roots.some((root) => isInside(realDir, root))) {
        throw new Error(ACCESS_DENIED_MESSAGE);
    }
    const resolvedFile = resolveArchiveFile(resolvedPath);
    if (!resolvedFile) {
        throw new Error(`File not found: ${resolvedPath}`);
    }
    // The file itself (or the variant picked) may still be a link out of the roots.
    const realFile = fs.realpathSync(resolvedFile);
    if (!roots.some((root) => isInside(realFile, root))) {
        throw new Error(ACCESS_DENIED_MESSAGE);
    }
    return realFile;
}
/** A reversed line range is a mistake to report, not an empty conversation to return. */
export function assertLineRange(startLine, endLine) {
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
        throw new Error(`Invalid line range: startLine (${startLine}) is after endLine (${endLine})`);
    }
}
