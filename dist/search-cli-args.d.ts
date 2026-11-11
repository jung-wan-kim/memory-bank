/**
 * Arguments of `memory-bank search`, parsed strictly.
 *
 * The old loop pushed everything it did not recognize onto the query list: `--both "sqlite vec"` (the help's
 * own example) searched for the two "concepts" `--both` and `sqlite vec`, a typo like `--txt` did the same,
 * and `--limit abc` reached SQLite as NaN. An option this parser does not know, or a value it cannot use,
 * is an error before anything is searched. A query that starts with a dash goes after `--`.
 */
export declare const SEARCH_USAGE = "\nUsage: memory-bank search [OPTIONS] <query> [query2 ...]\n\nSearch indexed conversations by meaning, by keyword, or both.\n\nMODES (one query):\n  --both         Semantic + keyword, merged (default)\n  --vector       Semantic similarity only\n  --text         Keyword only: every word of the query must occur\n                 (word by word, not an exact phrase \u2014 use it for identifiers, error codes, SHAs)\n\nOPTIONS:\n  --after DATE     Only conversations on or after YYYY-MM-DD\n  --before DATE    Only conversations before YYYY-MM-DD\n  --limit N        Max results, 1-50 (default: 10)\n  --include-noise  Also return machine-generated turns (sub-agent warm-ups, other plugins' observer prompts)\n  --               Everything after this is a query, even if it starts with a dash\n  --help, -h       Show this help\n\nEXAMPLES:\n  # Semantic + keyword search\n  memory-bank search \"React Router authentication errors\"\n\n  # Find an identifier\n  memory-bank search --text \"a1b2c3d4e5f6\"\n\n  # Time filtering\n  memory-bank search --after 2025-09-01 \"refactoring\"\n\n  # Explicit combined mode\n  memory-bank search --both \"React Router data loading\"\n\n  # Multi-concept search (AND - exchanges containing every word first, then conversations\n  # semantically near every concept)\n  memory-bank search \"React Router\" \"authentication\" \"JWT\"\n";
export type SearchCliArgs = {
    kind: 'help';
} | {
    kind: 'search';
    mode: 'vector' | 'text' | 'both';
    limit: number;
    after: string | undefined;
    before: string | undefined;
    includeNoise: boolean;
    queries: string[];
};
export declare function parseSearchArgs(argv: string[]): SearchCliArgs;
