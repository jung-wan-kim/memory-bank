import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange } from '../src/db.js';
import { countPurgeLeftovers, PURGE_WORKLIST_TABLE } from '../src/pollution-predicate.js';
import { OBSERVER_PROMPT_PREFIX } from '../src/noise.js';
import { suppressConsole } from './test-utils.js';

// scripts/purge-llm-sessions.mjs deletes rows. A dry run must not write, a
// mistyped flag must stop it, the backup must hold what is deleted, and the
// check after the deletes must be able to see what was left behind.

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());
const EMB = new Array(384).fill(0.01);

describe('purge-llm-sessions', () => {
  let cfg: string;
  let dbPath: string;

  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/purge-llm-sessions.mjs', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath },
  });
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const backupPath = () => path.join(cfg, 'conversation-index', 'purge-llm-backup.sqlite');

  function seed(): void {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      const add = (id: string, project: string, userMessage: string, isSidechain = false) => insertExchange(db, {
        id, project, timestamp: 't', userMessage, assistantMessage: `answer ${id}`,
        archivePath: `/arch/${id}.jsonl`, lineStart: 1, lineEnd: 2, isSidechain,
        toolCalls: [{ id: `${id}:0`, exchangeId: id, toolName: 'Read', isError: false, timestamp: 't' }],
      }, EMB);
      add('slug-1', '-private-tmp-memory-bank-llm', 'worker session');
      add('warm-1', 'proj', 'Warmup', true);
      add('warm-2', 'proj', 'Warmup', true);
      add('obs-1', 'proj', `${OBSERVER_PROMPT_PREFIX}\n<what_happened>Read</what_happened>`);
      add('human-1', 'proj', 'Warmup 순서 알려줘', true);
      add('human-2', 'proj', 'Warmup'); // a person typed it on the main chain
      add('human-3', 'proj', 'an ordinary question');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
      delete process.env.TEST_DB_PATH;
    }
  }
  const ids = (file = dbPath, table = 'exchanges') => {
    const db = new Database(file, { readonly: true });
    try {
      return (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-purge-'));
    dbPath = path.join(cfg, 'db.sqlite');
    seed();
  });
  afterEach(() => {
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it('a dry run reports the counts and leaves the database file byte-for-byte unchanged', () => {
    const before = sha();
    const r = run('--warmup', '--observer');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/families: slug \+ warmup \+ observer/);
    expect(r.stdout).toMatch(/polluted exchanges: 4/);
    expect(r.stdout).toMatch(/polluted tool_calls: 4/);
    expect(r.stdout).toMatch(/polluted vectors: +4/);
    expect(r.stdout).toMatch(/DRY-RUN \(no changes made\)/);
    expect(sha()).toBe(before);
    expect(ids()).toHaveLength(7);
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it('a dry run does not migrate or heal an older database either (it opens read-only)', () => {
    const db = new Database(dbPath);
    db.exec('CREATE INDEX idx_facts_active ON facts(is_active)'); // initDatabase() would drop this
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = sha();
    expect(run().status).toBe(0);
    expect(sha()).toBe(before);
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'idx_facts_active'`).get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });

  it('each family flag selects its own rows; without a flag only the slug family is counted', () => {
    expect(run().stdout).toMatch(/families: slug\n[^]*polluted exchanges: 1\n/);
    expect(run('--warmup').stdout).toMatch(/polluted exchanges: 3\n/);
    expect(run('--observer').stdout).toMatch(/polluted exchanges: 2\n/);
  });

  it('a mistyped or repeated flag stops the run: exit 1, nothing read or written', () => {
    const before = sha();
    for (const args of [['--aply'], ['--warmup', '--obsrver', '--apply'], ['--apply', '--apply'], ['--warmup=1']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/purge-llm-sessions: /);
      expect(r.stdout, args.join(' ')).toBe('');
    }
    expect(sha()).toBe(before);
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it('--apply backs the rows up, deletes exactly them, and a second run finds nothing and adds nothing to the backup', () => {
    const r = run('--warmup', '--observer', '--apply');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/left of the 4 worklist ids — exchanges: 0, tool_calls: 0, vectors: 0/);
    expect(ids()).toEqual(['human-1', 'human-2', 'human-3']);
    expect(ids(dbPath, 'vec_exchanges_rowids')).toEqual(['human-1', 'human-2', 'human-3']);
    expect(ids(dbPath, 'tool_calls')).toEqual(['human-1:0', 'human-2:0', 'human-3:0']);
    expect(ids(backupPath())).toEqual(['obs-1', 'slug-1', 'warm-1', 'warm-2']);
    expect(ids(backupPath(), 'tool_calls')).toEqual(['obs-1:0', 'slug-1:0', 'warm-1:0', 'warm-2:0']);

    const again = run('--warmup', '--observer', '--apply');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/nothing to purge — index is clean/);
    expect(ids(backupPath())).toEqual(['obs-1', 'slug-1', 'warm-1', 'warm-2']);
  });

  it('a later purge of another family appends to the same backup file instead of writing a new one', () => {
    expect(run('--warmup', '--apply').status).toBe(0);
    expect(ids(backupPath())).toEqual(['slug-1', 'warm-1', 'warm-2']);
    expect(run('--observer', '--apply').status).toBe(0);
    expect(ids(backupPath())).toEqual(['obs-1', 'slug-1', 'warm-1', 'warm-2']);
    expect(fs.readdirSync(path.join(cfg, 'conversation-index')).filter((f) => f.startsWith('purge-llm-backup'))).toEqual(['purge-llm-backup.sqlite']);
  });

  it('the check after the deletes sees a vector that was left behind', () => {
    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      db.exec(`CREATE TEMP TABLE ${PURGE_WORKLIST_TABLE} (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO temp.${PURGE_WORKLIST_TABLE} VALUES ('warm-1'), ('warm-2')`).run();
      // the exchange rows and tool calls go, the vector of warm-2 stays
      db.prepare(`DELETE FROM tool_calls WHERE exchange_id IN ('warm-1', 'warm-2')`).run();
      db.prepare(`DELETE FROM exchanges WHERE id IN ('warm-1', 'warm-2')`).run();
      db.prepare(`DELETE FROM vec_exchanges WHERE id = 'warm-1'`).run();
      expect(countPurgeLeftovers(db)).toEqual({ exchanges: 0, toolCalls: 0, vectors: 1 });
      // the old check — vectors of the exchanges still matching the predicate — is blind to it
      const blind = db.prepare(`SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE user_message = 'Warmup' AND is_sidechain = 1)`).get() as { n: number };
      expect(blind.n).toBe(0);
    } finally {
      db.close();
      delete process.env.TEST_DB_PATH;
    }
  });
});
