import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 비밀값 거부가 놓치던 네 가지 꼴 (검수 CE-03 · SEC-3, 2026-11-11).
 *
 * 봇 API URL 안의 텔레그램 토큰, Slack 웹훅 URL, Stripe 키, DB 접속 URL 의 비밀번호가
 * 저장 직전 판정·sync 가져오기·정리 스크립트(dry-run) 세 곳을 모두 통과했다. 배선은
 * 멀쩡했고 구멍은 규칙이었다 — 그래서 규칙 단위 테스트(test/secret-scan.test.ts)와 따로,
 * 세 문 각각에서 네 꼴이 실제로 막히는지를 여기서 고정한다.
 *
 * 값은 모두 지어낸 것이고, 저장소의 비밀값 검사에 걸리지 않게 실행 때 조각을 이어 만든다.
 */

const j = (...parts: string[]) => parts.join('');
const BODY = 'q7Zp2LmX9vTr4KbN8sWdE3fG';

const SHAPES: Array<{ name: string; kind: string; value: string; fact: (v: string) => string }> = [
  {
    name: '봇 API URL 안의 텔레그램 토큰',
    kind: 'secret-telegram-bot-token',
    value: j('1234567890', ':', 'AAF', 'x9Qw'.repeat(8)),
    fact: (v) => `Notifications are sent with curl ${j('https://api.', 'telegram.org/', 'bot')}${v}/sendMessage after each task.`,
  },
  {
    name: 'Slack 웹훅 URL',
    kind: 'secret-slack-webhook-url',
    value: j('hooks.', 'slack.com/services/', 'T', 'A1B2C3D4E', '/', 'B', 'F5G6H7J8K', '/', BODY),
    fact: (v) => `Build alerts post to https://${v} from the release script.`,
  },
  {
    name: 'Stripe 비밀 키',
    kind: 'secret-stripe-key',
    value: j('sk', '_live_', BODY, BODY),
    fact: (v) => `Billing uses the Stripe key ${v} in production.`,
  },
  {
    name: 'DB 접속 URL 의 비밀번호',
    kind: 'secret-url-credentials',
    value: j('postgres', '://app:', 'Xk29fLq8Zr71TbV4mN', '@db.internal:5432/main'),
    fact: (v) => `The staging database is at ${v} and is reset nightly.`,
  },
];

vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
// 저장 뒤의 온톨로지 분류는 LLM 을 부른다 — 이 테스트의 대상이 아니다.
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
  classifyAndLinkFacts: async () => {},
}));
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => '[]',
}));

let tmp: string;
let logged: string[];
let restoreError: () => void;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-secret-shapes-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  logged = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  restoreError = () => { console.error = original; };
});
afterEach(() => {
  restoreError();
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('새 꼴 4종이 세 문에서 모두 막힌다', () => {
  it('저장 직전 판정(saveExtractedFacts): 네 사실은 들어가지 않고 평범한 사실만 남는다', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { saveExtractedFacts } = await import('../src/fact-extractor.js');
    const db = initDatabase();
    try {
      const ids = await saveExtractedFacts(db, [
        ...SHAPES.map((s) => ({ fact: s.fact(s.value), category: 'knowledge', scope_type: 'project' as const, confidence: 0.9 })),
        { fact: 'Deploys run from the main branch only.', category: 'constraint', scope_type: 'project' as const, confidence: 0.9 },
      ], '/tmp/shapes', ['x-0']);

      expect(ids).toHaveLength(1);
      const stored = (db.prepare('SELECT fact FROM facts').all() as Array<{ fact: string }>).map((r) => r.fact).join('\n');
      expect(stored).toContain('Deploys run from the main branch only.');
      for (const s of SHAPES) expect(stored, s.name).not.toContain(s.value);
      // 거부 로그에는 종류만 있고 값은 없다
      const all = logged.join('\n');
      for (const s of SHAPES) {
        expect(all, s.name).toContain(s.kind);
        expect(all, s.name).not.toContain(s.value);
      }
    } finally {
      db.close();
    }
  });

  it('sync 가져오기: 네 줄은 들이지 않고 종류별로 센다 (한글 문장에만 있어도)', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const now = '2026-10-01T00:00:00.000Z';
    const row = (id: string, fact: string, fact_kr: string | null = null) => JSON.stringify({
      id, fact, fact_kr, category: 'knowledge', scope_type: 'global', scope_project: null,
      source_exchange_ids: '[]', created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
    });
    fs.writeFileSync(path.join(getSyncDir(), 'facts.jsonl'), [
      row('ok-fact', 'Public APIs use REST.'),
      ...SHAPES.map((s, i) => (i % 2 === 0
        ? row(`shape-${i}`, s.fact(s.value))
        : row(`shape-${i}`, 'The value is kept in the team vault.', `값은 ${s.value} 이다`))),
    ].join('\n') + '\n');

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newFacts).toBe(1);
    expect(result.rejectedSecrets).toBe(SHAPES.length);
    expect(result.rejectedSecretReasons).toEqual(Object.fromEntries(SHAPES.map((s) => [s.kind, 1])));

    const db = new Database(path.join(tmp, 't.sqlite'), { readonly: true });
    try {
      expect((db.prepare('SELECT id FROM facts ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['ok-fact']);
    } finally {
      db.close();
    }
    for (const s of SHAPES) expect(logged.join('\n'), s.name).not.toContain(s.value);
  });

  it('정리 스크립트 dry-run: 네 행을 모두 찾고 값은 출력하지 않는다', () => {
    const REPO = path.resolve(__dirname, '..');
    const dbPath = path.join(tmp, 'facts.sqlite');
    const T0 = '2026-06-12T03:04:05.678Z';
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE facts (
        id TEXT PRIMARY KEY, fact TEXT NOT NULL, fact_kr TEXT, category TEXT, scope_type TEXT, scope_project TEXT,
        source_exchange_ids TEXT, created_at TEXT, updated_at TEXT, consolidated_count INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1)`);
      const ins = db.prepare(`INSERT INTO facts (id, fact, fact_kr, category, scope_type, created_at, updated_at, is_active)
        VALUES (?, ?, ?, 'knowledge', 'global', ?, ?, 1)`);
      SHAPES.forEach((s, i) => ins.run(`shape-${i}`, s.fact(s.value), null, T0, T0));
      ins.run('fact-normal', 'Public APIs use REST.', null, T0, T0);
    } finally {
      db.close();
    }

    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'redact-secret-facts.mjs'), '--db', dbPath], {
      cwd: REPO, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'cfg'), MEMORY_BANK_DB_PATH: path.join(tmp, 'not-used.sqlite') },
    });
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status).toBe(0);
    SHAPES.forEach((s, i) => {
      expect(out, s.name).toContain(`shape-${i}\t${s.kind}\tactive\tfact\n`);
      expect(out, s.name).not.toContain(s.value);
    });
    expect(out).not.toMatch(/fact-normal/);
    expect(out).toMatch(/scanned 5 fact\(s\): 4 carry a credential-shaped string \(4 active, 0 inactive\)/);
  });
});
