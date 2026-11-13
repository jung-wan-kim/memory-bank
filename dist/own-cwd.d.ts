/**
 * The working directory of THIS process, or null when it cannot be read (the directory was removed).
 *
 * Only a session's own process calls this — the stdio entry point and the relay, whose working directory is
 * the session's. Code that serves sessions (server-core and everything under it) must never import it:
 * test/server-scope-guard.test.ts keeps it out of that set.
 */
export declare function ownCwd(): string | null;
