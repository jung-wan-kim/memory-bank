import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_UNIX_SOCKET_PATH_BYTES } from './version-guard.js';
/**
 * Which sessions may share one MCP server process, and what that process is told.
 *
 * A session-local server inherits everything its session has: the session id, the messaging socket and token,
 * the project directory, the shell's secrets — and hands all of it on to the LLM child `ask_avatar` starts.
 * A shared server is started by whichever session arrives first, so whatever it inherits is that session's,
 * for every session it later serves. Two rules follow:
 *
 *  1. A shared server is started with an allow-list environment (serverEnvFor): the settings the server and
 *     its LLM child read, never what belongs to one session.
 *  2. Sessions share a server only when that whole environment is equal (sharedServerIdentity), together with
 *     the code version and the code itself. A setting that differs — another database, another LLM account,
 *     another locale — is another server.
 *
 * A session-specific variable that slips into the allow-list splits sessions onto servers of their own: no
 * sharing, and nothing mixed. test/server-scope-guard.test.ts holds the other side: every variable the server
 * code reads is on the list.
 */
/** Read by the server code or by the LLM child it starts. Equal values are required to share a server. */
const IDENTITY_PREFIXES = [
    'MEMORY_BANK_', 'TEST_',
    'ANTHROPIC_', 'CLAUDE_', '_CLAUDE_', 'AWS_', 'GOOGLE_', 'CLOUD_ML_', 'VERTEX_', 'DISABLE_', 'ENABLE_',
];
const IDENTITY_NAMES = new Set([
    'HOME', 'XDG_CONFIG_HOME', 'PERSONAL_SUPERPOWERS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS',
    'CLAUDECODE', 'API_TIMEOUT_MS', 'MAX_THINKING_TOKENS',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // `read` prints dates and numbers in the process locale and time zone
    'LANG', 'LC_ALL', 'LC_MESSAGES', 'LC_TIME', 'LC_NUMERIC', 'LC_CTYPE', 'LC_COLLATE', 'TZ',
]);
/** Belongs to one session, or is read only by the session's own processes (relay, wrapper, hook client). */
const SESSION_ONLY_NAMES = new Set([
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_ENV_FILE',
    'MEMORY_BANK_SHARED_SERVER', 'MEMORY_BANK_INJECT_REQ_ID',
]);
const SESSION_ONLY_PREFIXES = ['MEMORY_BANK_RELAY_', 'MEMORY_BANK_WRAPPER_'];
/** Handed to the server as the starting session has them; they do not decide who shares it. */
const PASSTHROUGH_NAMES = new Set(['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR']);
/** Settings whose value is a path: a relative one means "relative to the session", so it is made absolute. */
const PATH_NAMES = new Set([
    'MEMORY_BANK_CONFIG_DIR', 'PERSONAL_SUPERPOWERS_DIR', 'XDG_CONFIG_HOME', 'MEMORY_BANK_DB_PATH',
    'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'CLAUDE_CONFIG_DIR',
]);
/** How a shared server gets a variable: as part of its identity, as an operating variable, or not at all. */
export function serverEnvKind(name) {
    if (SESSION_ONLY_NAMES.has(name) || SESSION_ONLY_PREFIXES.some((p) => name.startsWith(p)))
        return null;
    if (PASSTHROUGH_NAMES.has(name))
        return 'passthrough';
    if (IDENTITY_NAMES.has(name) || IDENTITY_PREFIXES.some((p) => name.startsWith(p)))
        return 'identity';
    return null;
}
/**
 * The identity part of the environment a shared server runs with: allow-listed names only, path settings
 * absolute. null when a path setting is relative and the working directory it is relative to is unknown.
 */
export function serverEnvFor(env, cwd) {
    const out = {};
    for (const name of Object.keys(env).sort()) {
        const value = env[name];
        if (value === undefined || serverEnvKind(name) !== 'identity')
            continue;
        if (PATH_NAMES.has(name) && value !== '' && !path.isAbsolute(value)) {
            if (cwd === null)
                return null;
            out[name] = path.resolve(cwd, value);
        }
        else {
            out[name] = value;
        }
    }
    return out;
}
/** The full environment to start a shared server with: its identity part plus the operating variables. */
export function spawnEnvFor(env, serverEnv) {
    const out = { ...serverEnv };
    for (const name of PASSTHROUGH_NAMES) {
        const value = env[name];
        if (value !== undefined)
            out[name] = value;
    }
    return out;
}
/**
 * sha256 over the compiled code in `distDir` (its top-level .js files, by name and content).
 *
 * The version string alone does not say which code runs: a development checkout and an installed copy carry
 * the same number, and so do two builds of one checkout. Folders with the same code — a version folder and
 * the older folder a live update copied it into — get the same fingerprint and share a server.
 */
export function distFingerprint(distDir) {
    const hash = crypto.createHash('sha256');
    for (const name of fs.readdirSync(distDir).filter((n) => n.endsWith('.js')).sort()) {
        hash.update(name).update('\0').update(fs.readFileSync(path.join(distDir, name))).update('\0');
    }
    return hash.digest('hex');
}
/** The identity of the server a session may use: equal for sessions that may share one, and only for those. */
export function sharedServerIdentity(o) {
    const env = Object.keys(o.serverEnv).sort().map((name) => [name, o.serverEnv[name]]);
    return crypto.createHash('sha256').update(JSON.stringify({ v: o.version, f: o.fingerprint, env })).digest('hex');
}
const SOCKET_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const sharedFileStem = (version, identity) => `mb-shared-${version}-${identity.slice(0, 8)}`;
/**
 * The shared server's socket for one version and identity, or null when the version cannot be part of a file
 * name or the path does not fit a unix socket (see maxUnixSocketPathBytes — a longer path is not refused by
 * Node, it is cut). The name never matches the inject daemon's sockets, which that daemon sweeps.
 */
export function sharedSocketPathIn(indexDir, version, identity, maxBytes = MAX_UNIX_SOCKET_PATH_BYTES) {
    if (!SOCKET_VERSION_RE.test(version) || !/^[0-9a-f]{8,}$/.test(identity))
        return null;
    const file = path.join(indexDir, `${sharedFileStem(version, identity)}.sock`);
    return Buffer.byteLength(file) <= maxBytes ? file : null;
}
/** Files that live next to a shared server's socket: its pid, and the lock a relay holds while starting it. */
export const sharedPidPath = (socketPath) => socketPath.replace(/\.sock$/, '.pid');
export const sharedLockPath = (socketPath) => socketPath.replace(/\.sock$/, '.lock');
/** Marks a shared server on its command line, so a pid read from a file can be checked before it is signalled. */
export const sharedServerArg = (identity) => `--mb-shared=${identity.slice(0, 8)}`;
