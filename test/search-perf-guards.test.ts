import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static guards for the 2026-10-16 search-performance changes. Each one pins a
// property no unit test would notice regressing silently.

const REPO = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SOURCES = ['src', 'scripts', 'cli', 'bench']
  .flatMap((d) => walk(path.join(REPO, d)))
  .concat([path.join(REPO, 'bench-perf.mjs')]);

describe('per-table int8 scale is used everywhere', () => {
  it('scans real files', () => {
    expect(SOURCES.length).toBeGreaterThan(40);
  });

  it('no caller encodes/decodes with a bare dtype string (that would silently use the wrong scale)', () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, 'utf8');
      if (/getVecDtype\s*\(/.test(src)) offenders.push(`${path.relative(REPO, f)}: getVecDtype`);
      if (/(embeddingToVecBlob|normalizeVecDistance)\([^)]*,\s*'(int8|float32)'\s*\)/.test(src)) offenders.push(`${path.relative(REPO, f)}: string dtype`);
      if (/vecParamSql\(\s*'(int8|float32)'\s*\)/.test(src)) offenders.push(`${path.relative(REPO, f)}: vecParamSql string`);
    }
    expect(offenders).toEqual([]);
  });

  it('every file that writes or MATCHes a vec table derives its codec from getVecQuant', () => {
    const missing: string[] = [];
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, 'utf8');
      const touches = /(INSERT INTO|FROM)\s+\$?\{?(vec_facts|vec_facts_kr|vec_categories|vec_exchanges)\b[^`]*?(VALUES|MATCH)/s.test(src);
      if (touches && !/getVecQuant\(/.test(src) && !/vecParamFor\(/.test(src)) missing.push(path.relative(REPO, f));
    }
    // Deliberate exceptions, all on vec_exchanges (scale unchanged at 127) or copying blobs as-is:
    //  - src/vec-compact.ts copies stored blobs and reads the quant once per swap;
    //  - bench/analyze-int8.mjs is the one-off float32-vs-int8@127 comparison that justified the
    //    exchanges migration (it builds its own int8 table on purpose);
    //  - bench/profile.mjs predates the int8 exchanges table (already broken since 2026-07-11,
    //    out of scope here — recorded in docs/plans/2026-10-16-local-search-perf.md Deviations).
    const allowed = new Set([path.join('src', 'vec-compact.ts'), path.join('bench', 'analyze-int8.mjs'), path.join('bench', 'profile.mjs')]);
    expect(missing.filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe('MCP search knowledge section', () => {
  it('reuses the cached search connection (no initDatabase per call)', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/search.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function getKnowledgeContext'), src.indexOf('export function formatKnowledgeContext'))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body).toContain('getSearchDb()');
    expect(body).not.toMatch(/initDatabase\(\)|db\.close\(\)|listCategories\(/);
  });

  it('a failure is reported on stderr and in the result, never swallowed', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/mcp-server.ts'), 'utf8');
    const at = src.indexOf('getKnowledgeContext(params.query');
    const tail = src.slice(at, at + 700);
    expect(tail).not.toMatch(/catch\s*\{/);
    expect(tail).toMatch(/console\.error\(`memory-bank search: related knowledge unavailable/);
    expect(tail).toMatch(/Related knowledge unavailable/);
  });
});

// 2026-11-02 — the read-only search connection memory-maps the DB (plan native-inject-client AC-007 / TC-MMAP-001).
describe('search connection mmap (AC-007)', () => {
  it('searchMmapBytes: default 256MB, "0" turns it off, a bad value falls back to the default and warns once', async () => {
    const { searchMmapBytes, DEFAULT_SEARCH_MMAP_BYTES } = await import('../src/search.js');
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(DEFAULT_SEARCH_MMAP_BYTES).toBe(268_435_456);
    expect(searchMmapBytes(undefined, warn)).toBe(268_435_456);
    expect(searchMmapBytes('', warn)).toBe(268_435_456);
    expect(searchMmapBytes('0', warn)).toBe(0);
    expect(searchMmapBytes('134217728', warn)).toBe(134_217_728);
    expect(warnings).toEqual([]);
    expect(searchMmapBytes('abc', warn)).toBe(268_435_456);
    expect(searchMmapBytes('-5', warn)).toBe(268_435_456);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/MEMORY_BANK_SQLITE_MMAP_BYTES/);
  });

  it('getSearchDb() applies PRAGMA mmap_size to the search connection only', async () => {
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mmap-'));
    const prev = { db: process.env.MEMORY_BANK_DB_PATH, mm: process.env.MEMORY_BANK_SQLITE_MMAP_BYTES };
    process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 'search.db');
    delete process.env.MEMORY_BANK_SQLITE_MMAP_BYTES;
    try {
      const { getSearchDb } = await import('../src/search.js');
      const { initDatabase } = await import('../src/db.js');
      const search = getSearchDb();
      expect(search.pragma('mmap_size', { simple: true })).toBe(268_435_456);
      const writer = initDatabase();
      expect(writer.pragma('mmap_size', { simple: true })).toBe(0);
      writer.close();
    } finally {
      if (prev.db === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = prev.db;
      if (prev.mm !== undefined) process.env.MEMORY_BANK_SQLITE_MMAP_BYTES = prev.mm;
    }
  });
});
