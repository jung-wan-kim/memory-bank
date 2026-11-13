import path from 'node:path';
const MAX_CWD_BYTES = 4096;
/** A working directory a session may declare: a non-empty absolute path. */
export function validSessionCwd(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        !value.includes('\0') &&
        path.isAbsolute(value) &&
        Buffer.byteLength(value) <= MAX_CWD_BYTES);
}
const MAX_LOCALE_CHARS = 64;
/**
 * A locale a session may declare: a tag this runtime formats in. A well-formed tag it has no data for
 * ("POSIX") is refused too — Intl would quietly format in the process default, which is not that session's.
 */
export function validSessionLocale(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LOCALE_CHARS)
        return false;
    try {
        return Intl.DateTimeFormat.supportedLocalesOf(value).length === 1;
    }
    catch {
        return false;
    }
}
/** The context of one session. Anything but an absolute path or null is refused — never repaired. */
export function sessionContext(cwd, rest = {}) {
    if (cwd !== null && !validSessionCwd(cwd)) {
        throw new Error('memory-bank: a session must declare its working directory as an absolute path');
    }
    if (rest.locale !== undefined && !validSessionLocale(rest.locale)) {
        throw new Error('memory-bank: a session must declare its locale as a language tag');
    }
    return {
        cwd,
        ...(rest.childEnv ? { childEnv: rest.childEnv } : {}),
        ...(rest.locale !== undefined ? { locale: rest.locale } : {}),
    };
}
/**
 * The project a tool call is about: the one the caller named, else the session's working directory.
 *
 * Never an empty value — several scope filters read a missing project as "every project". A session whose
 * working directory is unknown gets an error for the calls that need the default, and only those.
 */
export function sessionProject(ctx, explicit, argument = 'project') {
    if (typeof explicit === 'string' && explicit !== '')
        return explicit;
    if (ctx.cwd === null) {
        throw new Error(`this session's working directory could not be read, so there is no default project — pass \`${argument}\``);
    }
    return ctx.cwd;
}
