import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { initDatabase } from './db.js';
import { getSuperpowersDir } from './paths.js';
import { syncFactRefusal, syncJudgmentFingerprint } from './import-guard.js';
import { OWNER_ONLY_DIR_MODE, OWNER_ONLY_FILE_MODE } from './file-perms.js';

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

/**
 * What judging the active facts gave last time (syncFactRefusal over every one
 * of them), kept beside OwnExportState — local, never in sync/. Counts and
 * fingerprints only: no id, no text.
 *
 * The judgment of a fact depends on the fact's row and on the judgment code,
 * nothing else. So while the serialized active facts hash the same (`input`)
 * and the code is the same (`judged_by`), the result is the same: which facts
 * are left out, and so what facts.jsonl holds (`output`). The export then does
 * not judge again — it did at every session end, 0.55s of CPU over 30,584
 * facts to find the same 877 (measured 2026-11-11).
 */
interface JudgedFacts {
  /** syncJudgmentFingerprint() of the code that judged. */
  judged_by: string;
  /** Every active fact as serialized, left out or not: what was judged. */
  input: { sha256: string; rows: number };
  /** facts.jsonl as that judgment leaves it. */
  output: { sha256: string; bytes: number; rows: number };
  withheld: WithheldFacts;
}

/** Where the last judgment is recorded (see JudgedFacts). */
function judgedFactsPath(): string {
  return path.join(getSuperpowersDir(), 'conversation-index', 'state', 'sync-export-judged.json');
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * The recorded judgment, or null when there is none or the record does not
 * hold together (not the expected shape, or its counts do not add up) — a
 * record that is not used costs one judgment; one used wrongly would say what
 * the export holds.
 */
function readJudgedFacts(): JudgedFacts | null {
  const v = readJsonOrNull<JudgedFacts>(judgedFactsPath());
  if (!v) return null;
  const { judged_by, input, output, withheld } = v;
  if (typeof judged_by !== 'string' || !input || typeof input.sha256 !== 'string' || !isCount(input.rows)) return null;
  if (!output || typeof output.sha256 !== 'string' || !isCount(output.bytes) || !isCount(output.rows)) return null;
  if (!withheld || !isCount(withheld.count) || !withheld.by_reason || typeof withheld.by_reason !== 'object' || Array.isArray(withheld.by_reason)) return null;
  const counts: unknown[] = Object.values(withheld.by_reason);
  if (!counts.every(isCount) || counts.reduce((sum, n) => sum + n, 0) !== withheld.count) return null;
  if (output.rows + withheld.count !== input.rows) return null;
  return v;
}

function sameJudged(a: JudgedFacts | null, b: JudgedFacts): boolean {
  return a !== null && a.judged_by === b.judged_by
    && a.input.sha256 === b.input.sha256 && a.input.rows === b.input.rows
    && a.output.sha256 === b.output.sha256 && a.output.bytes === b.output.bytes && a.output.rows === b.output.rows
    && sameWithheld(a.withheld, b.withheld);
}

/** The text of a .jsonl file: one line per row and a newline after the last (a lone newline when there is none). */
const jsonlBody = (lines: string[]): string => lines.join('\n') + '\n';

/** sha256 and byte count of jsonlBody(lines), taken line by line — the text itself is built only when it is written. */
function digestJsonl(lines: string[]): SyncFileMeta {
  const hash = createHash('sha256');
  let bytes = 1; // the closing newline
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { hash.update('\n'); bytes += 1; }
    hash.update(lines[i], 'utf8');
    bytes += Buffer.byteLength(lines[i], 'utf8');
  }
  hash.update('\n');
  return { sha256: hash.digest('hex'), bytes };
}

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
 *
 * The file is owner-only at every write. The rename replaces the file, mode
 * included: with a temp file created under the process umask, a facts.jsonl
 * the one-time pass had made 0600 (file-perms.ts) came back 0644 with the
 * first export that changed it. The sync folder is 0700, but a `sync` that is
 * a symlink into a cloud folder is not tightened — there the file's own mode
 * is all there is.
 */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // The mode below is given to a file that is created. One left under this name by a dead run
    // that had the same pid would be reused with the mode it has, so it goes first.
    try { fs.unlinkSync(tmp); } catch { /* none — the usual case */ }
    fs.writeFileSync(tmp, body, { mode: OWNER_ONLY_FILE_MODE });
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
 * The facts are judged when something the judgment depends on changed — a row
 * of an active fact, or the judgment code — and otherwise the last judgment
 * stands (JudgedFacts): the counts above and the fingerprint of facts.jsonl
 * come from the record, and the file, being up to date, is not touched. When
 * facts.jsonl has to be written, it is written from a judgment made in that
 * call, never from the record.
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
    const factLines = activeFacts.map((f) => JSON.stringify(f));

    // Only what an import accepts goes into the file: every active fact is judged, and the
    // lines of the accepted ones are what facts.jsonl holds.
    const judgeFacts = () => {
      const byReason: Record<string, number> = {};
      const lines: string[] = [];
      activeFacts.forEach((f, i) => {
        const refusal = syncFactRefusal(f as { fact: unknown; fact_kr?: unknown; category: unknown; scope_type: unknown });
        if (!refusal) { lines.push(factLines[i]); return; }
        byReason[refusal.reason] = (byReason[refusal.reason] ?? 0) + 1;
      });
      const withheld: WithheldFacts = { count: activeFacts.length - lines.length, by_reason: byReason };
      return { lines, fp: digestJsonl(lines), rows: lines.length, withheld };
    };

    // The same facts under the same judgment code were judged by an earlier run: its result
    // stands (JudgedFacts). Anything else — a changed row, changed code, no usable record — is judged now.
    const judgedBy = syncJudgmentFingerprint();
    const input = { sha256: digestJsonl(factLines).sha256, rows: factLines.length };
    const recorded = judgedBy === null ? null : readJudgedFacts();
    const remembered = recorded !== null && recorded.judged_by === judgedBy
      && recorded.input.sha256 === input.sha256 && recorded.input.rows === input.rows ? recorded : null;
    let fresh: ReturnType<typeof judgeFacts> | null = null; // set once the facts were judged in this call
    let facts: { fp: SyncFileMeta; rows: number; withheld: WithheldFacts };
    if (remembered) {
      const { output, withheld } = remembered;
      facts = { fp: { sha256: output.sha256, bytes: output.bytes }, rows: output.rows, withheld };
    } else {
      fresh = judgeFacts();
      facts = fresh;
    }

    const domains = db.prepare('SELECT * FROM ontology_domains').all();
    const categories = db.prepare('SELECT * FROM ontology_categories').all();
    const relations = db.prepare('SELECT * FROM ontology_relations').all();
    const dbRows = countRows(db);

    const metaPath = path.join(syncDir, 'meta.json');
    const prevMeta = readJsonOrNull<SyncMeta>(metaPath);
    // Unchanged: same content as the meta on disk describes, and the file is still there at that size.
    const upToDate = (name: SyncFileName, fp: SyncFileMeta): boolean => {
      const prev = prevMeta?.files?.[name];
      const onDisk = statOrNull(path.join(syncDir, name));
      return !!prev && prev.sha256 === fp.sha256 && prev.bytes === fp.bytes && !!onDisk && onDisk.size === fp.bytes;
    };

    // facts.jsonl has to be written: a remembered judgment says what the file holds, not its
    // text — the facts are judged now, and that result is the one used from here on.
    let factsBody: string | null = null;
    if (!upToDate('facts.jsonl', facts.fp)) {
      if (fresh === null) { fresh = judgeFacts(); facts = fresh; }
      if (!upToDate('facts.jsonl', facts.fp)) factsBody = jsonlBody(fresh.lines);
    }

    const jsonl = (rows: unknown[]) => jsonlBody(rows.map((r) => JSON.stringify(r)));
    const otherBodies: Record<Exclude<SyncFileName, 'facts.jsonl'>, string> = {
      'ontology-domains.jsonl': jsonl(domains),
      'ontology-categories.jsonl': jsonl(categories),
      'ontology-relations.jsonl': jsonl(relations),
    };

    const files: Record<string, SyncFileMeta> = {};
    const written: string[] = [];
    for (const name of SYNC_FILES) {
      const file = path.join(syncDir, name);
      if (name === 'facts.jsonl') {
        files[name] = facts.fp;
        if (factsBody === null) continue;
        writeAtomic(file, factsBody);
        written.push(name);
        continue;
      }
      const body = otherBodies[name];
      const fp: SyncFileMeta = {
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(body, 'utf8'),
      };
      files[name] = fp;
      if (upToDate(name, fp)) continue;
      writeAtomic(file, body);
      written.push(name);
    }
    const withheld = facts.withheld;
    const withheldByReason = withheld.by_reason;

    const metaDescribesThis = prevMeta !== null && sameWithheld(prevMeta.withheld_facts, withheld) && SYNC_FILES.every((name) => {
      const prev = prevMeta.files?.[name];
      return prev !== undefined && prev.sha256 === files[name].sha256 && prev.bytes === files[name].bytes;
    });
    let metaText: string | null = null;
    if (written.length > 0 || !metaDescribesThis) {
      const meta: SyncMeta = {
        exported_at: new Date().toISOString(),
        hostname: os.hostname(),
        facts_count: facts.rows,
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
        fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
        writeAtomic(statePath, JSON.stringify(state));
      } catch (e) {
        console.error('sync-export: could not record this export locally (the next import will read the files in full):', e instanceof Error ? e.message : e);
      }
    }

    // Record the judgment this call made, for the next run to stand on — whether or not a file
    // was written (a change to a fact that is left out changes no file, and would otherwise be
    // judged again at every session end). Without a fingerprint of the code there is nothing to
    // key it by; a record that cannot be written costs the next run one judgment, no more.
    if (fresh !== null && judgedBy !== null) {
      const record: JudgedFacts = { judged_by: judgedBy, input, output: { ...fresh.fp, rows: fresh.rows }, withheld: fresh.withheld };
      if (!sameJudged(recorded, record)) {
        try {
          const judgedPath = judgedFactsPath();
          fs.mkdirSync(path.dirname(judgedPath), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
          writeAtomic(judgedPath, JSON.stringify(record));
        } catch (e) {
          console.error('sync-export: could not record the judgment of the active facts (the next export will judge them again):', e instanceof Error ? e.message : e);
        }
      }
    }

    return {
      facts: facts.rows,
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
