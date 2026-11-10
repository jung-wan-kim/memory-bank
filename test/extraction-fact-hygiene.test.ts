import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 추출 결과의 위생 (2026-11-10) — 저장 전에 걸러지거나 고쳐지는 것들.
 *
 *  - 프롬프트 예시 문장·자리표시자를 그대로 베낀 사실: 버린다
 *  - 세션 환경만 말하는 문장(작업 폴더·git 저장소·브랜치): 버린다
 *  - 한글 문장 칸만 자리표시자인 사실: 그 칸만 비우고 저장한다
 *  - 다섯 분류 밖의 category: 접어서 저장한다
 * 버린 것은 사유별로 세어 결과에 싣는다(워커가 로그에 남긴다).
 */

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

const stored = () => db.prepare('SELECT fact, fact_kr, category FROM facts ORDER BY rowid').all() as
  Array<{ fact: string; fact_kr: string | null; category: string }>;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fact-hygiene-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
  const ins = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  for (let i = 0; i < 2; i++) {
    ins.run(`hyg-${i}`, '/tmp/hyg', `2026-10-01T0${i}:00:00.000Z`,
      '배포는 어느 브랜치에서 하고, 릴리스 태그는 누가 찍는지 정해 주세요.',
      '배포는 main 브랜치에서만 하고, 릴리스 태그는 CI 가 찍도록 정했습니다. 수동 태그는 금지합니다.',
      `/tmp/hyg-${i}.jsonl`, 1, 10, 'S-hygiene');
  }
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('추출 결과의 위생', () => {
  it('예시·자리표시자·환경 상용구는 버리고 사유별로 센다', async () => {
    reply = [
      { fact: 'User uses Riverpod for state management', fact_kr: '사용자는 상태 관리에 Riverpod을 사용한다',
        category: 'decision', scope_type: 'project', confidence: 0.9 },
      { fact: '<one English sentence stating the fact>', category: 'decision', scope_type: 'project', confidence: 0.9 },
      { fact: 'Project is located at /tmp/hyg', category: 'knowledge', scope_type: 'project', confidence: 0.95 },
      { fact: 'The project is a git repository on the main branch.', category: 'knowledge', scope_type: 'project', confidence: 0.95 },
      { fact: 'Deploys run from the main branch only.', category: 'constraint', scope_type: 'project', confidence: 0.9 },
    ];
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-hygiene', '/tmp/hyg');

    expect(stored().map((r) => r.fact)).toEqual(['Deploys run from the main branch only.']);
    expect(result.saved).toBe(1);
    expect(result.rejectedInvalid).toEqual({
      'fact-prompt-example': 1, 'fact-bracket-placeholder': 1, 'fact-session-environment': 2,
    });
  });

  it('한글 문장 칸만 자리표시자면 그 칸만 비우고 사실은 저장한다', async () => {
    reply = [
      { fact: 'Release tags are created by CI, never by hand.', fact_kr: '<the same sentence in natural Korean>',
        category: 'constraint', scope_type: 'project', confidence: 0.9 },
      { fact: 'Deploys run from the main branch only.', fact_kr: '배포는 main 브랜치에서만 한다',
        category: 'constraint', scope_type: 'project', confidence: 0.9 },
    ];
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, 'S-hygiene', '/tmp/hyg');

    expect(stored()).toEqual([
      { fact: 'Release tags are created by CI, never by hand.', fact_kr: null, category: 'constraint' },
      { fact: 'Deploys run from the main branch only.', fact_kr: '배포는 main 브랜치에서만 한다', category: 'constraint' },
    ]);
    expect(result.rejectedInvalid).toBeUndefined();
  });

  it('다섯 분류 밖의 category 는 접어서 저장한다', async () => {
    reply = [
      { fact: 'Release tags must be created by CI.', category: 'requirement', scope_type: 'project', confidence: 0.9 },
      { fact: 'Hotfixes follow the same review process as features.', category: 'Process', scope_type: 'project', confidence: 0.9 },
      { fact: 'The release checklist lives in docs/release.md.', category: 'observation', scope_type: 'project', confidence: 0.9 },
      { fact: 'Deploys run from the main branch only.', category: 'constraint', scope_type: 'project', confidence: 0.9 },
    ];
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    await runFactExtraction(db, 'S-hygiene', '/tmp/hyg');

    expect(stored().map((r) => r.category)).toEqual(['constraint', 'pattern', 'knowledge', 'constraint']);
  });
});
