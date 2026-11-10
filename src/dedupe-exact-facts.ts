/**
 * One-time cleanup of EXACT duplicates: active facts of one scope whose
 * sentences are equal after collapsing whitespace and case — the same
 * identity the injection dedup uses (fact-text.ts factTextKey). Measured
 * 2026-11: 336 groups, 1,309 rows, 973 of them redundant, most from before the
 * consolidation cursor existed (those facts were never driven) or from groups
 * of 2–4 that the old candidate search could not see.
 *
 * No LLM and no vectors are involved: equal text is equal text. Per group the
 * OLDEST fact `(created_at, id)` stays — the same choice consolidation makes
 * for a DUPLICATE — and the others are deactivated (their vector rows go with
 * them, as deactivateFact does). Whether the survivor also takes the others'
 * confirmations is the caller's decision (`counts`): the largest groups are
 * session boilerplate ("the project is a git repository…" ×55), and a summed
 * count lifts exactly those to the top of the session-start facts. Sources are
 * always united. Ontology relations of a deactivated fact are NOT re-pointed.
 *
 * Finding the groups reads only (the script's dry run opens the database
 * read-only). Applying is one transaction that first copies every row it
 * changes into a backup table; `restoreExactDedupe` undoes it from there.
 */
import Database from 'better-sqlite3';
import { getVecQuant, vecParamSql, type VecQuant } from './db.js';

export type DedupeCounts = 'sum' | 'keep';

export interface ExactDuplicateGroup {
  survivorId: string;
  removedIds: string[];
  scopeType: string;
  scopeProject: string | null;
  /** The normalized sentence the members share — the apply step re-checks it. */
  sentenceKey: string;
}

/** Sentence identity: whitespace runs collapsed, trimmed, lower-cased. Nothing looser — "nearly the same" is the LLM's call. */
export function exactSentenceKey(fact: string): string {
  return fact.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Groups of active facts with one scope and one sentence, oldest member first. Reads only. */
export function findExactDuplicateGroups(db: Database.Database): ExactDuplicateGroup[] {
  const rows = db.prepare(
    'SELECT id, fact, scope_type, scope_project FROM facts WHERE is_active = 1 ORDER BY created_at ASC, id ASC'
  ).all() as Array<{ id: string; fact: string; scope_type: string; scope_project: string | null }>;
  const groups = new Map<string, ExactDuplicateGroup>();
  for (const r of rows) {
    const sentenceKey = exactSentenceKey(r.fact);
    const k = JSON.stringify([r.scope_type, r.scope_project, sentenceKey]);
    const g = groups.get(k);
    if (g) g.removedIds.push(r.id);
    else groups.set(k, { survivorId: r.id, removedIds: [], scopeType: r.scope_type, scopeProject: r.scope_project, sentenceKey });
  }
  return [...groups.values()].filter((g) => g.removedIds.length > 0);
}

export interface ExactDedupeApply {
  /** Groups merged. */
  groups: number;
  /** Facts deactivated. */
  deactivated: number;
  /** Groups left alone because a member changed (text, scope or active state) since they were found. */
  groupsChangedSinceCheck: number;
  /** Table holding the old values of every changed row; null when nothing changed. */
  backupTable: string | null;
}

const BACKUP_RE = /^dedupe_exact_backup_\d{14}$/;

function storedVec(db: Database.Database, table: 'vec_facts' | 'vec_facts_kr', id: string): Buffer | null {
  const row = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
  return row ? Buffer.from(row.embedding) : null;
}

/**
 * Merge every group into its oldest member. `counts: 'sum'` adds the removed
 * facts' consolidated_count to the survivor's, 'keep' leaves the survivor's
 * count alone. The survivor's updated_at is not touched (a cleanup is not a
 * new confirmation). One write transaction, the backup table included.
 */
export function applyExactDedupe(
  db: Database.Database,
  groups: ExactDuplicateGroup[],
  opts: { counts: DedupeCounts; now?: Date },
): ExactDedupeApply {
  const result: ExactDedupeApply = { groups: 0, deactivated: 0, groupsChangedSinceCheck: 0, backupTable: null };
  if (groups.length === 0) return result;
  const now = opts.now ?? new Date();
  const backupTable = `dedupe_exact_backup_${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  type Row = { id: string; fact: string; scope_type: string; scope_project: string | null; is_active: number; consolidated_count: number; source_exchange_ids: string | null; updated_at: string };

  db.transaction(() => {
    const qF = getVecQuant(db, 'vec_facts');
    const qK = getVecQuant(db, 'vec_facts_kr');
    db.exec(`CREATE TABLE ${backupTable} (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, survivor_id TEXT NOT NULL,
      consolidated_count INTEGER, source_exchange_ids TEXT, updated_at TEXT,
      count_added INTEGER NOT NULL DEFAULT 0, sources_after TEXT,
      vec BLOB, vec_kr BLOB, vec_quant TEXT NOT NULL, vec_kr_quant TEXT NOT NULL
    )`);
    const backup = db.prepare(`INSERT INTO ${backupTable}
      (id, role, survivor_id, consolidated_count, source_exchange_ids, updated_at, count_added, sources_after, vec, vec_kr, vec_quant, vec_kr_quant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const read = db.prepare('SELECT id, fact, scope_type, scope_project, is_active, consolidated_count, source_exchange_ids, updated_at FROM facts WHERE id = ?');
    const quants = [JSON.stringify(qF), JSON.stringify(qK)] as const;

    for (const g of groups) {
      const members = [g.survivorId, ...g.removedIds].map((id) => read.get(id) as Row | undefined);
      const intact = members.every((m) => m !== undefined && m.is_active === 1
        && m.scope_type === g.scopeType && m.scope_project === g.scopeProject && exactSentenceKey(m.fact) === g.sentenceKey);
      if (!intact) { result.groupsChangedSinceCheck++; continue; }
      const [survivor, ...removed] = members as Row[];

      const countAdded = opts.counts === 'sum' ? removed.reduce((s, r) => s + Math.max(1, r.consolidated_count ?? 1), 0) : 0;
      const sourcesAfter = JSON.stringify([...new Set(members.flatMap((m) => JSON.parse((m as Row).source_exchange_ids || '[]') as string[]))]);
      backup.run(survivor.id, 'survivor', survivor.id, survivor.consolidated_count, survivor.source_exchange_ids, survivor.updated_at,
        countAdded, sourcesAfter, null, null, ...quants);
      db.prepare('UPDATE facts SET consolidated_count = consolidated_count + ?, source_exchange_ids = ? WHERE id = ?')
        .run(countAdded, sourcesAfter, survivor.id);

      for (const r of removed) {
        backup.run(r.id, 'removed', survivor.id, r.consolidated_count, r.source_exchange_ids, r.updated_at,
          0, null, storedVec(db, 'vec_facts', r.id), storedVec(db, 'vec_facts_kr', r.id), ...quants);
        db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(now.toISOString(), r.id);
        db.prepare('DELETE FROM vec_facts WHERE id = ?').run(r.id);
        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(r.id);
        result.deactivated++;
      }
      result.groups++;
    }
    if (result.groups === 0) db.exec(`DROP TABLE ${backupTable}`);
    else result.backupTable = backupTable;
  }).immediate();
  return result;
}

export interface ExactDedupeRestore {
  /** Deactivated facts switched back on, with their vector rows. */
  reactivated: number;
  /** Survivors whose count (and, when unchanged since, sources) went back. */
  survivorsRestored: number;
  /** Backed-up facts no longer in the state the cleanup left them — not touched. */
  skippedChanged: number;
}

/**
 * Undo applyExactDedupe from its backup table. A removed fact is switched back
 * on only if it is still inactive; a survivor gives back exactly the count it
 * was given (later confirmations stay) and gets its old sources back only if
 * nothing was added to them since. Refuses when a vector table's dtype/scale
 * differs from the backup's.
 */
export function restoreExactDedupe(db: Database.Database, backupTable: string): ExactDedupeRestore {
  if (!BACKUP_RE.test(backupTable)) throw new Error(`not a backup table of this script: ${backupTable}`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(backupTable)) {
    throw new Error(`no such backup table: ${backupTable}`);
  }
  const result: ExactDedupeRestore = { reactivated: 0, survivorsRestored: 0, skippedChanged: 0 };
  db.transaction(() => {
    const quants: Record<'vec_facts' | 'vec_facts_kr', VecQuant> = { vec_facts: getVecQuant(db, 'vec_facts'), vec_facts_kr: getVecQuant(db, 'vec_facts_kr') };
    const rows = db.prepare(`SELECT * FROM ${backupTable}`).all() as Array<{
      id: string; role: string; consolidated_count: number; source_exchange_ids: string | null; updated_at: string;
      count_added: number; sources_after: string | null; vec: Buffer | null; vec_kr: Buffer | null; vec_quant: string; vec_kr_quant: string;
    }>;
    for (const r of rows) {
      for (const [table, recorded] of [['vec_facts', r.vec_quant], ['vec_facts_kr', r.vec_kr_quant]] as const) {
        if (JSON.stringify(quants[table]) !== recorded) {
          throw new Error(`${table} is ${JSON.stringify(quants[table])} now but the backup holds ${recorded} bytes — not restored`);
        }
      }
      const current = db.prepare('SELECT is_active, source_exchange_ids FROM facts WHERE id = ?')
        .get(r.id) as { is_active: number; source_exchange_ids: string | null } | undefined;
      if (r.role === 'removed') {
        if (!current || current.is_active !== 0) { result.skippedChanged++; continue; }
        db.prepare('UPDATE facts SET is_active = 1, updated_at = ? WHERE id = ?').run(r.updated_at, r.id);
        for (const [table, bytes] of [['vec_facts', r.vec], ['vec_facts_kr', r.vec_kr]] as const) {
          db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id);
          if (bytes) db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(quants[table])})`).run(r.id, bytes);
        }
        result.reactivated++;
      } else {
        if (!current) { result.skippedChanged++; continue; }
        db.prepare('UPDATE facts SET consolidated_count = MAX(1, consolidated_count - ?) WHERE id = ?').run(r.count_added, r.id);
        if (current.source_exchange_ids === r.sources_after) {
          db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(r.source_exchange_ids, r.id);
        }
        result.survivorsRestored++;
      }
    }
  }).immediate();
  return result;
}
