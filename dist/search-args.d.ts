export type SearchMode = 'vector' | 'text' | 'both';
export interface ParsedSearchArgs {
    mode: SearchMode;
    after?: string;
    before?: string;
    limit: number;
    project?: string;
    queries: string[];
    help: boolean;
}
export declare class SearchArgError extends Error {
    constructor(message: string);
}
export declare const SEARCH_HELP_TEXT = "\nUsage: memory-bank search [OPTIONS] <query>\n\nSearch indexed conversations using semantic similarity or exact text matching.\n\nMODES:\n  (default)      Combined vector + text search\n  --vector       Vector similarity only (semantic)\n  --text         Exact string matching only (for git SHAs, error codes)\n\nOPTIONS:\n  --project NAME Scope results to a project (substring of indexed project path)\n  --after DATE   Only conversations after YYYY-MM-DD\n  --before DATE  Only conversations before YYYY-MM-DD\n  --limit N      Max results (default: 10)\n  --help, -h     Show this help\n\nEXAMPLES:\n  memory-bank search \"React Router authentication errors\"\n  memory-bank search --text --project Quotation \"a1b2c3d4e5f6\"\n  memory-bank search --after 2025-09-01 \"refactoring\"\n  memory-bank search \"React Router\" \"authentication\" \"JWT\"\n";
export declare function parseSearchArgs(args: string[]): ParsedSearchArgs;
