import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.MEMORY_BANK_API_TOKEN;
    const baseURL = process.env.MEMORY_BANK_API_BASE_URL;
    client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }
  return client;
}

export async function callHaiku(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
): Promise<string> {
  const model = process.env.MEMORY_BANK_FACT_MODEL || 'claude-haiku-4-5-20251001';
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text || '';
}

export function parseJsonResponse<T>(text: string): T | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    || text.match(/(\[[\s\S]*\])/)
    || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
    return null;
  }

  try {
    return JSON.parse(jsonMatch[1]) as T;
  } catch (e) {
    console.error('parseJsonResponse: invalid JSON:', (e as Error).message, jsonMatch[1].substring(0, 200));
    return null;
  }
}
