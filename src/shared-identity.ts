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
 * for every session it later serves. Three rules follow:
 *
 *  1. A shared server is started with an allow-list environment (serverEnvFor): the settings the server code
 *     itself reads, and what the Node runtime of that one process reads when it starts (proxy, CA files, time
 *     zone). Never what belongs to one session.
 *  2. Sessions share a server only when that environment is equal (sharedServerIdentity), together with the
 *     code version and the code itself. Another database or another index dir is another server.
 *  3. What only the LLM child reads — the account, the endpoint, the model and client settings — and the
 *     locale a session's output is written in are not the server's: each connection declares its own
 *     (childEnvFor, and the locale in the hello), as it declares its working directory. The server keeps them
 *     per connection and uses them for that connection's calls only.
 *
 * Rule 3 is what makes sharing real. With those values in the identity, the sessions of one machine split by
 * model override, API timeout, entry point and locale: the 20 sessions running on one machine made 7
 * servers; with them per connection, 2 — the one setting that still differed was the server's own,
 * MEMORY_BANK_AGENT_SOURCES (measured 2026-11-14 — docs/plans/2026-11-14-shared-mcp-server.md, Deviations).
 *
 * A session-specific variable that slips into the identity list splits sessions onto servers of their own: no
 * sharing, and nothing mixed. test/server-scope-guard.test.ts holds the other side: every variable the server
 * code reads from its process is on the identity list, and nothing on the per-connection list is read there.
 */

/** Read by the server code itself, from its own process. Equal values are required to share a server. */
const IDENTITY_PREFIXES = ['MEMORY_BANK_', 'TEST_'];
const IDENTITY_NAMES = new Set([
  'HOME', 'XDG_CONFIG_HOME', 'PERSONAL_SUPERPOWERS_DIR', 'CONVERSATION_SEARCH_EXCLUDE_PROJECTS',
  // Read once by the Node runtime of the server process: they cannot differ per connection.
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'TZ',
]);
/**
 * Read by the LLM child `ask_avatar` starts, never by the server code: the session's account, endpoint, model
 * and client settings, and its locale. Sent in the hello, kept per connection, given to that connection's
 * child on top of the server's own environment.
 */
const CHILD_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', '_CLAUDE_', 'AWS_', 'GOOGLE_', 'CLOUD_ML_', 'VERTEX_', 'DISABLE_', 'ENABLE_'];
const CHILD_NAMES = new Set([
  'CLAUDECODE', 'API_TIMEOUT_MS', 'MAX_THINKING_TOKENS',
  'LANG', 'LC_ALL', 'LC_MESSAGES', 'LC_TIME', 'LC_NUMERIC', 'LC_CTYPE', 'LC_COLLATE',
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

export type ServerEnvKind = 'identity' | 'passthrough' | 'child';

/**
 * How a variable of a session reaches a shared server: as part of the server's identity, as an operating
 * variable of the process, per connection for the LLM child ('child'), or not at all.
 */
export function serverEnvKind(name: string): ServerEnvKind | null {
  if (SESSION_ONLY_NAMES.has(name) || SESSION_ONLY_PREFIXES.some((p) => name.startsWith(p))) return null;
  if (PASSTHROUGH_NAMES.has(name)) return 'passthrough';
  if (IDENTITY_NAMES.has(name) || IDENTITY_PREFIXES.some((p) => name.startsWith(p))) return 'identity';
  if (CHILD_NAMES.has(name) || CHILD_PREFIXES.some((p) => name.startsWith(p))) return 'child';
  return null;
}

/**
 * The most a connection may declare for its LLM child. The 19 sessions open on the machine this was measured
 * on declare at most 26 names, 1.3 KB in all, the longest value 185 bytes (2026-11-14): the limits leave
 * more than an order of magnitude. The total is counted as the JSON the hello carries, so it keeps that line under
 * the server's 64 KB limit whatever the values contain.
 */
export const CHILD_ENV_MAX_NAMES = 256;
export const CHILD_ENV_MAX_VALUE_BYTES = 8 * 1024;
export const CHILD_ENV_MAX_TOTAL_BYTES = 32 * 1024;

const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/**
 * What a session declares for the LLM child of its own calls: its variables of the 'child' kind.
 *
 * A path setting that is relative means "relative to the session" (the child runs elsewhere), so it is made
 * absolute against `cwd`. A value that cannot be carried — a NUL, over the limits above, or a relative path
 * with no working directory to resolve it against — is left out and named in `dropped`. The session
 * declares those names with its connection (`envMissing`), and the server then makes no LLM call for it:
 * one such value does not cost the session its other tools, and the LLM child is never started with only
 * part of the session's settings.
 */
export function childEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  let total = 0;
  for (const name of Object.keys(env).sort()) {
    let value = env[name];
    if (value === undefined || serverEnvKind(name) !== 'child') continue;
    if (PATH_NAMES.has(name) && value !== '' && !path.isAbsolute(value)) {
      if (cwd === null) { dropped.push(name); continue; }
      value = path.resolve(cwd, value);
    }
    const bytes = jsonBytes(name) + jsonBytes(value);
    const fits = !value.includes('\0')
      && Buffer.byteLength(value) <= CHILD_ENV_MAX_VALUE_BYTES
      && Object.keys(out).length < CHILD_ENV_MAX_NAMES
      && total + bytes <= CHILD_ENV_MAX_TOTAL_BYTES;
    if (!fits) { dropped.push(name); continue; }
    out[name] = value;
    total += bytes;
  }
  return { env: out, dropped };
}

/** A per-connection child environment as a server accepts it: 'child' names only, string values within the limits. */
export function validChildEnv(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const names = Object.keys(value);
  if (names.length > CHILD_ENV_MAX_NAMES) return false;
  let total = 0;
  for (const name of names) {
    const v = (value as Record<string, unknown>)[name];
    if (serverEnvKind(name) !== 'child') return false;
    if (typeof v !== 'string' || v.includes('\0') || Buffer.byteLength(v) > CHILD_ENV_MAX_VALUE_BYTES) return false;
    total += jsonBytes(name) + jsonBytes(v);
  }
  return total <= CHILD_ENV_MAX_TOTAL_BYTES;
}

/** The names a connection declares as not carried: 'child' names only, none of them also in `env`, no repeats. */
export function validChildEnvMissing(value: unknown, env: Record<string, string>): value is string[] {
  if (!Array.isArray(value) || value.length > CHILD_ENV_MAX_NAMES) return false;
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string' || serverEnvKind(name) !== 'child' || seen.has(name) || Object.hasOwn(env, name)) return false;
    seen.add(name);
  }
  return true;
}

/**
 * The identity part of the environment a shared server runs with: allow-listed names only, path settings
 * absolute. null when a path setting is relative and the working directory it is relative to is unknown.
 */
export function serverEnvFor(env: NodeJS.ProcessEnv, cwd: string | null): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || serverEnvKind(name) !== 'identity') continue;
    if (PATH_NAMES.has(name) && value !== '' && !path.isAbsolute(value)) {
      if (cwd === null) return null;
      out[name] = path.resolve(cwd, value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** The full environment to start a shared server with: its identity part plus the operating variables. */
export function spawnEnvFor(env: NodeJS.ProcessEnv, serverEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...serverEnv };
  for (const name of PASSTHROUGH_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
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
export function distFingerprint(distDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(distDir).filter((n) => n.endsWith('.js')).sort()) {
    hash.update(name).update('\0').update(fs.readFileSync(path.join(distDir, name))).update('\0');
  }
  return hash.digest('hex');
}

/** The identity of the server a session may use: equal for sessions that may share one, and only for those. */
export function sharedServerIdentity(o: { version: string; fingerprint: string; serverEnv: Record<string, string> }): string {
  const env = Object.keys(o.serverEnv).sort().map((name) => [name, o.serverEnv[name]]);
  return crypto.createHash('sha256').update(JSON.stringify({ v: o.version, f: o.fingerprint, env })).digest('hex');
}

const SOCKET_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const sharedFileStem = (version: string, identity: string) => `mb-shared-${version}-${identity.slice(0, 8)}`;

/**
 * The shared server's socket for one version and identity, or null when the version cannot be part of a file
 * name or the path does not fit a unix socket (see maxUnixSocketPathBytes — a longer path is not refused by
 * Node, it is cut). The name never matches the inject daemon's sockets, which that daemon sweeps.
 */
export function sharedSocketPathIn(indexDir: string, version: string, identity: string, maxBytes: number = MAX_UNIX_SOCKET_PATH_BYTES): string | null {
  if (!SOCKET_VERSION_RE.test(version) || !/^[0-9a-f]{8,}$/.test(identity)) return null;
  const file = path.join(indexDir, `${sharedFileStem(version, identity)}.sock`);
  return Buffer.byteLength(file) <= maxBytes ? file : null;
}

/** Files that live next to a shared server's socket: its pid, and the lock a relay holds while starting it. */
export const sharedPidPath = (socketPath: string) => socketPath.replace(/\.sock$/, '.pid');
export const sharedLockPath = (socketPath: string) => socketPath.replace(/\.sock$/, '.lock');
/** Marks a shared server on its command line, so a pid read from a file can be checked before it is signalled. */
export const sharedServerArg = (identity: string) => `--mb-shared=${identity.slice(0, 8)}`;

/** Whether a process with this pid exists (one that exists but is not ours to signal counts). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A lock file whose holder is gone is nobody's once it is this old: before that its pid may not be written yet. */
const ORPHAN_LOCK_MIN_AGE_MS = 1_000;

/**
 * The start lock as it is on disk: whether the process named in it exists, how old the file is, and whether
 * it is an orphan (no holder, and not brand new). null when there is no lock file.
 *
 * A relay takes the lock to start a server and gives it back when the server answers. One that is killed in
 * between cannot give it back — both sides read that state through here: the next relay that needs to start
 * a server (it replaces an orphan), and a server that is already serving (it removes one, since sessions that
 * find a server answering never look at the lock).
 */
export function startLockHolder(lockPath: string): { alive: boolean; ageMs: number; orphan: boolean } | null {
  let ageMs: number;
  let text: string;
  try {
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    text = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const holder = Number(text.trim());
  const alive = Number.isInteger(holder) && holder > 1 && isAlive(holder);
  return { alive, ageMs, orphan: !alive && ageMs > ORPHAN_LOCK_MIN_AGE_MS };
}

/** Remove the start lock when it is an orphan. true when a file was removed. */
export function removeOrphanStartLock(lockPath: string): boolean {
  if (startLockHolder(lockPath)?.orphan !== true) return false;
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}
