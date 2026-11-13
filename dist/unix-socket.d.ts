/** inode + times of a socket file — "is this still the file I probed". null when absent or not a socket. */
export declare function socketIdentity(p: string): {
    ino: number;
    ctimeMs: number;
    mtimeMs: number;
} | null;
/**
 * Who is behind a socket path: 'alive' (a connect was accepted), 'dead'
 * (ECONNREFUSED — a file with no listener), 'absent' (no file), 'unknown'
 * (anything else, no answer in time included — never treated as dead).
 */
export declare function probeSocket(p: string): Promise<'alive' | 'dead' | 'absent' | 'unknown'>;
/** The same file as `before`, old enough, and nobody answers on it twice: then (and only then) it may be unlinked. */
export declare function removeIfDead(p: string, minAgeMs: number): Promise<boolean>;
/** Is the name itself there — a dangling symlink is still a name (existsSync follows the link and would say "gone"). */
export declare function nameExists(p: string): boolean;
