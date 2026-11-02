import { createHash } from 'node:crypto';

/**
 * How a fact appears in an injected context block, shared by the per-prompt
 * injection (inject-core.ts) and the SessionStart key-facts block
 * (scripts/fact-consolidate-hook.js). Kept free of heavy imports: the
 * SessionStart hook runs synchronously before Claude's first response.
 */

/** Per-fact cap — facts average 140 chars, p90 207 (measured). The full text is one search_facts away. */
export const FACT_CHAR_CAP = 160;

export function truncateFact(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= FACT_CHAR_CAP) return t;
  let cut = t.slice(0, FACT_CHAR_CAP - 1);
  // Never end on a high surrogate: a split astral character would travel to the hook client as a lone
  // surrogate escape, which JSON.parse accepts but a strict parser (the native client's) refuses.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

/**
 * Text identity of a fact for in-session dedup. The same sentence is stored
 * under several ids (memory-doc double imports, re-extraction), and id-only
 * dedup let those copies through — 8.9% of injected lines were exact text
 * repeats inside one block (measured 2026-10-03).
 */
export function factTextKey(fact: { fact: string }): string {
  const norm = fact.fact.replace(/\s+/g, ' ').trim().toLowerCase();
  return 't:' + createHash('sha1').update(norm).digest('hex').slice(0, 16);
}
