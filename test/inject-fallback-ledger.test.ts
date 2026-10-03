import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';

/**
 * 대체 경로(데몬 없음)도 블록을 출력한 뒤 원장에 기록한다 (2026-10-03, v1.7.4 독립 검토 지적).
 * 소켓 시험의 대체 경로는 빈 DB 라 실을 fact 가 없어 「기록한다」 쪽을 검사하지 못했다.
 * 여기서는 실제 모델로 fact 를 넣은 DB 를 두고 클라이언트를 데몬 없이 띄운다.
 */

const restoreConsole = suppressConsole();
const REPO = path.resolve(__dirname, '..');
const FACT = 'The deploy pipeline publishes a Vercel preview for every pull request before merge';
const PROMPT = 'How does our deploy pipeline publish Vercel previews for pull requests?';
const prevEnv = { ...process.env };
let tmp: string;
let dbPath: string;
let factId: string;

const ledgerFile = (sid: string) => path.join(tmp, 'conversation-index', 'state', 'inject-ledger', `${sid}.json`);

function runClient(sessionId: string, closeStdout = false): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/inject-context.js'], {
      cwd: REPO,
      env: { ...process.env, MEMORY_BANK_CONFIG_DIR: tmp, MEMORY_BANK_DB_PATH: dbPath, TEST_DB_PATH: dbPath, MEMORY_BANK_CLIENT: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    if (closeStdout) child.stdout!.destroy(); // 받는 쪽이 먼저 떠났다
    else child.stdout!.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
    child.stdin!.end(JSON.stringify({ prompt: PROMPT, cwd: '/tmp/proj', session_id: sessionId, hook_event_name: 'UserPromptSubmit' }));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync('/tmp/mbfb-'); // 짧은 경로: 데몬 소켓 이름이 104바이트를 넘지 않게(여기엔 데몬이 없다)
  dbPath = path.join(tmp, 't.sqlite');
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.TEST_DB_PATH = dbPath;
  const { initDatabase } = await import('../src/db.js');
  const { insertFact } = await import('../src/fact-db.js');
  const { initEmbeddings, generateEmbedding } = await import('../src/embeddings.js');
  await initEmbeddings();
  const db = initDatabase();
  try {
    factId = insertFact(db, {
      fact: FACT, category: 'decision', scope_type: 'global', scope_project: null,
      source_exchange_ids: [], embedding: await generateEmbedding(FACT, 'passage'),
    });
  } finally {
    db.close();
  }
}, 120_000);

afterAll(() => {
  process.env = prevEnv;
  restoreConsole();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('대체 경로의 원장 기록', () => {
  it('데몬이 없으면 직접 계산해 블록을 출력하고, 그 fact 를 원장에 기록한다', async () => {
    const out = await runClient('sess-fb-deliver');
    expect(out).toContain('deploy pipeline publishes a Vercel preview');
    expect(fs.existsSync(ledgerFile('sess-fb-deliver')), '출력한 블록의 원장').toBe(true);
    expect(JSON.parse(fs.readFileSync(ledgerFile('sess-fb-deliver'), 'utf8'))).toContain(factId);
  }, 60_000);

  it('출력을 받는 쪽이 떠났으면 대체 경로도 원장에 기록하지 않는다', async () => {
    await runClient('sess-fb-epipe', true);
    expect(fs.existsSync(ledgerFile('sess-fb-epipe'))).toBe(false);
  }, 60_000);
});
