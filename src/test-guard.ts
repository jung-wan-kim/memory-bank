import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Test-run guard for the live database.
 *
 * `getDbPath()` falls back to the real home config dir whenever a test forgets
 * to point MEMORY_BANK_CONFIG_DIR / MEMORY_BANK_DB_PATH / TEST_DB_PATH at a temp
 * dir, and `initDatabase()` is a write connection that runs migrations as it
 * opens — one such test applied unreleased migration code to the developer's
 * own 4 GB database on every `npm test`. With the guard on, opening a database
 * under the live config dir throws instead.
 *
 * On only when MEMORY_BANK_TEST_GUARD=1, which test/setup.ts sets for every
 * test file (child processes a test spawns inherit it). It is this plugin's own
 * variable on purpose: VITEST is also set in the hooks and MCP server of a
 * Claude Code session that some other project's test run started, and those
 * must keep opening the live database.
 */
export const TEST_GUARD_ENV = 'MEMORY_BANK_TEST_GUARD';

/** Test-only: one more directory to protect (can only add protection, never lift it). */
export const TEST_GUARD_EXTRA_ROOT_ENV = 'MEMORY_BANK_TEST_GUARD_EXTRA_ROOT';

/**
 * Directories a test run must not open a database under: the account's
 * `~/.config/superpowers`, plus the extra root when set.
 *
 * The home comes from the account database (os.userInfo), not $HOME: a test
 * that points HOME at a temp dir keeps the real home protected, and its fake
 * home stays usable. If the account lookup fails, $HOME is what is protected.
 */
export function liveConfigRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  let home: string;
  try {
    home = os.userInfo().homedir;
  } catch {
    home = os.homedir();
  }
  const roots = [path.join(home, '.config', 'superpowers')];
  const extra = env[TEST_GUARD_EXTRA_ROOT_ENV];
  if (extra) roots.push(extra);
  return roots;
}

/**
 * The path with symlinks resolved as far as it exists; the part that does not
 * exist yet (a database about to be created) is appended unchanged.
 */
function resolveExisting(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throws when a test run is about to open a database under a live config dir.
 * Does nothing outside a test run.
 */
export function assertNotLiveDbUnderTest(dbPath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[TEST_GUARD_ENV] !== '1') return;
  const literal = path.resolve(dbPath);
  const resolved = resolveExisting(dbPath);
  for (const root of liveConfigRoots(env)) {
    const resolvedRoot = resolveExisting(root);
    if (isInside(literal, path.resolve(root)) || isInside(resolved, resolvedRoot)) {
      throw new Error(
        `memory-bank test guard: refusing to open ${dbPath} — it is under the live config dir ${root}. ` +
        `Point MEMORY_BANK_CONFIG_DIR (or MEMORY_BANK_DB_PATH / TEST_DB_PATH) at a temp dir; test/setup.ts sets one when none is given.`,
      );
    }
  }
}
