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

export type SharedMode =
  | {
      kind: 'shared';
      socketPath: string;
      indexDir: string;
      identity: string;
      version: string;
      /** The identity part of the server's environment. */
      serverEnv: Record<string, string>;
      /** dist/shared-server.js next to the running entry file. */
      serverEntry: string;
    }
  | { kind: 'session-local'; reason: SessionLocalReason };

export type SessionLocalReason =
  | 'switch-off' | 'switch-off-file' | 'windows' | 'not-built' | 'no-version' | 'relative-path' | 'socket-path-too-long';

const SWITCH_OFF_RE = /^(0|false|off|no)$/i;

/**
 * Whether the session whose entry file is `entryUrl` talks to a shared server, or runs a server of its own.
 * Decides only — no directory is created, nothing is started.
 */
export function sharedMode(o: {
  entryUrl: string;
  env: NodeJS.ProcessEnv;
  cwd: string | null;
  version?: string | null;
  platform?: NodeJS.Platform;
}): SharedMode {
  const local = (reason: SessionLocalReason): SharedMode => ({ kind: 'session-local', reason });
  if (SWITCH_OFF_RE.test(o.env.MEMORY_BANK_SHARED_SERVER ?? '')) return local('switch-off');
  if ((o.platform ?? process.platform) === 'win32') return local('windows');

  // The server is plain compiled output next to the entry file; a source run (tsx) has none to start.
  const entry = fileURLToPath(o.entryUrl);
  const distDir = path.dirname(entry);
  const serverEntry = path.join(distDir, 'shared-server.js');
  if (path.extname(entry) !== '.js' || !fs.existsSync(serverEntry)) return local('not-built');

  const version = o.version === undefined ? ownPackageVersion() : o.version;
  if (!version) return local('no-version');

  const serverEnv = serverEnvFor(o.env, o.cwd);
  if (serverEnv === null) return local('relative-path');

  const indexDir = indexDirOf(serverEnv);
  if (fs.existsSync(path.join(indexDir, SHARED_SWITCH_FILE))) return local('switch-off-file');

  const identity = sharedServerIdentity({ version, fingerprint: distFingerprint(distDir), serverEnv });
  const socketPath = sharedSocketPathIn(indexDir, version, identity);
  if (socketPath === null) return local('socket-path-too-long');

  return { kind: 'shared', socketPath, indexDir, identity, version, serverEnv, serverEntry };
}
