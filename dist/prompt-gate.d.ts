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
export declare const MIN_PROMPT_CHARS = 20;
export type SkipReason = 'empty' | 'short' | 'task-notification' | 'slash-command' | 'local-command' | 'cross-session' | 'teammate-message' | 'system-reminder' | 'hook-envelope';
export type InjectionQuery = {
    query: string;
    reason: null;
} | {
    query: null;
    reason: SkipReason;
};
/**
 * The text to search for this prompt, or why it gets no injection.
 *
 * Claude Code hands UserPromptSubmit the raw '/name args' form of a slash
 * command (measured 2026-10-03: the logged prompt_len matched the raw form in
 * all four /goal cases, never the expanded markup), so the expanded form below
 * is a guard against a format change. If it arrives, the arguments are the
 * person's request and get searched — the markup around them does not.
 */
export declare function injectionQuery(prompt: string | null | undefined): InjectionQuery;
/** Why this prompt gets no injection, or null when it should be searched. */
export declare function promptSkipReason(prompt: string | null | undefined): SkipReason | null;
