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
 * refused.
 */
export declare const VALID_SCOPE_TYPES: ReadonlySet<string>;
/**
 * Why this text must not become a fact's body, or null. For writers that only
 * set the text (updateFact, the consolidator's merged_fact).
 */
export declare function factTextRejectReason(text: unknown): string | null;
/** Why this fact must not be stored, or null when it is acceptable. */
export declare function factRejectReason(p: {
    fact: unknown;
    category: unknown;
    scope_type: unknown;
}): string | null;
/** Why this ontology domain/category name must not be stored, or null. */
export declare function ontologyNameRejectReason(name: unknown): string | null;
