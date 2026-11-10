import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 자격증명이 든 사실은 저장 직전에 거부한다 (2026-11-10).
 *
 * 추출 LLM 이 대화의 봇 토큰을 문장에 그대로 넣었고 저장 경로에 판정이 없어 활성
 * 사실로 남았다. 새 사실이 들어오는 두 문(추출 저장, sync 가져오기)에서 거부하고
 * 건수를 센다 — 로그에는 종류만 남기고 값은 남기지 않는다.
 */

const j = (...parts: string[]) => parts.join('');
// 지어낸 값. 저장소의 비밀값 검사에 걸리지 않게 조각으로 만든다.
const BOT_TOKEN = j('1234567890', ':', 'AAF', 'x9Qw'.repeat(8));
const API_KEY = j('s', 'k-', 'A1b2C3d4E5f6G7h8I9j0K1l2');

let reply: unknown[] = [];
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => JSON.stringify(reply),
}));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
}));

let tmp: string;
let db: import('better-sqlite3').Database;
let logged: string[];
let restoreError: () => void;

function allFactText(): string {
  return (db.prepare('SELECT fact, fact_kr FROM facts').all() as Array<{ fact: string; fact_kr: string | null }>)
    .map((r) => `${r.fact}\n${r.fact_kr ?? ''}`).join('\n');
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-secret-reject-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
  const ins = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  for (let i = 0; i < 2; i++) {
    ins.run(`sec-${i}`, '/tmp/sec', `2026-10-01T0${i}:00:00.000Z`,
      '완료 알림을 텔레그램으로 보내도록 설정해 주세요. 봇 설정은 전역 설정 파일에 있습니다.',
      '전역 설정 파일의 봇 설정을 읽어 완료 알림을 보내도록 했습니다. 재시도는 세 번까지 합니다.',
      `/tmp/sec-${i}.jsonl`, 1, 10, 'S-secret');
  }
  // console.error 로 나가는 문장을 모은다 — 값이 로그로 새지 않는지 본다.
  logged = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  restoreError = () => { console.error = original; };
});
afterEach(() => {
  restoreError();
  try { db.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('추출 저장 경로', () => {
  it('자격증명이 든 사실(영문·한글 어느 쪽이든)은 저장하지 않고 수를 돌려준다', async () => {
    reply = [
      { fact: 'User wants a Telegram notification after every finished task.', fact_kr: '사용자는 작업이 끝날 때마다 텔레그램 알림을 원한다',
        category: 'preference', scope_type: 'global', confidence: 0.9 },
      { fact: `User keeps the bot credentials (Token: ${BOT_TOKEN}) in the global config file.`,
        category: 'knowledge', scope_type: 'project', confidence: 0.95 },
      { fact: 'The notification script reads its key from the global config file.', fact_kr: `알림 스크립트의 키는 ${API_KEY} 이다`,
        category: 'knowledge', scope_type: 'project', confidence: 0.9 },
    ];
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-secret', '/tmp/sec');

    expect(result.saved).toBe(1);
    expect(result.extracted).toBe(1);
    expect(result.rejectedSecrets).toBe(2);
    const stored = allFactText();
    expect(stored).toContain('Telegram notification after every finished task');
    expect(stored).not.toContain(BOT_TOKEN);
    expect(stored).not.toContain(API_KEY);
  });

  it('거부 로그에는 종류와 건수만 있고 값은 없다', async () => {
    reply = [
      { fact: `Bot token is ${BOT_TOKEN}.`, category: 'knowledge', scope_type: 'project', confidence: 0.95 },
    ];
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    await runFactExtraction(db, 'S-secret', '/tmp/sec');

    const all = logged.join('\n');
    expect(all).toMatch(/secret-telegram-bot-token/);
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).not.toContain(BOT_TOKEN.slice(11, 31));
  });

  it('saveExtractedFacts 를 직접 불러도 자격증명이 든 사실은 들어가지 않는다 (저장 직전 판정)', async () => {
    const { saveExtractedFacts } = await import('../src/fact-extractor.js');
    const ids = await saveExtractedFacts(db, [
      { fact: `Deploy key: ${API_KEY}`, category: 'knowledge', scope_type: 'project', confidence: 0.9 },
      { fact: 'Deploys run from the main branch only.', category: 'constraint', scope_type: 'project', confidence: 0.9 },
    ], '/tmp/sec', ['sec-0']);

    expect(ids).toHaveLength(1);
    const stored = allFactText();
    expect(stored).toContain('Deploys run from the main branch only.');
    expect(stored).not.toContain(API_KEY);
  });
});

describe('sync 가져오기 경로', () => {
  it('다른 기기가 내보낸 자격증명 사실은 들이지 않고 수와 종류를 돌려준다', async () => {
    db.close();
    const { getSyncDir } = await import('../src/sync-export.js');
    const now = '2026-10-01T00:00:00.000Z';
    const row = (id: string, fact: string, fact_kr: string | null = null) => JSON.stringify({
      id, fact, fact_kr, category: 'knowledge', scope_type: 'global', scope_project: null,
      source_exchange_ids: '[]', created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
    });
    fs.writeFileSync(path.join(getSyncDir(), 'facts.jsonl'), [
      row('ok-fact', 'Public APIs use REST.'),
      row('secret-fact', `User keeps the bot credentials (Token: ${BOT_TOKEN}) in the config file.`),
      row('secret-kr-fact', 'The deploy key lives in the vault.', `배포 키는 ${API_KEY} 이다`),
    ].join('\n') + '\n');

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newFacts).toBe(1);
    expect(result.rejectedSecrets).toBe(2);
    expect(result.rejectedSecretReasons).toEqual({ 'secret-telegram-bot-token': 1, 'secret-api-key': 1 });
    expect(result.rejectedJunk, '템플릿 잔여물 집계와 섞이지 않는다').toBe(0);

    const { initDatabase } = await import('../src/db.js');
    db = initDatabase();
    const ids = (db.prepare('SELECT id FROM facts ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['ok-fact']);
    expect(logged.join('\n')).not.toContain(BOT_TOKEN);
    expect(logged.join('\n')).not.toContain(API_KEY);
  });
});
