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
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export declare function getExcludedProjects(): string[];
