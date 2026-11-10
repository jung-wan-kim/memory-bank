/**
 * One-time repair for facts whose sentence consolidation rewrote before it
 * re-embedded rewritten sentences (≤1.7.9): the row holds the new sentence but
 * its stored embedding, its vec_facts row and its fact_kr still describe the
 * old one (measured 2026-11: 72 of 80 sampled rewritten facts; 713 active
 * facts carry a revision's sentence).
 *
 * Candidates are the active facts whose sentence is the `new_fact` of a
 * revision in their own scope — that is where consolidation writes a sentence:
 * EVOLUTION onto the revised fact itself, CONTRADICTION onto the surviving
 * fact of the same scope. Whether a candidate is really stale is MEASURED, not
 * inferred: its sentence is embedded again and compared with the stored
 * vector. A fact whose vector already matches is left alone.
 *
 * The check needs no write, so it runs on a read-only handle (the script's
 * dry run opens the database read-only). Applying writes, in one transaction:
 * a backup table with every changed row's old bytes, then the new vectors.
 * `updated_at` is not touched — a repair is not a new confirmation, and
 * updated_at feeds the "recently updated" bonus of the session-start facts.
 */
import Database from 'better-sqlite3';
import { EMBEDDING_VERSION } from './embedding-version.js';
import { getVecQuant, embeddingToVecBlob, vecParamSql, type VecQuant } from './db.js';

/**
 * cos(stored, fresh) below this = the stored vector is not this sentence's.
 * Measured on a copy of a live DB (2026-11-10): 300 never-rewritten facts
 * re-embedded to 1.000000 each, and the 518 stale rewritten ones were all
 * ≤ 0.9969 — nothing lies between, so the exact value in that gap is not critical.
 */
export const SAME_SENTENCE_MIN_COSINE = 0.9995;

export type FactKrPolicy = 'clear' | 'keep';

export interface StaleRewrittenFact {
  id: string;
  /** The sentence that was embedded for the check — applied only if the row still holds it. */
  fact: string;
  embedding: number[];
  cosine: number;
  hasFactKr: boolean;
}

export interface RewrittenFactsCheck {
  /** Active facts, current embedding version, whose sentence is a revision's new sentence in their scope. */
  candidates: number;
  /** Candidates whose stored vector matches their sentence. */
  current: number;
  stale: StaleRewrittenFact[];
  /** Candidates not checked: no stored embedding. */
  skippedNoEmbedding: number;
  /** Rewritten facts on an older embedding version — the re-embed worker rebuilds those. */
  skippedOldVersion: number;
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

function toFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Find the rewritten facts whose stored vector is not their sentence's. Reads only. */
export async function checkRewrittenFacts(
  db: Database.Database,
  embed: (text: string) => Promise<number[]>,
): Promise<RewrittenFactsCheck> {
  const scopeKey = (scopeType: string, scopeProject: string | null, fact: string) => JSON.stringify([scopeType, scopeProject, fact]);
  // Without the embedding column: only the candidates' vectors are read (below).
  type Row = { id: string; fact: string; fact_kr: string | null; scope_type: string; scope_project: string | null; embedding_version: number };
  const active = db.prepare(
    'SELECT id, fact, fact_kr, scope_type, scope_project, embedding_version FROM facts WHERE is_active = 1'
  ).all() as Row[];
  const bySentence = new Map<string, Row[]>();
  for (const f of active) {
    const k = scopeKey(f.scope_type, f.scope_project, f.fact);
    const list = bySentence.get(k);
    if (list) list.push(f); else bySentence.set(k, [f]);
  }
  // The scope of a revision is the scope of the fact it was recorded under.
  const revisions = db.prepare(
    'SELECT r.new_fact, f.scope_type, f.scope_project FROM fact_revisions r JOIN facts f ON f.id = r.fact_id'
  ).all() as Array<{ new_fact: string; scope_type: string; scope_project: string | null }>;
  const candidates = new Map<string, Row>();
  for (const r of revisions) {
    for (const f of bySentence.get(scopeKey(r.scope_type, r.scope_project, r.new_fact)) ?? []) candidates.set(f.id, f);
  }

  const out: RewrittenFactsCheck = { candidates: 0, current: 0, stale: [], skippedNoEmbedding: 0, skippedOldVersion: 0 };
  for (const f of candidates.values()) {
    if (f.embedding_version !== EMBEDDING_VERSION) { out.skippedOldVersion++; continue; }
    const stored = (db.prepare('SELECT embedding FROM facts WHERE id = ?').get(f.id) as { embedding: Buffer | null }).embedding;
    if (!stored) { out.skippedNoEmbedding++; continue; }
    out.candidates++;
    const fresh = await embed(f.fact);
    const cos = cosine(toFloat32(stored), fresh);
    if (cos >= SAME_SENTENCE_MIN_COSINE) out.current++;
    else out.stale.push({ id: f.id, fact: f.fact, embedding: fresh, cosine: cos, hasFactKr: Boolean(f.fact_kr) });
  }
  return out;
}

export interface RewrittenFactsApply {
  /** Rows given their sentence's vector. */
  reembedded: number;
  /** Of those, rows whose fact_kr (and Korean vector) was removed. */
  factKrCleared: number;
  /** Stale at check time, but the sentence changed before the write — left for the next run. */
  changedSinceCheck: number;
  /** Table holding the old bytes of every changed row; null when nothing changed. */
  backupTable: string | null;
}

const BACKUP_PREFIX = 'reembed_rewritten_backup_';

function storedVec(db: Database.Database, table: 'vec_facts' | 'vec_facts_kr', id: string): Buffer | null {
  const row = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
  return row ? Buffer.from(row.embedding) : null;
}

/**
 * Give every stale fact its sentence's vector (facts.embedding + vec_facts).
 * `factKr: 'keep'` leaves fact_kr and its vec_facts_kr row as they are — the
 * choice to make unless a translation run follows. `'clear'` removes both (the
 * Korean sentence was written with the old sentence), and that is not undone
 * by waiting: the consolidation worker's restore (fact-kr-restore.ts) brings
 * back a Korean sentence only where a merged, deactivated fact still holds one
 * for the same sentence — on a copy of a live DB 71 of the 624 rewritten
 * active facts left without one after `clear`; the 436 whose sentence is
 * English only stay without a Korean vector until scripts/translate-facts.mjs
 * (LLM, run by hand) translates them. There is no default here on purpose:
 * the caller always says which.
 * One write transaction, the backup table included: all of it or none.
 */
export function applyRewrittenFacts(
  db: Database.Database,
  stale: StaleRewrittenFact[],
  opts: { factKr: FactKrPolicy; now?: Date },
): RewrittenFactsApply {
  const result: RewrittenFactsApply = { reembedded: 0, factKrCleared: 0, changedSinceCheck: 0, backupTable: null };
  if (stale.length === 0) return result;
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupTable = `${BACKUP_PREFIX}${stamp}`;

  db.transaction(() => {
    // dtype/scale read inside the write transaction (see fact-db.ts upsertFactVector).
    const qF = getVecQuant(db, 'vec_facts');
    const qK = getVecQuant(db, 'vec_facts_kr');
    db.exec(`CREATE TABLE ${backupTable} (
      id TEXT PRIMARY KEY, fact TEXT NOT NULL, fact_kr TEXT, embedding BLOB,
      vec BLOB, vec_kr BLOB, vec_quant TEXT NOT NULL, vec_kr_quant TEXT NOT NULL
    )`);
    const backup = db.prepare(`INSERT INTO ${backupTable} (id, fact, fact_kr, embedding, vec, vec_kr, vec_quant, vec_kr_quant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of stale) {
      const row = db.prepare('SELECT fact, fact_kr, embedding FROM facts WHERE id = ? AND is_active = 1')
        .get(s.id) as { fact: string; fact_kr: string | null; embedding: Buffer | null } | undefined;
      if (!row || row.fact !== s.fact) { result.changedSinceCheck++; continue; }
      backup.run(s.id, row.fact, row.fact_kr, row.embedding, storedVec(db, 'vec_facts', s.id), storedVec(db, 'vec_facts_kr', s.id),
        JSON.stringify(qF), JSON.stringify(qK));
      db.prepare('UPDATE facts SET embedding = ? WHERE id = ?').run(Buffer.from(new Float32Array(s.embedding).buffer), s.id);
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(s.id);
      db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(qF)})`).run(s.id, embeddingToVecBlob(s.embedding, qF));
      result.reembedded++;
      if (opts.factKr === 'clear' && (row.fact_kr || storedVec(db, 'vec_facts_kr', s.id))) {
        db.prepare('UPDATE facts SET fact_kr = NULL WHERE id = ?').run(s.id);
        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(s.id);
        result.factKrCleared++;
      }
    }
    if (result.reembedded === 0) db.exec(`DROP TABLE ${backupTable}`);
    else result.backupTable = backupTable;
  }).immediate();
  return result;
}

export interface RewrittenFactsRestore {
  restored: number;
  /** Backed-up rows whose sentence changed since (or that are gone): not overwritten. */
  skippedChanged: number;
}

/**
 * Put back what applyRewrittenFacts changed, from its backup table: the stored
 * embedding, fact_kr and both vector rows, byte for byte. A row whose sentence
 * is no longer the backed-up one is left alone. Refuses when a vector table's
 * dtype/scale differs from the backup's (the bytes would be decoded wrongly).
 */
export function restoreRewrittenFacts(db: Database.Database, backupTable: string): RewrittenFactsRestore {
  if (!/^reembed_rewritten_backup_\d{14}$/.test(backupTable)) throw new Error(`not a backup table of this script: ${backupTable}`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(backupTable)) {
    throw new Error(`no such backup table: ${backupTable}`);
  }
  const result: RewrittenFactsRestore = { restored: 0, skippedChanged: 0 };
  db.transaction(() => {
    const quants: Record<'vec_facts' | 'vec_facts_kr', VecQuant> = { vec_facts: getVecQuant(db, 'vec_facts'), vec_facts_kr: getVecQuant(db, 'vec_facts_kr') };
    const rows = db.prepare(`SELECT * FROM ${backupTable}`).all() as Array<{
      id: string; fact: string; fact_kr: string | null; embedding: Buffer | null; vec: Buffer | null; vec_kr: Buffer | null; vec_quant: string; vec_kr_quant: string;
    }>;
    for (const r of rows) {
      for (const [table, recorded] of [['vec_facts', r.vec_quant], ['vec_facts_kr', r.vec_kr_quant]] as const) {
        if (JSON.stringify(quants[table]) !== recorded) {
          throw new Error(`${table} is ${JSON.stringify(quants[table])} now but the backup holds ${recorded} bytes — not restored`);
        }
      }
      const current = db.prepare('SELECT fact FROM facts WHERE id = ?').get(r.id) as { fact: string } | undefined;
      if (!current || current.fact !== r.fact) { result.skippedChanged++; continue; }
      db.prepare('UPDATE facts SET embedding = ?, fact_kr = ? WHERE id = ?').run(r.embedding, r.fact_kr, r.id);
      for (const [table, bytes] of [['vec_facts', r.vec], ['vec_facts_kr', r.vec_kr]] as const) {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id);
        if (bytes) db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(quants[table])})`).run(r.id, bytes);
      }
      result.restored++;
    }
  }).immediate();
  return result;
}
