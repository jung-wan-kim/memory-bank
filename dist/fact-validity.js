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
 * that missing check — one place, used by every writer.
 *
 * Deliberately NOT enforced: the five-category taxonomy. Real facts still
 * arrive as 'requirement', 'solution', 'process' … (latest 2026-09-29) — they
 * are off-taxonomy content, not template residue, and rejecting them would
 * drop real knowledge. Only shapes that can only come from a template are
 * refused.
 */
export const VALID_SCOPE_TYPES = new Set(['global', 'project']);
/** Placeholder phrases seen in, or one edit away from, the leaked templates. */
const PLACEHOLDER_TEXTS = new Set([
    'concise statement', 'fact', 'fact text', 'the fact', 'fact in english', 'one sentence', 'statement',
    'domain', 'domain name', 'category', 'category name', 'name',
    'existing or new', 'existing or new domain name', 'existing or new category name',
    'new domain', 'new category', 'new domain name', 'new category name',
]);
function norm(s) {
    return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:;,!?…]+$/, '').trim();
}
function placeholderReason(text) {
    if (text.trim() === '')
        return 'empty';
    // Only dots/ellipsis/dashes/underscores/asterisks — the '...' template value
    if (/^[\s.…\-–—_*·]+$/.test(text))
        return 'punctuation-only';
    if (PLACEHOLDER_TEXTS.has(norm(text)))
        return 'template-placeholder';
    // A short value that is entirely one bracketed slot: '[concise sentence describing the fact]'
    if (/^\s*[\[<{][^\]>}]{0,80}[\]>}]\s*$/.test(text))
        return 'bracket-placeholder';
    return null;
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
/** Why this fact must not be stored, or null when it is acceptable. */
export function factRejectReason(p) {
    if (typeof p.fact !== 'string')
        return 'fact-not-string';
    const textReason = placeholderReason(p.fact);
    if (textReason)
        return `fact-${textReason}`;
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
