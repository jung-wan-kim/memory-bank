export interface IntentPrediction {
    likelyTools: Array<{
        tool: string;
        frequency: number;
    }>;
    commonPatterns: string[];
    projectProfile: string;
}
/**
 * Predict user intent based on historical tool usage patterns for a project.
 *
 * Analyzes: "In this project, the user usually does X, Y, Z"
 * This helps Claude proactively prepare relevant context.
 */
export declare function predictIntent(project: string): IntentPrediction;
/**
 * Format intent prediction for context injection.
 */
export declare function formatIntentContext(prediction: IntentPrediction): string;
