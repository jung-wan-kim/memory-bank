import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * scripts/requeue-zero-markers.mjs — 색인 전에 찍힌 "0건 완료" 표식을 걷어 내 그 세션을
 * 다시 추출 대상으로 돌려놓는 일회성 스크립트.
 *
 * 스크립트를 자식 프로세스로 실제 실행한다(dist 를 읽는다). DB 는 실제 스키마
 * (initDatabase)로 만든다. 고정하는 계약:
 *  - 기본은 dry-run 이고 DB 를 한 바이트도 바꾸지 않는다
 *  - 모르는 인자·모드에 안 맞는 인자는 exit 1
 *  - 걷어 내는 것은 "표식 뒤에야 색인된 세션"의 0건 표식뿐 — 추출이 교환을 읽었을 수
 *    있는 표식(먼저 색인됨·같은 초·색인 시각 모름·읽은 교환 수 기록·폐기 배치)은 그대로
 *  - 걷어 낸 세션은 backfill 의 pending 술어에 실제로 잡힌다
 *  - 추출기가 곧바로 제외할 세션(제외 저장소의 하위 폴더)은 걷어 내지 않는다
 *  - 앞선 추출이 사실을 저장한 적이 있는 세션은 걷어 내지 않는다(다시 추출하면 두 벌)
 *  - --apply 는 되돌리기 파일을 먼저 쓰고, --undo 는 그 뒤 아무도 손대지 않은 세션만 되돌린다
 *  - --apply 의 조사는 쓰기 잠금 밖에서 돈다. 잠금 안에서는 고른 세션만 다시 판정하고,
 *    조사 뒤에 바뀐 세션(선점됨·사실이 저장됨)은 걷어 내지 않는다
 *  - 0건 표식과 교환이 많아도 조사가 표식마다 교환 전체를 훑지 않는다(실DB 에서 dry-run 이
 *    끝나지 않던 조회)
 */

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'requeue-zero-markers.mjs');
const EXCLUDED = '/repos/self';

const MARK = '2026-09-01T10:00:00.400Z';           // 표식이 찍힌 시각
const AFTER = Date.parse('2026-09-01T10:01:00.000Z');   // 표식 뒤에 색인됨
const BEFORE = Date.parse('2026-09-01T09:59:00.000Z');  // 표식 전에 색인됨
const SAME_SECOND = Date.parse('2026-09-01T10:00:00.900Z');
const FRESH = new Date().toISOString();

let tmp: string;
let dbPath: string;

interface Seed {
  sid: string;
  marker?: { extracted: number; saved: number; dropped?: number; seen?: number | null; at?: string };
  exchanges: Array<{ indexed: number | null; sidechain?: boolean }>;
  cwd?: string;
  day?: string;
}

const SEEDS: Seed[] = [
  { sid: 'victim-old', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }, { indexed: AFTER }], day: '2026-08-01' },
  { sid: 'victim-new', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER + 5 }, { indexed: AFTER }], day: '2026-08-20' },
  { sid: 'read-before', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: BEFORE }, { indexed: BEFORE }] },
  { sid: 'read-partly', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: BEFORE }, { indexed: AFTER }, { indexed: AFTER }] },
  { sid: 'same-second', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: SAME_SECOND }, { indexed: AFTER }] },
  { sid: 'index-time-unknown', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: null }, { indexed: AFTER }] },
  { sid: 'seen-recorded', marker: { extracted: 0, saved: 0, seen: 3 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }, { indexed: AFTER }] },
  { sid: 'dropped-batches', marker: { extracted: 0, saved: 0, dropped: 2 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }] },
  { sid: 'too-short', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }] },
  { sid: 'sidechain-only', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER, sidechain: true }, { indexed: AFTER, sidechain: true }] },
  { sid: 'excluded-exact', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }], cwd: EXCLUDED },
  { sid: 'excluded-subfolder', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }], cwd: `${EXCLUDED}/tools` },
  // 0건 표식이지만 앞선 추출이 이 세션에서 사실을 저장한 적이 있다(비활성 사실이어도 같다).
  { sid: 'yielded-before', marker: { extracted: 0, saved: 0 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }] },
  { sid: 'has-facts', marker: { extracted: 3, saved: 3 }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }] },
  // 살아 있는 선점(리스가 만료되지 않은 것) — 만료된 선점은 원래 pending 이다.
  { sid: 'claimed', marker: { extracted: -3, saved: 0, at: FRESH }, exchanges: [{ indexed: AFTER }, { indexed: AFTER }] },
  { sid: 'never-marked', exchanges: [{ indexed: AFTER }, { indexed: AFTER }] },
];

async function seed(): Promise<void> {
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'cfg');
  process.env.MEMORY_BANK_DB_PATH = dbPath;
  const { initDatabase } = await import('../src/db.js');
  const { ensureSeenExchangesColumn } = await import('../src/pending-extraction.js');
  const db = initDatabase();
  try {
    expect(ensureSeenExchangesColumn(db)).toBe(true);
    const ex = db.prepare(`INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end,
       session_id, is_sidechain, cwd, last_indexed)
      VALUES (?, '-repos-app', ?, 'question', 'answer', ?, 1, 2, ?, ?, ?, ?)`);
    const mk = db.prepare(`INSERT INTO extraction_log
      (session_id, processed_at, extracted, saved, dropped_batches, seen_exchanges) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const s of SEEDS) {
      s.exchanges.forEach((e, i) => ex.run(
        `${s.sid}-${i}`, `${s.day ?? '2026-08-10'}T0${i}:00:00.000Z`, `/archive/${s.sid}.jsonl`,
        s.sid, e.sidechain ? 1 : 0, s.cwd ?? '/repos/app', e.indexed,
      ));
      if (s.sid === 'yielded-before') {
        db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at, is_active)
                    VALUES ('f-earlier', 'Deploys run from the main branch only.', 'constraint', 'global', ?, ?, ?, 0)`)
          .run(JSON.stringify(['yielded-before-1', 'unrelated-exchange']), MARK, MARK);
        db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
                    VALUES ('f-malformed-sources', 'Release tags are created by CI.', 'constraint', 'global', 'not json', ?, ?)`)
          .run(MARK, MARK);
      }
      if (s.marker) mk.run(s.sid, s.marker.at ?? MARK, s.marker.extracted, s.marker.saved, s.marker.dropped ?? 0, s.marker.seen ?? null);
    }
  } finally {
    db.close();
  }
  delete process.env.MEMORY_BANK_DB_PATH;
  delete process.env.MEMORY_BANK_CONFIG_DIR;
}

const scriptEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'cfg'),
  MEMORY_BANK_DB_PATH: path.join(tmp, 'not-used.sqlite'),
  BACKFILL_EXCLUDE_PROJECTS: EXCLUDED,
  BACKFILL_MIN_EXCHANGES: '',
});

function run(...argv: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: scriptEnv(),
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 스크립트를 기다리지 않고 띄운다 — 도는 동안 다른 연결이 무엇을 할 수 있는지 보려고. */
function start(...argv: string[]): { state: { out: string }; exited: Promise<number>; stop: () => void } {
  const child = spawn(process.execPath, [SCRIPT, ...argv], { cwd: REPO, env: scriptEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '' };
  child.stdout.on('data', (d) => { state.out += d; });
  child.stderr.on('data', (d) => { state.out += d; });
  let done = false;
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => { done = true; resolve(code ?? -1); }));
  return { state, exited, stop: () => { if (!done) child.kill('SIGKILL'); } };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const dbHash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

function markers(): Record<string, { extracted: number; saved: number; processed_at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, { extracted: number; saved: number; processed_at: string }> = {};
    for (const r of db.prepare('SELECT session_id, extracted, saved, processed_at FROM extraction_log').all() as
      Array<{ session_id: string; extracted: number; saved: number; processed_at: string }>) {
      out[r.session_id] = { extracted: r.extracted, saved: r.saved, processed_at: r.processed_at };
    }
    return out;
  } finally {
    db.close();
  }
}

/** backfill 워커가 쓰는 pending 술어(조용함 조건만 끔)에 잡히는 세션. */
async function pendingSessions(): Promise<string[]> {
  const { pendingExtractionCoreQuery } = await import('../src/pending-extraction.js');
  const { sql, params } = pendingExtractionCoreQuery({ minExchanges: 2, excludeProjects: [EXCLUDED], quietMinutes: 0 });
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT sid FROM (${sql}) ORDER BY sid`).all(...params) as Array<{ sid: string }>).map((r) => r.sid);
  } finally {
    db.close();
  }
}

const markedBefore = SEEDS.filter((s) => s.marker).map((s) => s.sid).sort();

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-requeue-'));
  dbPath = path.join(tmp, 'index.sqlite');
  await seed();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('requeue-zero-markers.mjs', () => {
  it('기본은 dry-run — 대상 수만 세고 DB 를 바꾸지 않는다', async () => {
    const pendingBefore = await pendingSessions();
    const before = dbHash();
    const { code, out } = run('--db', dbPath);

    expect(code, out).toBe(0);
    expect(out).toMatch(/0-fact completion markers: 11$/m);
    expect(out).toMatch(/with at least one indexed main-chain exchange today: 10$/m);
    expect(out).toMatch(/every exchange indexed after the marker was written: 6$/m);
    expect(out).toMatch(/pending by the backfill's predicate once the marker is gone: 4$/m);
    expect(out).toMatch(/excluded by the extractor \(folder under an excluded project\): 1$/m);
    expect(out).toMatch(/already yielded facts in an earlier extraction: 1$/m);
    expect(out).toMatch(/sessions to requeue: 2 \(6 exchange\(s\)\)$/m);
    expect(out).toMatch(/dry run: nothing changed/);
    expect(dbHash()).toBe(before);
    expect(Object.keys(markers()).sort()).toEqual(markedBefore);
    expect(await pendingSessions()).toEqual(pendingBefore);
    expect(fs.readdirSync(tmp).filter((f) => f.includes('undo'))).toEqual([]);
  });

  it('모르는 인자·모드에 안 맞는 인자는 exit 1 이고 아무것도 바꾸지 않는다', () => {
    const before = dbHash();
    for (const argv of [
      ['--db', dbPath, '--aply'],
      ['--db', dbPath, '--limit', '1'],                 // dry-run 에 --limit
      ['--db', dbPath, '--apply', '--limit', '0'],
      ['--db', dbPath, '--apply', '--limit', '1.5'],
      ['--db', dbPath, '--apply', '--undo', path.join(tmp, 'u.jsonl')],
      ['--db', path.join(tmp, 'missing.sqlite')],
    ]) {
      const { code, out } = run(...argv);
      expect(code, `${argv.join(' ')}\n${out}`).toBe(1);
    }
    expect(dbHash()).toBe(before);
    expect(Object.keys(markers()).sort()).toEqual(markedBefore);
  });

  it('--apply 는 표식 뒤에야 색인된 세션의 0건 표식만 걷어 내고, 그 세션은 backfill 대상이 된다', async () => {
    expect(await pendingSessions()).toEqual(['never-marked']);
    const undoFile = path.join(tmp, 'undo.jsonl');
    const { code, out } = run('--db', dbPath, '--apply', '--undo-file', undoFile);

    expect(code, out).toBe(0);
    expect(out).toMatch(/removed 2 marker\(s\)/);
    const left = markers();
    expect(Object.keys(left).sort()).toEqual(markedBefore.filter((s) => s !== 'victim-old' && s !== 'victim-new'));
    // 남은 표식은 값도 그대로다.
    expect(left['has-facts']).toEqual({ extracted: 3, saved: 3, processed_at: MARK });
    expect(left['claimed']).toEqual({ extracted: -3, saved: 0, processed_at: FRESH });
    expect(await pendingSessions()).toEqual(['never-marked', 'victim-new', 'victim-old']);

    const lines = fs.readFileSync(undoFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'requeue-zero-markers-undo', version: 1, count: 2 });
    expect(lines.slice(1).map((r) => r.session_id).sort()).toEqual(['victim-new', 'victim-old']);
    expect(lines.slice(1).every((r) => r.extracted === 0 && r.saved === 0 && r.processed_at === MARK)).toBe(true);
    expect(fs.statSync(undoFile).mode & 0o777).toBe(0o600);

    // 다시 돌리면 할 일이 없고 되돌리기 파일도 만들지 않는다.
    const again = run('--db', dbPath, '--apply', '--undo-file', path.join(tmp, 'undo-2.jsonl'));
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/nothing to requeue/);
    expect(fs.existsSync(path.join(tmp, 'undo-2.jsonl'))).toBe(false);
  });

  it('--limit N 은 최근 세션부터 N 개만 걷어 낸다', async () => {
    const { code, out } = run('--db', dbPath, '--apply', '--limit', '1', '--undo-file', path.join(tmp, 'undo.jsonl'));
    expect(code, out).toBe(0);
    expect(out).toMatch(/removed 1 marker\(s\) \(--limit 1\)/);
    const left = Object.keys(markers());
    expect(left).toContain('victim-old');
    expect(left).not.toContain('victim-new');
  });

  it('--undo 는 걷어 낸 표식을 되돌리되, 그 뒤 선점·추출된 세션은 건드리지 않는다', async () => {
    const undoFile = path.join(tmp, 'undo.jsonl');
    expect(run('--db', dbPath, '--apply', '--undo-file', undoFile).code).toBe(0);

    // 그 사이 backfill 이 한 세션을 선점했다.
    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner)
                  VALUES ('victim-new', '2026-11-10T00:00:00.000Z', -3, 0, 'owner-1')`).run();
    } finally {
      db.close();
    }

    const { code, out } = run('--db', dbPath, '--undo', undoFile);
    expect(code, out).toBe(0);
    expect(out).toMatch(/restored 1 of 2 marker\(s\)/);
    const now = markers();
    expect(now['victim-old']).toEqual({ extracted: 0, saved: 0, processed_at: MARK });
    expect(now['victim-new']).toEqual({ extracted: -3, saved: 0, processed_at: '2026-11-10T00:00:00.000Z' });
    expect(Object.keys(now).sort()).toEqual(markedBefore);
  });

  /**
   * 다른 연결이 쓰기 잠금을 쥔 채로 --apply 를 띄운다. 조사가 쓰기 잠금을 필요로 하면 건수가
   * 나오지 않는다(예전 코드: 조사 전체가 BEGIN IMMEDIATE 안 — 실DB 에서 조사 내내 다른 쓰기가
   * SQLITE_BUSY 였다). 건수가 나온 뒤 `change` 를 커밋해 잠금을 풀면 스크립트가 잠금을 얻는다.
   */
  async function applyWhileLocked(change: (holder: Database.Database) => void): Promise<{ code: number; out: string; undoFile: string }> {
    const undoFile = path.join(tmp, 'undo.jsonl');
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const script = start('--db', dbPath, '--apply', '--undo-file', undoFile);
    let committed = false;
    try {
      const surveyed = await until(() => /sessions to requeue: 2 \(6 exchange\(s\)\)/.test(script.state.out), 10_000);
      expect(surveyed, `the survey did not finish while another connection held the write lock:\n${script.state.out}`).toBe(true);
      expect(script.state.out).not.toMatch(/removed|nothing to requeue/);
      change(holder);
      holder.exec('COMMIT');
      committed = true;
      const code = await script.exited;
      return { code, out: script.state.out, undoFile };
    } finally {
      if (!committed) holder.exec('ROLLBACK');
      holder.close();
      script.stop();
    }
  }

  it('--apply 의 조사는 쓰기 잠금 밖에서 돈다 — 그 사이 선점된 세션은 잠금 안의 재확인에서 빠진다', async () => {
    const { code, out, undoFile } = await applyWhileLocked((holder) => {
      // 조사와 잠금 사이에 backfill 이 한 세션을 선점했다.
      holder.prepare(`UPDATE extraction_log SET extracted = -3, processed_at = ?, claim_owner = 'owner-1'
                      WHERE session_id = 'victim-new'`).run(FRESH);
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/removed 1 marker\(s\)/);
    expect(out).toMatch(/1 of the 2 chosen session\(s\) no longer qualified/);
    const left = markers();
    expect(left['victim-new']).toEqual({ extracted: -3, saved: 0, processed_at: FRESH });
    expect(Object.keys(left)).not.toContain('victim-old');
    // 되돌리기 파일은 실제로 걷어 낸 표식만 담는다.
    const lines = fs.readFileSync(undoFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'requeue-zero-markers-undo', version: 1, count: 1 });
    expect(lines.slice(1).map((r) => r.session_id)).toEqual(['victim-old']);
  });

  it('조사 뒤에 사실이 저장된 세션도 잠금 안의 재확인에서 빠진다 — 전부 빠지면 아무것도 바꾸지 않는다', async () => {
    const before = Object.keys(markers()).sort();
    const { code, out, undoFile } = await applyWhileLocked((holder) => {
      const fact = holder.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
                                   VALUES (?, 'Builds run on the release branch.', 'constraint', 'global', ?, ?, ?)`);
      fact.run('f-late-old', JSON.stringify(['victim-old-2']), FRESH, FRESH);
      fact.run('f-late-new', JSON.stringify(['victim-new-0']), FRESH, FRESH);
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/2 of the 2 chosen session\(s\) no longer qualified/);
    expect(out).toMatch(/nothing to requeue/);
    expect(Object.keys(markers()).sort()).toEqual(before);
    expect(fs.existsSync(undoFile)).toBe(false);
    // 잠금 안에서 다시 읽은 것은 조사 뒤에 저장된 두 행뿐이다(조사가 읽은 두 행은 다시 읽지 않는다).
    expect(out).toMatch(/facts read again under the write lock: 2 stored since the survey \(of 4\)$/m);
  });

  // 검수 CE-02-R: 잠금 안 재확인이 사실 표 전체(실DB: 출처 목록 61MB)를 다시 읽어 쓰기 잠금을 1.2~5.0초 쥐었다.
  it('잠금 안에서는 조사가 이미 읽은 사실 행을 다시 읽지 않는다 — 그 사이 저장된 행이 없으면 0행', async () => {
    const { code, out } = run('--db', dbPath, '--apply', '--undo-file', path.join(tmp, 'undo.jsonl'));
    expect(code, out).toBe(0);
    expect(out).toMatch(/removed 2 marker\(s\)/);
    expect(out).toMatch(/facts read again under the write lock: 0 stored since the survey \(of 2\)$/m);
  });

  it('조사가 읽은 사실 행이 그 사이 지워지고 그 자리에 새 행이 들어오면 사실 표 전체를 다시 읽는다', async () => {
    const { code, out, undoFile } = await applyWhileLocked((holder) => {
      // 조사가 읽은 마지막 행을 지우고 새 사실을 넣는다 — 새 행이 지워진 행의 rowid 를 물려받는다.
      const gone = holder.prepare(`SELECT rowid AS r FROM facts WHERE id = 'f-malformed-sources'`).get() as { r: number };
      holder.prepare(`DELETE FROM facts WHERE id = 'f-malformed-sources'`).run();
      holder.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
                      VALUES ('f-took-its-rowid', 'Builds run on the release branch.', 'constraint', 'global', ?, ?, ?)`)
        .run(JSON.stringify(['victim-old-2']), FRESH, FRESH);
      const now = holder.prepare(`SELECT rowid AS r FROM facts WHERE id = 'f-took-its-rowid'`).get() as { r: number };
      expect(now.r).toBe(gone.r); // "조사 뒤의 행 = 더 큰 rowid" 만 믿으면 이 행을 놓친다
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/facts read again under the write lock: all 2 \(a fact row the survey had read is gone or was replaced\)$/m);
    expect(out).toMatch(/1 of the 2 chosen session\(s\) no longer qualified/);
    expect(out).toMatch(/removed 1 marker\(s\)/);
    const left = markers();
    expect(left['victim-old']).toEqual({ extracted: 0, saved: 0, processed_at: MARK }); // 사실이 저장된 세션은 그대로
    expect(Object.keys(left)).not.toContain('victim-new');
    const lines = fs.readFileSync(undoFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.slice(1).map((r) => r.session_id)).toEqual(['victim-new']);
  });

  it('조사가 읽은 마지막 사실 행의 출처 목록이 그 사이 바뀌어도 사실 표 전체를 다시 읽는다', async () => {
    const { code, out } = await applyWhileLocked((holder) => {
      holder.prepare(`UPDATE facts SET source_exchange_ids = ? WHERE id = 'f-malformed-sources'`).run(JSON.stringify(['victim-new-1']));
    });
    expect(code, out).toBe(0);
    expect(out).toMatch(/facts read again under the write lock: all 2 /);
    expect(out).toMatch(/1 of the 2 chosen session\(s\) no longer qualified/);
    expect(Object.keys(markers())).toContain('victim-new');
    expect(Object.keys(markers())).not.toContain('victim-old');
  });

  it('고른 세션에 조사가 보지 못한 교환이 생기면 사실 표 전체를 다시 읽는다 — 옛 사실 행이 그 교환을 지목할 수 있다', async () => {
    // 조사 전부터 있던 사실이, 아직 색인되지 않은(지웠다가 다시 색인될) 교환 id 를 지목한다.
    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
                  VALUES ('f-names-a-turn-not-indexed-now', 'Hotfixes skip the staging step.', 'constraint', 'global', ?, ?, ?)`)
        .run(JSON.stringify(['victim-new-9']), MARK, MARK);
    } finally {
      db.close();
    }
    const { code, out } = await applyWhileLocked((holder) => {
      holder.prepare(`INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain, cwd, last_indexed)
        VALUES ('victim-new-9', '-repos-app', '2026-08-20T09:00:00.000Z', 'question', 'answer', '/archive/victim-new.jsonl', 19, 20, 'victim-new', 0, '/repos/app', ?)`)
        .run(AFTER);
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/facts read again under the write lock: all 3 \(a chosen session has an exchange the survey had not seen\)$/m);
    expect(out).toMatch(/1 of the 2 chosen session\(s\) no longer qualified/);
    expect(out).toMatch(/removed 1 marker\(s\)/);
    expect(Object.keys(markers())).toContain('victim-new');
    expect(Object.keys(markers())).not.toContain('victim-old');
  });

  // 교체된 옛 사본의 id 는 exchanges 에 없다. 그 id 를 지목하는 사실은 출처 옮기기(대기열)가 돌기 전까지
  // 어느 세션의 것인지 exchanges 만으로는 알 수 없다 — 대기열의 (옛 id → 새 id) 로 세션을 찾는다.
  it('교체된 옛 사본(출처 옮기기 대기 중)을 지목하는 사실도 그 세션의 사실로 센다', async () => {
    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT INTO exchange_repoints (from_id, to_id, session_id, queued_at) VALUES ('victim-new-0-shorter', 'victim-new-0', NULL, 1)`).run();
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at)
                  VALUES ('f-from-shorter-copy', 'Releases are cut on Thursdays.', 'constraint', 'global', ?, ?, ?)`)
        .run(JSON.stringify(['victim-new-0-shorter']), MARK, MARK);
    } finally {
      db.close();
    }
    const { code, out } = run('--db', dbPath);
    expect(code, out).toBe(0);
    expect(out).toMatch(/already yielded facts in an earlier extraction: 2$/m);
    expect(out).toMatch(/sessions to requeue: 1 \(3 exchange\(s\)\)$/m);
  });

  it('출처 옮기기 대기열 표가 없는 옛 DB 에서도 그대로 돈다', async () => {
    const db = new Database(dbPath);
    try { db.exec('DROP TABLE exchange_repoints'); } finally { db.close(); }
    const { code, out } = run('--db', dbPath);
    expect(code, out).toBe(0);
    expect(out).toMatch(/sessions to requeue: 2 \(6 exchange\(s\)\)$/m);
  });

  it('0건 표식과 본 대화 교환이 많아도 dry-run 이 표식마다 교환 전체를 훑지 않는다', () => {
    // 교환이 없는 세션의 0건 표식 20,000개 + 표식 없는 세션들의 본 대화 교환 40,000개.
    // 표식마다 본 대화 교환을 끝까지 훑는 조회(is_sidechain 색인)는 8억 행을 읽는다 —
    // 실DB(표식 38,088 · 본 대화 교환 69,081)에서는 dry-run 이 56분 뒤에도 끝나지 않았다.
    const db = new Database(dbPath);
    try {
      const ex = db.prepare(`INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end,
         session_id, is_sidechain, cwd, last_indexed)
        VALUES (?, '-repos-app', '2026-07-01T00:00:00.000Z', 'question', 'answer', ?, ?, ?, ?, 0, '/repos/app', ?)`);
      const mk = db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?, ?, 0, 0)`);
      db.transaction(() => {
        for (let s = 0; s < 2000; s++) {
          for (let i = 0; i < 20; i++) ex.run(`bulk-${s}-${i}`, `/archive/bulk-${s}.jsonl`, i * 2 + 1, i * 2 + 2, `bulk-${s}`, AFTER);
        }
        for (let m = 0; m < 20_000; m++) mk.run(`gone-${m}`, MARK);
      })();
    } finally {
      db.close();
    }

    const started = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT, '--db', dbPath], { cwd: REPO, encoding: 'utf8', timeout: 15_000, env: scriptEnv() });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, `dry run did not finish in 15s (signal ${r.signal}, ${Date.now() - started}ms):\n${out}`).toBe(0);
    expect(out).toMatch(/0-fact completion markers: 20011$/m);
    expect(out).toMatch(/with at least one indexed main-chain exchange today: 10$/m);
    expect(out).toMatch(/sessions to requeue: 2 \(6 exchange\(s\)\)$/m);
  });

  it('--undo 는 이 스크립트의 되돌리기 파일이 아니면 거부한다', () => {
    const bogus = path.join(tmp, 'bogus.jsonl');
    fs.writeFileSync(bogus, `${JSON.stringify({ kind: 'redact-secret-facts-undo', version: 1, applied_at: MARK, count: 0 })}\n`);
    const before = dbHash();
    const { code, out } = run('--db', dbPath, '--undo', bogus);
    expect(code, out).toBe(1);
    expect(out).toMatch(/not an undo file of this script/);
    expect(dbHash()).toBe(before);
  });
});
