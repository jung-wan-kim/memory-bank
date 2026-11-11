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
 * rewrites made by this version need no repair. "Once" is a pass that ran to
 * the end — one that threw is run again by the next worker run. The repair
 * script that removes Korean sentences (reembed-rewritten-facts.mjs --apply
 * --fact-kr clear) runs it itself when it is done (restoreKoreanToEnd): the
 * facts it just cleared are new candidates, and the worker's pass for this
 * version is usually over by then.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setFactKorean } from './fact-db.js';
import { factKrRejectReason } from './fact-validity.js';
import { secretRejectReason } from './secret-scan.js';
import { getIndexDir } from './paths.js';
/** Facts restored in one pass at most — bounds the embedding time of a pass (one local embedding each). */
export const KOREAN_RESTORE_LIMIT = 200;
export async function restoreKoreanFromMergedFacts(db, embed, opts = {}) {
    const limit = opts.limit ?? KOREAN_RESTORE_LIMIT;
    const candidates = db.prepare(`
    SELECT DISTINCT f.id, f.fact, f.scope_type, f.scope_project
    FROM fact_revisions r JOIN facts f ON f.id = r.fact_id
    WHERE f.is_active = 1 AND (f.fact_kr IS NULL OR trim(f.fact_kr) = '') AND r.new_fact = f.fact
    ORDER BY f.id
  `).all();
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
    const restorable = [];
    for (const c of candidates) {
        const donor = donorOf.get(c.scope_type, c.scope_project, c.fact, c.id);
        if (!donor)
            continue;
        if (factKrRejectReason(donor.fact_kr) ?? secretRejectReason(donor.fact_kr))
            continue;
        if (writtenForAnother.get(c.fact, c.id))
            continue;
        restorable.push({ candidate: c, text: donor.fact_kr });
    }
    let restored = 0;
    for (const { candidate, text } of restorable.slice(0, limit)) {
        const vector = await embed(text);
        // Written only if the row is still what was read: active, same sentence, still without a Korean one.
        const written = db.transaction(() => {
            const now = db.prepare('SELECT fact, fact_kr, is_active FROM facts WHERE id = ?')
                .get(candidate.id);
            if (!now || now.is_active !== 1 || now.fact !== candidate.fact || (now.fact_kr ?? '').trim() !== '')
                return false;
            setFactKorean(db, candidate.id, text, vector);
            return true;
        }).immediate();
        if (written)
            restored++;
    }
    return { candidates: candidates.length, restored, remaining: Math.max(0, restorable.length - limit) };
}
/**
 * Every pass until nothing restorable is left, for a caller that has just
 * removed Korean sentences and wants back the ones that exist for the new
 * sentences. `candidates` is the count before the first pass. Stops when a
 * pass restores nothing (rows that changed under it are not waited for).
 */
export async function restoreKoreanToEnd(db, embed, opts = {}) {
    let candidates = null;
    let restored = 0;
    for (;;) {
        const pass = await restoreKoreanFromMergedFacts(db, embed, opts);
        candidates ??= pass.candidates;
        restored += pass.restored;
        if (pass.remaining === 0 || pass.restored === 0)
            return { candidates, restored };
    }
}
// ── Once per plugin version ─────────────────────────────────────────────────
export function koreanRestoreStatePath() {
    return path.join(getIndexDir(), 'state', 'fact-kr-restore.json');
}
/**
 * Passes in a row that may throw before the restore is left alone for a plugin
 * version. A pass that threw has not run to the end, so the next call runs it
 * again — recording it like a finished one left the facts without their Korean
 * sentence for the whole version after one bad moment (measured: another
 * connection held the write lock for 30s while the pass ran). The limit is for
 * a failure that comes back every time (each try reads every revision and
 * writes a log line). 3: chosen, not measured.
 *
 * A held write lock does not count toward it: it says nothing about the pass,
 * and it ends when the other writer does.
 */
export const KOREAN_RESTORE_MAX_FAILED_PASSES = 3;
/** A restore pass that threw. The message is the failure's own. */
export class KoreanRestoreError extends Error {
    retry;
    constructor(message, 
    /** true: the next call runs the pass again. false: this was the last try for this plugin version. */
    retry) {
        super(message);
        this.retry = retry;
        this.name = 'KoreanRestoreError';
    }
}
const isLockContention = (message) => /database is locked|database table is locked|SQLITE_BUSY/i.test(message);
/** Failed passes a state stands for. A record with an error and no count is one (written before they were counted). */
function failedPassesOf(state) {
    if (state.error === undefined)
        return 0;
    const n = state.failedPasses;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 1;
}
function readState() {
    try {
        const s = JSON.parse(fs.readFileSync(koreanRestoreStatePath(), 'utf8'));
        return s !== null && typeof s === 'object' ? s : null;
    }
    catch {
        return null; // absent or unreadable = not run yet
    }
}
function writeState(state) {
    const file = koreanRestoreStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, file);
}
/**
 * Run restoreKoreanFromMergedFacts unless it already ran to the end for this
 * plugin version. Returns null when it did not run. A pass that stopped at its
 * limit runs again on the next call. So does a pass that threw — the failure
 * is thrown to the caller as a KoreanRestoreError that says whether there is a
 * next try: after KOREAN_RESTORE_MAX_FAILED_PASSES failed passes in a row the
 * restore is left alone for this version (a held write lock is not counted).
 */
export async function restoreKoreanOncePerVersion(db, pluginVersion, embed, opts = {}) {
    const state = readState();
    const previous = state && state.pluginVersion === pluginVersion ? state : null;
    if (previous) {
        if (previous.error === undefined && previous.remaining === 0)
            return null; // ran to the end
        if (failedPassesOf(previous) >= KOREAN_RESTORE_MAX_FAILED_PASSES)
            return null; // given up for this version
    }
    const at = new Date().toISOString();
    let result;
    try {
        result = await restoreKoreanFromMergedFacts(db, embed, opts);
    }
    catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const failedPasses = (previous ? failedPassesOf(previous) : 0) + (isLockContention(error) ? 0 : 1);
        try {
            writeState({ pluginVersion, at, error, failedPasses });
        }
        catch { /* the caller logs the pass's own error */ }
        throw new KoreanRestoreError(error, failedPasses < KOREAN_RESTORE_MAX_FAILED_PASSES);
    }
    writeState({ pluginVersion, at, ...result });
    return result;
}
