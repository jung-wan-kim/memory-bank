/**
 * Arguments of `memory-bank search`, parsed strictly.
 *
 * The old loop pushed everything it did not recognize onto the query list: `--both "sqlite vec"` (the help's
 * own example) searched for the two "concepts" `--both` and `sqlite vec`, a typo like `--txt` did the same,
 * and `--limit abc` reached SQLite as NaN. An option this parser does not know, or a value it cannot use,
 * is an error before anything is searched. A query that starts with a dash goes after `--`.
 */

export const SEARCH_USAGE = `
Usage: memory-bank search [OPTIONS] <query> [query2 ...]

Search indexed conversations by meaning, by keyword, or both.

MODES (one query):
  --both         Semantic + keyword, merged (default)
  --vector       Semantic similarity only
  --text         Keyword only: every word of the query must occur
                 (word by word, not an exact phrase — use it for identifiers, error codes, SHAs)

OPTIONS:
  --after DATE     Only conversations on or after YYYY-MM-DD
  --before DATE    Only conversations before YYYY-MM-DD
  --limit N        Max results, 1-50 (default: 10)
  --include-noise  Also return machine-generated turns (sub-agent warm-ups, other plugins' observer prompts)
  --               Everything after this is a query, even if it starts with a dash
  --help, -h       Show this help

EXAMPLES:
  # Semantic + keyword search
  memory-bank search "React Router authentication errors"

  # Find an identifier
  memory-bank search --text "a1b2c3d4e5f6"

  # Time filtering
  memory-bank search --after 2025-09-01 "refactoring"

  # Explicit combined mode
  memory-bank search --both "React Router data loading"

  # Multi-concept search (AND - every concept must have a semantic hit in the conversation)
  memory-bank search "React Router" "authentication" "JWT"
`;

export type SearchCliArgs =
  | { kind: 'help' }
  | {
      kind: 'search';
      mode: 'vector' | 'text' | 'both';
      limit: number;
      after: string | undefined;
      before: string | undefined;
      includeNoise: boolean;
      queries: string[];
    };

const MODE_FLAGS: Record<string, 'vector' | 'text' | 'both'> = { '--vector': 'vector', '--text': 'text', '--both': 'both' };
const VALUE_OPTIONS = new Set(['--after', '--before', '--limit']);

export function parseSearchArgs(argv: string[]): SearchCliArgs {
  let modeFlag: string | undefined;
  let includeNoise = false;
  const values: Record<string, string> = {};
  const queries: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      queries.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (!arg.startsWith('-') || arg === '-') {
      queries.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq > -1 ? arg.slice(0, eq) : arg;
    if (VALUE_OPTIONS.has(name)) {
      const value = eq > -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new Error(`${name} needs a value`);
      }
      if (name in values) throw new Error(`${name} given more than once`);
      values[name] = value;
    } else if (name in MODE_FLAGS && eq === -1) {
      if (modeFlag && modeFlag !== name) throw new Error(`use one of --vector, --text, --both (got ${modeFlag} and ${name})`);
      modeFlag = name;
    } else if (arg === '--include-noise') {
      includeNoise = true;
    } else {
      throw new Error(`unknown option: ${arg} (a query that starts with a dash goes after --)`);
    }
  }

  let limit = 10;
  if ('--limit' in values) {
    const raw = values['--limit'];
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
      throw new Error(`--limit must be an integer from 1 to 50 (got ${JSON.stringify(raw)})`);
    }
    limit = Number(raw);
  }
  for (const name of ['--after', '--before']) {
    if (name in values && !/^\d{4}-\d{2}-\d{2}$/.test(values[name])) {
      throw new Error(`${name} must be a date in YYYY-MM-DD form (got ${JSON.stringify(values[name])})`);
    }
  }

  if (queries.length === 0) throw new Error('no search query given');
  if (queries.length > 1 && modeFlag) {
    throw new Error(`${modeFlag} applies to one query; a multi-concept search (several queries) is always semantic`);
  }

  return {
    kind: 'search',
    mode: modeFlag ? MODE_FLAGS[modeFlag] : 'both',
    limit,
    after: values['--after'],
    before: values['--before'],
    includeNoise,
    queries,
  };
}
