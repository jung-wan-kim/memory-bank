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

export class SearchArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchArgError';
  }
}

export const SEARCH_HELP_TEXT = `
Usage: memory-bank search [OPTIONS] <query>

Search indexed conversations using semantic similarity or exact text matching.

MODES:
  (default)      Combined vector + text search
  --vector       Vector similarity only (semantic)
  --text         Exact string matching only (for git SHAs, error codes)

OPTIONS:
  --project NAME Scope results to a project (substring of indexed project path)
  --after DATE   Only conversations after YYYY-MM-DD
  --before DATE  Only conversations before YYYY-MM-DD
  --limit N      Max results (default: 10)
  --help, -h     Show this help

EXAMPLES:
  memory-bank search "React Router authentication errors"
  memory-bank search --text --project Quotation "a1b2c3d4e5f6"
  memory-bank search --after 2025-09-01 "refactoring"
  memory-bank search "React Router" "authentication" "JWT"
`;

export function parseSearchArgs(args: string[]): ParsedSearchArgs {
  let mode: SearchMode = 'both';
  let after: string | undefined;
  let before: string | undefined;
  let limit = 10;
  let project: string | undefined;
  let help = false;
  const queries: string[] = [];

  let index = 0;
  const takeValue = (flag: string): string => {
    const next = args[++index];
    if (next === undefined) {
      throw new SearchArgError(`Option ${flag} requires a value.`);
    }
    return next;
  };

  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--vector') {
      mode = 'vector';
    } else if (arg === '--text') {
      mode = 'text';
    } else if (arg === '--after') {
      after = takeValue(arg);
    } else if (arg === '--before') {
      before = takeValue(arg);
    } else if (arg === '--limit') {
      limit = parseInt(takeValue(arg), 10);
    } else if (arg === '--project') {
      project = takeValue(arg);
    } else {
      queries.push(arg);
    }
  }

  return { mode, after, before, limit, project, queries, help };
}
