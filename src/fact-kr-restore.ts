/**
 * Give facts that were rewritten without a Korean sentence the one their new
 * sentence already has.
 *
 * A fact that takes over another fact's sentence (EVOLUTION with no merged
 * sentence) now takes that fact's Korean sentence with it (consolidator.ts).
 * Rewrites made before that left the surviving fact with fact_kr NULL and no
 * Korean vector, so Korean queries stopped finding it (measured on a copy of
 * the live store: top 10 for 92 of 92 queries before the rewrite, 26 after).
 * The merged-away row is still in the table — inactive — with the Korean
 * sentence of exactly that sentence. This pass copies it back and embeds it.
 * No LLM call: nothing is translated here.
 *
 * What is restored, and only this:
 *  - the fact is active, has no Korean sentence, and a revision OF THIS FACT
 *    wrote the sentence it holds now (fact_revisions: fact_id = it, new_fact =
 *    its sentence) — a fact that simply never had a Korean sentence is not
 *    touched;
 *  - an inactive fact in the same scope holds the same sentence, word for
 *    word, with a Korean sentence, and has no revision of its own — its
 *    sentence and its Korean sentence are the pair it was stored with (a row
 *    rewritten by older code kept the Korean sentence of its EARLIER sentence);
 *  - no other fact's revision wrote that sentence: old code recorded a
 *    CONTRADICTION rewrite under the replaced fact's id, so such a row can hold
 *    a rewritten sentence with a stale Korean one and no revision of its own.
 *
 * The consolidate worker runs it once per plugin version
 * (restoreKoreanOncePerVersion): the first pass reads every revision, and
 * rewrites made by this version need no repair.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { setFactKorean } from './fact-db.js';
import { factKrRejectReason } from './fact-validity.js';
import { secretRejectReason } from './secret-scan.js';
import { getIndexDir } from './paths.js';

export interface KoreanRestoreResult {
  /** Active facts with no Korean sentence whose current sentence one of their own revisions wrote. */
  candidates: number;
  /** Of those, facts that got the Korean sentence (and a Korean vector) of the fact merged into them. */
  restored: number;
  /** Restorable facts left for a later pass because the per-pass limit was reached. */
  remaining: number;
}

/** Facts restored in one pass at most — bounds the embedding time of a pass (one local embedding each). */
export const KOREAN_RESTORE_LIMIT = 200;

interface Candidate { id: string; fact: string; scope_type: string; scope_project: string | null }

export async function restoreKoreanFromMergedFacts(
  db: Database.Database,
  embed: (text: string) => Promise<number[]>,
  opts: { limit?: number } = {},
): Promise<KoreanRestoreResult> {
  const limit = opts.limit ?? KOREAN_RESTORE_LIMIT;
  const candidates = db.prepare(`
    SELECT DISTINCT f.id, f.fact, f.scope_type, f.scope_project
    FROM fact_revisions r JOIN facts f ON f.id = r.fact_id
    WHERE f.is_active = 1 AND (f.fact_kr IS NULL OR trim(f.fact_kr) = '') AND r.new_fact = f.fact
    ORDER BY f.id
  `).all() as Candidate[];

  // The fact merged into the candidate: same scope, same sentence, inactive,
  // with a Korean sentence, never rewritten itself. The latest one when several.
  const donorOf = db.prepare(`
    SELECT d.fact_kr FROM facts d
    WHERE d.scope_type = ? AND d.scope_project IS ? AND d.is_active = 0 AND d.fact = ? AND d.id != ?
      AND d.fact_kr IS NOT NULL AND trim(d.fact_kr) != ''
      AND NOT EXISTS (SELECT 1 FROM fact_revisions r WHERE r.fact_id = d.id)
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1
  `);
  const writtenForAnother = db.prepare('SELECT 1 FROM fact_revisions WHERE new_fact = ? AND fact_id != ? LIMIT 1');

  const restorable: Array<{ candidate: Candidate; text: string }> = [];
  for (const c of candidates) {
    const donor = donorOf.get(c.scope_type, c.scope_project, c.fact, c.id) as { fact_kr: string } | undefined;
    if (!donor) continue;
    if (factKrRejectReason(donor.fact_kr) ?? secretRejectReason(donor.fact_kr)) continue;
    if (writtenForAnother.get(c.fact, c.id)) continue;
    restorable.push({ candidate: c, text: donor.fact_kr });
  }

  let restored = 0;
  for (const { candidate, text } of restorable.slice(0, limit)) {
    const vector = await embed(text);
    // Written only if the row is still what was read: active, same sentence, still without a Korean one.
    const written = db.transaction(() => {
      const now = db.prepare('SELECT fact, fact_kr, is_active FROM facts WHERE id = ?')
        .get(candidate.id) as { fact: string; fact_kr: string | null; is_active: number } | undefined;
      if (!now || now.is_active !== 1 || now.fact !== candidate.fact || (now.fact_kr ?? '').trim() !== '') return false;
      setFactKorean(db, candidate.id, text, vector);
      return true;
    }).immediate();
    if (written) restored++;
  }
  return { candidates: candidates.length, restored, remaining: Math.max(0, restorable.length - limit) };
}

// ── Once per plugin version ─────────────────────────────────────────────────

export function koreanRestoreStatePath(): string {
  return path.join(getIndexDir(), 'state', 'fact-kr-restore.json');
}

interface KoreanRestoreState extends Partial<KoreanRestoreResult> {
  pluginVersion: string | null;
  at: string;
  /** Set when the pass threw: it is not repeated for this version (the caller logged the error). */
  error?: string;
}

function readState(): KoreanRestoreState | null {
  try {
    const s = JSON.parse(fs.readFileSync(koreanRestoreStatePath(), 'utf8'));
    return s !== null && typeof s === 'object' ? s as KoreanRestoreState : null;
  } catch {
    return null; // absent or unreadable = not run yet
  }
}

function writeState(state: KoreanRestoreState): void {
  const file = koreanRestoreStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Run restoreKoreanFromMergedFacts unless it already ran to the end for this
 * plugin version. Returns null when it did not run. A pass that stopped at its
 * limit runs again on the next call; a pass that threw is recorded and not
 * repeated for this version — the error is thrown to the caller (once).
 */
export async function restoreKoreanOncePerVersion(
  db: Database.Database,
  pluginVersion: string | null,
  embed: (text: string) => Promise<number[]>,
  opts: { limit?: number } = {},
): Promise<KoreanRestoreResult | null> {
  const state = readState();
  if (state && state.pluginVersion === pluginVersion && (state.error !== undefined || state.remaining === 0)) return null;
  const at = new Date().toISOString();
  try {
    const result = await restoreKoreanFromMergedFacts(db, embed, opts);
    writeState({ pluginVersion, at, ...result });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try { writeState({ pluginVersion, at, error }); } catch { /* the caller logs the pass's own error */ }
    throw e;
  }
}
