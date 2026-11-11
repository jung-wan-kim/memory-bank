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
export const VALID_SCOPE_TYPES = new Set(['global', 'project']);
/** Placeholder phrases seen in, or one edit away from, the leaked templates. */
const PLACEHOLDER_TEXTS = new Set([
    'concise statement', 'fact', 'fact text', 'the fact', 'fact in english', 'one sentence', 'statement',
    'domain', 'domain name', 'category', 'category name', 'name',
    'existing or new', 'existing or new domain name', 'existing or new category name',
    'new domain', 'new category', 'new domain name', 'new category name',
    // consolidator.ts output-format example before 2026-10-03
    'final sentence for merge/replace', 'final sentence',
]);
function norm(s) {
    return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:;,!?…]+$/, '').trim();
}
function placeholderReason(text) {
    if (text.trim() === '')
        return 'empty';
    // Only punctuation/symbols ('...', '?', ':', '—') — the '...' template value
    // and its kin. Measured 2026-10-03: no other stored fact, category or ontology
    // name (42,663 facts incl. inactive) is made of these alone.
    if (/^[\p{P}\p{S}\s]+$/u.test(text))
        return 'punctuation-only';
    if (PLACEHOLDER_TEXTS.has(norm(text)))
        return 'template-placeholder';
    // A short value that is entirely one bracketed slot: '[concise sentence describing the fact]'
    if (/^\s*[\[<{][^\]>}]{0,80}[\]>}]\s*$/.test(text))
        return 'bracket-placeholder';
    return null;
}
/**
 * Output examples the extraction prompt showed until 2026-11-10 (normalized).
 * A concrete example reads like a real fact, so the copies passed every check:
 * the English one was stored 6 times and the Korean one once, all active.
 * The prompt now shows bracketed slots (refused above as bracket-placeholder).
 */
const PROMPT_EXAMPLE_FACTS = new Set([
    'user uses riverpod for state management',
    '사용자는 상태 관리에 riverpod을 사용한다',
]);
// A sentence that says only where the session's project is, that it is a git
// repository, or which branch it is on. The harness tells every session these,
// so they came back as "facts" in every session (the largest exact-duplicate
// groups, e.g. 96× "Project is located at <path>"). Narrow on purpose: the
// whole sentence has to be one of these statements — anything it adds (a
// reason, a second clause, a named other project's location) makes it pass.
const ENV_PATH = String.raw `[~/][^\s,;]*`;
const ENV_BRANCH = String.raw `(?:the )?[\w./-]+ branch`;
const ENV_OWNER = String.raw `(?:the |this |(?:the )?user'?s )?`;
const ENV_NOUN = String.raw `(?:project|repository|repo|codebase)(?: repository)?`;
const ENV_WORKING = String.raw `(?:the )?user (?:is(?: currently)? working|works)`;
const SESSION_ENVIRONMENT_SENTENCES = [
    // "(The|User's) project is located at <path>"
    String.raw `^${ENV_OWNER}${ENV_NOUN} is located (?:at|in|under) ${ENV_PATH}$`,
    // "(The) [name] project is a git repository [at <path>] [on the main branch]"
    String.raw `^${ENV_OWNER}(?:[\w.-]+ )?${ENV_NOUN} is a git repo(?:sitory)?(?: (?:located )?(?:at|in) ${ENV_PATH})?(?: on ${ENV_BRANCH})?$`,
    // "(The) [name] repository is [currently] on the main branch"
    String.raw `^${ENV_OWNER}(?:[\w.-]+ )?${ENV_NOUN} is(?: currently)? on ${ENV_BRANCH}$`,
    // "User is working (in|with|on) a [name] [git] project [called 'x'] [located] at <path> [on the main branch]"
    String.raw `^${ENV_WORKING} (?:in|with|on|within) (?:a |an |the )?(?:[\w.-]+ )?(?:git )?${ENV_NOUN}(?: called ['"][^'"]+['"])? (?:located )?(?:at|in) ${ENV_PATH}(?: on ${ENV_BRANCH})?$`,
    // "User is working in [the] <path> [directory] [which is a git repository] [on the main branch]"
    String.raw `^${ENV_WORKING} (?:in|within|from) (?:the )?${ENV_PATH}(?: directory)?(?:,? which is a git repo(?:sitory)?)?(?: on ${ENV_BRANCH})?$`,
    // "User is [currently] on the main branch [of the repository]"
    String.raw `^(?:the )?user is(?: currently)? on ${ENV_BRANCH}(?: of (?:the|this|their) (?:repository|repo|project))?$`,
].map((source) => new RegExp(source, 'i'));
function isSessionEnvironmentSentence(text) {
    const sentence = text.replace(/\s+/g, ' ').trim().replace(/[.:;,!?…]+$/, '').trim();
    return SESSION_ENVIRONMENT_SENTENCES.some((re) => re.test(sentence));
}
/** An option list ('a|b|c') or a bare slot is template syntax, never a label. */
function labelReason(label) {
    const reason = placeholderReason(label);
    if (reason)
        return reason;
    if (/[|<>{}\[\]]/.test(label))
        return 'template-syntax';
    return null;
}
/**
 * Why this text must not become a fact's body, or null. For writers that only
 * set the text (updateFact, the consolidator's merged_fact).
 */
export function factTextRejectReason(text) {
    if (typeof text !== 'string')
        return 'fact-not-string';
    const reason = placeholderReason(text);
    return reason ? `fact-${reason}` : null;
}
/**
 * Why this text must not be a fact's Korean sentence (fact_kr), or null. An
 * absent one is fine. Lets a writer drop a copied placeholder from that field
 * alone and keep the fact.
 */
export function factKrRejectReason(text) {
    if (text === undefined || text === null)
        return null;
    const reason = factTextRejectReason(text);
    if (reason)
        return reason;
    return PROMPT_EXAMPLE_FACTS.has(norm(text)) ? 'fact-prompt-example' : null;
}
/** Why this fact must not be stored, or null when it is acceptable. */
export function factRejectReason(p) {
    const textReason = factTextRejectReason(p.fact);
    if (textReason)
        return textReason;
    // New facts only (see the header): the prompt's old example sentence, session-environment boilerplate.
    if (PROMPT_EXAMPLE_FACTS.has(norm(p.fact)))
        return 'fact-prompt-example';
    if (isSessionEnvironmentSentence(p.fact))
        return 'fact-session-environment';
    if (typeof p.category !== 'string')
        return 'category-not-string';
    const categoryReason = labelReason(p.category);
    if (categoryReason)
        return `category-${categoryReason}`;
    if (typeof p.scope_type !== 'string' || !VALID_SCOPE_TYPES.has(p.scope_type))
        return 'invalid-scope';
    return null;
}
/** Why this ontology domain/category name must not be stored, or null. */
export function ontologyNameRejectReason(name) {
    if (typeof name !== 'string')
        return 'not-string';
    const reason = labelReason(name);
    if (reason)
        return reason;
    if (/^existing or new\b/i.test(name.trim()))
        return 'template-placeholder';
    return null;
}
const FACT_CATEGORIES = new Set(['decision', 'preference', 'pattern', 'knowledge', 'constraint']);
/**
 * Off-taxonomy category names that reached the store (active on 2026-11-10:
 * requirement 19, process 3, project 2, convention 2, bugfix 2, solution 1,
 * 'project knowledge' 1, feature 1, configuration 1), and the plural forms of
 * the five. search_facts filters on the exact five names, so a fact stored
 * under any other name is found by no category filter.
 */
const CATEGORY_ALIASES = {
    decisions: 'decision',
    preferences: 'preference',
    patterns: 'pattern',
    constraints: 'constraint',
    requirement: 'constraint', requirements: 'constraint',
    convention: 'pattern', conventions: 'pattern', process: 'pattern', solution: 'pattern',
    bugfix: 'pattern', 'bug fix': 'pattern',
    project: 'knowledge', 'project knowledge': 'knowledge', configuration: 'knowledge',
    feature: 'knowledge', architecture: 'knowledge',
};
/**
 * Fold a category name into the five-category taxonomy. `known` is false when
 * the name is neither one of the five nor a listed alias — it becomes
 * 'knowledge' (the fact is kept), and the caller can count it. Call after
 * factRejectReason: template syntax ('a|b|c') must be refused, not folded.
 */
export function normalizeCategory(category) {
    const name = category.replace(/\s+/g, ' ').trim().toLowerCase();
    if (FACT_CATEGORIES.has(name))
        return { category: name, known: true };
    const alias = CATEGORY_ALIASES[name];
    if (alias)
        return { category: alias, known: true };
    return { category: 'knowledge', known: false };
}
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
export function categoryLabel(category) {
    return typeof category === 'string' ? normalizeCategory(category).category : 'knowledge';
}
