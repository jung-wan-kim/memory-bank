import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

import { EMBEDDING_MODEL, EMBEDDING_VERSION } from './embedding-version.js';

export { EMBEDDING_MODEL, EMBEDDING_VERSION };

export type EmbeddingMode = 'query' | 'passage';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    // stderr: stdout of hook scripts is injected into the session as context,
    // so progress logs must never go to stdout.
    console.error(`Loading embedding model ${EMBEDDING_MODEL} (first run may take time)...`);
    embeddingPipeline = await pipeline(
      'feature-extraction',
      EMBEDDING_MODEL
    );
    console.error('Embedding model loaded');
  }
}

function applyModePrefix(text: string, mode: EmbeddingMode): string {
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
const queryEmbedMemo = new Map<string, number[]>();

/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export async function generateEmbedding(text: string, mode: EmbeddingMode = 'passage'): Promise<number[]> {
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

  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true
  });

  const embedding = Array.from(output.data) as number[];
  if (mode === 'query') {
    queryEmbedMemo.set(text, embedding.slice());
    if (queryEmbedMemo.size > QUERY_EMBED_MEMO_MAX) {
      queryEmbedMemo.delete(queryEmbedMemo.keys().next().value as string);
    }
  }
  return embedding;
}

export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): Promise<number[]> {
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

let probeEmbeddings: number[][] | null = null;

/** Max cosine similarity between the query embedding and the background probes. */
export async function queryBaseline(queryEmbedding: number[]): Promise<number> {
  if (!probeEmbeddings) {
    probeEmbeddings = [];
    for (const p of BACKGROUND_PROBES) {
      probeEmbeddings.push(await generateEmbedding(p, 'passage'));
    }
  }
  let max = -1;
  for (const probe of probeEmbeddings) {
    let dot = 0;
    for (let i = 0; i < probe.length; i++) dot += probe[i] * queryEmbedding[i];
    if (dot > max) max = dot;
  }
  return max;
}
