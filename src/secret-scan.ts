/**
 * Whether a text carries something shaped like a credential.
 *
 * A bot token that appeared in a conversation was copied into a fact by the
 * extraction LLM (2026-06-12) and stayed active: nothing on the write path
 * looked at a fact's content beyond "is it template residue". A stored fact is
 * re-shown in injection blocks, search results and the cross-device sync
 * files, so a credential must not get that far.
 *
 * Used where a new fact enters the store: the extractor (before the save) and
 * the sync import. The answer is a refusal, not a rewrite — a fact whose point
 * is a secret value has nothing left once the value is gone, and the reason
 * returned here never contains the matched text (callers log it).
 *
 * Kept narrow on purpose. A provider prefix or a fixed layout decides most
 * rules; the one keyword rule ("api_key = …") also needs a long value with a
 * random-looking run, so commit hashes, UUIDs in prose, env-var names,
 * placeholders ("your-token-here") and hyphenated wording pass. A password
 * shorter than 16 characters is not caught.
 */

/** A value written after a credential keyword: 16+ token characters. */
const ASSIGNED_VALUE = /(?<![A-Za-z])(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?key|token|password|passwd|비밀번호|시크릿|토큰)["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9_\-+=]{16,})/gi;

/** A stretch between '-' / '_' that mixes letters and digits — what a random value has and wording does not. */
function hasRandomRun(value: string, minLength: number): boolean {
  return value.split(/[-_]/).some((run) => run.length >= minLength && /[0-9]/.test(run) && /[A-Za-z]/.test(run));
}

const RULES: ReadonlyArray<{ reason: string; test: (text: string) => boolean }> = [
  // Telegram bot token: <bot id>:<35 characters>
  { reason: 'secret-telegram-bot-token', test: (t) => /(?<![0-9A-Za-z])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/.test(t) },
  // "sk-" keys (OpenAI, Anthropic and the providers that copied the prefix). The run check keeps
  // a kebab-case name that happens to start with "sk-" out.
  {
    reason: 'secret-api-key',
    test: (t) => [...t.matchAll(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g)].some((m) => hasRandomRun(m[0].slice(3), 16)),
  },
  // GitHub: classic/OAuth/server/user/refresh tokens and fine-grained PATs
  { reason: 'secret-github-token', test: (t) => /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/.test(t) },
  // Slack: xox?- tokens
  { reason: 'secret-slack-token', test: (t) => /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{20,}/.test(t) },
  // AWS access key id (long-term and temporary)
  { reason: 'secret-aws-access-key-id', test: (t) => /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/.test(t) },
  // JWT: three base64url parts, the first two starting as a JSON object does
  { reason: 'secret-jwt', test: (t) => /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(t) },
  // PEM private key header
  { reason: 'secret-private-key', test: (t) => /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(t) },
  // Supabase secret key / personal access token (the publishable key is public and is not matched)
  { reason: 'secret-supabase-key', test: (t) => /(?<![A-Za-z0-9])(?:sb_secret_[A-Za-z0-9_-]{20,}|sbp_[0-9a-f]{40})/.test(t) },
  // Google API key
  { reason: 'secret-google-api-key', test: (t) => /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/.test(t) },
  // npm access token
  { reason: 'secret-npm-token', test: (t) => /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/.test(t) },
  // "<keyword> = <value>" / "<keyword>: <value>"
  {
    reason: 'secret-credential-assignment',
    test: (t) => [...t.matchAll(ASSIGNED_VALUE)].some((m) => hasRandomRun(m[1], 12)),
  },
];

/**
 * Why this text must not be stored as (part of) a fact — the kind of
 * credential it carries — or null. Non-strings are not judged (an absent
 * fact_kr is not a secret).
 */
export function secretRejectReason(text: unknown): string | null {
  if (typeof text !== 'string' || text === '') return null;
  for (const rule of RULES) {
    if (rule.test(text)) return rule.reason;
  }
  return null;
}
