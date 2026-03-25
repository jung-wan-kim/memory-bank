export interface LastSessionContext {
    sessionId: string;
    project: string;
    timestamp: string;
    exchangeCount: number;
    lastUserMessage: string;
    lastAssistantSummary: string;
    toolsUsed: string[];
    gitBranch: string | null;
}
/**
 * Get the last session's context for a project.
 * This enables "continuing where you left off" — the most direct
 * way to reduce repeated context setting at session start.
 */
export declare function getLastSessionContext(project: string): LastSessionContext | null;
/**
 * Format last session context for injection at session start.
 */
export declare function formatSessionContinuity(ctx: LastSessionContext): string;
