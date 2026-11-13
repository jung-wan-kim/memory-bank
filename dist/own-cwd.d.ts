/**
 * The working directory of THIS process, or null when it cannot be read (the directory was removed).
 *
 * Only a session's own process calls this — the stdio entry point and the relay, whose working directory is
 * the session's. Code that serves sessions (server-core and everything under it) must never import it:
 * test/server-scope-guard.test.ts keeps it out of that set.
 */
export declare function ownCwd(): string | null;
/**
 * The locale THIS process writes dates and numbers in — what Node made of the session's LANG / LC_*, read
 * back from Intl rather than worked out from those variables again. null when it cannot be told.
 *
 * A session's own process only, like ownCwd(): a shared server's default locale is nobody's.
 */
export declare function ownLocale(): string | null;
