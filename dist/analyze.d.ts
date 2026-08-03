/**
 * Full-history analysis over the conversation index.
 *
 * Deterministic (no LLM) aggregation used by `memory-bank analyze` and the
 * `analyzing-all-conversations` skill: coverage, per-project rollups,
 * fact breakdowns, ontology domains, monthly timeline, and gap
 * recommendations (which backfills to run).
 */
export interface ProjectRollup {
    project: string;
    conversations: number;
    sessions: number;
    exchanges: number;
    facts: number;
    firstActivity: string | null;
    lastActivity: string | null;
}
export interface MonthlyActivity {
    month: string;
    exchanges: number;
    sessions: number;
}
export interface AnalysisReport {
    generatedAt: string;
    coverage: {
        totalConversations: number;
        /** Conversations from main sessions (UUID-named files) */
        mainConversations: number;
        /** Subagent transcripts (agent-*.jsonl) — no summaries by design */
        agentTranscripts: number;
        totalSessions: number;
        totalExchanges: number;
        projectCount: number;
        dateRange: {
            earliest: string;
            latest: string;
        } | null;
        /** retrying: 내부 실패 후 재시도 예산이 남아 아직 pending 인 세션 수 */
        extraction: {
            processed: number;
            seeded: number;
            errors: number;
            retrying: number;
            pending: number;
        };
        /** Summary coverage over main conversations only */
        summaries: {
            withSummary: number;
            withoutSummary: number;
        };
    };
    facts: {
        active: number;
        inactive: number;
        byCategory: Array<{
            category: string;
            count: number;
        }>;
        byScope: Array<{
            scope: string;
            count: number;
        }>;
    };
    domains: Array<{
        domain: string;
        facts: number;
    }>;
    projects: ProjectRollup[];
    timeline: MonthlyActivity[];
    recommendations: string[];
}
export interface AnalyzeOptions {
    dbPath?: string;
    topProjects?: number;
    timelineMonths?: number;
}
/**
 * Convert a filesystem path to the Claude Code project slug used in the
 * `exchanges.project` column (e.g. /Users/me/app → -Users-me-app).
 * Uses the canonical slug rule from project-canon ('/', '.', '_' → '-').
 * Values that already look like slugs are returned unchanged.
 */
export declare function projectSlug(project: string): string;
/**
 * Whether an archive path is a main-session conversation (UUID-named file)
 * as opposed to a subagent transcript (agent-*.jsonl). Summaries are only
 * ever generated for main sessions.
 */
export declare function isMainConversation(archivePath: string): boolean;
export declare function analyzeHistory(options?: AnalyzeOptions): Promise<AnalysisReport>;
export declare function formatAnalysisMarkdown(report: AnalysisReport): string;
