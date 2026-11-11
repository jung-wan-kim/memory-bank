/**
 * How the neighbours of a fact (1-hop relations) are listed in tool output.
 *
 * Every tool used to print all neighbours with their full text. That was fine at 1–2 relations per fact;
 * measured on the live graph one fact carried 106 neighbours and 76,620 characters, and a single
 * search_facts answer had 80 "Related" lines. The neighbours are context, not the answer: a few, short,
 * and the ones that change the reading of the fact (CONTRADICTS / SUPERSEDES) never among the hidden.
 */
/** Neighbours listed per fact. */
export declare const RELATED_MAX_ITEMS = 5;
/** Characters of one neighbour's text. */
export declare const RELATED_MAX_CHARS = 160;
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
export declare function clipLine(text: string, maxChars: number): string;
/**
 * The neighbours kept for one fact: CONTRADICTS and SUPERSEDES first, then the caller's order
 * (getRelatedFacts returns most relevant first), cut to `maxItems`.
 */
export declare function pickRelated<T extends {
    relation: {
        relation_type: string;
    };
}>(related: ReadonlyArray<T>, maxItems?: number): {
    picked: T[];
    omitted: number;
};
/** The neighbours to print for one fact: pickRelated, each text clipped to `maxChars`. */
export declare function summarizeRelated(related: ReadonlyArray<{
    fact: {
        fact: string;
    };
    relation: {
        relation_type: string;
    };
}>, opts?: {
    maxItems?: number;
    maxChars?: number;
}): RelatedSummary;
