import { query } from '@anthropic-ai/claude-agent-sdk';
/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code).
 * Falls back to direct Anthropic SDK if ANTHROPIC_API_KEY is set (for standalone use).
 */
export async function callHaiku(systemPrompt, userMessage, maxTokens = 2048) {
    const model = process.env.MEMORY_BANK_FACT_MODEL || 'haiku';
    // Try Claude Agent SDK first (works inside Claude Code without API key)
    try {
        for await (const message of query({
            prompt: `${systemPrompt}\n\n${userMessage}`,
            options: {
                model,
                max_tokens: maxTokens,
                systemPrompt,
            },
        })) {
            if (message && typeof message === 'object' && 'type' in message && message.type === 'result') {
                return message.result || '';
            }
        }
        return '';
    }
    catch (agentSdkError) {
        // Fallback to direct Anthropic SDK if agent SDK fails (standalone mode)
        const apiKey = process.env.ANTHROPIC_API_KEY || process.env.MEMORY_BANK_API_TOKEN;
        if (!apiKey) {
            throw new Error(`LLM call failed: ${agentSdkError instanceof Error ? agentSdkError.message : agentSdkError}`);
        }
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const baseURL = process.env.MEMORY_BANK_API_BASE_URL;
        const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
        const response = await client.messages.create({
            model: process.env.MEMORY_BANK_FACT_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });
        const textBlock = response.content.find((b) => b.type === 'text');
        return textBlock?.text || '';
    }
}
export function parseJsonResponse(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
        || text.match(/(\[[\s\S]*\])/)
        || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
        console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
        return null;
    }
    try {
        return JSON.parse(jsonMatch[1]);
    }
    catch (e) {
        console.error('parseJsonResponse: invalid JSON:', e.message, jsonMatch[1].substring(0, 200));
        return null;
    }
}
