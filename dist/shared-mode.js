import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexDirOf } from './paths.js';
import { distFingerprint, serverEnvFor, sharedServerIdentity, sharedSocketPathIn } from './shared-identity.js';
import { ownPackageVersion } from './version-guard.js';
/**
 * A session's decision: talk to a shared server, or run a server of its own.
 *
 * This is the session's side of shared-identity.ts — it reads the session's own switch and environment — and
 * is kept out of the modules a server loads (test/server-scope-guard.test.ts).
 */
/** A file with this name in the index dir turns the shared server off for every session that starts after it. */
export const SHARED_SWITCH_FILE = 'shared-server.off';
const SWITCH_OFF_RE = /^(0|false|off|no)$/i;
/**
 * Whether the session whose entry file is `entryUrl` talks to a shared server, or runs a server of its own.
 * Decides only — no directory is created, nothing is started.
 */
export function sharedMode(o) {
    const local = (reason) => ({ kind: 'session-local', reason });
    if (SWITCH_OFF_RE.test(o.env.MEMORY_BANK_SHARED_SERVER ?? ''))
        return local('switch-off');
    if ((o.platform ?? process.platform) === 'win32')
        return local('windows');
    // The server is plain compiled output next to the entry file; a source run (tsx) has none to start.
    const entry = fileURLToPath(o.entryUrl);
    const distDir = path.dirname(entry);
    const serverEntry = path.join(distDir, 'shared-server.js');
    if (path.extname(entry) !== '.js')
        return local('source-run');
    // The user's "off" comes before anything about the install: either form of it is a choice to run without
    // the parts checked below.
    const serverEnv = serverEnvFor(o.env, o.cwd);
    const indexDir = serverEnv === null ? null : indexDirOf(serverEnv);
    if (indexDir !== null && fs.existsSync(path.join(indexDir, SHARED_SWITCH_FILE)))
        return local('switch-off-file');
    if (!fs.existsSync(serverEntry))
        return { kind: 'broken', reason: 'server-file-missing' };
    const version = o.version === undefined ? ownPackageVersion() : o.version;
    if (!version)
        return { kind: 'broken', reason: 'no-version' };
    if (serverEnv === null || indexDir === null)
        return local('relative-path');
    const identity = sharedServerIdentity({ version, fingerprint: distFingerprint(distDir), serverEnv });
    const socketPath = sharedSocketPathIn(indexDir, version, identity);
    if (socketPath === null)
        return local('socket-path-too-long');
    return { kind: 'shared', socketPath, indexDir, identity, version, serverEnv, serverEntry };
}
