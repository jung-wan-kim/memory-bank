import os from 'os';
import path from 'path';
import fs from 'fs';
/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
/**
 * Get the personal superpowers directory
 *
 * Precedence:
 * 1. MEMORY_BANK_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export function getSuperpowersDir() {
    let dir;
    if (process.env.MEMORY_BANK_CONFIG_DIR) {
        dir = process.env.MEMORY_BANK_CONFIG_DIR;
    }
    else if (process.env.PERSONAL_SUPERPOWERS_DIR) {
        dir = process.env.PERSONAL_SUPERPOWERS_DIR;
    }
    else {
        const xdgConfigHome = process.env.XDG_CONFIG_HOME;
        if (xdgConfigHome) {
            dir = path.join(xdgConfigHome, 'superpowers');
        }
        else {
            dir = path.join(os.homedir(), '.config', 'superpowers');
        }
    }
    return ensureDir(dir);
}
/**
 * Get conversation archive directory
 */
export function getArchiveDir() {
    // Allow test override
    if (process.env.TEST_ARCHIVE_DIR) {
        return ensureDir(process.env.TEST_ARCHIVE_DIR);
    }
    return ensureDir(path.join(getSuperpowersDir(), 'conversation-archive'));
}
/**
 * Get conversation index directory
 */
export function getIndexDir() {
    return ensureDir(path.join(getSuperpowersDir(), 'conversation-index'));
}
/**
 * Get database path
 */
export function getDbPath() {
    // Allow test override with direct DB path
    if (process.env.MEMORY_BANK_DB_PATH || process.env.TEST_DB_PATH) {
        return process.env.MEMORY_BANK_DB_PATH || process.env.TEST_DB_PATH;
    }
    return path.join(getIndexDir(), 'db.sqlite');
}
/**
 * Get exclude config path
 */
export function getExcludeConfigPath() {
    return path.join(getIndexDir(), 'exclude.txt');
}
/**
 * Get the list of coding agent sources to sync from.
 * Default: Claude Code only. Additional agents configured via
 * MEMORY_BANK_AGENT_SOURCES env var (JSON) or agent-sources.json config file.
 *
 * Format: [{"name": "codex", "sourceDir": "/path/to/codex/conversations"}]
 */
export function getAgentSources() {
    const home = os.homedir();
    const defaultSources = [
        { name: 'claude-code', sourceDir: path.join(home, '.claude', 'projects') },
    ];
    // Check env variable for additional sources
    if (process.env.MEMORY_BANK_AGENT_SOURCES) {
        try {
            const extra = JSON.parse(process.env.MEMORY_BANK_AGENT_SOURCES);
            return [...defaultSources, ...extra];
        }
        catch {
            // Invalid JSON, use defaults only
        }
    }
    // Check for config file
    const configPath = path.join(getIndexDir(), 'agent-sources.json');
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const extra = JSON.parse(content);
            return [...defaultSources, ...extra];
        }
        catch {
            // Invalid config, use defaults only
        }
    }
    return defaultSources;
}
/**
 * Detect coding agent from a source directory path.
 * Returns the agent name if the path matches a known source, 'claude-code' otherwise.
 */
export function detectCodingAgent(sourcePath) {
    const sources = getAgentSources();
    for (const source of sources) {
        if (sourcePath.startsWith(source.sourceDir)) {
            return source.name;
        }
    }
    return 'claude-code';
}
/**
 * Claude Code transcripts root (~/.claude/projects). TEST_PROJECTS_DIR
 * override matches the long-standing indexer test convention.
 */
export function getProjectsDir() {
    return process.env.TEST_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}
export function getRetentionPolicy() {
    const days = Number(process.env.MEMORY_BANK_RETENTION_DAYS ?? 14);
    const mb = Number(process.env.MEMORY_BANK_MAX_FILE_MB ?? 64);
    return {
        maxAgeDays: Number.isFinite(days) && days > 0 ? days : 14,
        maxFileBytes: (Number.isFinite(mb) && mb > 0 ? mb : 64) * 1024 * 1024,
    };
}
/** Source .jsonl is retained (copied + indexed) only if recent enough and not oversized. */
export function isRetainedSource(filePath, now = Date.now(), policy = getRetentionPolicy()) {
    const st = fs.statSync(filePath);
    if (st.size > policy.maxFileBytes)
        return false;
    return now - st.mtimeMs <= policy.maxAgeDays * 86_400_000;
}
/**
 * Reserved basename of the isolated working directory that llm.ts gives to
 * headless Agent SDK sessions (see LLM_WORKDIR in llm.ts). Every Haiku
 * classification call spawns a one-shot CLI session whose transcript lands in
 * ~/.claude/projects/<slug-of-that-cwd>/ — those slugs always end with this
 * name (current fixed dir and legacy mkdtemp variants alike). They are
 * ephemeral worker state, not knowledge: indexing them polluted the
 * conversation index with 6.4k exchanges (observed 2026-07-08).
 */
export const LLM_WORKDIR_BASENAME = 'memory-bank-llm';
/**
 * True if a project slug (directory name under ~/.claude/projects) must be
 * skipped by indexing/sync. Combines the user-configured exact-match list
 * with the built-in exclusion of the plugin's own LLM worker sessions.
 */
export function isExcludedProject(project, excluded) {
    const list = excluded ?? getExcludedProjects();
    if (list.includes(project))
        return true;
    // Built-in: LLM worker session slugs (cwd path with '/' → '-'), e.g.
    // -private-var-folders-…-T-memory-bank-llm or …-T-tmp-XXXX-memory-bank-llm.
    return project === LLM_WORKDIR_BASENAME || project.endsWith(`-${LLM_WORKDIR_BASENAME}`);
}
/**
 * Exact leading text of the plugin's own Haiku worker prompts. Sessions from
 * BEFORE the fixed LLM workdir existed ran query() with the CALLER project's
 * cwd, so their transcripts sit in REAL project archives and can never be
 * excluded by slug — the slug is a legitimate project's. Content is the only
 * discriminator. Kept as full first sentences so a prefix can't match
 * ordinary human text by accident (measured pollution: 59,940 exchanges /
 * ~16% of one production corpus before this guard existed).
 */
export const WORKER_PROMPT_PREFIXES = [
    'You are an expert at extracting long-term facts from conversations.', // fact-extractor
    'You are an ontology classifier for technical decision facts.', // ontology batch classify
    'You are analyzing relationships between technical decision facts.', // ontology relation detect
    'Compare two facts and determine their relationship.', // consolidator
];
/**
 * True if a user message is one of the plugin's own LLM worker prompts —
 * such an exchange is ephemeral worker state, never knowledge, and must not
 * be indexed (searchable) regardless of which project slug it sits under.
 */
export function isWorkerPromptMessage(userMessage) {
    if (!userMessage)
        return false;
    return WORKER_PROMPT_PREFIXES.some((p) => userMessage.startsWith(p));
}
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export function getExcludedProjects() {
    // Check env variable first
    if (process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS) {
        return process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS.split(',').map(p => p.trim()).filter(p => p !== '');
    }
    // Check for config file
    const configPath = getExcludeConfigPath();
    if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        return content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    }
    // Default: no exclusions
    return [];
}
