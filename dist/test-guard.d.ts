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
export declare const TEST_GUARD_ENV = "MEMORY_BANK_TEST_GUARD";
/** Test-only: one more directory to protect (can only add protection, never lift it). */
export declare const TEST_GUARD_EXTRA_ROOT_ENV = "MEMORY_BANK_TEST_GUARD_EXTRA_ROOT";
/**
 * Directories a test run must not open a database under: the account's
 * `~/.config/superpowers`, plus the extra root when set.
 *
 * The home comes from the account database (os.userInfo), not $HOME: a test
 * that points HOME at a temp dir keeps the real home protected, and its fake
 * home stays usable. If the account lookup fails, $HOME is what is protected.
 */
export declare function liveConfigRoots(env?: NodeJS.ProcessEnv): string[];
/**
 * Throws when a test run is about to open a database under a live config dir.
 * Does nothing outside a test run.
 */
export declare function assertNotLiveDbUnderTest(dbPath: string, env?: NodeJS.ProcessEnv): void;
