/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code).
 * Falls back to direct Anthropic SDK if ANTHROPIC_API_KEY is set (for standalone use).
 */
export declare function callHaiku(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
