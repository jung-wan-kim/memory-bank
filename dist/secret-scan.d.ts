/**
 * Whether a text carries something shaped like a credential.
 *
 * A bot token that appeared in a conversation was copied into a fact by the
 * extraction LLM (2026-06-12) and stayed active: nothing on the write path
 * looked at a fact's content beyond "is it template residue". A stored fact is
 * re-shown in injection blocks, search results and the cross-device sync
 * files, so a credential must not get that far.
 *
 * Used where a new fact enters the store — the extractor (before the save) and
 * the sync import — and where a stored one would leave it: the sync export.
 * scripts/redact-secret-facts.mjs applies the same rules to rows stored before
 * the check existed. The answer is a refusal, not a
 * rewrite — a fact whose point is a secret value has nothing left once the
 * value is gone, and the reason returned here never contains the matched text
 * (callers log it).
 *
 * Kept narrow on purpose. A provider prefix or a fixed layout decides most
 * rules, and the value behind it must read as generated — a placeholder
 * ("sk_live_xxxxxxxx", "postgres://user:password@host", "Bearer <token>")
 * passes. The keyword rules ("api_key = …", "API_KEY_PROD=…", "the token is …")
 * also need a long value with a random-looking run, so env-var names and
 * hyphenated wording pass, and so does a commit hash or a UUID with no
 * credential keyword in front of it.
 *
 * With a keyword in front, a UUID or a 40-/64-digit hex digest passes only
 * where the keyword names it — the value follows the keyword directly, nothing
 * but spaces between them ("the pagination token <uuid> is returned", "캐시
 * 토큰 <sha256> 는 내용 해시다"). Where the sentence states it as the value
 * ("the token is <uuid>", "토큰은 <hash>", "token = <uuid>") it is refused like
 * any other value: API keys are issued in both shapes.
 *
 * What is not caught (rule-based limits): a password shorter than 16
 * characters after a keyword, or one made of letters only; a URL password
 * shorter than 8 characters or made of plain words; a value containing
 * punctuation outside "_-+=" (it is cut there); a provider whose token has no
 * fixed prefix and that is written with no credential keyword next to it; a
 * credential that is itself a UUID or a 40-/64-digit hex string, written
 * right after the keyword with no "is" / ":" / "=" ("deploy token <hex>"); an
 * assignment to a lower- or mixed-case name whose keyword is followed by more
 * of the name ("api_key_prod = …", "apiKeyProd: …") — only upper-case,
 * env-var-style names are read word by word.
 */
/**
 * Why this text must not be stored as (part of) a fact — the kind of
 * credential it carries — or null. Non-strings are not judged (an absent
 * fact_kr is not a secret).
 */
export declare function secretRejectReason(text: unknown): string | null;
