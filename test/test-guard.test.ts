import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNotLiveDbUnderTest, liveConfigRoots, TEST_GUARD_ENV, TEST_GUARD_EXTRA_ROOT_ENV } from '../src/test-guard.js';

/**
 * TEST-01: a test run must never open the developer's live database.
 * test/setup.ts turns the guard on for every test file; these tests pin what it refuses.
 * The live path is only ever compared as a string here — nothing below opens it.
 */

const realHome = os.userInfo().homedir;
const liveDb = path.join(realHome, '.config', 'superpowers', 'conversation-index', 'db.sqlite');

describe('test/setup.ts defaults', () => {
  it('turns the guard on and points every default at a temp dir', () => {
    expect(process.env[TEST_GUARD_ENV]).toBe('1');
    for (const key of ['MEMORY_BANK_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'TEST_PROJECTS_DIR']) {
      const value = process.env[key];
      expect(value, key).toBeTruthy();
      expect(path.resolve(value!).startsWith(path.join(realHome, '.config', 'superpowers')), key).toBe(false);
      expect(path.resolve(value!).startsWith(path.join(realHome, '.claude')), key).toBe(false);
    }
    // The closed port (or the endpoint named for the test run) — never whatever the shell exported.
    expect(process.env.ANTHROPIC_BASE_URL).toBe(process.env.MEMORY_BANK_TEST_LLM_BASE_URL || 'http://127.0.0.1:9');
  });

  it('puts a default back before each test after a test file deleted it', () => {
    // An earlier test's afterEach deleting the variable must not send the next test to the real home.
    expect(process.env.TEST_PROJECTS_DIR).toBeTruthy();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.MEMORY_BANK_CONFIG_DIR;
  });

  it('…and here they are again', () => {
    expect(process.env.TEST_PROJECTS_DIR).toBeTruthy();
    expect(process.env.MEMORY_BANK_CONFIG_DIR).toBeTruthy();
  });
});

describe('assertNotLiveDbUnderTest', () => {
  it('refuses the live database path while the guard is on', () => {
    expect(() => assertNotLiveDbUnderTest(liveDb, { [TEST_GUARD_ENV]: '1' })).toThrow(/test guard/);
    expect(() => assertNotLiveDbUnderTest(path.join(realHome, '.config', 'superpowers', 'x', 'backup.sqlite'), { [TEST_GUARD_ENV]: '1' }))
      .toThrow(/test guard/);
  });

  it('protects the account home, not $HOME — a test that fakes HOME keeps the real one protected', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(liveConfigRoots({ [TEST_GUARD_ENV]: '1' })).toContain(path.join(realHome, '.config', 'superpowers'));
      // The fake home's own config dir is an ordinary temp dir: allowed.
      expect(() => assertNotLiveDbUnderTest(path.join(fakeHome, '.config', 'superpowers', 'conversation-index', 'db.sqlite'), { [TEST_GUARD_ENV]: '1' }))
        .not.toThrow();
      expect(() => assertNotLiveDbUnderTest(liveDb, { [TEST_GUARD_ENV]: '1' })).toThrow(/test guard/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('allows a temp path, and does nothing at all outside a test run', () => {
    expect(() => assertNotLiveDbUnderTest(path.join(os.tmpdir(), 'mb-guard-x', 'db.sqlite'), { [TEST_GUARD_ENV]: '1' })).not.toThrow();
    expect(() => assertNotLiveDbUnderTest(liveDb, {})).not.toThrow();
    expect(() => assertNotLiveDbUnderTest(liveDb, { [TEST_GUARD_ENV]: '0' })).not.toThrow();
  });

  it('sees through a symlink that leads into a protected dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-link-'));
    try {
      const protectedDir = path.join(tmp, 'protected');
      fs.mkdirSync(path.join(protectedDir, 'conversation-index'), { recursive: true });
      const link = path.join(tmp, 'innocent-name');
      fs.symlinkSync(protectedDir, link);
      const env = { [TEST_GUARD_ENV]: '1', [TEST_GUARD_EXTRA_ROOT_ENV]: protectedDir };
      expect(() => assertNotLiveDbUnderTest(path.join(link, 'conversation-index', 'db.sqlite'), env)).toThrow(/test guard/);
      // A sibling whose name merely starts with the protected dir's name is not inside it.
      expect(() => assertNotLiveDbUnderTest(path.join(tmp, 'protected-not', 'db.sqlite'), env)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('initDatabase under the guard', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-db-'));
    for (const key of ['MEMORY_BANK_DB_PATH', 'TEST_DB_PATH', TEST_GUARD_EXTRA_ROOT_ENV]) saved[key] = process.env[key];
    delete process.env.TEST_DB_PATH;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('throws before creating or opening a database under a protected dir', async () => {
    // A stand-in for the live config dir: the wiring is what is under test, and a
    // missing guard must not be able to touch the real one.
    const protectedDir = path.join(tmp, 'stand-in-live-config');
    const dbPath = path.join(protectedDir, 'conversation-index', 'db.sqlite');
    process.env[TEST_GUARD_EXTRA_ROOT_ENV] = protectedDir;
    process.env.MEMORY_BANK_DB_PATH = dbPath;
    const { initDatabase } = await import('../src/db.js');
    expect(() => initDatabase()).toThrow(/test guard/);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  it('opens a database in an ordinary temp dir', async () => {
    process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 'ok', 'db.sqlite');
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM exchanges').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
