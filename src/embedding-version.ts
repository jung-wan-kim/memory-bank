/**
 * Embedding model identity, split out of embeddings.ts (2026-10-03) so that
 * modules needing only the version stamp — db.ts and fact-db.ts, and through
 * them the synchronous SessionStart hook — do not load @xenova/transformers
 * and its native onnxruntime/sharp bindings just to read a constant. The hook
 * blocks Claude's first response, so that import cost is paid at every
 * session start. embeddings.ts re-exports both names.
 */

/**
 * Multilingual retrieval model (Korean/English/100 langs), 384-dim — same
 * dimension as the original all-MiniLM-L6-v2 so vec tables are unchanged.
 *
 * Model selection (2026-06-12, measured on real-DB Korean/English pairs):
 *   - all-MiniLM-L6-v2: English-only — Korean queries score ~0 vs English facts
 *   - paraphrase-multilingual-MiniLM-L12-v2: top-1 ranking broke on real data
 *     (unrelated Korean pairs up to 0.82 — strong anisotropy)
 *   - multilingual-e5-small: perfect top-1 ranking on the hard set; absolute
 *     scores are compressed (~0.72-0.99) so consumers use either retuned
 *     thresholds (passage↔passage) or probe-baseline normalization (queries).
 *
 * e5 protocol: queries are embedded with a "query: " prefix, stored content
 * with "passage: ". Pass the mode explicitly at call sites.
 *
 * Vectors from different models are NOT comparable; EMBEDDING_VERSION tracks
 * which model produced a stored vector and the re-embed worker upgrades rows.
 */
const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

export const EMBEDDING_MODEL =
  process.env.MEMORY_BANK_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

/**
 * Curated model → version map:
 *   1 = all-MiniLM-L6-v2 (English-only)
 *   2 = paraphrase-multilingual-MiniLM-L12-v2 (rejected — anisotropy)
 *   3 = multilingual-e5-small (query/passage prefixes)
 *
 * The version is DERIVED from the model so a MEMORY_BANK_EMBEDDING_MODEL
 * override can never poison stored vectors: an unknown model gets its own
 * deterministic version (1000+), so switching back later re-embeds those
 * rows instead of silently mixing incompatible vector spaces.
 */
const KNOWN_MODEL_VERSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 1,
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 2,
  [DEFAULT_EMBEDDING_MODEL]: 3,
};

function modelVersion(model: string): number {
  const known = KNOWN_MODEL_VERSIONS[model];
  if (known !== undefined) return known;
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return 1000 + (h % 1000000);
}

export const EMBEDDING_VERSION = modelVersion(EMBEDDING_MODEL);
