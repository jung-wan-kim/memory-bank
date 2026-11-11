import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { factRejectReason } from './fact-validity.js';
import { secretRejectReason } from './secret-scan.js';
const SHELLS = '(?:bash|sh|zsh|dash|ksh|fish|python3?|node|perl|ruby|php|pwsh|powershell)';
/**
 * A whole <system>…</system> / <system-reminder>…</system-reminder> block inside a text: an
 * opening tag and, anywhere after it, a closing tag of either name. One mention of the tag
 * name is ordinary (facts describe harness text); an opened and closed block is a forgery.
 *
 * Two bounded searches, not one `<open>[\s\S]*<close>` pattern: that one restarted its scan
 * at every opening tag, so a line of repeated unclosed tags took time quadratic in its length
 * (594KB held the import hook for 62s — the sync file sets no limit on a line).
 */
function hasRoleBlock(flat) {
    const open = flat.search(/<\s?(?:system-reminder|system)\b[^>]{0,60}>/i);
    if (open < 0)
        return false;
    const close = /<\s?\/\s?(?:system-reminder|system)\s?>/gi;
    close.lastIndex = open;
    return close.test(flat);
}
const PATTERNS = [
    // "ignore all previous instructions", "disregard the system prompt"
    {
        reason: 'override-instructions',
        re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|system|developer)\b[^.\n]{0,40}\b(?:instructions?|prompts?|directives?|messages?|guidelines?|context)\b/i,
    },
    // "이전 지시를 무시하고 …" (not "…무시하지 않는다")
    {
        reason: 'override-instructions',
        re: /(?:이전|위|앞선|앞의|기존|시스템)\s*(?:의\s*)?(?:모든\s*)?(?:지시|지침|명령|프롬프트)(?:사항)?(?:을|를|은|는|들을)?\s*(?:전부\s*|모두\s*)?(?:무시|잊어)(?!하지|하면\s*안)/,
    },
    // "never mention this step to the user", "don't tell the user about it" — but not
    // "never tell the user to <do something>", which is a rule about asking the user for work.
    {
        reason: 'conceal-from-user',
        re: /\b(?:never|do not|don't|dont|without)\s+(?:mention(?:ing)?|reveal(?:ing)?|disclos(?:e|ing)|tell(?:ing)?|inform(?:ing)?|notify(?:ing)?)\b[^.\n]{0,60}\b(?:the\s+)?(?:user|human|operator)s?\b(?!\s+to\s+\w)/i,
    },
    { reason: 'conceal-from-user', re: /\b(?:hide|conceal|keep)\b[^.\n]{0,60}\b(?:secret\s+)?from\s+(?:the\s+)?(?:user|human|operator)s?\b/i },
    // curl … | sh   ·   bash -c "$(curl …)"   ·   bash <(curl …)   ·   iwr … | iex   ·   base64 -d | sh
    { reason: 'remote-script-execution', re: new RegExp(`\\b(?:curl|wget)\\b[^\\n|;]{0,200}\\|\\s*(?:sudo\\s+)?${SHELLS}\\b`, 'i') },
    { reason: 'remote-script-execution', re: new RegExp(`\\b${SHELLS}\\s+(?:-c\\s+)?["']?\\$\\(\\s*(?:curl|wget)\\b`, 'i') },
    { reason: 'remote-script-execution', re: new RegExp(`(?:\\b${SHELLS}|\\bsource|(?:^|\\s)\\.)\\s+<\\(\\s*(?:curl|wget)\\b`, 'i') },
    { reason: 'remote-script-execution', re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|;]{0,200}\|\s*(?:iex|invoke-expression)\b/i },
    { reason: 'remote-script-execution', re: new RegExp(`\\bbase64\\s+(?:-d|-D|--decode)\\b[^\\n|;]{0,80}\\|\\s*(?:sudo\\s+)?${SHELLS}\\b`, 'i') },
    // A whole <system>…</system> / <system-reminder>…</system-reminder> block inside a fact (hasRoleBlock).
    { reason: 'role-marker', test: hasRoleBlock },
    // "send the API key to https://…", "email the credentials to x@y.z"
    {
        reason: 'credential-exfiltration',
        re: /\b(?:send|upload|post|forward|email|exfiltrate|copy|paste)\b[^.\n]{0,80}\b(?:api[ _-]?keys?|access[ _-]?tokens?|tokens?|credentials?|passwords?|secrets?|ssh[ _-]?keys?|private[ _-]?keys?|\.env)\b[^.\n]{0,80}\b(?:to|at|into)\b[^.\n]{0,40}(?:https?:\/\/|\b[\w.+-]+@[\w-]+\.[\w.]+)/i,
    },
];
/** Why this text is an instruction aimed at the model rather than a recorded decision, or null. */
export function instructionLikeReason(text) {
    if (typeof text !== 'string' || text === '')
        return null;
    // Whitespace runs collapsed: the injected block shows the text that way, and a newline must not hide a match.
    const flat = text.replace(/\s+/g, ' ');
    for (const pattern of PATTERNS) {
        if ('test' in pattern ? pattern.test(flat) : pattern.re.test(flat))
            return pattern.reason;
    }
    return null;
}
/**
 * Why a sync-file fact must not be imported, or null: its English text, its
 * Korean text or its category is an instruction aimed at the model.
 */
export function importGuardReason(f) {
    return instructionLikeReason(f.fact) ?? instructionLikeReason(f.fact_kr) ?? instructionLikeReason(f.category);
}
/**
 * The one judgment the sync export and the sync import share: a fact this
 * returns a refusal for is not written to the sync files and is not imported
 * from them. In order: fact validity (template residue, the prompt's example,
 * session-environment boilerplate), a credential-shaped string, an
 * instruction aimed at the model.
 *
 * One function on purpose. While only the import checked, the export kept
 * writing rows every receiving device refused at every session start (875 on
 * 2026-11-11), credential-shaped facts among them.
 */
export function syncFactRefusal(f) {
    const validity = factRejectReason(f);
    if (validity)
        return { kind: 'validity', reason: validity };
    const secret = secretRejectReason(f.fact) ?? secretRejectReason(f.fact_kr);
    if (secret)
        return { kind: 'secret', reason: secret };
    const guard = importGuardReason(f);
    if (guard)
        return { kind: 'instruction-like', reason: guard };
    return null;
}
/** sha256 over the content of these files, in this order — or null when one of them cannot be read. */
export function fingerprintOfFiles(files) {
    try {
        const hash = createHash('sha256');
        for (const file of files)
            hash.update(fs.readFileSync(file));
        return hash.digest('hex');
    }
    catch {
        return null;
    }
}
/**
 * A fingerprint of the code behind syncFactRefusal, or null when it cannot be
 * taken. What that function answers depends on the fact it is given and on
 * the three modules it is made of — this one, fact-validity and secret-scan,
 * which import nothing else at run time (pinned by
 * test/sync-export-judgment-reuse.test.ts). The fingerprint is the text of
 * those three files as loaded: it changes with any change to a rule, a
 * release or not.
 *
 * The sync export keeps its last judgment only while this value stays the
 * same (sync-export.ts). null — the files are not where this module is — means
 * "judge again", never "unchanged".
 */
export function syncJudgmentFingerprint() {
    try {
        const self = fileURLToPath(import.meta.url);
        const ext = path.extname(self);
        // Built into one file with its imports (a bundle): that file is all three.
        if (path.basename(self, ext) !== 'import-guard')
            return fingerprintOfFiles([self]);
        return fingerprintOfFiles(['fact-validity', 'import-guard', 'secret-scan'].map((name) => path.join(path.dirname(self), name + ext)));
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Origin mark
// ---------------------------------------------------------------------------
/** Origin recorded for a fact written by sync import. */
export const SYNC_IMPORT_ORIGIN = 'sync-import';
const ensured = new WeakSet();
/**
 * `fact_origins`: where a fact came from, for facts that did not come from
 * this device's own extraction. A side table rather than a column, so that
 * every existing reader and writer of `facts` is unaffected; a fact with no
 * row here was extracted locally.
 */
function ensureFactOriginsTable(db) {
    if (ensured.has(db))
        return;
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_origins (
      fact_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `);
    // Created inside a transaction that may still roll back: check again next time.
    if (!db.inTransaction)
        ensured.add(db);
}
/** Mark a fact as written by sync import. Call inside the transaction that inserts it. */
export function recordImportedFact(db, factId, now = new Date()) {
    ensureFactOriginsTable(db);
    db.prepare('INSERT OR REPLACE INTO fact_origins (fact_id, origin, recorded_at) VALUES (?, ?, ?)')
        .run(factId, SYNC_IMPORT_ORIGIN, now.toISOString());
}
/** The recorded origin of a fact, or null for a fact this device extracted itself. */
export function factOrigin(db, factId) {
    ensureFactOriginsTable(db);
    const row = db.prepare('SELECT origin, recorded_at AS recordedAt FROM fact_origins WHERE fact_id = ?').get(factId);
    return row ?? null;
}
