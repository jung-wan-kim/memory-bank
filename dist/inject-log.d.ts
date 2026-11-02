export interface InjectLogEntry {
    ts: string;
    /** 'deduped': 후보 전부가 이 세션에서 이미 주입됨 → 재주입 0 (토큰 절약 관측용). */
    status: 'injected' | 'no-match' | 'skipped' | 'error' | 'deduped';
    project?: string;
    prompt_len?: number;
    candidates?: number;
    injected?: number;
    /** 세션 원장 dedup 으로 걸러진 fact 수 — 절감량이 로그로 상시 측정된다. */
    deduped?: number;
    /** 실제 주입된 블록 크기(자) — 토큰 비용 관측용 (~chars/3 tok). */
    chars?: number;
    duration_ms?: number;
    error?: string;
    /**
     * Which execution path served this injection: warm MCP-server daemon, cold
     * fallback, the thin hook client itself (prompt skipped before any search), or
     * the SessionStart key-facts block (scripts/fact-consolidate-hook.js).
     */
    via?: 'daemon' | 'fallback' | 'client' | 'session-start';
    /** status='skipped' only — why (short prompt, task notification, slash command …). */
    reason?: string;
    /** Length of the text actually searched, when it differs from the prompt (prompt-gate.ts). */
    query_len?: number;
    /** via='fallback' only — why the warm daemon did not answer ('no-daemon', 'daemon-timeout', 'daemon-closed', 'daemon-error'). */
    fallback_reason?: string;
    /** One id per hook run: a daemon line and a fallback line with the same id are one prompt. */
    req_id?: string;
    /** Hook host: 'claude-code' | 'codex' | 'manual' — lets the two clients be measured apart. */
    client?: string;
    /** Which thin client made the request: the native binary (native/inject-client) or scripts/inject-context.js. */
    client_impl?: 'native' | 'node';
    /** CLAUDE_CODE_ENTRYPOINT (cli, sdk-ts …) — separates interactive sessions from automation. */
    entrypoint?: string;
    /** Whether the hook supplied a session id (no id = no per-session dedup). */
    has_session?: boolean;
    /** Stage timings (ms): embedding+baseline, fact KNN, 1-hop relations, repeat detection. */
    embed_ms?: number;
    search_ms?: number;
    related_ms?: number;
    /** Absent when repeat detection did not run (off by default — MEMORY_BANK_REPEAT_DETECT=1). */
    repeat_ms?: number;
    /** Injected facts by origin: vector hit vs 1-hop relation expansion. */
    from_vec?: number;
    from_rel?: number;
    /** Facts dropped because the same text was already in the block or the session ledger. */
    text_deduped?: number;
    /**
     * sim − baseline of each KNN candidate, rank order, 3 decimals — the gate's
     * input, so a margin change can be replayed against the log.
     */
    top_margins?: number[];
    /** Ids (first 12 chars) that cleared the gate, BEFORE the session ledger — what a prompt would have pulled in. */
    gated_ids?: string[];
    /**
     * Ids (first 12 chars) of the block handed to the host. The prompt path logs before it
     * writes the block, so a delivery that then fails still carries them (its ledger stays
     * empty); the SessionStart line logs after delivery and records a failed one as an error.
     */
    injected_ids?: string[];
    /** sha256(session_id) first 12 hex chars — groups one session's lines without storing its id. */
    session_key?: string;
    /** package.json version of the code that wrote the line. */
    plugin_version?: string;
    /** via='session-start' only — the SessionStart source Claude Code reports (startup, resume, clear, compact). */
    source?: string;
    /** Relation gate on only: neighbours dropped below the margin / never scored (inject-select.ts). */
    rel_gated_out?: number;
    rel_unscored?: number;
}
/** Log form of a fact id — 12 chars keep lines short and are unique enough for joins. */
export declare function shortId(id: string): string;
/** sha256(session id) prefix, or undefined without a session id. */
export declare function sessionKey(sessionId: unknown): string | undefined;
/** Version from the package.json next to dist/ (works for dist/*.js and the bundled server alike); undefined when unreadable. */
export declare function pluginVersion(): string | undefined;
export declare function getInjectLogPath(): string;
/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export declare function appendInjectLog(entry: Omit<InjectLogEntry, 'ts'>): void;
