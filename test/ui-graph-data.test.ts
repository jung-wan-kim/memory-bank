import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * REL-8: the dashboard's first page (`/`) computes /api/graph-data before it
 * answers, and better-sqlite3 is synchronous — while a query runs the whole
 * server stands still. The project connections used to self-join `exchanges`
 * on session_id: rows-per-session squared. One long session shared by two
 * projects (a real archive has one of 66,101 exchanges) never came back.
 *
 * Two things are pinned here:
 *  1. the response is what the original SQL returns (same keys, same rows) —
 *     the original statements are kept below as the definition;
 *  2. a long shared session answers at once, with the pair count the join
 *     would have produced.
 *
 * The server is a real child process on a free port, reading a seeded database
 * in a temp config dir with a temp HOME.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'ui', 'server.cjs');

/** The statements /api/graph-data ran up to v1.7.9 — what the response must still equal. */
const ORIGINAL = {
  projects: `
    SELECT project, COUNT(*) as exchanges, COUNT(DISTINCT session_id) as sessions,
           MIN(timestamp) as first_seen, MAX(timestamp) as last_seen,
           COUNT(DISTINCT git_branch) as branches
    FROM exchanges GROUP BY project ORDER BY exchanges DESC`,
  toolUsage: `
    SELECT e.project, tc.tool_name, COUNT(*) as cnt
    FROM tool_calls tc JOIN exchanges e ON tc.exchange_id = e.id
    GROUP BY e.project, tc.tool_name ORDER BY cnt DESC`,
  connections: `
    SELECT DISTINCT e1.project as source, e2.project as target, COUNT(*) as strength
    FROM exchanges e1 JOIN exchanges e2 ON e1.session_id = e2.session_id AND e1.project < e2.project
    GROUP BY e1.project, e2.project HAVING strength > 2`,
  allTools: `
    SELECT tool_name, COUNT(*) as cnt FROM tool_calls GROUP BY tool_name ORDER BY cnt DESC LIMIT 50`,
};

// Exchanges of the long session in each of its two projects: 8,000 x 8,000 = 64 million row pairs for the old join.
const LONG_SESSION_ROWS = 8_000;
// Far above what the page needs on this fixture (tens of milliseconds), far below what the old join took.
const ANSWER_WITHIN_MS = 10_000;

let tmp: string;
let configDir: string;
let fakeHome: string;
let dbPath: string;
const running: ChildProcess[] = [];

interface Started { port: number; kill: () => void }
interface Reply { status: number; body: string; ms: number }

function startServer(): Promise<Started> {
  return new Promise((resolve, reject) => {
    // Built from scratch: nothing of the developer's shell (HOME, config dir, tokens) reaches the server.
    const env = { PATH: process.env.PATH, HOME: fakeHome, MEMORY_BANK_CONFIG_DIR: configDir, PORT: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server did not report its listen address within 15s. Output:\n${output}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const main = /Listening on \S+:(\d+) /.exec(output);
      if (!settled && main) {
        settled = true;
        clearTimeout(timer);
        // SIGKILL: a server stuck in a synchronous query does not get to its SIGTERM handler.
        resolve({ port: Number(main[1]), kill: () => { child.kill('SIGKILL'); } });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening. Output:\n${output}`));
    });
  });
}

function get(port: number, urlPath: string, timeoutMs = ANSWER_WITHIN_MS): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${urlPath} within ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Rows in an order that does not depend on how ties were broken. */
function sorted<T>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

type Rows = Array<Record<string, unknown>>;

function reference(): Record<keyof typeof ORIGINAL, Rows> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const run = (sql: string) => db.prepare(sql).all() as Rows;
    return { projects: run(ORIGINAL.projects), toolUsage: run(ORIGINAL.toolUsage), connections: run(ORIGINAL.connections), allTools: run(ORIGINAL.allTools) };
  } finally {
    db.close();
  }
}

/** Opens the fixture database through the real schema. */
async function withFixtureDb(fn: (db: Database.Database) => void): Promise<void> {
  const savedDbPath = process.env.MEMORY_BANK_DB_PATH;
  const savedTestDbPath = process.env.TEST_DB_PATH;
  delete process.env.TEST_DB_PATH;
  process.env.MEMORY_BANK_DB_PATH = dbPath;
  try {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try { fn(db); } finally { db.close(); }
  } finally {
    if (savedDbPath === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = savedDbPath;
    if (savedTestDbPath !== undefined) process.env.TEST_DB_PATH = savedTestDbPath;
  }
}

let nextExchange = 0;
function insertExchanges(db: Database.Database, rows: Array<{ project: string; session: string | null; branch: string | null; count: number }>): string[] {
  const insert = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, git_branch)
    VALUES (?, ?, ?, 'question', 'answer', '/archive/fixture.jsonl', ?, ?, ?, ?)`);
  const ids: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      for (let i = 0; i < row.count; i++) {
        const n = nextExchange++;
        const id = `gx-${n}`;
        insert.run(id, row.project, new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), n * 2 + 1, n * 2 + 2, row.session, row.branch);
        ids.push(id);
      }
    }
  })();
  return ids;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ui-graph-'));
  configDir = path.join(tmp, 'config');
  fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  dbPath = path.join(configDir, 'conversation-index', 'db.sqlite');

  await withFixtureDb((db) => {
    const ids = insertExchanges(db, [
      // s1: alpha x2, beta x3 -> alpha|beta 6
      { project: 'alpha', session: 's1', branch: 'main', count: 2 },
      { project: 'beta', session: 's1', branch: 'main', count: 3 },
      // s2: one each -> alpha|beta +1, alpha|gamma 1, beta|gamma 1
      { project: 'alpha', session: 's2', branch: 'dev', count: 1 },
      { project: 'beta', session: 's2', branch: 'main', count: 1 },
      { project: 'gamma', session: 's2', branch: null, count: 1 },
      // s3: beta x2, gamma x2 -> beta|gamma +4. alpha|gamma stays 1: below the `strength > 2` cut.
      { project: 'beta', session: 's3', branch: '', count: 2 },
      { project: 'gamma', session: 's3', branch: null, count: 2 },
      // a project of its own
      { project: 'solo', session: 's4', branch: 'main', count: 4 },
      // no session id: counted as exchanges, never as a session or a connection
      { project: 'no-session', session: null, branch: 'main', count: 3 },
      { project: 'alpha', session: null, branch: null, count: 2 },
      // names beyond ASCII: source/target follow SQLite's byte order
      { project: '가나다', session: 's5', branch: 'main', count: 2 },
      { project: 'zeta', session: 's5', branch: 'feature/x', count: 2 },
    ]);
    const call = db.prepare(`INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
      VALUES (?, ?, ?, '{}', 'ok', 0, '2026-01-01T00:00:00.000Z')`);
    // By exchange index: alpha 0,1,5,19,20 · beta 2,3,4,6,8,9 · gamma 7,10,11 · solo 12..15 · 가나다 21,22.
    const calls: Array<[number, string]> = [
      [0, 'Read'], [0, 'Read'], [0, 'Bash'], [1, 'Read'], [5, 'Edit'], [19, 'Read'],
      [2, 'Read'], [3, 'Read'], [6, 'Bash'], [8, 'Bash'],
      [7, 'Grep'], [10, 'Grep'],
      [12, 'Bash'], [12, 'Bash'], [13, 'Bash'],
      [21, 'Read'],
    ];
    db.transaction(() => { calls.forEach(([index, tool], n) => call.run(`gt-${n}`, ids[index], tool)); })();
  });
}, 60_000);

afterAll(() => {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/api/graph-data', () => {
  it('returns what the original statements return: same keys, same rows', async () => {
    const server = await startServer();
    try {
      const reply = await get(server.port, '/api/graph-data');
      expect(reply.status).toBe(200);
      const data = JSON.parse(reply.body);
      expect(Object.keys(data)).toEqual(['projects', 'toolUsage', 'connections', 'timeline', 'allTools', 'facts', 'domains', 'relations']);
      expect(data.timeline).toEqual([]);

      const want = reference();
      // The fixture exercises every clause: the cut, sessions without an id, branches that are NULL or ''.
      expect(sorted(want.connections)).toEqual(sorted([
        { source: 'alpha', target: 'beta', strength: 7 },
        { source: 'beta', target: 'gamma', strength: 5 },
        { source: 'zeta', target: '가나다', strength: 4 },
      ]));
      expect(want.projects.find((p) => p.project === 'alpha')).toEqual({
        project: 'alpha', exchanges: 5, sessions: 2, first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:20.000Z', branches: 2,
      });
      expect(want.projects.find((p) => p.project === 'gamma')).toMatchObject({ exchanges: 3, sessions: 2, branches: 0 });
      expect(want.projects.find((p) => p.project === 'no-session')).toMatchObject({ exchanges: 3, sessions: 0, branches: 1 });

      expect(sorted(data.projects)).toEqual(sorted(want.projects));
      expect(sorted(data.toolUsage)).toEqual(sorted(want.toolUsage));
      expect(sorted(data.connections)).toEqual(sorted(want.connections));
      expect(sorted(data.allTools)).toEqual(sorted(want.allTools));
      // Key order is part of the shape the page reads.
      expect(Object.keys(data.projects[0])).toEqual(Object.keys(want.projects[0]));
      expect(Object.keys(data.toolUsage[0])).toEqual(Object.keys(want.toolUsage[0]));
      expect(Object.keys(data.connections[0])).toEqual(Object.keys(want.connections[0]));
      // Largest first, as before.
      const counts = (rows: Array<Record<string, number>>, key: string) => rows.map((r) => r[key]);
      expect(counts(data.projects, 'exchanges')).toEqual([...counts(data.projects, 'exchanges')].sort((a, b) => b - a));
      expect(counts(data.toolUsage, 'cnt')).toEqual([...counts(data.toolUsage, 'cnt')].sort((a, b) => b - a));

      // Asking again gives the same answer (nothing is left behind by the first call).
      const again = await get(server.port, '/api/graph-data');
      expect(again.status).toBe(200);
      expect(JSON.parse(again.body)).toEqual(data);
    } finally {
      server.kill();
    }
  }, 60_000);

  it('answers at once when two projects share one long session', async () => {
    await withFixtureDb((db) => {
      insertExchanges(db, [
        { project: 'tall', session: 's-long', branch: 'main', count: LONG_SESSION_ROWS },
        { project: 'wide', session: 's-long', branch: 'main', count: LONG_SESSION_ROWS },
      ]);
    });
    const server = await startServer();
    try {
      const reply = await get(server.port, '/api/graph-data');
      expect(reply.status).toBe(200);
      const data = JSON.parse(reply.body);
      // The number of row pairs the join would have walked, without walking them.
      expect(data.connections).toContainEqual({ source: 'tall', target: 'wide', strength: LONG_SESSION_ROWS * LONG_SESSION_ROWS });
      expect(data.connections).toContainEqual({ source: 'alpha', target: 'beta', strength: 7 });
      expect(data.connections).toHaveLength(4);
      expect(data.projects.find((p: { project: string }) => p.project === 'tall')).toMatchObject({ exchanges: LONG_SESSION_ROWS, sessions: 1, branches: 1 });

      // The first page of the dashboard is the same computation, and the server is free again right after.
      const page = await get(server.port, '/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('"strength":' + LONG_SESSION_ROWS * LONG_SESSION_ROWS);
      expect((await get(server.port, '/api/stats', 5_000)).status).toBe(200);
    } finally {
      server.kill();
    }
  }, 120_000);
});
