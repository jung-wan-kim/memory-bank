import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * scripts/redact-secret-facts.mjs — 이미 저장된 자격증명 사실의 정리 스크립트.
 *
 * 스크립트를 자식 프로세스로 실제 실행한다(dist 를 읽는다). 고정하는 계약:
 *  - 기본은 dry-run 이고 DB 를 한 바이트도 바꾸지 않는다
 *  - 모르는 인자는 exit 1 (오타 하나로 다른 모드가 돌지 않게)
 *  - 출력·되돌리기 파일 어디에도 사실 본문(값)이 없다 — id 와 종류만
 *  - --apply 는 되돌리기 파일을 먼저 쓰고 활성 행만 비활성화한다
 *  - --undo 는 그 실행이 남긴 상태 그대로인 행만 되돌린다
 */

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'redact-secret-facts.mjs');
const j = (...parts: string[]) => parts.join('');
// 지어낸 값. 저장소의 비밀값 검사에 걸리지 않게 조각으로 만든다.
const BOT_TOKEN = j('1234567890', ':', 'AAF', 'x9Qw'.repeat(8));
const API_KEY = j('s', 'k-', 'A1b2C3d4E5f6G7h8I9j0K1l2');
const T0 = '2026-06-12T03:04:05.678Z';

let tmp: string;
let dbPath: string;

function seed(): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL'); // 운영 DB 와 같은 저널 모드
    db.exec(`CREATE TABLE facts (
      id TEXT PRIMARY KEY, fact TEXT NOT NULL, fact_kr TEXT, category TEXT, scope_type TEXT, scope_project TEXT,
      source_exchange_ids TEXT, created_at TEXT, updated_at TEXT, consolidated_count INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1)`);
    const ins = db.prepare(`INSERT INTO facts (id, fact, fact_kr, category, scope_type, created_at, updated_at, is_active)
      VALUES (?, ?, ?, 'knowledge', 'global', ?, ?, ?)`);
    ins.run('fact-token', `User keeps the bot credentials (Token: ${BOT_TOKEN}) in the config file.`, null, T0, T0, 1);
    ins.run('fact-kr-key', 'The deploy key lives in the vault.', `배포 키는 ${API_KEY} 이다`, T0, T0, 1);
    ins.run('fact-old-token', `Old bot token was ${BOT_TOKEN}.`, null, T0, T0, 0);
    ins.run('fact-normal', 'Public APIs use REST and commit 681c9950a1b2c3d4e5f60718293a4b5c6d7e8f90 fixed pagination.', null, T0, T0, 1);
  } finally {
    db.close();
  }
}

function run(...argv: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MEMORY_BANK_CONFIG_DIR: path.join(tmp, 'cfg'), MEMORY_BANK_DB_PATH: path.join(tmp, 'not-used.sqlite') },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const dbHash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

function rows(): Record<string, { is_active: number; updated_at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, { is_active: number; updated_at: string }> = {};
    for (const r of db.prepare('SELECT id, is_active, updated_at FROM facts').all() as Array<{ id: string; is_active: number; updated_at: string }>) {
      out[r.id] = { is_active: r.is_active, updated_at: r.updated_at };
    }
    return out;
  } finally {
    db.close();
  }
}

const undoFiles = () => fs.readdirSync(tmp).filter((f) => f.includes('undo'));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-redact-secret-'));
  dbPath = path.join(tmp, 'facts.sqlite');
  seed();
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('redact-secret-facts.mjs', () => {
  it('기본 실행은 dry-run: id 와 종류만 출력하고 DB 지문이 변하지 않는다', () => {
    const before = dbHash();
    const { code, out } = run('--db', dbPath);

    expect(code).toBe(0);
    expect(out).toMatch(/fact-token\tsecret-telegram-bot-token\tactive\tfact\n/);
    expect(out).toMatch(/fact-kr-key\tsecret-api-key\tactive\tfact_kr\n/);
    expect(out).toMatch(/fact-old-token\tsecret-telegram-bot-token\tinactive\tfact\n/);
    expect(out).not.toMatch(/fact-normal/);
    expect(out).toMatch(/scanned 4 fact\(s\): 3 carry a credential-shaped string \(2 active, 1 inactive\)/);
    expect(out).toMatch(/dry run: nothing changed/);
    expect(out).not.toContain(BOT_TOKEN);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain('bot credentials');
    expect(dbHash()).toBe(before);
    expect(undoFiles()).toEqual([]);
  });

  it('모르는 인자·모드와 맞지 않는 인자는 exit 1 이고 아무것도 바꾸지 않는다', () => {
    const before = dbHash();
    for (const argv of [
      ['--db', dbPath, '--aply'],
      ['--db', dbPath, '--dry-run'],
      ['--db', dbPath, '--undo-file', path.join(tmp, 'u.jsonl')],
      ['--db', dbPath, '--apply', '--undo', path.join(tmp, 'u.jsonl')],
      ['--db'],
    ]) {
      const { code } = run(...argv);
      expect(code, argv.join(' ')).toBe(1);
    }
    expect(run('--db', path.join(tmp, 'missing.sqlite')).code).toBe(1);
    expect(dbHash()).toBe(before);
    expect(undoFiles()).toEqual([]);
  });

  it('--apply: 활성 행만 비활성화하고, 값이 없는 되돌리기 파일을 남긴다', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    const { code, out } = run('--db', dbPath, '--apply', '--undo-file', undoPath);

    expect(code).toBe(0);
    expect(out).toMatch(/deactivated 2 fact\(s\)/);
    expect(out).not.toContain(BOT_TOKEN);
    expect(out).not.toContain(API_KEY);

    const after = rows();
    expect(after['fact-token'].is_active).toBe(0);
    expect(after['fact-kr-key'].is_active).toBe(0);
    expect(after['fact-token'].updated_at).not.toBe(T0);
    expect(after['fact-old-token']).toEqual({ is_active: 0, updated_at: T0 });
    expect(after['fact-normal']).toEqual({ is_active: 1, updated_at: T0 });

    const undoText = fs.readFileSync(undoPath, 'utf8');
    expect(undoText).not.toContain(BOT_TOKEN);
    expect(undoText).not.toContain(API_KEY);
    const [header, ...entries] = undoText.trim().split('\n').map((l) => JSON.parse(l));
    // 벡터 표가 없는 DB 라 백업 표도 없다(있으면 그 이름이 여기 적힌다 — 아래 CE-10 테스트)
    expect(header).toMatchObject({ kind: 'redact-secret-facts-undo', version: 2, count: 2, vec_backup_table: null });
    expect(header.applied_at).toBe(after['fact-token'].updated_at);
    expect(entries.map((e) => e.id).sort()).toEqual(['fact-kr-key', 'fact-token']);
    expect(entries.every((e) => e.is_active === 1 && e.updated_at === T0)).toBe(true);
  });

  it('--apply 를 다시 돌리면 바꿀 것이 없고 되돌리기 파일도 만들지 않는다', () => {
    expect(run('--db', dbPath, '--apply').code).toBe(0);
    const first = undoFiles();
    expect(first).toHaveLength(1);
    const before = dbHash();

    const { code, out } = run('--db', dbPath, '--apply');
    expect(code).toBe(0);
    expect(out).toMatch(/nothing to deactivate/);
    expect(undoFiles()).toEqual(first);
    expect(dbHash()).toBe(before);
  });

  it('이미 있는 되돌리기 파일은 덮어쓰지 않는다', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    fs.writeFileSync(undoPath, 'keep me\n');
    const before = dbHash();
    expect(run('--db', dbPath, '--apply', '--undo-file', undoPath).code).toBe(1);
    expect(fs.readFileSync(undoPath, 'utf8')).toBe('keep me\n');
    expect(dbHash()).toBe(before);
  });

  it('--undo: 그 실행이 남긴 상태 그대로인 행만 되돌린다', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    expect(run('--db', dbPath, '--apply', '--undo-file', undoPath).code).toBe(0);
    // 그 뒤 한 행을 다른 경로가 고쳤다 — 되돌리기가 덮어쓰면 안 된다.
    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE facts SET updated_at = '2026-11-11T00:00:00.000Z' WHERE id = 'fact-kr-key'").run();
    } finally {
      db.close();
    }

    const { code, out } = run('--db', dbPath, '--undo', undoPath);
    expect(code).toBe(0);
    expect(out).toMatch(/restored 1 of 2 fact\(s\)/);
    const after = rows();
    expect(after['fact-token']).toEqual({ is_active: 1, updated_at: T0 });
    expect(after['fact-kr-key']).toEqual({ is_active: 0, updated_at: '2026-11-11T00:00:00.000Z' });
    expect(after['fact-old-token']).toEqual({ is_active: 0, updated_at: T0 });
  });

  it('--apply 는 끈 사실의 벡터 행도 지우고, --undo 는 그 바이트 그대로 되돌린다 (검수 CE-10)', async () => {
    // 실제 스키마(벡터 표 포함)의 DB. 예전에는 is_active 만 바꿔, 비밀값이 든 문장의 벡터가 색인에 남았다.
    const realPath = path.join(tmp, 'real.sqlite');
    const saved = { cfg: process.env.MEMORY_BANK_CONFIG_DIR, db: process.env.MEMORY_BANK_DB_PATH };
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'cfg-real');
    process.env.MEMORY_BANK_DB_PATH = realPath;
    const { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } = await import('../src/db.js');
    const vecRows = (table: string): Record<string, string> => {
      const db = initDatabase();
      try {
        return Object.fromEntries((db.prepare(`SELECT id, embedding FROM ${table} ORDER BY id`).all() as Array<{ id: string; embedding: Buffer }>)
          .map((r) => [r.id, Buffer.from(r.embedding).toString('hex')]));
      } finally {
        db.close();
      }
    };
    try {
      const db = initDatabase();
      try {
        const ins = db.prepare(`INSERT INTO facts (id, fact, fact_kr, category, scope_type, source_exchange_ids, created_at, updated_at, is_active)
          VALUES (?, ?, ?, 'knowledge', 'global', '[]', ?, ?, 1)`);
        ins.run('fact-token', `User keeps the bot credentials (Token: ${BOT_TOKEN}) in the config file.`, '봇 설정은 설정 파일에 있다', T0, T0);
        ins.run('fact-normal', 'Public APIs use REST.', '공개 API 는 REST 를 쓴다', T0, T0);
        const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 20);
        for (const [table, offset] of [['vec_facts', 0], ['vec_facts_kr', 100]] as const) {
          const q = getVecQuant(db, table);
          const put = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(q)})`);
          put.run('fact-token', embeddingToVecBlob(vec(1 + offset), q));
          put.run('fact-normal', embeddingToVecBlob(vec(2 + offset), q));
        }
      } finally {
        db.close();
      }
      const before = { en: vecRows('vec_facts'), kr: vecRows('vec_facts_kr') };
      expect(Object.keys(before.en)).toEqual(['fact-normal', 'fact-token']);

      const undoPath = path.join(tmp, 'undo-real.jsonl');
      const applied = run('--db', realPath, '--apply', '--undo-file', undoPath);
      expect(applied.code).toBe(0);
      expect(applied.out).toMatch(/deactivated 1 fact\(s\)/);
      expect(applied.out).toMatch(/removed 2 vector row\(s\)/);
      expect(Object.keys(vecRows('vec_facts')), '끈 사실의 벡터는 색인에 없다').toEqual(['fact-normal']);
      expect(Object.keys(vecRows('vec_facts_kr'))).toEqual(['fact-normal']);
      expect(fs.readFileSync(undoPath, 'utf8'), '되돌리기 파일에는 벡터도 본문도 없다').not.toContain(BOT_TOKEN);

      const undone = run('--db', realPath, '--undo', undoPath);
      expect(undone.code).toBe(0);
      expect(undone.out).toMatch(/restored 1 of 1 fact\(s\)/);
      expect({ en: vecRows('vec_facts'), kr: vecRows('vec_facts_kr') }, '벡터가 지우기 전 바이트 그대로 돌아온다').toEqual(before);
    } finally {
      if (saved.cfg === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR; else process.env.MEMORY_BANK_CONFIG_DIR = saved.cfg;
      if (saved.db === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = saved.db;
    }
  });

  it('--undo 는 벡터를 지우기 전 버전이 쓴 되돌리기 파일(version 1)도 받는다', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    expect(run('--db', dbPath, '--apply', '--undo-file', undoPath).code).toBe(0);
    const [headerLine, ...rest] = fs.readFileSync(undoPath, 'utf8').trim().split('\n');
    const { vec_backup_table: _dropped, ...header } = JSON.parse(headerLine);
    fs.writeFileSync(undoPath, [JSON.stringify({ ...header, version: 1 }), ...rest].join('\n') + '\n');

    const { code, out } = run('--db', dbPath, '--undo', undoPath);
    expect(code).toBe(0);
    expect(out).toMatch(/restored 2 of 2 fact\(s\)/);
    expect(rows()['fact-token']).toEqual({ is_active: 1, updated_at: T0 });
  });

  it('--undo 는 이 스크립트가 쓰지 않는 이름의 백업 표를 건드리지 않는다', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    expect(run('--db', dbPath, '--apply', '--undo-file', undoPath).code).toBe(0);
    const [headerLine, ...rest] = fs.readFileSync(undoPath, 'utf8').trim().split('\n');
    fs.writeFileSync(undoPath, [JSON.stringify({ ...JSON.parse(headerLine), vec_backup_table: 'facts' }), ...rest].join('\n') + '\n');
    const before = dbHash();

    expect(run('--db', dbPath, '--undo', undoPath).code).toBe(1);
    expect(dbHash()).toBe(before);
  });

  it('--undo 는 이 스크립트의 되돌리기 파일이 아니면 거부한다', () => {
    const bogus = path.join(tmp, 'bogus.jsonl');
    fs.writeFileSync(bogus, JSON.stringify({ id: 'fact-normal', is_active: 1, updated_at: T0 }) + '\n');
    const before = dbHash();
    expect(run('--db', dbPath, '--undo', bogus).code).toBe(1);
    expect(run('--db', dbPath, '--undo', path.join(tmp, 'absent.jsonl')).code).toBe(1);
    expect(dbHash()).toBe(before);
  });

  // monotonicity-ok: 새로 더하는 시험이다(끄는 시험 없음). Windows 에는 POSIX 권한 비트가 없어 그 플랫폼에서만 건너뛴다 — file-perms.test.ts 와 같은 조건.
  it.skipIf(process.platform === 'win32')('되돌리기 파일은 소유자 전용(0600)으로 만든다 — 기본 경로와 --undo-file 모두 (R2-SEC-3)', () => {
    // 보통의 데스크톱 umask(자식 프로세스가 물려받는다): 권한을 주지 않으면 0644 로 만들어진다.
    const previous = process.umask(0o022);
    try {
      const named = path.join(tmp, 'undo-named.jsonl');
      expect(run('--db', dbPath, '--apply', '--undo-file', named).code).toBe(0);
      expect(fs.statSync(named).mode & 0o777).toBe(0o600);

      expect(run('--db', dbPath, '--undo', named).code).toBe(0);
      expect(run('--db', dbPath, '--apply').code).toBe(0);
      const byDefault = undoFiles().filter((f) => f !== 'undo-named.jsonl');
      expect(byDefault).toHaveLength(1);
      expect(fs.statSync(path.join(tmp, byDefault[0])).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it('이미 되돌린 파일로 --undo 를 다시 부르면 "already restored" 라고 답하고 아무것도 바꾸지 않는다 (R2-SEC-6)', () => {
    const undoPath = path.join(tmp, 'undo.jsonl');
    expect(run('--db', dbPath, '--apply', '--undo-file', undoPath).code).toBe(0);
    expect(run('--db', dbPath, '--undo', undoPath).out).toMatch(/restored 2 of 2 fact\(s\)\n/);
    const before = rows();

    const again = run('--db', dbPath, '--undo', undoPath);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/restored 0 of 2 fact\(s\) — 2 already restored\n/);
    expect(again.out, '바뀐 적 없는 행을 "그 뒤에 바뀌었다"고 하지 않는다').not.toMatch(/changed since/);
    expect(rows()).toEqual(before);
    expect(before['fact-token']).toEqual({ is_active: 1, updated_at: T0 });
  });

  it('--help 는 벡터 정리와 백업 표까지 적은 사용법을 찍고 아무것도 열지 않는다 (R2-SEC-6)', () => {
    const before = dbHash();
    const { code, out } = run('--help');
    expect(code).toBe(0);
    for (const part of ['--apply [--undo-file PATH]', '--undo FILE', 'vec_facts, vec_facts_kr', 'redact_secret_backup_<UTC time>', "drops that run's backup table", 'rotate it']) {
      expect(out, part).toContain(part);
    }
    // 다른 인자와 섞이면 예전처럼 exit 1 — 도움말을 찍고 적용까지 하는 일은 없다
    expect(run('--help', '--apply', '--db', dbPath).code).toBe(1);
    expect(dbHash()).toBe(before);
    expect(undoFiles()).toEqual([]);
  });

  describe('벡터 표가 있는 DB (실제 스키마)', () => {
    let realPath: string;
    let dbMod: typeof import('../src/db.js');
    const savedEnv: Record<string, string | undefined> = {};

    const withRealDb = <T>(fn: (db: ReturnType<typeof dbMod.initDatabase>) => T): T => {
      const db = dbMod.initDatabase();
      try { return fn(db); } finally { db.close(); }
    };
    const vecIds = (table: string): string[] =>
      withRealDb((db) => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id));
    const vecHex = (table: string): Record<string, string> => withRealDb((db) => Object.fromEntries(
      (db.prepare(`SELECT id, embedding FROM ${table} ORDER BY id`).all() as Array<{ id: string; embedding: Buffer }>)
        .map((r) => [r.id, Buffer.from(r.embedding).toString('hex')])));
    const backupTables = (): string[] => withRealDb((db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'redact_secret_backup_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name));
    const active = (): Record<string, number> => withRealDb((db) => Object.fromEntries(
      (db.prepare('SELECT id, is_active FROM facts ORDER BY id').all() as Array<{ id: string; is_active: number }>).map((r) => [r.id, r.is_active])));

    beforeEach(async () => {
      realPath = path.join(tmp, 'real.sqlite');
      for (const key of ['MEMORY_BANK_CONFIG_DIR', 'MEMORY_BANK_DB_PATH']) savedEnv[key] = process.env[key];
      process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'cfg-real');
      process.env.MEMORY_BANK_DB_PATH = realPath;
      dbMod = await import('../src/db.js');
      withRealDb((db) => {
        const ins = db.prepare(`INSERT INTO facts (id, fact, fact_kr, category, scope_type, source_exchange_ids, created_at, updated_at, is_active)
          VALUES (?, ?, ?, 'knowledge', 'global', '[]', ?, ?, 1)`);
        ins.run('fact-token', `User keeps the bot credentials (Token: ${BOT_TOKEN}) in the config file.`, '봇 설정은 설정 파일에 있다', T0, T0);
        ins.run('fact-key', `The deploy key is ${API_KEY} for now.`, '배포 키는 금고에 있다', T0, T0);
        ins.run('fact-normal', 'Public APIs use REST.', '공개 API 는 REST 를 쓴다', T0, T0);
        const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 20);
        for (const [table, offset] of [['vec_facts', 0], ['vec_facts_kr', 100]] as const) {
          const q = dbMod.getVecQuant(db, table);
          const put = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${dbMod.vecParamSql(q)})`);
          ['fact-token', 'fact-key', 'fact-normal'].forEach((id, i) => put.run(id, dbMod.embeddingToVecBlob(vec(i + 1 + offset), q)));
        }
      });
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });

    it('벡터 표의 꼴(dtype/scale)이 적용 때와 다르면 --undo 는 exit 1 이고 행·벡터·백업 표가 그대로다 (R2-SEC-3)', () => {
      const undoPath = path.join(tmp, 'undo-real.jsonl');
      expect(run('--db', realPath, '--apply', '--undo-file', undoPath).code).toBe(0);
      const [table] = backupTables();
      // 적용 뒤 벡터 표가 다른 꼴로 옮겨진 상황: 백업에 적힌 꼴과 지금 표의 꼴이 다르다
      const quants = withRealDb((db) => (db.prepare(`SELECT DISTINCT quant FROM ${table}`).all() as Array<{ quant: string }>).map((r) => r.quant));
      expect(quants).toHaveLength(1);
      withRealDb((db) => db.prepare(`UPDATE ${table} SET quant = ?`).run(JSON.stringify({ dtype: 'another-shape' })));

      const refused = run('--db', realPath, '--undo', undoPath);
      expect(refused.code).toBe(1);
      expect(refused.out).toMatch(/undo failed, no row changed: vec_facts(?:_kr)? is .* now but the backup holds/);
      expect(active()).toEqual({ 'fact-key': 0, 'fact-normal': 1, 'fact-token': 0 });
      expect(vecIds('vec_facts')).toEqual(['fact-normal']);
      expect(vecIds('vec_facts_kr')).toEqual(['fact-normal']);
      expect(backupTables()).toEqual([table]);

      // 양성 대조: 꼴이 맞으면 같은 파일로 되돌아간다
      withRealDb((db) => db.prepare(`UPDATE ${table} SET quant = ?`).run(quants[0]));
      expect(run('--db', realPath, '--undo', undoPath).code).toBe(0);
      expect(active()).toEqual({ 'fact-key': 1, 'fact-normal': 1, 'fact-token': 1 });
    });

    it('--undo 가 끝나면 그 실행의 백업 표를 지운다 — 적용·되돌리기를 되풀이해도 표가 쌓이지 않는다 (R2-SEC-6)', () => {
      const before = { en: vecHex('vec_facts'), kr: vecHex('vec_facts_kr') };
      for (const round of [1, 2]) {
        const undoPath = path.join(tmp, `undo-round-${round}.jsonl`);
        const applied = run('--db', realPath, '--apply', '--undo-file', undoPath);
        expect(applied.code, applied.out).toBe(0);
        const tables = backupTables();
        expect(tables, `${round}회차 적용 뒤`).toHaveLength(1);

        const undone = run('--db', realPath, '--undo', undoPath);
        expect(undone.code, undone.out).toBe(0);
        expect(undone.out).toMatch(/restored 2 of 2 fact\(s\)\n/);
        expect(undone.out).toMatch(/put back 4 vector row\(s\)/);
        expect(undone.out).toContain(`dropped ${tables[0]}`);
        expect(backupTables(), `${round}회차 되돌린 뒤`).toEqual([]);
        expect({ en: vecHex('vec_facts'), kr: vecHex('vec_facts_kr') }, '벡터가 지우기 전 바이트 그대로').toEqual(before);
      }
      // 표가 없어진 뒤 같은 파일로 다시 불러도 오류가 아니다: 되돌릴 것이 없다
      const again = run('--db', realPath, '--undo', path.join(tmp, 'undo-round-2.jsonl'));
      expect(again.code, again.out).toBe(0);
      expect(again.out).toMatch(/restored 0 of 2 fact\(s\) — 2 already restored\n/);
      expect(again.out).not.toMatch(/put back|dropped|kept/);
    });

    it('그 뒤에 바뀌어 되돌리지 않은 사실이 있으면 백업 표를 남기고 그렇게 말한다 (R2-SEC-6)', () => {
      const undoPath = path.join(tmp, 'undo-real.jsonl');
      expect(run('--db', realPath, '--apply', '--undo-file', undoPath).code).toBe(0);
      const [table] = backupTables();
      withRealDb((db) => db.prepare("UPDATE facts SET updated_at = '2026-11-11T00:00:00.000Z' WHERE id = 'fact-key'").run());

      const undone = run('--db', realPath, '--undo', undoPath);
      expect(undone.code, undone.out).toBe(0);
      expect(undone.out).toMatch(/restored 1 of 2 fact\(s\) — 1 changed since the apply run and were left as they are\n/);
      expect(undone.out).toContain(`kept ${table}`);
      expect(backupTables()).toEqual([table]);
      expect(active()).toEqual({ 'fact-key': 0, 'fact-normal': 1, 'fact-token': 1 });
      expect(vecIds('vec_facts')).toEqual(['fact-normal', 'fact-token']);
      // 남긴 표에는 되돌리지 않은 사실의 벡터가 그대로 있다
      expect(withRealDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE fact_id = 'fact-key'`).get() as { n: number }).n)).toBe(2);
    });

    it('되돌릴 행이 남아 있는데 백업 표가 사라졌으면 여전히 거부한다 — 벡터 없이 되살리지 않는다', () => {
      const undoPath = path.join(tmp, 'undo-real.jsonl');
      expect(run('--db', realPath, '--apply', '--undo-file', undoPath).code).toBe(0);
      const [table] = backupTables();
      withRealDb((db) => db.exec(`DROP TABLE ${table}`));

      const refused = run('--db', realPath, '--undo', undoPath);
      expect(refused.code).toBe(1);
      expect(refused.out).toMatch(/is gone/);
      expect(active()).toEqual({ 'fact-key': 0, 'fact-normal': 1, 'fact-token': 0 });
    });
  });
});
