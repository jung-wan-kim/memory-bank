/**
 * Which prompts are worth a context injection.
 *
 * UserPromptSubmit also fires for text the harness submits on its own —
 * background-task notifications, slash-command expansions, local command
 * output, messages relayed from other sessions. None of it is a person asking
 * something, so injecting past decisions there only spends tokens and pushes
 * the same facts into the ledger before the real question arrives.
 *
 * Kept import-free on purpose: the thin hook client (scripts/inject-context.js)
 * loads this before deciding whether to contact the daemon, and it must not
 * pay for the heavy dist chain (better-sqlite3, transformers).
 */
export const MIN_PROMPT_CHARS = 20;
/**
 * Leading markers of harness-generated prompts whose whole text is machine
 * output (matched after leading whitespace). Slash-command expansions and
 * system reminders are handled separately: a person's text can follow them.
 */
const MACHINE_PREFIXES = [
    ['<task-notification>', 'task-notification'],
    ['<local-command-', 'local-command'],
    ['<cross-session-message', 'cross-session'],
    ['<teammate-message', 'teammate-message'],
];
const use = (query) => ({ query, reason: null });
const skip = (reason) => ({ query: null, reason });
const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
/** The text after any leading <system-reminder> blocks ('' when nothing follows). */
function afterLeadingReminders(text) {
    let rest = text;
    while (rest.startsWith(REMINDER_OPEN)) {
        const end = rest.indexOf(REMINDER_CLOSE);
        if (end < 0)
            return '';
        rest = rest.slice(end + REMINDER_CLOSE.length).trimStart();
    }
    return rest;
}
/**
 * The text to search for this prompt, or why it gets no injection.
 *
 * Claude Code hands UserPromptSubmit the raw '/name args' form of a slash
 * command (measured 2026-10-03: the logged prompt_len matched the raw form in
 * all four /goal cases, never the expanded markup), so the expanded form below
 * is a guard against a format change. If it arrives, the arguments are the
 * person's request and get searched — the markup around them does not.
 */
export function injectionQuery(prompt) {
    if (!prompt || !prompt.trim())
        return skip('empty');
    const head = prompt.trimStart();
    if (head.startsWith('<command-message>') || head.startsWith('<command-name>')) {
        const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(head)?.[1] ?? '').trim();
        if (!args)
            return skip('slash-command');
        return args.length >= MIN_PROMPT_CHARS ? use(args) : skip('short');
    }
    if (head.startsWith(REMINDER_OPEN)) {
        const rest = afterLeadingReminders(head);
        if (!rest)
            return skip('system-reminder');
        return rest.length >= MIN_PROMPT_CHARS ? use(rest) : skip('short');
    }
    for (const [prefix, reason] of MACHINE_PREFIXES) {
        if (head.startsWith(prefix))
            return skip(reason);
    }
    if (prompt.length < MIN_PROMPT_CHARS)
        return skip('short');
    return use(prompt);
}
/** Why this prompt gets no injection, or null when it should be searched. */
export function promptSkipReason(prompt) {
    return injectionQuery(prompt).reason;
}
