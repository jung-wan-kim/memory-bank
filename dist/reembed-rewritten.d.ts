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
/**
 * cos(stored, fresh) below this = the stored vector is not this sentence's.
 * Measured on a copy of a live DB (2026-11-10): 300 never-rewritten facts
 * re-embedded to 1.000000 each, and the 518 stale rewritten ones were all
 * ≤ 0.9969 — nothing lies between, so the exact value in that gap is not critical.
 */
export declare const SAME_SENTENCE_MIN_COSINE = 0.9995;
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
/** Find the rewritten facts whose stored vector is not their sentence's. Reads only. */
export declare function checkRewrittenFacts(db: Database.Database, embed: (text: string) => Promise<number[]>): Promise<RewrittenFactsCheck>;
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
/**
 * Give every stale fact its sentence's vector (facts.embedding + vec_facts).
 * `factKr: 'keep'` leaves fact_kr and its vec_facts_kr row as they are — the
 * choice to make unless a translation run follows. `'clear'` removes both (the
 * Korean sentence was written with the old sentence), and that is not undone
 * by waiting: the restore the script runs next (fact-kr-restore.ts — also run
 * by the consolidation worker, once per plugin version) brings back a Korean
 * sentence only where a merged, deactivated fact still holds one
 * for the same sentence — on a copy of a live DB 71 of the 624 rewritten
 * active facts left without one after `clear`; the 436 whose sentence is
 * English only stay without a Korean vector until scripts/translate-facts.mjs
 * (LLM, run by hand) translates them. There is no default here on purpose:
 * the caller always says which.
 * One write transaction, the backup table included: all of it or none.
 */
export declare function applyRewrittenFacts(db: Database.Database, stale: StaleRewrittenFact[], opts: {
    factKr: FactKrPolicy;
    now?: Date;
}): RewrittenFactsApply;
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
export declare function restoreRewrittenFacts(db: Database.Database, backupTable: string): RewrittenFactsRestore;
