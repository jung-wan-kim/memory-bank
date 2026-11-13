import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

/**
 * Isolation every test file starts from (vitest `setupFiles`).
 *
 * Without it a test that forgets one variable reads and writes the developer's
 * real state: the config dir (live database, sync files, logs), the Claude
 * Code projects dir, and — through the Agent SDK's bundled CLI — the logged-in
 * Claude account.
 *
 *  - MEMORY_BANK_CONFIG_DIR, CLAUDE_CONFIG_DIR, TEST_PROJECTS_DIR: a temp dir of
 *    this test file, only when the variable has no value (a value given on the
 *    command line, or set by the test file itself, is kept).
 *  - ANTHROPIC_BASE_URL: a closed local port. A value inherited from the shell
 *    is replaced when the file starts — a developer shell that routes Claude
 *    through a local proxy would otherwise keep every unmocked call live. To
 *    run against a chosen endpoint, set MEMORY_BANK_TEST_LLM_BASE_URL.
 *  - MEMORY_BANK_TEST_GUARD=1: initDatabase() refuses a database under the real
 *    home config dir (src/test-guard.ts).
 *  - MEMORY_BANK_SHARED_SERVER=0, when the variable has no value: an MCP server a
 *    test starts runs in its own process and ends with it. The shared server is a
 *    detached process that outlives the test that started it — only the tests of
 *    the shared server turn it on, with a config dir and an idle time of their own
 *    (test/helpers/shared-harness.ts).
 *
 * The defaults are put back before every test: test files delete these
 * variables in their own afterEach, and the next test must not fall through
 * to the real home.
 */

const CLOSED_LLM_BASE_URL = 'http://127.0.0.1:9';

let root: string | null = null;

function tempDir(name: string): string {
  if (root === null) root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-vitest-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DIR_DEFAULTS: Record<string, string> = {
  MEMORY_BANK_CONFIG_DIR: 'config',
  CLAUDE_CONFIG_DIR: 'claude',
  TEST_PROJECTS_DIR: 'projects',
};

function applyDefaults(): void {
  process.env.MEMORY_BANK_TEST_GUARD = '1';
  if (process.env.MEMORY_BANK_SHARED_SERVER === undefined) process.env.MEMORY_BANK_SHARED_SERVER = '0';
  for (const [key, name] of Object.entries(DIR_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = tempDir(name);
  }
  if (!process.env.ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = process.env.MEMORY_BANK_TEST_LLM_BASE_URL || CLOSED_LLM_BASE_URL;
  }
}

// File start: whatever the shell exported for the LLM endpoint does not count.
process.env.ANTHROPIC_BASE_URL = process.env.MEMORY_BANK_TEST_LLM_BASE_URL || CLOSED_LLM_BASE_URL;
applyDefaults();

beforeEach(applyDefaults);

afterAll(() => {
  if (root !== null) fs.rmSync(root, { recursive: true, force: true });
});
