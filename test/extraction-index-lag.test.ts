import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 색인 시점과 추출 시점의 어긋남 (2026-11-10).
 *
 * 색인은 SessionStart 의 sync 에서만 일어나는데 추출은 SessionEnd 에서 색인 DB 만
 * 읽었다. 그래서 정상 종료한 세션은 교환이 0개인 채로 추출이 돌아 "0건 완료" 마커가
 * 남고, 그 마커 때문에 backfill 도 그 세션을 영영 집지 않았다(훅 결과의 93.7% 가 0/0).
 *
 * 고정하는 계약:
 *  ① 색인된 교환이 0개인 세션에는 완료 마커를 쓰지 않는다 (skipped: 'not_indexed')
 *  ② 그 세션은 색인된 뒤 backfill 의 pending 에 잡힌다
 *  ③ 훅 워커는 추출 전에 그 세션을 색인하고, 그러면 추출이 실제로 돈다
 */

let calls = 0;
vi.mock('../src/llm.js', async (io) => ({
  ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => {
    calls++;
    return JSON.stringify([
      { fact: `index-lag-probe-${calls}`, category: 'decision', scope_type: 'project', confidence: 0.9 },
    ]);
  },
}));
vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
  generateExchangeEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock('../src/ontology-classifier.js', async (io) => ({
  ...(await io<typeof import('../src/ontology-classifier.js')>()),
  classifyAndLinkFact: async () => {},
}));

const SID = '4b1d6f0e-7a3c-4e52-9d18-6c0f2a9b5e71';
const SLUG = '-tmp-index-lag-project';
let tmp: string;
let db: import('better-sqlite3').Database;

/** 실질 교환 n 개짜리 대화 파일 한 줄씩(JSONL). 시각은 한 시간 전부터 1분 간격. */
function transcriptLines(sessionId: string, n: number, firstUserText?: string): string {
  const base = Date.now() - 2 * 60 * 60_000;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const meta = { isSidechain: false, sessionId, cwd: '/tmp/index-lag-project', version: '2.1.0', gitBranch: 'main' };
    lines.push(JSON.stringify({
      ...meta, type: 'user', uuid: `u-${i}`, parentUuid: null,
      timestamp: new Date(base + i * 60_000).toISOString(),
      message: { role: 'user', content: i === 0 && firstUserText ? firstUserText
        : `결제 서비스 저장소를 MySQL 에서 Postgres 로 옮길지 결정해야 합니다. 근거도 알려주세요 (${i})` },
    }));
    lines.push(JSON.stringify({
      ...meta, type: 'assistant', uuid: `a-${i}`, parentUuid: `u-${i}`,
      timestamp: new Date(base + i * 60_000 + 20_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text:
        `Postgres 로 옮기는 것을 권장합니다. JSONB 지원과 부분 인덱스가 결제 원장 조회에 필요하기 때문입니다 (${i}).` }] },
    }));
  }
  return lines.join('\n') + '\n';
}

function writeTranscript(content: string): string {
  const dir = path.join(tmp, 'projects', SLUG);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function markerRow(): { extracted: number; saved: number } | undefined {
  return db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?').get(SID) as
    { extracted: number; saved: number } | undefined;
}

function indexedCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?').get(SID) as { n: number }).n;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-index-lag-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  process.env.TEST_PROJECTS_DIR = path.join(tmp, 'projects');
  process.env.TEST_ARCHIVE_DIR = path.join(tmp, 'archive');
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  calls = 0;
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
  delete process.env.TEST_PROJECTS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('색인 안 된 세션의 추출', () => {
  it('완료 마커를 쓰지 않고 not_indexed 로 건너뛴다 (LLM 호출 없음)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const result = await runFactExtraction(db, SID, '/tmp/index-lag-project');

    expect(result.skipped, '색인 0건은 "0건 처리 완료"가 아니다').toBe('not_indexed');
    expect(result.saved).toBe(0);
    expect(markerRow(), '마커가 남으면 backfill 이 이 세션을 영영 집지 않는다').toBeUndefined();
    expect(calls).toBe(0);
  });

  it('건너뛴 세션은 색인된 뒤 backfill 의 pending 에 잡힌다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const { pendingExtractionCoreQuery } = await import('../src/pending-extraction.js');
    await runFactExtraction(db, SID, '/tmp/index-lag-project');

    // 이후 다른 세션 시작의 sync 가 이 세션을 색인한 상황
    const ins = db.prepare(`INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain, cwd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
    for (let i = 0; i < 3; i++) {
      ins.run(`lag-${i}`, SLUG, `2026-10-01T0${i}:00:00.000Z`,
        `결제 서비스 저장소를 Postgres 로 옮기기로 했습니다 (${i})`, `알겠습니다. 스키마를 옮기겠습니다 (${i}).`,
        '/x/a.jsonl', i * 2, i * 2 + 1, SID, '/tmp/index-lag-project');
    }

    const { sql, params } = pendingExtractionCoreQuery({ minExchanges: 2, excludeProjects: [] });
    const pending = (db.prepare(sql).all(...params) as Array<{ sid: string }>).map((r) => r.sid);
    expect(pending).toContain(SID);
  });
});

describe('추출 전 색인 (preindexSession)', () => {
  it('대화 파일을 색인하고, 그 뒤 추출이 실제로 돌아 양수 마커를 남긴다', async () => {
    writeTranscript(transcriptLines(SID, 3));
    const { preindexSession } = await import('../src/session-preindex.js');
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    expect(indexedCount()).toBe(0);
    const pre = await preindexSession(SID);
    expect(pre).toEqual({ status: 'indexed' });
    expect(indexedCount()).toBe(3);

    const result = await runFactExtraction(db, SID, '/tmp/index-lag-project');
    expect(result.skipped).toBeUndefined();
    expect(calls).toBe(1);
    expect(result.saved).toBe(1);
    expect(markerRow()).toEqual({ extracted: 1, saved: 1 });
  });

  it('대화 파일이 없으면 색인하지 않고 no_transcript 를 돌려준다', async () => {
    const { preindexSession } = await import('../src/session-preindex.js');
    expect(await preindexSession(SID)).toEqual({ status: 'no_transcript' });
    expect(indexedCount()).toBe(0);
  });

  it('세션 id 꼴이 아니면 파일을 찾지 않는다 (부분 문자열로 남의 대화를 집지 않게)', async () => {
    writeTranscript(transcriptLines(SID, 2));
    const { preindexSession } = await import('../src/session-preindex.js');
    expect(await preindexSession(SID.slice(0, 8))).toEqual({ status: 'invalid_session_id' });
    expect(indexedCount()).toBe(0);
  });

  it('색인 제외 마커가 든 대화는 색인하지 않고, 추출도 마커 없이 건너뛴다', async () => {
    const { preindexSession, INDEX_EXCLUSION_MARKERS } = await import('../src/session-preindex.js');
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    for (const marker of INDEX_EXCLUSION_MARKERS) {
      writeTranscript(transcriptLines(SID, 3, `${marker}\n이 대화는 색인하지 마세요.`));
      expect(await preindexSession(SID)).toEqual({ status: 'excluded_marker' });
      expect(indexedCount()).toBe(0);
    }
    const result = await runFactExtraction(db, SID, '/tmp/index-lag-project');
    expect(result.skipped).toBe('not_indexed');
    expect(markerRow()).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('제외 마커 목록이 sync.ts 의 목록과 같다', async () => {
    const { INDEX_EXCLUSION_MARKERS } = await import('../src/session-preindex.js');
    const { SUMMARIZER_CONTEXT_MARKER } = await import('../src/constants.js');
    const syncSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sync.ts'), 'utf8');
    const block = /const EXCLUSION_MARKERS = \[([\s\S]*?)\];/.exec(syncSource);
    expect(block, 'sync.ts 의 제외 마커 정의 모양이 바뀌었다 — session-preindex.ts 의 사본과 이 테스트를 그 정의에 맞출 것').not.toBeNull();
    const body = block![1];
    const literals = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    // 문자열 리터럴을 지우고 남는 항목은 상수 이름뿐이어야 한다(모르는 항목이 있으면 사본을 만들 수 없다).
    const rest = body.replace(/'(?:[^'\\]|\\.)*'/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    expect(rest).toEqual(['SUMMARIZER_CONTEXT_MARKER']);
    expect([...INDEX_EXCLUSION_MARKERS].sort()).toEqual([...literals, SUMMARIZER_CONTEXT_MARKER].sort());
  });

  it('색인 모듈을 불러와도 프로세스의 출력 토큰 상한 설정이 바뀌지 않는다', async () => {
    writeTranscript(transcriptLines(SID, 2));
    vi.resetModules(); // indexer.ts 의 모듈 최상위 대입이 이 테스트 안에서 다시 실행되게
    const { preindexSession } = await import('../src/session-preindex.js');

    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '777';
    try {
      expect(await preindexSession(SID)).toEqual({ status: 'indexed' });
      expect(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('777');
    } finally {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }

    vi.resetModules();
    const again = await import('../src/session-preindex.js');
    expect(await again.preindexSession(SID)).toEqual({ status: 'indexed' });
    expect(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '없던 설정이 생기면 안 된다').toBeUndefined();
  });
});
