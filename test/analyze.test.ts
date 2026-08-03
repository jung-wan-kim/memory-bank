import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { analyzeHistory, formatAnalysisMarkdown, projectSlug, isMainConversation } from '../src/analyze.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT
    );
    CREATE TABLE extraction_log (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT,
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      is_active INTEGER DEFAULT 1,
      ontology_category_id TEXT
    );
    CREATE TABLE ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
  `);
}

describe('analyze', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-bank-analyze-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('projectSlug', () => {
    it('converts filesystem paths to project slugs', () => {
      expect(projectSlug('/Users/me/Project/app')).toBe('-Users-me-Project-app');
    });

    it('converts dots as well as slashes', () => {
      expect(projectSlug('/tmp/my.app')).toBe('-tmp-my-app');
    });

    it('converts underscores per the canonical slug rule', () => {
      expect(projectSlug('/Users/me/article21_admin')).toBe('-Users-me-article21-admin');
    });

    it('leaves existing slugs unchanged', () => {
      expect(projectSlug('-Users-me-Project-app')).toBe('-Users-me-Project-app');
    });
  });

  describe('isMainConversation', () => {
    it('accepts UUID-named session files', () => {
      expect(isMainConversation('/a/b/2b0b050f-a99d-43df-85d0-b507fe6fa611.jsonl')).toBe(true);
    });

    it('rejects subagent transcripts', () => {
      expect(isMainConversation('/a/b/agent-abf9d54.jsonl')).toBe(false);
    });

    it('rejects non-jsonl names', () => {
      expect(isMainConversation('/a/b/2b0b050f-a99d-43df-85d0-b507fe6fa611.txt')).toBe(false);
    });
  });

  it('returns an empty report when database does not exist', async () => {
    const report = await analyzeHistory({ dbPath: join(testDir, 'missing.db') });
    expect(report.coverage.totalConversations).toBe(0);
    expect(report.coverage.totalExchanges).toBe(0);
    expect(report.projects).toEqual([]);
    expect(report.timeline).toEqual([]);
  });

  it('returns an empty report when exchanges table is missing', async () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE something_else (id TEXT)');
    db.close();

    const report = await analyzeHistory({ dbPath });
    expect(report.coverage.totalConversations).toBe(0);
  });

  it('aggregates coverage, projects, facts, and timeline', async () => {
    const db = new Database(dbPath);
    createSchema(db);

    const archiveDir = join(testDir, 'archive', 'proj-a');
    mkdirSync(archiveDir, { recursive: true });
    // Main-session conversations are UUID-named
    const convA = join(archiveDir, '11111111-1111-1111-1111-111111111111.jsonl');
    const convB = join(archiveDir, '22222222-2222-2222-2222-222222222222.jsonl');
    writeFileSync(convA, '{}');
    writeFileSync(convB, '{}');
    // Only conversation A has a summary
    writeFileSync(convA.replace('.jsonl', '-summary.txt'), 'summary A');

    const insert = db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Project A: 2 main conversations, 2 sessions, 3 exchanges across 2 months
    insert.run('e1', '-tmp-proj-a', '2026-05-01T10:00:00Z', 'q1', 'a1', convA, 1, 2, 0, 'sess-1');
    insert.run('e2', '-tmp-proj-a', '2026-05-02T10:00:00Z', 'q2', 'a2', convA, 3, 4, 0, 'sess-1');
    insert.run('e3', '-tmp-proj-a', '2026-06-01T10:00:00Z', 'q3', 'a3', convB, 1, 2, 0, 'sess-2');
    // Project B: 1 main conversation + 1 agent transcript
    const convC = join(testDir, '33333333-3333-3333-3333-333333333333.jsonl');
    const agentConv = join(testDir, 'agent-abc1234.jsonl');
    writeFileSync(convC, '{}');
    writeFileSync(agentConv, '{}');
    insert.run('e4', '-tmp-proj-b', '2026-06-15T10:00:00Z', 'q4', 'a4', convC, 1, 2, 0, 'sess-3');
    // is_sidechain=0 — sess-3 이 워커의 최소 교환수(기본 2)를 충족해야 pending 이다.
    // pending 판정이 단일 소스로 바뀌면서 이 수치는 "로그 행 없는 세션"이 아니라
    // "워커가 실제로 집을 세션"이 됐으므로, 픽스처도 그 조건을 갖춰야 의미가 유지된다.
    insert.run('e5', '-tmp-proj-b', '2026-06-15T11:00:00Z', 'q5', 'a5', agentConv, 1, 2, 0, 'sess-3');

    // Extraction: sess-1 processed, sess-2 seeded, sess-3 pending
    db.prepare("INSERT INTO extraction_log VALUES ('sess-1', '2026-06-01T00:00:00Z', 3, 2)").run();
    db.prepare("INSERT INTO extraction_log VALUES ('sess-2', '2026-06-01T00:00:00Z', -1, -1)").run();

    // Facts: 2 for project A (one via cwd path, one via slug), 1 global, 1 inactive
    db.prepare(`INSERT INTO facts VALUES ('f1', 'Fact one', 'decision', 'project', '/tmp/proj-a', 1, 'cat-1')`).run();
    db.prepare(`INSERT INTO facts VALUES ('f2', 'Fact two', 'pattern', 'project', '-tmp-proj-a', 1, 'cat-1')`).run();
    db.prepare(`INSERT INTO facts VALUES ('f3', 'Fact three', 'preference', 'global', NULL, 1, NULL)`).run();
    db.prepare(`INSERT INTO facts VALUES ('f4', 'Old fact', 'decision', 'project', '/tmp/proj-a', 0, NULL)`).run();

    // Ontology: one domain with one category holding f1/f2
    db.prepare("INSERT INTO ontology_domains VALUES ('dom-1', 'Infrastructure')").run();
    db.prepare("INSERT INTO ontology_categories VALUES ('cat-1', 'dom-1', 'Databases')").run();

    db.close();

    const report = await analyzeHistory({ dbPath });

    // Coverage
    expect(report.coverage.totalConversations).toBe(4);
    expect(report.coverage.mainConversations).toBe(3);
    expect(report.coverage.agentTranscripts).toBe(1);
    expect(report.coverage.totalSessions).toBe(3);
    expect(report.coverage.totalExchanges).toBe(5);
    expect(report.coverage.projectCount).toBe(2);
    expect(report.coverage.dateRange?.earliest).toBe('2026-05-01T10:00:00Z');
    expect(report.coverage.dateRange?.latest).toBe('2026-06-15T11:00:00Z');

    // Extraction: 1 processed, 1 seeded, 0 errors, 1 pending (sess-3)
    expect(report.coverage.extraction.processed).toBe(1);
    expect(report.coverage.extraction.seeded).toBe(1);
    expect(report.coverage.extraction.errors).toBe(0);
    expect(report.coverage.extraction.pending).toBe(1);

    // Summaries: 1 of 3 MAIN conversations (agent transcripts excluded)
    expect(report.coverage.summaries.withSummary).toBe(1);
    expect(report.coverage.summaries.withoutSummary).toBe(2);

    // Facts
    expect(report.facts.active).toBe(3);
    expect(report.facts.inactive).toBe(1);
    expect(report.facts.byCategory.find(c => c.category === 'decision')?.count).toBe(1);
    expect(report.facts.byScope.find(s => s.scope === 'project')?.count).toBe(2);
    expect(report.facts.byScope.find(s => s.scope === 'global')?.count).toBe(1);

    // Domains
    expect(report.domains).toEqual([{ domain: 'Infrastructure', facts: 2 }]);

    // Projects: A first (more exchanges), facts matched via cwd→slug + slug
    expect(report.projects[0].project).toBe('-tmp-proj-a');
    expect(report.projects[0].conversations).toBe(2);
    expect(report.projects[0].sessions).toBe(2);
    expect(report.projects[0].exchanges).toBe(3);
    expect(report.projects[0].facts).toBe(2);
    expect(report.projects[1].project).toBe('-tmp-proj-b');
    expect(report.projects[1].facts).toBe(0);

    // Timeline: ascending months
    expect(report.timeline.map(m => m.month)).toEqual(['2026-05', '2026-06']);
    expect(report.timeline[0].exchanges).toBe(2);
    expect(report.timeline[1].exchanges).toBe(3);
    expect(report.timeline[1].sessions).toBe(2);

    // Recommendations mention pending extraction and missing summaries
    expect(report.recommendations.some(r => r.includes('backfill-extract-worker'))).toBe(true);
    expect(report.recommendations.some(r => r.includes('memory-bank sync'))).toBe(true);
  });

  it('recommends nothing when coverage is complete', async () => {
    const db = new Database(dbPath);
    createSchema(db);

    const conv = join(testDir, '44444444-4444-4444-4444-444444444444.jsonl');
    writeFileSync(conv, '{}');
    writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'summary');

    db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
      VALUES ('e1', 'p', '2026-06-01T00:00:00Z', 'q', 'a', ?, 1, 2, 0, 'sess-1')
    `).run(conv);
    db.prepare("INSERT INTO extraction_log VALUES ('sess-1', '2026-06-01T00:00:00Z', 1, 1)").run();
    db.close();

    const report = await analyzeHistory({ dbPath });
    expect(report.coverage.extraction.pending).toBe(0);
    expect(report.coverage.summaries.withoutSummary).toBe(0);
    expect(report.recommendations).toEqual(['Analysis coverage is complete — no backfill needed.']);
  });

  it('respects topProjects and timelineMonths options', async () => {
    const db = new Database(dbPath);
    createSchema(db);
    const insert = db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    for (let i = 0; i < 5; i++) {
      insert.run(`e${i}`, `proj-${i}`, `2026-0${i + 1}-01T00:00:00Z`, 'q', 'a', join(testDir, `c${i}.jsonl`), 1, 2, `s${i}`);
    }
    db.close();

    const report = await analyzeHistory({ dbPath, topProjects: 2, timelineMonths: 3 });
    expect(report.projects).toHaveLength(2);
    expect(report.timeline).toHaveLength(3);
    // Most recent 3 months, ascending
    expect(report.timeline.map(m => m.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  describe('formatAnalysisMarkdown', () => {
    it('renders all sections with data', async () => {
      const db = new Database(dbPath);
      createSchema(db);
      db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
        VALUES ('e1', 'proj-a', '2026-06-01T00:00:00Z', 'q', 'a', ?, 1, 2, 0, 'sess-1')
      `).run(join(testDir, 'x.jsonl'));
      db.prepare(`INSERT INTO facts VALUES ('f1', 'Fact', 'decision', 'project', 'proj-a', 1, NULL)`).run();
      db.close();

      const report = await analyzeHistory({ dbPath });
      const md = formatAnalysisMarkdown(report);

      expect(md).toContain('# Conversation History Analysis');
      expect(md).toContain('## Coverage');
      expect(md).toContain('| Fact extraction |');
      expect(md).toContain('| Summaries (main sessions) |');
      expect(md).toContain('## Facts');
      expect(md).toContain('## Top Projects');
      expect(md).toContain('proj-a');
      expect(md).toContain('## Monthly Activity');
      expect(md).toContain('## Recommendations');
    });

    it('escapes pipe characters from DB-sourced values in table cells', async () => {
      const db = new Database(dbPath);
      createSchema(db);
      db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
        VALUES ('e1', 'evil | project', '2026-06-01T00:00:00Z', 'q', 'a', ?, 1, 2, 0, 'sess-1')
      `).run(join(testDir, 'x.jsonl'));
      db.prepare(`INSERT INTO facts VALUES ('f1', 'Fact', 'cat | injected', 'project', 'p', 1, NULL)`).run();
      db.prepare("INSERT INTO facts VALUES ('f2', 'Fact2', 'cr' || char(13) || '## injected-heading', 'project', 'p', 1, NULL)").run();
      db.close();

      const report = await analyzeHistory({ dbPath });
      const md = formatAnalysisMarkdown(report);
      expect(md).toContain('evil \\| project');
      expect(md).toContain('cat \\| injected');
      expect(md).not.toContain('| evil | project |');
      // lone \r must not survive as a line break either
      expect(md).not.toMatch(/\r/);
      expect(md).not.toMatch(/^## injected-heading/m);
    });

    it('escapes backslash-pipe sequences so `\\|` input cannot re-arm the pipe', async () => {
      const db = new Database(dbPath);
      createSchema(db);
      db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, is_sidechain, session_id)
        VALUES ('e1', ?, '2026-06-01T00:00:00Z', 'q', 'a', ?, 1, 2, 0, 'sess-1')
      `).run('evil \\| injected', join(testDir, 'x.jsonl'));
      db.close();

      const report = await analyzeHistory({ dbPath });
      const md = formatAnalysisMarkdown(report);
      // backslash doubled, pipe escaped: `evil \\\| injected`
      expect(md).toContain('evil \\\\\\| injected');
    });

    it('renders an empty report without crashing', () => {
      const md = formatAnalysisMarkdown({
        generatedAt: '2026-07-03T00:00:00Z',
        coverage: {
          totalConversations: 0,
          mainConversations: 0,
          agentTranscripts: 0,
          totalSessions: 0,
          totalExchanges: 0,
          projectCount: 0,
          dateRange: null,
          extraction: { processed: 0, seeded: 0, errors: 0, pending: 0 },
          summaries: { withSummary: 0, withoutSummary: 0 },
        },
        facts: { active: 0, inactive: 0, byCategory: [], byScope: [] },
        domains: [],
        projects: [],
        timeline: [],
        recommendations: ['Analysis coverage is complete — no backfill needed.'],
      });
      expect(md).toContain('# Conversation History Analysis');
      expect(md).toContain('0.0%');
    });
  });
});
