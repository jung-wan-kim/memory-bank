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
export type SkipReason = 'empty' | 'short' | 'task-notification' | 'slash-command' | 'local-command' | 'cross-session' | 'teammate-message' | 'system-reminder';
/** Why this prompt gets no injection, or null when it should be searched. */
export declare function promptSkipReason(prompt: string | null | undefined): SkipReason | null;
