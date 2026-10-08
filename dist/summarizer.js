import { query } from '@anthropic-ai/claude-agent-sdk';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { llmWorkdir, ISOLATED_QUERY_OPTIONS, DEFAULT_LLM_MODEL } from './llm.js';
import { noteSdkFailure } from './deps-heal.js';
/**
 * Get API environment overrides for summarization calls.
 * Returns full env merged with process.env so subprocess inherits PATH, HOME, etc.
 *
 * Env vars (all optional):
 * - MEMORY_BANK_API_MODEL: Model to use (default: DEFAULT_LLM_MODEL, claude-haiku-5-5)
 * - MEMORY_BANK_API_MODEL_FALLBACK: Fallback model on error (default: sonnet)
 * - MEMORY_BANK_API_BASE_URL: Custom API endpoint
 * - MEMORY_BANK_API_TOKEN: Auth token for custom endpoint
 * - MEMORY_BANK_API_TIMEOUT_MS: Timeout for API calls (default: SDK default)
 */
function getApiEnv() {
    const baseUrl = process.env.MEMORY_BANK_API_BASE_URL;
    const token = process.env.MEMORY_BANK_API_TOKEN;
    const timeoutMs = process.env.MEMORY_BANK_API_TIMEOUT_MS;
    if (!baseUrl && !token && !timeoutMs) {
        return undefined;
    }
    // Merge with process.env so subprocess inherits PATH, HOME, etc.
    return {
        ...process.env,
        ...(baseUrl && { ANTHROPIC_BASE_URL: baseUrl }),
        ...(token && { ANTHROPIC_AUTH_TOKEN: token }),
        ...(timeoutMs && { API_TIMEOUT_MS: timeoutMs }),
    };
}
export function formatConversationText(exchanges) {
    return exchanges.map(ex => {
        return `User: ${ex.userMessage}\n\nAgent: ${ex.assistantMessage}`;
    }).join('\n\n---\n\n');
}
function extractSummary(text) {
    const match = text.match(/<summary>(.*?)<\/summary>/s);
    if (match) {
        return match[1].trim();
    }
    // Fallback if no tags found
    return text.trim();
}
/** The model declined to summarize. The same conversation is declined again. */
class SummaryRefusedError extends Error {
    constructor(detail) {
        super(`Summary refused: ${detail}`);
        this.name = 'SummaryRefusedError';
    }
}
/**
 * Written as the summary of a conversation the model declines to summarize.
 * Writing nothing would have sync retry it on every run, and sync summarizes at
 * most `summaryLimit` files per run in directory order — conversations that are
 * always declined would hold those slots for good. Failures that may pass
 * (outage, API error, no result) still throw and write nothing, so they retry.
 */
export const REFUSED_SUMMARY = '[No summary: the model declined to summarize this conversation.]';
async function callClaude(prompt, sessionId, useFallback = false) {
    try {
        return await callClaudeOnce(prompt, sessionId, useFallback);
    }
    catch (error) {
        noteSdkFailure(error, 'memory-bank summarizer');
        throw error;
    }
}
async function callClaudeOnce(prompt, sessionId, useFallback = false) {
    const primaryModel = process.env.MEMORY_BANK_API_MODEL || DEFAULT_LLM_MODEL;
    const fallbackModel = process.env.MEMORY_BANK_API_MODEL_FALLBACK || 'sonnet';
    const model = useFallback ? fallbackModel : primaryModel;
    let refused = false;
    for await (const message of query({
        prompt,
        options: {
            model,
            max_tokens: 4096,
            env: getApiEnv(),
            resume: sessionId,
            // Same containment as llm.ts callHaiku: transcripts land in the reserved
            // memory-bank-llm slug (never indexed, TTL-pruned), and the spawned
            // session must not load user settings/plugins — its SessionStart/End
            // hooks would re-spawn sync/backfill workers and cascade into more
            // sessions. Resume works because every call shares this fixed cwd.
            cwd: llmWorkdir(),
            ...ISOLATED_QUERY_OPTIONS,
            // Don't override systemPrompt when resuming - it uses the original session's prompt
            // Instead, the prompt itself should provide clear instructions
            ...(sessionId ? {} : {
                systemPrompt: 'Write concise, factual summaries. Output ONLY the summary - no preamble, no "Here is", no "I will". Your output will be indexed directly.'
            })
        }
    })) {
        if (message.type === 'system' && message.subtype === 'model_refusal_no_fallback') {
            refused = true; // the SDK's structured refusal signal; stop_reason may not carry it
            continue;
        }
        if (message && typeof message === 'object' && 'type' in message && message.type === 'result') {
            const result = message.result;
            // Check if result is an API error (SDK returns errors as result strings)
            if (typeof result === 'string' && result.includes('API Error') && result.includes('thinking.budget_tokens')) {
                if (!useFallback) {
                    console.log(`    ${primaryModel} hit thinking budget error, retrying with ${fallbackModel}`);
                    return await callClaude(prompt, sessionId, true);
                }
                // The fallback hit it too: an error, not a summary to write out.
                throw new Error(`Summary call failed (${fallbackModel} thinking budget): ${result.slice(0, 300)}`);
            }
            // An error turn carries its error text in `result`; returned, it would be
            // written out as the summary. A refusal is final; anything else is
            // retried on a later run (callers write no summary file on a throw).
            if (refused || message.stop_reason === 'refusal') {
                throw new SummaryRefusedError(typeof result === 'string' ? result.slice(0, 300) : '');
            }
            if (message.is_error) {
                throw new Error(`Summary call failed (${message.stop_reason ?? message.subtype}): ${typeof result === 'string' ? result.slice(0, 300) : ''}`);
            }
            return result;
        }
    }
    // No result message: a failed call. Returned as '', it became an empty
    // summary file that was never redone.
    throw new Error('Summary call ended without a result');
}
function chunkExchanges(exchanges, chunkSize) {
    const chunks = [];
    for (let i = 0; i < exchanges.length; i += chunkSize) {
        chunks.push(exchanges.slice(i, i + chunkSize));
    }
    return chunks;
}
export async function summarizeConversation(exchanges, sessionId) {
    // Handle trivial conversations
    if (exchanges.length === 0) {
        return 'Trivial conversation with no substantive content.';
    }
    if (exchanges.length === 1) {
        const text = formatConversationText(exchanges);
        if (text.length < 100 || exchanges[0].userMessage.trim() === '/exit') {
            return 'Trivial conversation with no substantive content.';
        }
    }
    // For short conversations (≤15 exchanges), summarize directly
    if (exchanges.length <= 15) {
        const conversationText = sessionId
            ? '' // When resuming, no need to include conversation text - it's already in context
            : formatConversationText(exchanges);
        const prompt = `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise, factual summary of this conversation. Output ONLY the summary - no preamble. Claude will see this summary when searching previous conversations for useful memories and information.

Summarize what happened in 2-4 sentences. Be factual and specific. Output in <summary></summary> tags.

Include:
- What was built/changed/discussed (be specific)
- Key technical decisions or approaches
- Problems solved or current state

Exclude:
- Apologies, meta-commentary, or your questions
- Raw logs or debug output
- Generic descriptions - focus on what makes THIS conversation unique

Good:
<summary>Built JWT authentication for React app with refresh tokens and protected routes. Fixed token expiration bug by implementing refresh-during-request logic.</summary>

Bad:
<summary>I apologize. The conversation discussed authentication and various approaches were considered...</summary>

${conversationText}`;
        let result;
        try {
            result = await callClaude(prompt, sessionId);
        }
        catch (error) {
            if (error instanceof SummaryRefusedError)
                return REFUSED_SUMMARY;
            throw error;
        }
        return extractSummary(result);
    }
    // For long conversations, use hierarchical summarization
    console.log(`  Long conversation (${exchanges.length} exchanges) - using hierarchical summarization`);
    // Note: Hierarchical summarization doesn't support resume mode (needs fresh session for each chunk)
    // This is fine since we only use resume for the main session-end hook
    // Chunk into groups of 8 exchanges
    const chunks = chunkExchanges(exchanges, 8);
    console.log(`  Split into ${chunks.length} chunks`);
    // Summarize each chunk
    const chunkSummaries = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunkText = formatConversationText(chunks[i]);
        const prompt = `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise summary of this part of a conversation in 2-3 sentences. What happened, what was built/discussed. Use <summary></summary> tags.

${chunkText}

Example: <summary>Implemented HID keyboard functionality for ESP32. Hit Bluetooth controller initialization error, fixed by adjusting memory allocation.</summary>`;
        try {
            const summary = await callClaude(prompt); // No sessionId for chunks
            const extracted = extractSummary(summary);
            chunkSummaries.push(extracted);
            console.log(`  Chunk ${i + 1}/${chunks.length}: ${extracted.split(/\s+/).length} words`);
        }
        catch (error) {
            // A failed call (outage, API error) would fail the remaining chunks too,
            // and a summary of the chunks that got through would be written for good.
            // Abort instead: no file is written, and the next sync retries it.
            if (!(error instanceof SummaryRefusedError))
                throw error;
            console.log(`  Chunk ${i + 1} refused, skipping`);
        }
    }
    // Every chunk was refused (any other failure has thrown above).
    if (chunkSummaries.length === 0)
        return REFUSED_SUMMARY;
    // Synthesize chunks into final summary
    const synthesisPrompt = `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise, factual summary that synthesizes these part-summaries into one cohesive paragraph. Focus on what was accomplished and any notable technical decisions or challenges. Output in <summary></summary> tags. Claude will see this summary when searching previous conversations for useful memories and information.

Part summaries:
${chunkSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Good:
<summary>Built conversation search system with JavaScript, sqlite-vec, and local embeddings. Implemented hierarchical summarization for long conversations. System archives conversations permanently and provides semantic search via CLI.</summary>

Bad:
<summary>This conversation synthesizes several topics discussed across multiple parts...</summary>

Your summary (max 200 words):`;
    console.log(`  Synthesizing final summary...`);
    try {
        const result = await callClaude(synthesisPrompt); // No sessionId for synthesis
        return extractSummary(result);
    }
    catch (error) {
        console.log(`  Synthesis failed, using chunk summaries`);
        return chunkSummaries.join(' ');
    }
}
