export interface RepeatMatch {
    exchangeId: string;
    project: string;
    timestamp: string;
    userMessage: string;
    assistantSummary: string;
    similarity: number;
    archivePath: string;
    lineStart: number;
    lineEnd: number;
}
/**
 * Detect if the current prompt is similar to a past exchange.
 * Returns matches above the threshold, sorted by similarity.
 *
 * This enables "You asked something similar before — here's what happened"
 * context injection, reducing repeated prompts.
 */
export declare function detectRepeat(prompt: string, project: string | null, limit?: number, threshold?: number): Promise<RepeatMatch[]>;
/**
 * Format repeat detection results for context injection.
 */
export declare function formatRepeatContext(matches: RepeatMatch[]): string;
