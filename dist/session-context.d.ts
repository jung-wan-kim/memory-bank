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
}
/** A working directory a session may declare: a non-empty absolute path. */
export declare function validSessionCwd(value: unknown): value is string;
/** The context of one session. Anything but an absolute path or null is refused — never repaired. */
export declare function sessionContext(cwd: unknown): SessionContext;
/**
 * The project a tool call is about: the one the caller named, else the session's working directory.
 *
 * Never an empty value — several scope filters read a missing project as "every project". A session whose
 * working directory is unknown gets an error for the calls that need the default, and only those.
 */
export declare function sessionProject(ctx: SessionContext, explicit: unknown, argument?: string): string;
