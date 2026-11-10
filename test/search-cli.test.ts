import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseSearchArgs, SEARCH_USAGE } from '../src/search-cli-args.js';

// ROB-14 — the help text showed `--both`, the parser did not know it, and anything it did not know became a
// search term: `--both "sqlite vec"` ran a two-concept search for "--both" and "sqlite vec" (rc 0), a typo
// like `--txt` did the same, and `--limit abc` ended in a SQLite "datatype mismatch" stack trace.

const REPO = path.resolve(__dirname, '..');

describe('parseSearchArgs', () => {
  it('defaults: both modes, limit 10, noise left out', () => {
    expect(parseSearchArgs(['sqlite vec'])).toEqual({
      kind: 'search', mode: 'both', limit: 10, after: undefined, before: undefined, includeNoise: false, queries: ['sqlite vec'],
    });
  });

  it('accepts every mode the help lists', () => {
    expect(parseSearchArgs(['--both', 'q'])).toMatchObject({ mode: 'both', queries: ['q'] });
    expect(parseSearchArgs(['--vector', 'q'])).toMatchObject({ mode: 'vector' });
    expect(parseSearchArgs(['--text', 'q'])).toMatchObject({ mode: 'text' });
    for (const flag of ['--both', '--vector', '--text', '--after', '--before', '--limit', '--include-noise']) {
      expect(SEARCH_USAGE).toContain(flag);
    }
  });

  it('reads the options with values, in either form', () => {
    expect(parseSearchArgs(['--after', '2026-01-01', '--before=2026-02-01', '--limit', '25', '--include-noise', 'q1', 'q2'])).toEqual({
      kind: 'search', mode: 'both', limit: 25, after: '2026-01-01', before: '2026-02-01', includeNoise: true, queries: ['q1', 'q2'],
    });
  });

  it('an unknown option is an error, not a search term', () => {
    expect(() => parseSearchArgs(['--txt', 'sqlite'])).toThrow(/unknown option: --txt/);
    expect(() => parseSearchArgs(['-x', 'sqlite'])).toThrow(/unknown option: -x/);
  });

  it('everything after `--` is a search term, whatever it looks like', () => {
    expect(parseSearchArgs(['--text', '--', '--both'])).toMatchObject({ mode: 'text', queries: ['--both'] });
    expect(parseSearchArgs(['--', '--txt', '-x'])).toMatchObject({ mode: 'both', queries: ['--txt', '-x'] });
  });

  it('--limit must be an integer from 1 to 50', () => {
    for (const bad of [['--limit', 'abc', 'q'], ['--limit', '-1', 'q'], ['--limit', '0', 'q'], ['--limit', '51', 'q'], ['--limit', '2.5', 'q'], ['q', '--limit']]) {
      expect(() => parseSearchArgs(bad), bad.join(' ')).toThrow(/--limit/);
    }
    expect(parseSearchArgs(['--limit', '50', 'q'])).toMatchObject({ limit: 50 });
  });

  it('dates must be YYYY-MM-DD and options are not repeated or mixed', () => {
    expect(() => parseSearchArgs(['--after', 'yesterday', 'q'])).toThrow(/--after.*YYYY-MM-DD/);
    expect(() => parseSearchArgs(['--after', '--text', 'q'])).toThrow(/--after/);
    expect(() => parseSearchArgs(['--text', '--vector', 'q'])).toThrow(/one of --vector, --text, --both/);
    expect(() => parseSearchArgs(['--limit', '5', '--limit', '6', 'q'])).toThrow(/--limit given more than once/);
  });

  it('no search term is an error; --help wins', () => {
    expect(() => parseSearchArgs([])).toThrow(/no search query/);
    expect(() => parseSearchArgs(['--text'])).toThrow(/no search query/);
    expect(parseSearchArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseSearchArgs(['q', '-h'])).toEqual({ kind: 'help' });
  });

  it('a multi-concept search does not take a mode', () => {
    expect(() => parseSearchArgs(['--text', 'a', 'b'])).toThrow(/multi-concept search \(several queries\) does not take a mode/);
    expect(parseSearchArgs(['a', 'b'])).toMatchObject({ queries: ['a', 'b'] });
  });
});

describe('search CLI process', () => {
  let configDir: string;

  beforeAll(() => { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-search-cli-')); });
  afterAll(() => { fs.rmSync(configDir, { recursive: true, force: true }); });

  const run = (args: string[]) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.MEMORY_BANK_DB_PATH;
    delete env.TEST_DB_PATH;
    Object.assign(env, { MEMORY_BANK_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: path.join(configDir, 'claude'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
    return spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'src', 'search-cli.ts'), ...args], {
      cwd: REPO, env, encoding: 'utf8', timeout: 60_000,
    });
  };

  it('an unknown option exits 1 with the reason and the usage hint, before any search', () => {
    const r = run(['--txt', 'sqlite']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown option: --txt/);
    expect(r.stderr).toMatch(/memory-bank search --help/);
    expect(r.stdout).toBe('');
  }, 70_000);

  it('a bad --limit exits 1 with the reason, not a SQLite stack trace', () => {
    const r = run(['--text', '--limit', 'abc', 'sqlite']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--limit must be an integer from 1 to 50/);
    expect(r.stderr).not.toMatch(/SqliteError|datatype mismatch|\n\s+at /);
  }, 70_000);

  it('a keyword search on an empty index answers and exits 0', () => {
    const r = run(['--text', 'zebrafish']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No results found\./);
  }, 70_000);

  it('--help prints the usage and exits 0', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--both');
    expect(r.stdout).toContain('--include-noise');
  }, 70_000);
});
