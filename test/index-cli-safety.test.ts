import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange } from '../src/db.js';
import { suppressConsole } from './test-utils.js';

// The real commands (`dist/index-cli.js rebuild|repair`, what `index-conversations
// --rebuild|--repair` runs): a rebuild keeps the database file and the facts in
// it, nothing destructive runs without its flag, and a mistyped flag stops the
// command instead of being ignored.

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());
const EMB = new Array(384).fill(0.01);

describe('index-cli rebuild / repair (the shipped command)', () => {
  let cfg: string;
  let dbPath: string;
  let archiveDir: string;

  const run = (...args: string[]) => spawnSync(process.execPath, ['dist/index-cli.js', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath,
      TEST_ARCHIVE_DIR: archiveDir, TEST_PROJECTS_DIR: path.join(cfg, 'projects'),
    },
  });

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-index-cli-'));
    dbPath = path.join(cfg, 'db.sqlite');
    archiveDir = path.join(cfg, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });

    process.env.TEST_DB_PATH = dbPath;
    const db = initDatabase();
    try {
      const fact = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at, tags)
        VALUES (?, ?, 'decision', 'global', '[]', 't', 't', ?)`);
      fact.run('f1', 'Use WAL mode for the index database', '["verified"]');
      fact.run('f2', 'Batch vec0 deletes in groups of 2000', null);
      db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('rel1', 'f1', 'SUPPORTS', 'f2')`).run();
      for (let i = 0; i < 3; i++) {
        insertExchange(db, {
          id: `ex-${i}`, project: 'proj', timestamp: 't', userMessage: `question ${i}`, assistantMessage: `answer ${i}`,
          archivePath: path.join(archiveDir, 'proj', `gone-${i}.jsonl`), lineStart: 1, lineEnd: 2,
          toolCalls: [{ id: `ex-${i}:0`, exchangeId: `ex-${i}`, toolName: 'Read', isError: false, timestamp: 't' }],
        }, EMB);
      }
    } finally {
      db.close();
      delete process.env.TEST_DB_PATH;
    }
  });

  afterEach(() => {
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  const state = () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
      return {
        facts: db.prepare('SELECT id, fact, tags FROM facts ORDER BY id').all(),
        relations: n('ontology_relations'), exchanges: n('exchanges'), toolCalls: n('tool_calls'), vectors: n('vec_exchanges_rowids'),
      };
    } finally {
      db.close();
    }
  };
  const backups = () => {
    const dir = path.join(cfg, 'conversation-index', 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  /** Put the three indexed conversations' files back in the archive (two lines each: a question and an answer). */
  const restoreArchiveFiles = () => {
    fs.mkdirSync(path.join(archiveDir, 'proj'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(archiveDir, 'proj', `gone-${i}.jsonl`), [
        JSON.stringify({ type: 'user', message: { role: 'user', content: `question ${i}` }, timestamp: 't' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `answer ${i}` }, timestamp: 't' }),
      ].join('\n'));
    }
  };

  it('rebuild --yes keeps the database file, its facts and relations; the conversation index is emptied and re-created from the archive', () => {
    restoreArchiveFiles();
    const before = state();
    const inode = fs.statSync(dbPath).ino;

    const r = run('rebuild', '--yes');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fs.statSync(dbPath).ino).toBe(inode);
    const after = state();
    expect(after.facts).toEqual(before.facts);
    expect(after.facts).toHaveLength(2);
    expect(after.relations).toBe(1);
    // re-created from the three archive files: rows and vectors back, with the ids the parser gives
    expect(after).toMatchObject({ exchanges: 3, toolCalls: 0, vectors: 3 });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect((db.prepare(`SELECT count(*) AS n FROM exchanges WHERE id LIKE 'ex-%'`).get() as { n: number }).n).toBe(0);
      expect(db.prepare('SELECT user_message FROM exchanges ORDER BY user_message').all())
        .toEqual([{ user_message: 'question 0' }, { user_message: 'question 1' }, { user_message: 'question 2' }]);
    } finally {
      db.close();
    }
    expect(r.stdout).toMatch(/Preserved: 2 facts \(2 active, 1 tagged\), 1 relations/);
    // what is cleared, and how much of it can come back, are two numbers (review LSO-9: one line used to
    // call every cleared row "re-created", next to the line counting the rows that are not)
    expect(r.stdout).toMatch(/^Cleared: 3 exchanges, 3 tool calls, 3 vectors$/m);
    expect(r.stdout).toMatch(/Re-index source: 3 archive conversation\(s\) — at most 3 of the 3 cleared exchanges are indexed from them and can be re-created/);
    expect(r.stdout).not.toMatch(/Cleared and re-created/);
    expect(r.stdout).toMatch(/Cleared and NOT re-created \(file not among them\): 0 exchanges from 0 file\(s\)/);

    const made = backups().filter((f) => f.startsWith('pre-rebuild-facts-'));
    expect(made).toHaveLength(1);
    const bak = new Database(path.join(cfg, 'conversation-index', 'backups', made[0]), { readonly: true });
    try {
      expect(bak.prepare('SELECT id, fact, tags FROM facts ORDER BY id').all()).toEqual(before.facts);
    } finally {
      bak.close();
    }
  });

  it('rebuild without --yes prints the counts, exits 1 and changes nothing', () => {
    restoreArchiveFiles();
    const before = state();
    const r = run('rebuild');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Preserved: 2 facts/);
    expect(r.stderr).toMatch(/nothing was changed\. Pass --yes/);
    expect(state()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  it('rebuild --yes is refused when indexed exchanges cannot be re-created (their files are gone); --allow-index-loss backs them up and goes ahead', () => {
    const before = state();
    const refused = run('rebuild', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/Cleared and NOT re-created \(file not among them\): 3 exchanges from 3 file\(s\)/);
    expect(refused.stdout).toMatch(/Re-index source: 0 archive conversation\(s\) — at most 0 of the 3 cleared exchanges are indexed from them and can be re-created/);
    expect(refused.stdout).not.toMatch(/Cleared and re-created/);
    expect(refused.stderr).toMatch(/rebuild refused — nothing was changed\. 3 indexed exchange\(s\) from 3 file\(s\) cannot be re-created/);
    expect(refused.stderr).toMatch(/--allow-index-loss/);
    expect(state()).toEqual(before);
    expect(backups()).toEqual([]);

    const allowed = run('rebuild', '--yes', '--allow-index-loss');
    expect(allowed.status, allowed.stderr + allowed.stdout).toBe(0);
    expect(state()).toMatchObject({ facts: before.facts, relations: 1, exchanges: 0, toolCalls: 0, vectors: 0 });
    const lost = backups().filter((f) => f.startsWith('pre-rebuild-unreachable-exchanges-'));
    expect(lost).toHaveLength(1);
    const bak = new Database(path.join(cfg, 'conversation-index', 'backups', lost[0]), { readonly: true });
    try {
      expect(bak.prepare('SELECT id FROM exchanges ORDER BY id').all()).toEqual([{ id: 'ex-0' }, { id: 'ex-1' }, { id: 'ex-2' }]);
      expect((bak.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n).toBe(3);
    } finally {
      bak.close();
    }
  });

  it('repair keeps rows whose file is gone; --prune-missing backs them up and deletes them', () => {
    const before = state();
    const kept = run('repair');
    expect(kept.status, kept.stderr + kept.stdout).toBe(0);
    expect(kept.stdout).toMatch(/3 index row\(s\) point at a file that is gone — kept/);
    expect(state()).toEqual(before);
    expect(backups()).toEqual([]);

    const pruned = run('repair', '--prune-missing');
    expect(pruned.status, pruned.stderr + pruned.stdout).toBe(0);
    expect(pruned.stdout).toMatch(/index rows whose file is gone: 3 — 3 will be backed up, then deleted/);
    expect(state()).toMatchObject({ exchanges: 0, toolCalls: 0, vectors: 0, relations: 1 });
    const made = backups().filter((f) => f.startsWith('prune-missing-'));
    expect(made).toHaveLength(1);
    const bak = new Database(path.join(cfg, 'conversation-index', 'backups', made[0]), { readonly: true });
    try {
      expect((bak.prepare('SELECT count(*) AS n FROM exchanges').get() as { n: number }).n).toBe(3);
      expect((bak.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n).toBe(3);
    } finally {
      bak.close();
    }
  });

  it('a mistyped flag stops repair and rebuild before anything is opened', () => {
    const before = state();
    for (const args of [['repair', '--prune-mising'], ['repair', '--prune-missing', '--yse'], ['rebuild', '--yes', '--reset-summarys'], ['rebuild', '--yes', '--allow-index-los']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/unknown argument/);
    }
    expect(state()).toEqual(before);
    expect(backups()).toEqual([]);
  });
});
