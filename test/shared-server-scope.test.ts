import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QUERY_VECTOR, vecAt } from './helpers/search-seed.js';
import { LineClient, openSession, shortTmpDir, toolText } from './helpers/shared-harness.js';

// TC-SCOPE-001 — the real tools behind one shared server, two sessions in different projects calling at the
// same time. A tool called without `project` must answer for the project of the session that called it:
// the facts of the other session's project never show up, whatever the interleaving.

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  embeddingsReady: vi.fn(() => true),
  generateEmbedding: vi.fn(async () => QUERY_VECTOR),
}));

const IDENTITY = 'c0ffee00' + '1'.repeat(56);
const VERSION = '9.9.9';
const A = '/work/project-a';
const B = '/work/project-b';

let dir: string;
let socketPath: string;
let close: () => Promise<void>;
const clients: LineClient[] = [];
const prevDb = process.env.MEMORY_BANK_DB_PATH;

async function session(cwd: string | null): Promise<LineClient> {
  const c = await openSession(socketPath, { identity: IDENTITY, version: VERSION, cwd });
  clients.push(c);
  return c;
}

let seq = 0;
async function call(c: LineClient, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await c.request(`c${seq++}`, 'tools/call', { name, arguments: args });
  return { text: toolText(response), isError: response.result?.isError === true };
}

beforeAll(async () => {
  dir = shortTmpDir();
  process.env.MEMORY_BANK_DB_PATH = path.join(dir, 'db.sqlite');
  socketPath = path.join(dir, 'mb-shared-9.9.9-c0ffee00.sock');

  const { initDatabase } = await import('../src/db.js');
  const { insertFact, setFactTags } = await import('../src/fact-db.js');
  const db = initDatabase();
  let axis = 0;
  const seed = (text: string, theta: number, scope: 'global' | 'project', project: string | null, tag: string) => {
    const id = insertFact(db, {
      fact: text, category: 'knowledge', scope_type: scope, scope_project: project,
      source_exchange_ids: [], embedding: vecAt(theta, 1 + (axis++ % 300)),
    });
    setFactTags(db, id, [tag]);
  };
  // The other project's facts are the NEAREST to the query: a scope that leaks ranks them first.
  for (let i = 0; i < 6; i++) seed(`BRAVO-ONLY deploy rule number ${i} for the bravo service`, 0.05 + i * 0.01, 'project', B, 'bravo-tag');
  for (let i = 0; i < 6; i++) seed(`ALPHA-ONLY deploy rule number ${i} for the alpha service`, 0.06 + i * 0.01, 'project', A, 'alpha-tag');
  for (let i = 0; i < 3; i++) seed(`GLOBAL deploy habit number ${i} kept everywhere`, 0.2 + i * 0.01, 'global', null, 'shared-tag');
  db.close();

  const { startSharedServer } = await import('../src/shared-server-core.js');
  const { createMemoryBankServer } = await import('../src/server-core.js');
  const result = await startSharedServer({
    socketPath, identity: IDENTITY, version: VERSION, createServer: createMemoryBankServer,
    idleMs: 60_000, tickMs: 60_000, onStop: () => {},
  });
  if (result.kind !== 'serving') throw new Error(`server did not start: ${JSON.stringify(result)}`);
  close = result.handle.close;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await close?.();
  if (prevDb === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prevDb;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Side { name: string; cwd: string; mine: string; theirs: string; myTag: string; theirTag: string }
const SIDE_A: Side = { name: 'A', cwd: A, mine: 'ALPHA-ONLY', theirs: 'BRAVO-ONLY', myTag: 'alpha-tag', theirTag: 'bravo-tag' };
const SIDE_B: Side = { name: 'B', cwd: B, mine: 'BRAVO-ONLY', theirs: 'ALPHA-ONLY', myTag: 'bravo-tag', theirTag: 'alpha-tag' };

/** The four tools with a project default, called without `project`, checked against the caller's side. */
async function defaultsRound(c: LineClient, side: Side, label: string): Promise<number> {
  const [facts, tags, tagged, trace, cross] = await Promise.all([
    call(c, 'search_facts', { query: 'deploy rule' }),
    call(c, 'list_tags', {}),
    call(c, 'list_tags', { tags: [side.myTag, side.theirTag], match: 'any' }),
    call(c, 'trace_fact', { query: 'deploy rule' }),
    call(c, 'cross_project_insights', { query: 'deploy rule' }),
  ]);
  for (const [tool, answer] of Object.entries({ facts, tags, tagged, trace, cross })) {
    expect(answer.isError, `${label} ${side.name} ${tool}: ${answer.text.slice(0, 200)}`).toBe(false);
  }

  expect(facts.text, `${label} search_facts header`).toContain(`Project: ${side.cwd}`);
  expect(facts.text).toContain(side.mine);
  expect(facts.text).toContain('GLOBAL deploy habit');
  expect(facts.text, `${label} search_facts leaked the other project`).not.toContain(side.theirs);

  expect(tags.text).toContain(`Project: ${side.cwd}`);
  expect(tags.text).toContain(side.myTag);
  expect(tags.text).toContain('shared-tag');
  expect(tags.text, `${label} list_tags leaked the other project's tag`).not.toContain(side.theirTag);

  expect(tagged.text).toContain(side.mine);
  expect(tagged.text, `${label} list_tags(tags) leaked the other project`).not.toContain(side.theirs);

  expect(trace.text, `${label} trace_fact leaked the other project`).not.toContain(side.theirs);
  expect(trace.text).toContain(side.mine);

  // cross_project_insights is the mirror: it shows OTHER projects and leaves the caller's own out.
  expect(cross.text).toContain(`Excluding: ${side.cwd}`);
  expect(cross.text).toContain(side.theirs);
  expect(cross.text, `${label} cross_project_insights showed the caller's own project`).not.toContain(side.mine);
  return 5;
}

describe('two sessions on one shared server keep their own project', () => {
  it('50 rounds of both sessions calling at once: no fact of the other project in any answer', async () => {
    const a = await session(A);
    const b = await session(B);
    let checked = 0;
    for (let round = 0; round < 50; round++) {
      const [x, y] = await Promise.all([defaultsRound(a, SIDE_A, `round ${round}`), defaultsRound(b, SIDE_B, `round ${round}`)]);
      checked += x + y;
    }
    expect(checked).toBe(500);
  }, 120_000);

  it('an explicit project is honoured as given, from either session', async () => {
    const a = await session(A);
    const asB = await call(a, 'search_facts', { query: 'deploy rule', project: B });
    expect(asB.text).toContain(`Project: ${B}`);
    expect(asB.text).toContain('BRAVO-ONLY');
    expect(asB.text).not.toContain('ALPHA-ONLY');
    const back = await call(a, 'search_facts', { query: 'deploy rule' });
    expect(back.text, 'the explicit call left nothing behind').toContain(`Project: ${A}`);
    expect(back.text).not.toContain('BRAVO-ONLY');
  });

  it('a third session in a project with no facts sees the global ones only', async () => {
    const c = await session('/work/project-c');
    const facts = await call(c, 'search_facts', { query: 'deploy rule' });
    expect(facts.text).toContain('Project: /work/project-c');
    expect(facts.text).toContain('GLOBAL deploy habit');
    expect(facts.text).not.toMatch(/ALPHA-ONLY|BRAVO-ONLY/);
  });
});

describe('TC-SCOPE-002 — a session whose working directory is unknown (cwd: null)', () => {
  it('the tools that need the default project say so; nothing answers for "every project"', async () => {
    const blind = await session(null);
    for (const [tool, args, argument] of [
      ['search_facts', { query: 'deploy rule' }, 'project'],
      ['list_tags', {}, 'project'],
      ['trace_fact', { query: 'deploy rule' }, 'project'],
      ['ask_avatar', { question: 'which deploy rule applies here?' }, 'project'],
      ['cross_project_insights', { query: 'deploy rule' }, 'current_project'],
    ] as const) {
      const answer = await call(blind, tool, args);
      expect(answer.isError, tool).toBe(true);
      expect(answer.text, tool).toContain(`pass \`${argument}\``);
      expect(answer.text, `${tool} answered with facts`).not.toMatch(/ALPHA-ONLY|BRAVO-ONLY|GLOBAL deploy habit/);
    }
  });

  it('the same session: a call that names its project works, and so do the tools without a project scope', async () => {
    const blind = await session(null);
    const named = await call(blind, 'search_facts', { query: 'deploy rule', project: A });
    expect(named.isError).toBe(false);
    expect(named.text).toContain('ALPHA-ONLY');
    expect(named.text).not.toContain('BRAVO-ONLY');
    const stats = await call(blind, 'graph_stats', {});
    expect(stats.isError).toBe(false);
    expect(stats.text).toMatch(/15/); // every active fact, whatever its project
  });
});
