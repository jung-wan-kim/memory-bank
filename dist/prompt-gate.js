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
/** Leading markers of harness-generated prompts, matched after leading whitespace. */
const MACHINE_PREFIXES = [
    ['<task-notification>', 'task-notification'],
    ['<command-message>', 'slash-command'],
    ['<command-name>', 'slash-command'],
    ['<local-command-', 'local-command'],
    ['<cross-session-message', 'cross-session'],
    ['<teammate-message', 'teammate-message'],
    ['<system-reminder>', 'system-reminder'],
];
/** Why this prompt gets no injection, or null when it should be searched. */
export function promptSkipReason(prompt) {
    if (!prompt)
        return 'empty';
    const head = prompt.trimStart();
    for (const [prefix, reason] of MACHINE_PREFIXES) {
        if (head.startsWith(prefix))
            return reason;
    }
    if (prompt.length < MIN_PROMPT_CHARS)
        return 'short';
    return null;
}
