/**
 * Get the personal superpowers directory
 *
 * Precedence:
 * 1. MEMORY_BANK_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export declare function getSuperpowersDir(): string;
/**
 * Get conversation archive directory
 */
export declare function getArchiveDir(): string;
/**
 * Get conversation index directory
 */
export declare function getIndexDir(): string;
/**
 * Get database path
 */
export declare function getDbPath(): string;
/**
 * Get exclude config path
 */
export declare function getExcludeConfigPath(): string;
/**
 * Known coding agent source directories.
 * Maps source directory paths to coding agent identifiers.
 * Used during sync to auto-detect which agent generated a conversation.
 */
export interface AgentSource {
    name: string;
    sourceDir: string;
}
/**
 * Get the list of coding agent sources to sync from.
 * Default: Claude Code only. Additional agents configured via
 * MEMORY_BANK_AGENT_SOURCES env var (JSON) or agent-sources.json config file.
 *
 * Format: [{"name": "codex", "sourceDir": "/path/to/codex/conversations"}]
 */
export declare function getAgentSources(): AgentSource[];
/**
 * Detect coding agent from a source directory path.
 * Returns the agent name if the path matches a known source, 'claude-code' otherwise.
 */
export declare function detectCodingAgent(sourcePath: string): string;
/**
 * Claude Code transcripts root (~/.claude/projects). TEST_PROJECTS_DIR
 * override matches the long-standing indexer test convention.
 */
export declare function getProjectsDir(): string;
/**
 * Retention limits for source transcripts. Both are configurable via env
 * (MEMORY_BANK_RETENTION_DAYS, MEMORY_BANK_MAX_FILE_MB); a non-positive or
 * unparseable value falls back to the default. There is deliberately no
 * "unlimited" switch — pass a large number if you really want one.
 */
export interface RetentionPolicy {
    maxAgeDays: number;
    maxFileBytes: number;
}
export declare function getRetentionPolicy(): RetentionPolicy;
/** Source .jsonl is retained (copied + indexed) only if recent enough and not oversized. */
export declare function isRetainedSource(filePath: string, now?: number, policy?: RetentionPolicy): boolean;
/**
 * Reserved basename of the isolated working directory that llm.ts gives to
 * headless Agent SDK sessions (see LLM_WORKDIR in llm.ts). Every Haiku
 * classification call spawns a one-shot CLI session whose transcript lands in
 * ~/.claude/projects/<slug-of-that-cwd>/ — those slugs always end with this
 * name (current fixed dir and legacy mkdtemp variants alike). They are
 * ephemeral worker state, not knowledge: indexing them polluted the
 * conversation index with 6.4k exchanges (observed 2026-07-08).
 */
export declare const LLM_WORKDIR_BASENAME = "memory-bank-llm";
/**
 * True if a project slug (directory name under ~/.claude/projects) must be
 * skipped by indexing/sync. Combines the user-configured exact-match list
 * with the built-in exclusion of the plugin's own LLM worker sessions.
 */
export declare function isExcludedProject(project: string, excluded?: string[]): boolean;
/**
 * Exact leading text of the plugin's own Haiku worker prompts. Sessions from
 * BEFORE the fixed LLM workdir existed ran query() with the CALLER project's
 * cwd, so their transcripts sit in REAL project archives and can never be
 * excluded by slug — the slug is a legitimate project's. Content is the only
 * discriminator. Kept as full first sentences so a prefix can't match
 * ordinary human text by accident (measured pollution: 59,940 exchanges /
 * ~16% of one production corpus before this guard existed).
 */
export declare const WORKER_PROMPT_PREFIXES: readonly string[];
/**
 * True if a user message is one of the plugin's own LLM worker prompts —
 * such an exchange is ephemeral worker state, never knowledge, and must not
 * be indexed (searchable) regardless of which project slug it sits under.
 */
export declare function isWorkerPromptMessage(userMessage: string | null | undefined): boolean;
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export declare function getExcludedProjects(): string[];
