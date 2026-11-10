import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { initDatabase } from './db.js';
import { getSuperpowersDir } from './paths.js';
import { syncFactRefusal } from './import-guard.js';

const SYNC_DIR_NAME = 'sync';

/** The data files of an export, in write order (meta.json is written after them). */
const SYNC_FILES = ['facts.jsonl', 'ontology-domains.jsonl', 'ontology-categories.jsonl', 'ontology-relations.jsonl'] as const;
type SyncFileName = (typeof SYNC_FILES)[number];

/** A temp file older than this was left by a run that died mid-write; a younger one may be another run's. */
const STALE_TMP_MS = 10 * 60 * 1000;

interface SyncFileMeta {
  sha256: string;
  bytes: number;
}

interface SyncMeta {
  exported_at: string;
  hostname: string;
  facts_count: number;
  domains_count: number;
  categories_count: number;
  relations_count: number;
  /** Content fingerprint per data file — what the next export compares against (absent in files an older version wrote). */
  files?: Record<string, SyncFileMeta>;
  /** Active facts this export left out because an import refuses them: how many, by reason (no ids, no text). */
  withheld_facts?: WithheldFacts;
}

interface WithheldFacts {
  count: number;
  by_reason: Record<string, number>;
}

function sameWithheld(a: WithheldFacts | undefined, b: WithheldFacts): boolean {
  if (!a || typeof a !== 'object' || a.count !== b.count || !a.by_reason || typeof a.by_reason !== 'object') return false;
  const keys = Object.keys(b.by_reason);
  return Object.keys(a.by_reason).length === keys.length && keys.every((k) => a.by_reason[k] === b.by_reason[k]);
}

/**
 * What this install wrote last, kept OUTSIDE sync/ so it never travels with the
 * folder: the exact meta.json text, each data file's size and mtime right after
 * the write, and the row totals of the tables behind them (ownExportStillInDb).
 */
interface OwnExportState {
  meta: string;
  files: Record<string, { bytes: number; mtimeMs: number }>;
  db_rows: Record<string, number>;
}

const DB_ROW_TABLES = ['facts', 'ontology_domains', 'ontology_categories', 'ontology_relations'] as const;

export function getSyncDir(): string {
  const dir = path.join(getSuperpowersDir(), 'conversation-index', SYNC_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // owner-only: the exported facts are private (file-perms.ts)
  }
  return dir;
}

/** Where this install records its own last export (see OwnExportState). */
export function ownExportStatePath(): string {
  return path.join(getSuperpowersDir(), 'conversation-index', 'state', 'sync-own-export.json');
}

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function readJsonOrNull<T>(p: string): T | null {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

/**
 * Write through a temp file in the same folder and rename it into place: a
 * reader (the import of a session starting meanwhile, a folder-sync tool) sees
 * the old file or the new one, never a half-written one. A failed write removes
 * its temp file and throws — the final path keeps its previous content.
 */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

/** Temp files of runs that died mid-write (a killed SessionEnd hook) — a younger one may belong to a run in progress. */
function removeStaleTempFiles(syncDir: string): void {
  let names: string[];
  try { names = fs.readdirSync(syncDir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const p = path.join(syncDir, name);
    const st = statOrNull(p);
    if (st && now - st.mtimeMs > STALE_TMP_MS) {
      try { fs.unlinkSync(p); } catch { /* raced another run — fine */ }
    }
  }
}

function countRows(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of DB_ROW_TABLES) out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return out;
}

/**
 * Export facts, ontology domains/categories, and relations to JSONL files for
 * cross-device sync (cc-sync, iCloud, etc). The local SQLite DB itself is not synced.
 *
 * A file is rewritten only when its content changed: each file's sha256 and
 * byte count are kept in meta.json, and a file whose new content hashes the same
 * — and that still exists at that size — is left alone, mtime included. The
 * export used to rewrite everything at every session end, straight onto the
 * final paths: 103MB per session on a DB with 30k facts (measured 2026-11-10),
 * for files that had not changed and that nothing was collecting. The
 * fingerprint is the content itself, not (count, max(updated_at)): a category
 * re-assignment does not touch updated_at, and a deactivation plus an insert
 * keeps the count.
 *
 * Files that are written go through a temp file + rename (writeAtomic).
 * meta.json is written last, and only when a data file was written or the meta
 * on disk does not describe this content.
 *
 * An active fact the import refuses is not exported (syncFactRefusal — fact
 * validity, a credential-shaped string, an instruction aimed at the model):
 * the files used to carry rows stored before those checks existed, a bot token
 * among them, and every receiving device refused the same 875 lines at every
 * session start (measured 2026-11-11). The fact stays in this database as it
 * is — scripts/redact-secret-facts.mjs deactivates the credential-shaped ones.
 * `withheld` / `withheldByReason` and meta.json's `withheld_facts` say how many
 * were left out and why (counts only). Relations are exported as before: one
 * that names a fact the receiving device does not have is counted there.
 *
 * `written` names the files this call rewrote ([] = nothing changed).
 */
export function exportForSync(): {
  facts: number; domains: number; categories: number; relations: number; written: string[];
  withheld: number; withheldByReason: Record<string, number>;
} {
  const db = initDatabase();
  const syncDir = getSyncDir();

  try {
    removeStaleTempFiles(syncDir);

    // Export facts (fact_kr included so other devices can build Korean vectors)
    const activeFacts = db.prepare(`
      SELECT id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, ontology_category_id
      FROM facts WHERE is_active = 1
    `).all() as Array<Record<string, unknown>>;
    // Only what an import accepts goes into the file.
    const withheldByReason: Record<string, number> = {};
    const facts = activeFacts.filter((f) => {
      const refusal = syncFactRefusal(f as { fact: unknown; fact_kr?: unknown; category: unknown; scope_type: unknown });
      if (!refusal) return true;
      withheldByReason[refusal.reason] = (withheldByReason[refusal.reason] ?? 0) + 1;
      return false;
    });
    const withheld: WithheldFacts = { count: activeFacts.length - facts.length, by_reason: withheldByReason };
    const domains = db.prepare('SELECT * FROM ontology_domains').all();
    const categories = db.prepare('SELECT * FROM ontology_categories').all();
    const relations = db.prepare('SELECT * FROM ontology_relations').all();
    const dbRows = countRows(db);

    const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const bodies: Record<SyncFileName, string> = {
      'facts.jsonl': jsonl(facts),
      'ontology-domains.jsonl': jsonl(domains),
      'ontology-categories.jsonl': jsonl(categories),
      'ontology-relations.jsonl': jsonl(relations),
    };

    const metaPath = path.join(syncDir, 'meta.json');
    const prevMeta = readJsonOrNull<SyncMeta>(metaPath);
    const files: Record<string, SyncFileMeta> = {};
    const written: string[] = [];
    for (const name of SYNC_FILES) {
      const body = bodies[name];
      const fp: SyncFileMeta = {
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(body, 'utf8'),
      };
      files[name] = fp;
      const file = path.join(syncDir, name);
      const prev = prevMeta?.files?.[name];
      const onDisk = statOrNull(file);
      // Unchanged: same content as the meta on disk describes, and the file is still there at that size.
      if (prev && prev.sha256 === fp.sha256 && prev.bytes === fp.bytes && onDisk && onDisk.size === fp.bytes) continue;
      writeAtomic(file, body);
      written.push(name);
    }

    const metaDescribesThis = prevMeta !== null && sameWithheld(prevMeta.withheld_facts, withheld) && SYNC_FILES.every((name) => {
      const prev = prevMeta.files?.[name];
      return prev !== undefined && prev.sha256 === files[name].sha256 && prev.bytes === files[name].bytes;
    });
    let metaText: string | null = null;
    if (written.length > 0 || !metaDescribesThis) {
      const meta: SyncMeta = {
        exported_at: new Date().toISOString(),
        hostname: os.hostname(),
        facts_count: facts.length,
        domains_count: domains.length,
        categories_count: categories.length,
        relations_count: relations.length,
        files,
        withheld_facts: withheld,
      };
      metaText = JSON.stringify(meta, null, 2);
      writeAtomic(metaPath, metaText);
      written.push('meta.json');
      if (withheld.count > 0) {
        // Said when the export changed, not at every session end. Kinds and counts only.
        const kinds = Object.entries(withheldByReason).map(([reason, n]) => `${reason} ${n}`).join(', ');
        const secrets = Object.keys(withheldByReason).some((reason) => reason.startsWith('secret-'));
        console.error(
          `sync-export: left out ${withheld.count} active fact(s) an import refuses (${kinds})`
          + (secrets ? ' — the credential-shaped ones are still active here: node scripts/redact-secret-facts.mjs lists them, --apply deactivates them' : ''),
        );
      }
    }

    // Record what this install wrote — after the files, so a run that dies in
    // between leaves no record and the next import simply runs in full.
    if (metaText !== null) {
      const state: OwnExportState = { meta: metaText, files: {}, db_rows: dbRows };
      for (const name of SYNC_FILES) {
        const st = fs.statSync(path.join(syncDir, name));
        state.files[name] = { bytes: st.size, mtimeMs: st.mtimeMs };
      }
      // The record only lets the next import skip its read; failing to write it must not
      // turn a finished export into an error (a stale record never matches the new meta).
      try {
        const statePath = ownExportStatePath();
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        writeAtomic(statePath, JSON.stringify(state));
      } catch (e) {
        console.error('sync-export: could not record this export locally (the next import will read the files in full):', e instanceof Error ? e.message : e);
      }
    }

    return {
      facts: facts.length,
      domains: domains.length,
      categories: categories.length,
      relations: relations.length,
      written,
      withheld: withheld.count,
      withheldByReason,
    };
  } finally {
    db.close();
  }
}

/**
 * Data files in sync/ whose size is not the one meta.json declares: the folder
 * was read while an export or a folder-sync tool was still delivering it (a
 * data file and meta.json from different exports). [] when meta.json is
 * absent, unreadable, or written by a version that recorded no sizes — there
 * is nothing to compare against. Sizes only: the content is not re-hashed.
 */
export function syncFilesNotMatchingMeta(syncDir: string): string[] {
  const meta = readJsonOrNull<SyncMeta>(path.join(syncDir, 'meta.json'));
  if (!meta || !meta.files || typeof meta.files !== 'object') return [];
  const out: string[] = [];
  for (const name of SYNC_FILES) {
    const declared = meta.files[name];
    if (!declared || typeof declared.bytes !== 'number') continue;
    const st = statOrNull(path.join(syncDir, name));
    if (!st || st.size !== declared.bytes) out.push(name);
  }
  return out;
}

/**
 * Whether sync/ still holds exactly what THIS install exported last and the
 * local DB still has every row it had then — in which case an import has
 * nothing to add and need not read the files (it read ~100MB and ran ~80k id
 * lookups at every session start to find 0 new rows; measured 2026-11-10).
 *
 * All of these must hold, else false (the import runs in full, as before):
 *  - meta.json names this host, and its text is byte-for-byte the one this
 *    install recorded in ownExportStatePath(). The hostname alone is not
 *    enough: two of a user's machines can share one, and the device that never
 *    imports the other's files would stay silent about it.
 *  - every data file is still there at the size and mtime it had after the
 *    export (a tool that replaced one file but not meta.json is caught here).
 *  - no table behind the export has fewer rows than at export time. The import
 *    is also how a rebuilt or restored DB gets its facts back from this
 *    install's own files — that must keep working. Row totals (inactive facts
 *    included, so an inactive row cannot stand in for a lost active one), not
 *    the exported counts.
 *
 * Known limit: rows lost AND at least as many new ones added since the export
 * read as "nothing lost". The files' content is not re-hashed (that is the
 * read this check exists to avoid).
 */
export function ownExportStillInDb(db: Database.Database, syncDir: string): boolean {
  const state = readJsonOrNull<OwnExportState>(ownExportStatePath());
  if (!state || typeof state.meta !== 'string' || !state.files || !state.db_rows) return false;

  let metaText: string;
  try { metaText = fs.readFileSync(path.join(syncDir, 'meta.json'), 'utf-8'); } catch { return false; }
  if (metaText !== state.meta) return false;
  let meta: SyncMeta;
  try { meta = JSON.parse(metaText) as SyncMeta; } catch { return false; }
  if (!meta || meta.hostname !== os.hostname()) return false;

  for (const name of SYNC_FILES) {
    const rec = state.files[name];
    const st = statOrNull(path.join(syncDir, name));
    if (!rec || !st || st.size !== rec.bytes || st.mtimeMs !== rec.mtimeMs) return false;
  }

  const now = countRows(db);
  return DB_ROW_TABLES.every((table) => typeof state.db_rows[table] === 'number' && now[table] >= state.db_rows[table]);
}
