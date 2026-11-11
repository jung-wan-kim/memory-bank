/**
 * Save-time validity for facts and ontology names.
 *
 * Prompt templates leaked into the store once (created 2026-06-12~16, still
 * active on 2026-10-03): fact text '...', 'concise statement', 'fact in English',
 * '[concise sentence describing the fact]', category
 * 'decision|preference|pattern|knowledge|constraint', scope '...' /
 * 'project|global', and four ontology domains named 'domain name',
 * 'existing or new domain name', '...', 'existing or new'. The '...' facts
 * alone filled 183 injection slots. Nothing on the write path rejected them
 * because every check was "is it a non-empty string". These predicates are
 * that missing check, in one place: insertFact and updateFact (fact-db.ts),
 * the extractor, the consolidator's merged_fact, ontology domain/category
 * creation and the classifier's name sanitizer, and cross-device sync import.
 *
 * Deliberately NOT enforced: the five-category taxonomy. Real facts still
 * arrive as 'requirement', 'solution', 'process' … (latest 2026-09-29) — they
 * are off-taxonomy content, not template residue, and rejecting them would
 * drop real knowledge. Only shapes that can only come from a template are
 * refused. Writers fold such a name into the taxonomy with normalizeCategory
 * instead (the extractor does, before the save).
 *
 * Two more checks apply to a NEW fact only (factRejectReason — insertFact, the
 * extractor, sync import), not to a text written over an existing row
 * (factTextRejectReason — updateFact, the consolidator): the extraction
 * prompt's own example sentence, and sentences that only state the session's
 * environment. Rows with those texts are already stored (7 and 893 on
 * 2026-11-10); refusing the update path would make the consolidator's write
 * throw whenever one of them is merged.
 */
import type { FactCategory } from './types.js';
export declare const VALID_SCOPE_TYPES: ReadonlySet<string>;
/**
 * Why this text must not become a fact's body, or null. For writers that only
 * set the text (updateFact, the consolidator's merged_fact).
 */
export declare function factTextRejectReason(text: unknown): string | null;
/**
 * Why this text must not be a fact's Korean sentence (fact_kr), or null. An
 * absent one is fine. Lets a writer drop a copied placeholder from that field
 * alone and keep the fact.
 */
export declare function factKrRejectReason(text: unknown): string | null;
/** Why this fact must not be stored, or null when it is acceptable. */
export declare function factRejectReason(p: {
    fact: unknown;
    category: unknown;
    scope_type: unknown;
}): string | null;
/** Why this ontology domain/category name must not be stored, or null. */
export declare function ontologyNameRejectReason(name: unknown): string | null;
/**
 * Fold a category name into the five-category taxonomy. `known` is false when
 * the name is neither one of the five nor a listed alias — it becomes
 * 'knowledge' (the fact is kept), and the caller can count it. Call after
 * factRejectReason: template syntax ('a|b|c') must be refused, not folded.
 */
export declare function normalizeCategory(category: string): {
    category: FactCategory;
    known: boolean;
};
/**
 * The category name to PRINT for a stored fact: always one of the five, never
 * the stored value as it is. The blocks a model reads put it in front of the
 * fact (`- [decision] …` — inject-select.ts formatInjectBlock,
 * scripts/fact-consolidate-hook.js). The writers fold a category before they
 * store it, but rows stored before they did are still there: a sync import by
 * an older version kept the file's value, whatever it was — a value with a
 * newline adds a line to the block, a long one takes the block's budget. The
 * column is nullable, so anything that is not a string is 'knowledge' too.
 * Same folding as the writers (normalizeCategory) — no second rule.
 */
export declare function categoryLabel(category: unknown): FactCategory;
