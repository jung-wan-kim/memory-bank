import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';

/**
 * 내보내기가 쓰는 파일은 쓸 때마다 소유자 전용이다 (2차 검수 R2-SEC-4, 2026-11-11).
 *
 * 내보내기는 임시 파일을 만들어 제자리로 옮긴다. 임시 파일을 기본 권한으로 만들었기 때문에,
 * 업그레이드 때 한 번 도는 조이기가 0600 으로 만든 facts.jsonl·meta.json 이 내용이 바뀐 첫
 * 내보내기에서 다시 0644 가 됐다. sync 폴더가 0700 이면 닿지 못하지만, sync 가 클라우드 폴더로
 * 가는 심링크인 설치에서는(조이기가 따라가지 않는다) 파일 권한이 유일한 막이다.
 */

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const DATA_FILES = ['facts.jsonl', 'ontology-domains.jsonl', 'ontology-categories.jsonl', 'ontology-relations.jsonl'];
const ALL = [...DATA_FILES, 'meta.json'];
const NOW = '2026-11-11T01:02:03.000Z';
const ENV_KEYS = ['MEMORY_BANK_CONFIG_DIR', 'MEMORY_BANK_DB_PATH', 'TEST_DB_PATH', 'PERSONAL_SUPERPOWERS_DIR', 'XDG_CONFIG_HOME'];

describe.skipIf(process.platform === 'win32')('sync 내보내기가 쓰는 파일의 권한', () => {
  let tmp: string;
  let indexDir: string;
  let previousUmask: number;
  let restoreConsole: () => void;
  const saved: Record<string, string | undefined> = {};

  async function addFact(id: string, text: string): Promise<void> {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active)
        VALUES (?, ?, 'decision', 'global', NULL, '[]', ?, ?, 1, 1)`).run(id, text, NOW, NOW);
    } finally {
      db.close();
    }
  }
  const exportOnce = async () => (await import('../src/sync-export.js')).exportForSync();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-export-perms-'));
    for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'config');
    indexDir = path.join(tmp, 'config', 'conversation-index');
    // 보통의 데스크톱 umask: 권한을 주지 않으면 파일 0644, 폴더 0755 로 만들어진다.
    previousUmask = process.umask(0o022);
    restoreConsole = suppressConsole();
  });
  afterEach(() => {
    restoreConsole();
    process.umask(previousUmask);
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('첫 내보내기: sync 파일 5개와 자기 기록 파일이 0600, state 폴더가 0700', async () => {
    await addFact('perm-1', 'The synthetic project keeps its release notes in the docs folder.');

    const result = await exportOnce();

    expect([...result.written].sort()).toEqual([...ALL].sort());
    for (const name of ALL) expect(mode(path.join(indexDir, 'sync', name)), name).toBe(0o600);
    expect(mode(path.join(indexDir, 'state', 'sync-own-export.json'))).toBe(0o600);
    expect(mode(path.join(indexDir, 'state'))).toBe(0o700);
  });

  it('다시 쓴 파일도 0600 이다 — 예전 버전이 0644 로 남긴 파일을 바뀐 내용으로 바꿀 때', async () => {
    await addFact('perm-1', 'The synthetic project keeps its release notes in the docs folder.');
    await exportOnce();
    // 예전 버전이 남긴 상태: sync 파일과 자기 기록이 0644
    for (const name of ALL) fs.chmodSync(path.join(indexDir, 'sync', name), 0o644);
    fs.chmodSync(path.join(indexDir, 'state', 'sync-own-export.json'), 0o644);

    await addFact('perm-2', 'The synthetic project runs its lint step before each commit.');
    const second = await exportOnce();

    expect([...second.written].sort()).toEqual(['facts.jsonl', 'meta.json']);
    expect(mode(path.join(indexDir, 'sync', 'facts.jsonl'))).toBe(0o600);
    expect(mode(path.join(indexDir, 'sync', 'meta.json'))).toBe(0o600);
    expect(mode(path.join(indexDir, 'state', 'sync-own-export.json'))).toBe(0o600);
    // 바뀌지 않은 파일은 건드리지 않는다(다시 쓰지 않았다) — 그 권한은 한 번 도는 조이기의 몫이다
    expect(mode(path.join(indexDir, 'sync', 'ontology-relations.jsonl'))).toBe(0o644);
  });

  it('sync 가 다른 폴더로 가는 심링크여도, 그 폴더에 쓰는 파일은 0600 이다', async () => {
    const cloud = path.join(tmp, 'cloud-folder');
    fs.mkdirSync(cloud, { mode: 0o755 });
    fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(cloud, path.join(indexDir, 'sync'));
    await addFact('perm-1', 'The synthetic project keeps its release notes in the docs folder.');

    await exportOnce();
    await addFact('perm-2', 'The synthetic project runs its lint step before each commit.');
    await exportOnce();

    expect(mode(cloud), '가리키는 폴더는 사용자의 배치다 — 바꾸지 않는다').toBe(0o755);
    for (const name of ALL) expect(mode(path.join(cloud, name)), name).toBe(0o600);
  });

  it('같은 pid 의 임시 파일이 0644 로 남아 있어도 옮긴 파일은 0600 이다', async () => {
    await addFact('perm-1', 'The synthetic project keeps its release notes in the docs folder.');
    const syncDir = path.join(indexDir, 'sync');
    fs.mkdirSync(syncDir, { recursive: true, mode: 0o700 });
    // 쓰다가 죽은 실행이 남긴 임시 파일(10분이 안 돼 치워지지 않는다)이 우연히 같은 pid 를 가진 경우
    const leftover = path.join(syncDir, `facts.jsonl.${process.pid}.tmp`);
    fs.writeFileSync(leftover, 'half-written', { mode: 0o644 });
    expect(mode(leftover)).toBe(0o644);

    await exportOnce();

    expect(fs.existsSync(leftover)).toBe(false);
    expect(mode(path.join(syncDir, 'facts.jsonl'))).toBe(0o600);
    expect(fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8')).toContain('perm-1');
  });
});
