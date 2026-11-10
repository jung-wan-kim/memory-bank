/**
 * How the neighbours of a fact (1-hop relations) are listed in tool output.
 *
 * Every tool used to print all neighbours with their full text. That was fine at 1–2 relations per fact;
 * measured on the live graph one fact carried 106 neighbours and 76,620 characters, and a single
 * search_facts answer had 80 "Related" lines. The neighbours are context, not the answer: a few, short,
 * and the ones that change the reading of the fact (CONTRADICTS / SUPERSEDES) never among the hidden.
 */

/** Neighbours listed per fact. */
export const RELATED_MAX_ITEMS = 5;
/** Characters of one neighbour's text. */
export const RELATED_MAX_CHARS = 160;

export interface RelatedLine {
  relationType: string;
  /** Neighbour text, whitespace collapsed, at most `maxChars` characters (ends with … when clipped). */
  text: string;
}

export interface RelatedSummary {
  shown: RelatedLine[];
  /** Neighbours left out by `maxItems`. */
  omitted: number;
}

/** `text` on one line, at most `maxChars` characters (never ends on half a surrogate pair). */
export function clipLine(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  let cut = t.slice(0, maxChars - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

const BELIEF_FIRST: Record<string, number> = { CONTRADICTS: 0, SUPERSEDES: 1 };

/**
 * The neighbours kept for one fact: CONTRADICTS and SUPERSEDES first, then the caller's order
 * (getRelatedFacts returns most relevant first), cut to `maxItems`.
 */
export function pickRelated<T extends { relation: { relation_type: string } }>(
  related: ReadonlyArray<T>,
  maxItems: number = RELATED_MAX_ITEMS,
): { picked: T[]; omitted: number } {
  const ordered = related
    .map((r, index) => ({ r, index, rank: BELIEF_FIRST[r.relation.relation_type] ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ r }) => r);
  return { picked: ordered.slice(0, maxItems), omitted: Math.max(0, ordered.length - maxItems) };
}

/** The neighbours to print for one fact: pickRelated, each text clipped to `maxChars`. */
export function summarizeRelated(
  related: ReadonlyArray<{ fact: { fact: string }; relation: { relation_type: string } }>,
  opts: { maxItems?: number; maxChars?: number } = {},
): RelatedSummary {
  const maxChars = opts.maxChars ?? RELATED_MAX_CHARS;
  const { picked, omitted } = pickRelated(related, opts.maxItems ?? RELATED_MAX_ITEMS);
  return {
    shown: picked.map((r) => ({ relationType: r.relation.relation_type, text: clipLine(r.fact.fact, maxChars) })),
    omitted,
  };
}
