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
 * the sync import. scripts/redact-secret-facts.mjs applies the same rules to
 * rows stored before the check existed. The answer is a refusal, not a
 * rewrite — a fact whose point is a secret value has nothing left once the
 * value is gone, and the reason returned here never contains the matched text
 * (callers log it).
 *
 * Kept narrow on purpose. A provider prefix or a fixed layout decides most
 * rules, and the value behind it must read as generated — a placeholder
 * ("sk_live_xxxxxxxx", "postgres://user:password@host", "Bearer <token>")
 * passes. The keyword rules ("api_key = …", "the token is …") also need a long
 * value with a random-looking run, so commit hashes, UUIDs in prose, env-var
 * names and hyphenated wording pass.
 *
 * What is not caught (rule-based limits): a password shorter than 16
 * characters after a keyword, or one made of letters only; a URL password
 * shorter than 8 characters or made of plain words; a value containing
 * punctuation outside "_-+=" (it is cut there); a provider whose token has no
 * fixed prefix and that is written with no credential keyword next to it.
 */

/** Characters a credential value is made of (what the keyword rules capture). */
const VALUE_CHARS = 'A-Za-z0-9_\\-+=';

/** Words that announce a credential. */
const KEYWORD = '(?:api[ _-]?key|api\\s?키|secret(?:[ _-]?key)?|access[ _-]?key|private[ _-]?key|token|password|passwd|비밀번호|시크릿|토큰)';

/** "<keyword> = <value>" / "<keyword>: <value>": 16+ value characters after a credential keyword. */
const ASSIGNED_VALUE = new RegExp(`(?<![A-Za-z])${KEYWORD}["'\`]?\\s*[:=]\\s*["'\`]?([${VALUE_CHARS}]{16,})`, 'gi');

/**
 * The same keyword with the value in running text, no ':' or '=' between them:
 * "the API key is <value>", "토큰이야 <value>", "API 키는 <value>", "the deploy
 * token <value> is used". Between the two: a Korean particle attached to the
 * keyword (up to 4 syllables), then at most one linking word.
 */
const STATED_VALUE = new RegExp(
  `(?<![A-Za-z])${KEYWORD}[가-힣]{0,4}(?:\\s{1,8}(?:is|was|are|값|값은|값이))?\\s{1,8}["'\`(]?([${VALUE_CHARS}]{16,})`,
  'gi',
);

/** Keys that are public by design: a keyword next to one of these is not a secret. */
const PUBLIC_VALUE = /^(?:sb_publishable_|pk_(?:live|test)_)/;

/** A stretch between '-' / '_' that mixes letters and digits — what a random value has and wording does not. */
function hasRandomRun(value: string, minLength: number): boolean {
  return value.split(/[-_]/).some((run) => run.length >= minLength && /[0-9]/.test(run) && /[A-Za-z]/.test(run));
}

/**
 * A value that reads as generated rather than as a placeholder ("xxxxxxxx",
 * "YOUR_TOKEN_HERE", "0000…"): letters and digits together, or both letter
 * cases over many different characters.
 */
function looksGenerated(value: string): boolean {
  const distinct = new Set(value).size;
  if (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) return distinct >= 6;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && distinct >= 10;
}

/** Whether any match of `re` has a first group that `accept` takes for a real value. */
function anyValue(text: string, re: RegExp, accept: (value: string) => boolean): boolean {
  for (const m of text.matchAll(re)) {
    if (accept(m[1])) return true;
  }
  return false;
}

/**
 * Provider tokens recognised by a fixed prefix; group 1 is the generated body.
 * The publishable counterparts (pk_live_, sb_publishable_) are public and are not listed.
 */
const PREFIXED: ReadonlyArray<{ reason: string; re: RegExp }> = [
  // Stripe secret / restricted keys, live and test
  { reason: 'secret-stripe-key', re: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_([A-Za-z0-9]{16,})/g },
  // Stripe webhook signing secret
  { reason: 'secret-stripe-webhook-secret', re: /(?<![A-Za-z0-9])whsec_([A-Za-z0-9]{24,})/g },
  // Paddle API key
  { reason: 'secret-paddle-api-key', re: /(?<![A-Za-z0-9])pdl_(?:live|sdbx)_apikey_([A-Za-z0-9_]{20,})/g },
  // GitLab personal access token
  { reason: 'secret-gitlab-token', re: /(?<![A-Za-z0-9])glpat-([A-Za-z0-9_-]{20,})/g },
  // Hugging Face access token
  { reason: 'secret-huggingface-token', re: /(?<![A-Za-z0-9])hf_([A-Za-z0-9]{30,})/g },
  // Google OAuth client secret
  { reason: 'secret-google-oauth-client-secret', re: /(?<![A-Za-z0-9])GOCSPX-([A-Za-z0-9_-]{20,})/g },
  // Vercel token (vcp_ and its siblings)
  { reason: 'secret-vercel-token', re: /(?<![A-Za-z0-9])vc[a-z]_([A-Za-z0-9]{40,})/g },
  // PyPI upload token (the body always starts with the encoded "pypi.org")
  { reason: 'secret-pypi-token', re: /(?<![A-Za-z0-9])pypi-(AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})/g },
  // Groq, Replicate, Notion, Linear, xAI, Perplexity
  { reason: 'secret-provider-token', re: /(?<![A-Za-z0-9])(?:gsk_|r8_|ntn_|lin_api_|xai-|pplx-)([A-Za-z0-9]{30,})/g },
  // Figma personal access token
  { reason: 'secret-provider-token', re: /(?<![A-Za-z0-9])figd_([A-Za-z0-9_-]{40,})/g },
  // DigitalOcean personal / OAuth / refresh token
  { reason: 'secret-provider-token', re: /(?<![A-Za-z0-9])do[opr]_v1_([0-9a-f]{64})/g },
  // SendGrid: SG.<id>.<secret>
  { reason: 'secret-provider-token', re: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.([A-Za-z0-9_-]{30,})/g },
  // Mapbox secret token: sk.<payload>.<signature>
  { reason: 'secret-provider-token', re: /(?<![A-Za-z0-9])sk\.eyJ[A-Za-z0-9_-]{20,}\.([A-Za-z0-9_-]{16,})/g },
];

/** "scheme://user:password@host" — group 1 is the password. */
const URL_CREDENTIALS = /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]{1,20}:\/\/[^\s\/:@]{0,64}:([^\s\/@]{8,128})@/gi;

/** A URL password that is a value, not a placeholder ("password", "[YOUR-PASSWORD]", "${DB_PASSWORD}", "****"). */
function isUrlPassword(value: string): boolean {
  return !/[<>[\]{}$*]/.test(value) && looksGenerated(value);
}

const RULES: ReadonlyArray<{ reason: string; test: (text: string) => boolean }> = [
  // Telegram bot token: <bot id>:<35 characters>. Only a digit may not precede it — the token sits
  // right after "bot" in an API URL ("…/bot<id>:<token>/sendMessage") and after a Korean particle in prose.
  { reason: 'secret-telegram-bot-token', test: (t) => /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/.test(t) },
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
  // Slack incoming webhook: the URL itself is the credential (anyone holding it can post)
  {
    reason: 'secret-slack-webhook-url',
    test: (t) => anyValue(t, /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/([A-Za-z0-9]{16,})/g, looksGenerated),
  },
  // Discord webhook: same
  {
    reason: 'secret-discord-webhook-url',
    test: (t) => anyValue(t, /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/([A-Za-z0-9_-]{30,})/g, looksGenerated),
  },
  // AWS access key id (long-term and temporary)
  { reason: 'secret-aws-access-key-id', test: (t) => /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/.test(t) },
  // JWT: three base64url parts, the first two starting as a JSON object does
  { reason: 'secret-jwt', test: (t) => /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(t) },
  // PEM private key header, and the PGP private key block
  { reason: 'secret-private-key', test: (t) => /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(t) },
  // Supabase secret key / personal access token (the publishable key is public and is not matched)
  { reason: 'secret-supabase-key', test: (t) => /(?<![A-Za-z0-9])(?:sb_secret_[A-Za-z0-9_-]{20,}|sbp_[0-9a-f]{40})/.test(t) },
  // Google API key
  { reason: 'secret-google-api-key', test: (t) => /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/.test(t) },
  // npm access token
  { reason: 'secret-npm-token', test: (t) => /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/.test(t) },
  ...PREFIXED.map(({ reason, re }) => ({ reason, test: (t: string) => anyValue(t, re, looksGenerated) })),
  // "Authorization: Bearer <opaque value>" (a JWT after Bearer is the JWT rule's), "Authorization: Basic <base64>"
  {
    reason: 'secret-authorization-header',
    test: (t) =>
      anyValue(t, /\bBearer\s{1,4}([A-Za-z0-9._~+\/=-]{20,})/gi, (v) => hasRandomRun(v.replace(/[^A-Za-z0-9]/g, '-'), 16))
      || anyValue(t, /\bAuthorization["'`]?\s{0,4}[:=]\s{0,4}["'`]?Basic\s{1,4}([A-Za-z0-9+\/=]{16,})/gi, looksGenerated),
  },
  // A connection string or any other URL that carries its password: postgres://user:<password>@host
  { reason: 'secret-url-credentials', test: (t) => anyValue(t, URL_CREDENTIALS, isUrlPassword) },
  // "<keyword> = <value>" / "<keyword>: <value>"
  {
    reason: 'secret-credential-assignment',
    test: (t) => anyValue(t, ASSIGNED_VALUE, (v) => !PUBLIC_VALUE.test(v) && hasRandomRun(v, 12)),
  },
  // "<keyword> is <value>" / "<keyword>는 <value>" / "<keyword> <value>"
  {
    reason: 'secret-credential-in-prose',
    test: (t) => anyValue(t, STATED_VALUE, (v) => !PUBLIC_VALUE.test(v) && hasRandomRun(v, 12)),
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
