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
export declare const ACCESS_DENIED_MESSAGE = "Access denied: path is outside the conversation archive";
/**
 * The real path of the conversation file to read for `requestedPath`.
 *
 * A relative path is the caller's: it is resolved against `baseDir`, the working directory of the session
 * that asked — never against the directory of the process this runs in, which for a shared server is the
 * index dir and nobody's project. With no `baseDir` (the session could not read its own) a relative path is
 * refused.
 *
 * Throws: "Invalid file type" (not .jsonl / .jsonl.zst), ACCESS_DENIED_MESSAGE
 * (outside the roots — existing or not), "File not found" (inside, absent).
 */
export declare function resolveReadableConversation(requestedPath: string, allowedRoots: string[], baseDir?: string | null): string;
/** A reversed line range is a mistake to report, not an empty conversation to return. */
export declare function assertLineRange(startLine: number | undefined, endLine: number | undefined): void;
