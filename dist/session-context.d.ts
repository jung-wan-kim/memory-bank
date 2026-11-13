/**
 * What a server knows about the session it is serving.
 *
 * One process may serve several sessions (the shared server), so "the current project" cannot be the working
 * directory of the process: that is whichever session happened to start it. Each MCP server instance is made
 * for one session and carries that session's working directory, as the session's own process read it.
 */
export interface SessionContext {
    /** Absolute path, or null when the session could not read its own working directory (it was removed). */
    readonly cwd: string | null;
    /**
     * What the LLM child started for this session's calls gets on top of the server's own environment: the
     * session's account, endpoint, model and client settings. Absent or null when the process is the session's
     * own (session-local) — the child then inherits that process, as it always did.
     */
    readonly childEnv?: Readonly<Record<string, string>> | null;
    /**
     * The locale this session's output is written in — dates, numbers, the order of names (a BCP 47 tag).
     * Absent when the process is the session's own, or the session could not tell: the process default.
     */
    readonly locale?: string;
}
/** A working directory a session may declare: a non-empty absolute path. */
export declare function validSessionCwd(value: unknown): value is string;
/**
 * A locale a session may declare: a tag this runtime formats in. A well-formed tag it has no data for
 * ("POSIX") is refused too — Intl would quietly format in the process default, which is not that session's.
 */
export declare function validSessionLocale(value: unknown): value is string;
/** The context of one session. Anything but an absolute path or null is refused — never repaired. */
export declare function sessionContext(cwd: unknown, rest?: {
    childEnv?: Readonly<Record<string, string>> | null;
    locale?: string;
}): SessionContext;
/**
 * The project a tool call is about: the one the caller named, else the session's working directory.
 *
 * Never an empty value — several scope filters read a missing project as "every project". A session whose
 * working directory is unknown gets an error for the calls that need the default, and only those.
 */
export declare function sessionProject(ctx: SessionContext, explicit: unknown, argument?: string): string;
