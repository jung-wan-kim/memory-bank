import { pipeline } from '@xenova/transformers';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from './embedding-version.js';
export { EMBEDDING_MODEL, EMBEDDING_VERSION };
let embeddingPipeline = null;
let embeddingLoad = null;
/**
 * Load the model once. Concurrent callers share the one load in flight — the
 * daemon pre-warms on bind, and a prompt arriving meanwhile used to start a
 * second load of the same model (2026-10-03: daemon embed 7.0s vs 5.3s cold).
 * A failed load is forgotten so the next call retries.
 */
export async function initEmbeddings() {
    if (embeddingPipeline)
        return;
    if (!embeddingLoad) {
        // stderr: stdout of hook scripts is injected into the session as context,
        // so progress logs must never go to stdout.
        console.error(`Loading embedding model ${EMBEDDING_MODEL} (first run may take time)...`);
        embeddingLoad = pipeline('feature-extraction', EMBEDDING_MODEL).then((loaded) => {
            embeddingPipeline = loaded;
            console.error('Embedding model loaded');
            return loaded;
        }, (error) => {
            embeddingLoad = null;
            throw error;
        });
    }
    await embeddingLoad;
}
/** Whether the model is loaded (the daemon tells a waiting client it is still warming). */
export function embeddingsReady() {
    return embeddingPipeline !== null;
}
function applyModePrefix(text, mode) {
    // e5-family models require asymmetric prefixes; other models take raw text.
    if (EMBEDDING_MODEL.toLowerCase().includes('e5')) {
        return `${mode}: ${text}`;
    }
    return text;
}
// Small LRU memo for query embeddings. One MCP search embeds the SAME query
// text twice (searchConversations + getKnowledgeContext), each costing a full
// model inference (~35ms measured) — the memo collapses that to one. Also
// covers a user re-running the same query. 'query' mode only: passage-mode
// callers embed unique content (indexing), where a memo is pure overhead.
const QUERY_EMBED_MEMO_MAX = 32;
const queryEmbedMemo = new Map();
/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export async function generateEmbedding(text, mode = 'passage') {
    if (mode === 'query') {
        const hit = queryEmbedMemo.get(text);
        if (hit) {
            // refresh LRU position
            queryEmbedMemo.delete(text);
            queryEmbedMemo.set(text, hit);
            return hit.slice();
        }
    }
    if (!embeddingPipeline) {
        await initEmbeddings();
    }
    // Truncate text to avoid token limits (512 tokens max for this model)
    const truncated = applyModePrefix(text.substring(0, 2000), mode);
    const output = await embeddingPipeline(truncated, {
        pooling: 'mean',
        normalize: true
    });
    const embedding = Array.from(output.data);
    if (mode === 'query') {
        queryEmbedMemo.set(text, embedding.slice());
        if (queryEmbedMemo.size > QUERY_EMBED_MEMO_MAX) {
            queryEmbedMemo.delete(queryEmbedMemo.keys().next().value);
        }
    }
    return embedding;
}
export async function generateExchangeEmbedding(userMessage, assistantMessage, toolNames) {
    // Combine user question, assistant answer, and tools used for better searchability
    let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
    // Include tool names in embedding for tool-based searches
    if (toolNames && toolNames.length > 0) {
        combined += `\n\nTools: ${toolNames.join(', ')}`;
    }
    return generateEmbedding(combined, 'passage');
}
/**
 * Query-side anisotropy normalization (probe baseline).
 *
 * e5 similarity scores sit in a compressed band (~0.72-0.9 even for unrelated
 * pairs), so a fixed absolute threshold cannot separate relevant from
 * irrelevant. Instead, compare each query↔fact score against the query's own
 * baseline: its best similarity to a fixed set of neutral "background probe"
 * sentences. A fact is relevant only if it beats that baseline by a margin
 * (measured: related pairs +0.047~+0.123, unrelated pairs -0.028~-0.091).
 */
export const BACKGROUND_PROBES = [
    '오늘 날씨가 참 좋네요',
    '주말에 뭐 할지 고민 중이야',
    '맛있는 저녁 식사를 했다',
    'The weather is nice today',
    'I went for a walk in the park',
    '음악을 들으면서 휴식을 취했다',
    '새로운 취미를 시작해볼까 생각 중',
    'Let me think about what to do next',
];
let probeEmbeddings = null;
let probeLoad = null;
/**
 * The probe embeddings, computed once and published only when complete.
 * Filling a shared array in place let a concurrent caller see it empty (or
 * half-filled) and get baseline -1, which passes every fact through the
 * relevance gate; a failed fill stayed partial for the process lifetime.
 * Concurrent callers now share the one computation; a failure is forgotten.
 */
function backgroundProbes() {
    if (probeEmbeddings)
        return Promise.resolve(probeEmbeddings);
    if (!probeLoad) {
        probeLoad = (async () => {
            const out = [];
            for (const p of BACKGROUND_PROBES)
                out.push(await generateEmbedding(p, 'passage'));
            return out;
        })().then((done) => {
            probeEmbeddings = done;
            return done;
        }, (error) => {
            probeLoad = null;
            throw error;
        });
    }
    return probeLoad;
}
/** Max cosine similarity between the query embedding and the background probes. */
export async function queryBaseline(queryEmbedding) {
    const probes = await backgroundProbes();
    let max = -1;
    for (const probe of probes) {
        let dot = 0;
        for (let i = 0; i < probe.length; i++)
            dot += probe[i] * queryEmbedding[i];
        if (dot > max)
            max = dot;
    }
    return max;
}
