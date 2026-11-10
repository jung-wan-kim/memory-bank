import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suppressConsole } from './test-utils.js';

// Mock embeddings (avoid loading the model) — same stubs as sync-export-import.test.ts
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));
vi.mock('../src/embedding-version.js', () => ({ EMBEDDING_VERSION: 2, EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' }));

/**
 * sync 내보내기·가져오기의 무변화 처리 (2026-11-10, 감사 SYNC-09 ①③ · PERF-11).
 *
 * 내보내기는 세션이 끝날 때마다 사실·분류·관계 전체(라이브 103MB)를 최종 경로에 바로 덮어썼고,
 * 가져오기는 세션이 시작할 때마다 자기 기기가 방금 쓴 그 파일을 전부 읽어 id 를 8만 번 조회했다
 * (재현 1.1초·RSS +261MB, 새 행 0).
 *  - 내보내기: 내용 지문(sha256)이 직전과 같으면 쓰지 않는다. 쓸 때는 임시 파일 + rename.
 *  - 가져오기: sync 폴더가 이 설치가 마지막으로 내보낸 그대로이고(meta 의 hostname 이 자기 것 +
 *    로컬 기록과 일치) DB 가 그 뒤로 행을 잃지 않았으면 파일을 읽지 않고 끝낸다.
 */

const originalEnv = { ...process.env };
const FILES = ['facts.jsonl', 'ontology-domains.jsonl', 'ontology-categories.jsonl', 'ontology-relations.jsonl'];
const ALL = [...FILES, 'meta.json'];

describe('sync 내보내기 — 변화가 있을 때만 쓴다', () => {
  let tmpDir: string;
  let syncDir: string;
  let restoreConsole: () => void;
  let exp: typeof import('../src/sync-export.js');
  let imp: typeof import('../src/sync-import.js');
  let dbMod: typeof import('../src/db.js');

  const NOW = '2026-11-10T01:02:03.000Z';
  function seedDb() {
    const db = dbMod.initDatabase();
    try {
      db.prepare('INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)').run('dom-1', 'Frontend', 'Frontend dev', NOW);
      db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run('cat-1', 'dom-1', 'React', 'React patterns', NOW);
      const ins = db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id)
        VALUES (?, ?, 'decision', 'global', NULL, '[]', ?, ?, 1, 1, ?)`);
      ins.run('fact-1', 'Use React hooks for shared state', NOW, NOW, 'cat-1');
      ins.run('fact-2', '배포는 Vercel 프리뷰로 확인한 뒤 병합한다', NOW, NOW, null);
      ins.run('fact-3', 'Standalone fact with no relation', NOW, NOW, null); // 관계가 없어 지울 수 있다(외래 키)
      db.prepare('INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('rel-1', 'fact-1', 'SUPPORTS', 'fact-2', 'test', NOW);
    } finally {
      db.close();
    }
  }
  const withDb = <T>(fn: (db: ReturnType<typeof dbMod.initDatabase>) => T): T => {
    const db = dbMod.initDatabase();
    try { return fn(db); } finally { db.close(); }
  };
  /** 파일마다 (mtime ns, 크기, 내용) — 쓰기가 일어났으면 mtime 이 달라진다. */
  const fingerprint = () => Object.fromEntries(ALL.map((f) => {
    const p = path.join(syncDir, f);
    const st = fs.statSync(p, { bigint: true });
    return [f, `${st.mtimeNs}:${st.size}:${st.ino}`];
  }));
  /** 모든 sync 파일의 mtime 을 과거로 돌린다 — 다시 쓰면 반드시 달라지게(같은 ms 안에서 다시 써도 구분된다). */
  const ageFiles = () => { for (const f of ALL) fs.utimesSync(path.join(syncDir, f), 1_700_000_000, 1_700_000_000); };
  const readMeta = () => JSON.parse(fs.readFileSync(path.join(syncDir, 'meta.json'), 'utf8'));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-sync-unchanged-'));
    process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_DB_PATH;
    restoreConsole = suppressConsole();
    exp = await import('../src/sync-export.js');
    imp = await import('../src/sync-import.js');
    dbMod = await import('../src/db.js');
    syncDir = exp.getSyncDir();
    seedDb();
  });

  afterEach(() => {
    restoreConsole();
    Object.keys(process.env).forEach((key) => { if (!(key in originalEnv)) delete process.env[key]; });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('무변화 2회 실행: 두 번째는 어느 파일도 다시 쓰지 않는다 (mtime·inode 불변)', () => {
    const first = exp.exportForSync();
    expect(first).toMatchObject({ facts: 3, domains: 1, categories: 1, relations: 1 });
    expect([...first.written].sort()).toEqual([...ALL].sort());
    ageFiles();
    const before = fingerprint();

    const second = exp.exportForSync();
    expect(second).toMatchObject({ facts: 3, domains: 1, categories: 1, relations: 1, written: [] });
    expect(fingerprint()).toEqual(before);
    // 세 번째도 같다 — 건너뛴 실행이 다음 판정의 기준(meta)을 흐리지 않는다
    expect(exp.exportForSync().written).toEqual([]);
    expect(fingerprint()).toEqual(before);
  });

  it('바뀐 파일만 다시 쓰고 meta 를 갱신한다 — 사실 하나가 바뀌면 facts.jsonl 과 meta.json 뿐', () => {
    exp.exportForSync();
    ageFiles();
    const before = fingerprint();
    withDb((db) => db.prepare("UPDATE facts SET fact = 'Use React hooks and context for shared state' WHERE id = 'fact-1'").run());

    const r = exp.exportForSync();
    expect([...r.written].sort()).toEqual(['facts.jsonl', 'meta.json']);
    const after = fingerprint();
    expect(after['facts.jsonl']).not.toBe(before['facts.jsonl']);
    expect(after['meta.json']).not.toBe(before['meta.json']);
    for (const f of ['ontology-domains.jsonl', 'ontology-categories.jsonl', 'ontology-relations.jsonl']) expect(after[f], f).toBe(before[f]);
    expect(fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8')).toContain('hooks and context');
  });

  it('updated_at 이 그대로인 변경(분류 재지정·비활성화+추가로 건수 동일)도 놓치지 않는다 — 지문은 내용이다', () => {
    exp.exportForSync();
    // (건수, max(updated_at)) 지문이라면 둘 다 놓친다
    withDb((db) => db.prepare("UPDATE facts SET ontology_category_id = 'cat-1' WHERE id = 'fact-2'").run());
    expect(exp.exportForSync().written).toContain('facts.jsonl');
    withDb((db) => {
      db.prepare("UPDATE facts SET is_active = 0 WHERE id = 'fact-3'").run();
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active)
        VALUES ('fact-4', 'Older fact added back', 'decision', 'global', NULL, '[]', ?, ?, 1, 1)`).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    });
    const r = exp.exportForSync();
    expect(r.facts).toBe(3);
    expect(r.written).toContain('facts.jsonl');
    const ids = fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id).sort();
    expect(ids).toEqual(['fact-1', 'fact-2', 'fact-4']);
  });

  it('meta.json 은 파일별 sha256·바이트 수와 hostname 을 싣고, 실제 파일과 맞는다', async () => {
    const { createHash } = await import('crypto');
    exp.exportForSync();
    const meta = readMeta();
    expect(meta).toMatchObject({ hostname: os.hostname(), facts_count: 3, domains_count: 1, categories_count: 1, relations_count: 1 });
    expect(Object.keys(meta.files).sort()).toEqual([...FILES].sort());
    for (const f of FILES) {
      const buf = fs.readFileSync(path.join(syncDir, f));
      expect(meta.files[f], f).toEqual({ sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
    }
  });

  it('파일이 없어졌거나 크기가 달라졌으면 지문이 같아도 다시 쓴다', () => {
    exp.exportForSync();
    fs.unlinkSync(path.join(syncDir, 'ontology-relations.jsonl'));
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '{"truncated":');
    const r = exp.exportForSync();
    expect([...r.written].sort()).toEqual(['facts.jsonl', 'meta.json', 'ontology-relations.jsonl']);
    expect(fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(fs.existsSync(path.join(syncDir, 'ontology-relations.jsonl'))).toBe(true);
  });

  it('지문 없는 옛 meta.json(이전 버전이 쓴 것)이면 전부 다시 쓴다', () => {
    exp.exportForSync();
    const meta = readMeta();
    delete meta.files;
    fs.writeFileSync(path.join(syncDir, 'meta.json'), JSON.stringify(meta, null, 2));
    expect([...exp.exportForSync().written].sort()).toEqual([...ALL].sort());
    expect(readMeta().files).toBeDefined();
  });

  it('임시 파일 + rename: 쓰기 뒤 sync 폴더에 임시 파일이 남지 않고, 쓰기가 실패하면 원래 파일이 그대로다', () => {
    exp.exportForSync();
    expect(fs.readdirSync(syncDir).sort()).toEqual([...ALL].sort());

    const original = fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8');
    withDb((db) => db.prepare("UPDATE facts SET fact = 'Changed while the disk was failing' WHERE id = 'fact-1'").run());
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('facts.jsonl')) throw new Error('ENOSPC: simulated');
      return realRename(from, to);
    });
    try {
      expect(() => exp.exportForSync()).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    // 최종 경로에 바로 쓰던 예전 코드는 여기서 반쯤 쓰인 파일을 남겼다
    expect(fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8')).toBe(original);
    expect(fs.readdirSync(syncDir).filter((f) => f.endsWith('.tmp')), '실패한 쓰기의 임시 파일을 치운다').toEqual([]);
    // 다음 실행이 마저 쓴다
    expect(exp.exportForSync().written).toContain('facts.jsonl');
    expect(fs.readFileSync(path.join(syncDir, 'facts.jsonl'), 'utf8')).toContain('Changed while the disk was failing');
  });

  it('죽은 실행이 남긴 오래된 임시 파일은 치우고, 방금 생긴 것(다른 실행이 쓰는 중)은 건드리지 않는다', () => {
    exp.exportForSync();
    const stale = path.join(syncDir, 'facts.jsonl.99999.tmp');
    const live = path.join(syncDir, 'facts.jsonl.99998.tmp');
    fs.writeFileSync(stale, 'x'); fs.writeFileSync(live, 'y');
    fs.utimesSync(stale, 1_700_000_000, 1_700_000_000);
    exp.exportForSync();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  describe('가져오기 — 자기 기기가 내보낸 그대로면 바로 끝낸다', () => {
    /** 가져오기가 도는 동안 sync 폴더에서 읽은 데이터 파일 이름 (meta.json 은 판정에 쓰므로 세지 않는다). */
    async function dataFilesReadDuringImport(): Promise<{ read: string[]; result: Awaited<ReturnType<typeof imp.importFromSync>> }> {
      const real = fs.readFileSync;
      const seen: string[] = [];
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        seen.push(String(p));
        return (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readFileSync);
      try {
        const result = await imp.importFromSync();
        return { read: [...new Set(seen.filter((p) => path.dirname(p) === syncDir).map((p) => path.basename(p)).filter((b) => FILES.includes(b)))].sort(), result };
      } finally {
        spy.mockRestore();
      }
    }
    const remoteFactLine = (id: string, fact: string) => {
      const now = new Date().toISOString();
      return JSON.stringify({
        id, fact, category: 'decision', scope_type: 'global', scope_project: null,
        source_exchange_ids: '[]', created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
      }) + '\n';
    };

    it('자기 내보내기 직후의 가져오기는 데이터 파일을 하나도 읽지 않고 0건으로 끝난다', async () => {
      exp.exportForSync();
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(true);
      const { read, result } = await dataFilesReadDuringImport();
      expect(read).toEqual([]);
      expect(result).toMatchObject({ newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0, failedFacts: 0 });
    });

    it('양성 대조: 로컬 기록이 없으면(이전 버전이 내보낸 파일) 예전처럼 네 파일을 다 읽는다', async () => {
      exp.exportForSync();
      fs.unlinkSync(exp.ownExportStatePath());
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
      const { read, result } = await dataFilesReadDuringImport();
      expect(read).toEqual([...FILES].sort());
      expect(result).toMatchObject({ newFacts: 0, newRelations: 0 });
    });

    it('다른 기기의 meta(hostname 다름)면 가져오기가 돈다', async () => {
      exp.exportForSync();
      fs.writeFileSync(path.join(syncDir, 'meta.json'), JSON.stringify({ ...readMeta(), hostname: `${os.hostname()}-other-device` }, null, 2));
      fs.appendFileSync(path.join(syncDir, 'facts.jsonl'), remoteFactLine('remote-1', 'Fact from the other device'));
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
      expect((await imp.importFromSync()).newFacts).toBe(1);
    });

    it('hostname 이 같아도 이 설치가 쓴 meta 가 아니면(같은 이름의 다른 기기) 가져오기가 돈다', async () => {
      exp.exportForSync();
      // 같은 hostname, 다른 내보내기 시각 — 이름만 같은 다른 기기의 파일이 sync 폴더에 놓인 모양
      fs.writeFileSync(path.join(syncDir, 'meta.json'), JSON.stringify({ ...readMeta(), exported_at: '2026-01-01T00:00:00.000Z' }, null, 2));
      fs.appendFileSync(path.join(syncDir, 'facts.jsonl'), remoteFactLine('twin-1', 'Fact from a device with the same hostname'));
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
      expect((await imp.importFromSync()).newFacts).toBe(1);
    });

    it('meta 는 그대로인데 데이터 파일만 바뀌었으면(크기 또는 수정 시각) 가져오기가 돈다', async () => {
      exp.exportForSync();
      // 크기가 달라진 경우
      fs.appendFileSync(path.join(syncDir, 'facts.jsonl'), remoteFactLine('partial-1', 'Fact appended without touching meta'));
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
      expect((await imp.importFromSync()).newFacts).toBe(1);
      // 크기는 같고 수정 시각만 달라진 경우 (같은 바이트를 누가 다시 썼다)
      exp.exportForSync();
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(true);
      fs.utimesSync(path.join(syncDir, 'ontology-relations.jsonl'), 1_700_000_000, 1_700_000_000);
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
    });

    it('내보낸 뒤 DB 가 행을 잃었으면(재구축·옛 백업 복원) 자기 파일에서 되살린다', async () => {
      exp.exportForSync();
      withDb((db) => {
        db.prepare("DELETE FROM ontology_relations WHERE id = 'rel-1'").run();
        db.prepare("DELETE FROM facts WHERE id = 'fact-3'").run();
      });
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(false);
      expect(await imp.importFromSync()).toMatchObject({ newFacts: 1, newRelations: 1 });
    });

    it('비활성 사실이 섞여 있어도 판정이 흔들리지 않는다 — 기준은 내보낼 때의 전체 행 수다', async () => {
      // 활성 3건만 내보내지만 표에는 비활성 1건이 더 있다. 그 비활성 행이 「잃은 활성 행」을 가리면 안 된다.
      withDb((db) => db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active)
        VALUES ('fact-old', 'Retired fact', 'decision', 'global', NULL, '[]', ?, ?, 1, 0)`).run(NOW, NOW));
      exp.exportForSync();
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir))).toBe(true);
      withDb((db) => db.prepare("DELETE FROM facts WHERE id = 'fact-3'").run());
      expect(withDb((db) => exp.ownExportStillInDb(db, syncDir)), '전체 4행 → 3행: 내보낸 활성 건수(3)와 같아도 잃은 것이다').toBe(false);
      expect((await imp.importFromSync()).newFacts).toBe(1);
    });

    it('건너뛴 내보내기(무변화) 뒤에도 가져오기는 여전히 바로 끝난다', async () => {
      exp.exportForSync();
      expect(exp.exportForSync().written).toEqual([]);
      const { read } = await dataFilesReadDuringImport();
      expect(read).toEqual([]);
    });
  });
});
