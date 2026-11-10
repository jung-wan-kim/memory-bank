import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity } from './db.js';
import { OBSERVER_PROMPT_PREFIX, WARMUP_MESSAGE } from './noise.js';
import type { VecQuant } from './db.js';
import { getDbPath } from './paths.js';
import { initEmbeddings, generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
import { searchSimilarFacts } from './fact-db.js';
import { getRelatedFacts } from './ontology-db.js';
import { clipLine, summarizeRelated } from './related-format.js';
import { SearchResult, ConversationExchange, MultiConceptResult } from './types.js';
import type DatabaseType from 'better-sqlite3';
import fs from 'fs';
import readline from 'readline';
import { readArchiveFile, createArchiveReadStream, statArchiveFile } from './archive-io.js';

// Module-level cached connection for the search read path. searchConversations
// runs inside long-lived MCP server processes where re-running initDatabase()'s
// full DDL/migration pass and re-opening the file on EVERY search call is pure
// overhead (~3-4ms/call). Keyed by resolved DB path AND file identity
// (dev:inode) — a path-only key would keep serving a stale handle after the
// DB file is unlinked/recreated (rebuild/restore), returning deleted rows and
// missing new ones. Test overrides (TEST_DB_PATH / MEMORY_BANK_DB_PATH)
// switching mid-process also get a fresh handle. Short-lived CLI processes
// release the handle at exit.
let cachedSearchDb: DatabaseType.Database | null = null;
let cachedSearchDbPath: string | null = null;
let cachedSearchDbIdent: string | null = null;

function fileIdent(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null; // file missing — force reopen (initDatabase recreates it)
  }
}

/** Default mmap window for the search connection (writable, used only for reads): 256MB covers the fact vector tables. */
export const DEFAULT_SEARCH_MMAP_BYTES = 268_435_456;

/**
 * Bytes for `PRAGMA mmap_size` on the search connection — MEMORY_BANK_SQLITE_MMAP_BYTES (integer ≥ 0; 0 turns
 * mmap off) or the default. A value that is not a non-negative integer falls back to the default and says so
 * once on stderr (a silent fallback would hide a typo in the user's shell profile).
 */
export function searchMmapBytes(raw: string | undefined = process.env.MEMORY_BANK_SQLITE_MMAP_BYTES, warn: (msg: string) => void = (m) => process.stderr.write(m + '\n')): number {
  if (raw === undefined || raw === '') return DEFAULT_SEARCH_MMAP_BYTES;
  if (/^\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  warn(`memory-bank: MEMORY_BANK_SQLITE_MMAP_BYTES=${JSON.stringify(raw)} is not a non-negative integer — using ${DEFAULT_SEARCH_MMAP_BYTES}`);
  return DEFAULT_SEARCH_MMAP_BYTES;
}

export function getSearchDb(): DatabaseType.Database {
  const p = getDbPath();
  const ident = fileIdent(p);
  if (
    cachedSearchDb && cachedSearchDb.open &&
    cachedSearchDbPath === p &&
    ident !== null && cachedSearchDbIdent === ident
  ) {
    return cachedSearchDb;
  }
  try { cachedSearchDb?.close(); } catch { /* already closed */ }
  cachedSearchDb = initDatabase();
  // Read path only: the brute-force KNN over the fact vector tables reads them whole on every prompt, so the
  // scan is served from the page cache through the map. Measured gain is within noise once the cache is warm
  // (2026-11-02, 9-run medians, LIMIT 50: vec_facts 8.1 → 8.0ms, vec_facts_kr 7.0 → 6.7ms — .qa-artifacts/knn-mmap.json);
  // the design-phase "16.8 → 9.6ms" was a cold-first-call ordering effect. Kept because it costs nothing.
  // Writers (indexer, workers) open their own connections and are left alone.
  try { cachedSearchDb.pragma(`mmap_size = ${searchMmapBytes()}`); } catch { /* an SQLite built without mmap — the scan still works */ }
  cachedSearchDbPath = p;
  cachedSearchDbIdent = fileIdent(p);
  return cachedSearchDb;
}

export interface SearchOptions {
  limit?: number;
  mode?: 'vector' | 'text' | 'both';
  after?: string;  // ISO date string
  before?: string; // ISO date string
  coding_agent?: string; // Filter by coding agent (e.g., 'claude-code', 'codex', 'opencode')
  /** Also return machine-generated turns (NOISE_EXCHANGE_SQL). Default false. */
  include_noise?: boolean;
  /**
   * Keyword pass: only exchanges that contain EVERY word of the query — no partial-match ladder. Used by
   * the multi-concept search, where "some of the words" is not a match.
   */
  require_all_tokens?: boolean;
}

/** First characters of the prompts another memory plugin's observer session sends — not a person asking. */
export const NOISE_OBSERVER_PREFIX = OBSERVER_PROMPT_PREFIX;

/**
 * SQL condition over `exchanges AS e` that is TRUE for a machine-noise row — the one definition of what the
 * conversation search leaves out unless SearchOptions.include_noise is set:
 *  - a sub-agent warm-up turn: a sidechain row whose user message is exactly "Warmup";
 *  - an observer prompt of another memory plugin: the user message starts with NOISE_OBSERVER_PREFIX.
 * On the live index these are 150,715 + 131,638 of 341,817 rows (82.6%); a search for a real question
 * returned 16 observer prompts and 2 warm-ups in its 18 results. Rows are only hidden here — nothing is
 * deleted, and a person's own "Warmup" in the main chain stays.
 * substr(), not LIKE: the `_` in the prefix is a LIKE wildcard.
 * The two texts come from noise.ts — the rule that keeps such turns out of the index (isNoiseExchange) —
 * so what the index refuses and what the search hides cannot drift apart (test/noise-search-parity.test.ts).
 */
export const NOISE_EXCHANGE_SQL =
  `((COALESCE(e.is_sidechain, 0) = 1 AND e.user_message = '${WARMUP_MESSAGE}')` +
  ` OR substr(e.user_message, 1, ${NOISE_OBSERVER_PREFIX.length}) = '${NOISE_OBSERVER_PREFIX}')`;

/** sqlite-vec refuses a KNN whose k is above this ("k value in knn query too large … the limit is 4096"). */
export const VEC_KNN_K_MAX = 4096;

/** Reciprocal-rank-fusion constant for merging the vector and keyword passes in `both` mode. */
const RRF_K = 60;

/** Most keyword matches one look-ahead reads to find `limit` rows that are not machine noise. */
const TEXT_LOOKAHEAD_MAX = 4096;

/**
 * A coding_agent filter on at most this many rows is applied in the keyword query from the agent's own row
 * list (idx_coding_agent, read once per query) instead of from each matching exchange row.
 *
 * The keyword query always scans the keyword index first (see filteredSql). How the agent condition is then
 * tested decides the cost, measured on a 341,840-row index (ms, first run, `limit` 10):
 *   rows of the agent          0     457    5,017   20,133   316,233
 *   test on the exchange row   1,500–4,800  48–1,600  4–64   1–79    1–18
 *   test on the row list       4–55         4–51      2–21   8–24    21–61
 * Testing the row opens every match of the query until `limit` rows pass, and the agent column sits behind
 * the message text (overflow pages) — cheap when most rows pass, seconds when few do. The row list costs one
 * index read of the agent's rows per query — cheap while the list is short.
 */
export const RARE_AGENT_ROWS = 20_000;

/** Rows that carry `agent`, counted no further than RARE_AGENT_ROWS + 1 (index-only; under 6 ms measured). */
function countAgentRows(db: DatabaseType.Database, agent: string): number {
  return (db.prepare(
    'SELECT count(*) AS c FROM (SELECT 1 FROM exchanges WHERE coding_agent = ? LIMIT ?)'
  ).get(agent, RARE_AGENT_ROWS + 1) as { c: number }).c;
}

/**
 * One query token as an FTS5 term. A Hangul word of two or more characters is a PREFIX term: unicode61
 * splits on whitespace, so a word with a particle attached ("검색을") is a different token from the bare
 * word ("검색") and an exact term misses it (measured: 6–22% of the matches of common words). Everything
 * else stays an exact term (Latin words already go through the porter stemmer; a one-character Hangul
 * prefix would match half the vocabulary). Prefix terms work under detail=column and detail=full alike,
 * and the match-count guard below bounds their ranking cost the same way.
 */
function ftsTerm(token: string): string {
  return /^[\uAC00-\uD7A3]{2,}$/.test(token) ? `"${token}"*` : `"${token}"`;
}

/** The turn a row belongs to. A growing session is re-indexed with the same turn under a new id each time. */
const turnKey = (row: { archive_path: string; line_start: number }): string => `${row.archive_path}\u0000${row.line_start}`;

/**
 * One entry per turn, in first-seen order (the best-ranked snapshot decides the position). `rep` is the
 * snapshot with the largest line_end — the most complete copy of the turn; `first` is the best-ranked one.
 */
function foldTurns<T extends { archive_path: string; line_start: number; line_end: number }>(
  rows: T[],
): Array<{ rep: T; first: T; members: number }> {
  const turns = new Map<string, { rep: T; first: T; members: number }>();
  for (const row of rows) {
    const key = turnKey(row);
    const turn = turns.get(key);
    if (!turn) {
      turns.set(key, { rep: row, first: row, members: 1 });
    } else {
      turn.members++;
      if (row.line_end > turn.rep.line_end) turn.rep = row;
    }
  }
  return [...turns.values()];
}

/**
 * Whether a stored "summary" is not one: empty, an LLM/CLI failure message that was written out as the
 * result ("Invalid API key · Please run /login", "API Error: Rate limit reached" — 1,907 of the 3,005 short
 * summaries on the live disk), or a worker's JSON reply. Such a file is never shown as a conversation summary.
 */
export function isErrorSummary(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^(Invalid API key|API Error\b|Your account does not have access to Claude Code)/i.test(t)) return true;
  if (/^```(?:json)?\s*[{[]/.test(t) || /^[{[]\s*"/.test(t)) return true;
  return false;
}

/** How a search ran — what a caller needs to tell "nothing matched" from "the search was cut short". */
export interface SearchMeta {
  /**
   * Vector pass: the k of the last KNN, how many candidates it returned, how many of them passed the row
   * conditions (date, agent, embedding version), and whether k hit the sqlite-vec ceiling before `limit`
   * rows passed (the index held more candidates that were never looked at).
   */
  vector?: { k: number; candidates: number; matched: number; truncated: boolean };
  /**
   * Keyword pass: whether it used the FTS index or a full LIKE scan of every exchange (and why), and
   * whether its look-ahead past machine-noise matches ended before `limit` rows were found.
   */
  text?: { path: 'fts' | 'like-scan'; reason?: string; truncated: boolean };
  /** Snapshot copies of a turn that were folded into the turn's one result. */
  folded?: number;
}

export type SearchHit = SearchResult & { summary?: string };

interface ExchangeRow {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
  distance: number;
  coding_agent: string | null;
}

function validateISODate(dateStr: string, paramName: string): void {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRegex.test(dateStr)) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Expected YYYY-MM-DD format (e.g., 2025-10-01)`);
  }
  // Verify it's actually a valid date
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Not a valid calendar date.`);
  }
}

export async function searchConversations(
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  return (await searchConversationsDetailed(query, options)).results;
}

/** searchConversations plus how the search ran (SearchMeta) — pass both to formatResults. */
export async function searchConversationsDetailed(
  query: string,
  options: SearchOptions = {}
): Promise<{ results: SearchHit[]; meta: SearchMeta }> {
  const { limit = 10, mode = 'both', after, before, coding_agent, include_noise = false, require_all_tokens = false } = options;

  // Validate date parameters
  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const db = getSearchDb();
  const meta: SearchMeta = { folded: 0 };
  let folded = 0;
  let vectorRows: ExchangeRow[] = [];
  let textRows: ExchangeRow[] = [];
  // null = no agent filter. 0 = no exchange carries the agent: nothing can pass, so neither pass runs
  // (the vector pass would otherwise scan to the sqlite-vec ceiling and report "cut short").
  const agentRows = coding_agent ? countAgentRows(db, coding_agent) : null;

  const cols = `
          e.id,
          e.project,
          e.timestamp,
          e.user_message,
          e.assistant_message,
          e.archive_path,
          e.line_start,
          e.line_end,
          e.coding_agent`;

  {
    // Build filter clauses with parameterized queries
    const filterParts: string[] = [];
    // The same filters as the keyword query writes them (same parameters, same order) — only the agent
    // condition differs, see RARE_AGENT_ROWS.
    const ftsFilterParts: string[] = [];
    const filterParams: string[] = [];
    if (after) {
      filterParts.push(`e.timestamp >= ?`);
      ftsFilterParts.push(`e.timestamp >= ?`);
      filterParams.push(after);
    }
    if (before) {
      filterParts.push(`e.timestamp <= ?`);
      ftsFilterParts.push(`e.timestamp <= ?`);
      filterParams.push(before);
    }
    if (coding_agent) {
      filterParts.push(`e.coding_agent = ?`);
      // Unary plus: the condition must stay a test on each keyword match. Without it SQLite may turn the
      // list into the outer loop and probe the keyword index once per listed row.
      ftsFilterParts.push((agentRows ?? 0) <= RARE_AGENT_ROWS
        ? `+fts.rowid IN (SELECT a.rowid FROM exchanges AS a WHERE a.coding_agent = ?)`
        : `e.coding_agent = ?`);
      filterParams.push(coding_agent);
    }
    const timeClause = filterParts.length > 0 ? `AND ${filterParts.join(' AND ')}` : '';
    const timeParams = filterParams;
    // Machine-noise rows are left out unless asked for (NOISE_EXCHANGE_SQL carries no parameter).
    const noiseClause = include_noise ? '' : `AND NOT ${NOISE_EXCHANGE_SQL}`;
    // Every condition on the exchange row: the caller's filters plus the noise exclusion.
    const rowClause = [timeClause, noiseClause].filter(Boolean).join(' ');
    const ftsRowClause = [ftsFilterParts.length > 0 ? `AND ${ftsFilterParts.join(' AND ')}` : '', noiseClause].filter(Boolean).join(' ');

    /** Display rows of the given ids (the full message text is read only here). */
    const fetchRows = (ids: string[]): Map<string, ExchangeRow> => {
      const byId = new Map<string, ExchangeRow>();
      for (let at = 0; at < ids.length; at += 500) {
        const chunk = ids.slice(at, at + 500);
        const rows = db.prepare(
          `SELECT ${cols}, 0 as distance FROM exchanges AS e WHERE e.id IN (${chunk.map(() => '?').join(',')})`
        ).all(...chunk) as ExchangeRow[];
        for (const row of rows) byId.set(row.id, row);
      }
      return byId;
    };

    if (agentRows === 0) {
      if (mode !== 'text') meta.vector = { k: 0, candidates: 0, matched: 0, truncated: false };
    } else if (mode === 'vector' || mode === 'both') {
      // Vector similarity search
      await initEmbeddings();
      const queryEmbedding = await generateEmbedding(query, 'query');

      // dtype/scale-aware: int8 tables need vec_int8()-wrapped quantized query
      // blobs, and their distances come back ×scale (normalized below).
      //
      // The KNN applies k BEFORE any condition on the joined exchange row, so
      // those conditions cannot simply sit in WHERE: with k = limit, a date or
      // agent filter discarded most (often all) of the top-k and the passing
      // rows behind them never came back — the vector pass silently returned
      // nothing and only keyword hits were left. Every candidate is returned
      // with a `pass` flag instead (LEFT JOIN: a vector whose exchange row is
      // gone still counts toward "did the index run out"), and k grows until
      // `limit` rows pass, the index is exhausted, or the sqlite-vec ceiling is
      // reached — in which case the result says so (meta.vector.truncated).
      // Snapshot copies of one turn count once (foldTurns), so they cannot use
      // up the limit. The heavy text columns are read only for the winners.
      const vecQuery = (vecQuant: VecQuant): { rows: ExchangeRow[]; folded: number; stats: NonNullable<SearchMeta['vector']> } => {
        const stmt = db.prepare(`
          SELECT
            vec.id AS id,
            vec.distance AS distance,
            e.archive_path AS archive_path,
            e.line_start AS line_start,
            e.line_end AS line_end,
            (e.id IS NOT NULL AND e.embedding_version = ? ${rowClause}) AS pass
          FROM vec_exchanges AS vec
          LEFT JOIN exchanges AS e ON e.id = vec.id
          WHERE vec.embedding MATCH ${vecParamSql(vecQuant)}
            AND k = ?
          ORDER BY vec.distance ASC
        `);

        // embedding_version condition: old-model vectors are incomparable with
        // the current-model query embedding — exclude rows the re-embed worker
        // has not upgraded yet (newest sessions are upgraded first).
        const blob = embeddingToVecBlob(queryEmbedding, vecQuant);
        const want = Math.min(limit, VEC_KNN_K_MAX);
        let k = rowClause ? Math.min(VEC_KNN_K_MAX, Math.max(want * 8, 64)) : want;
        type Candidate = { id: string; distance: number; archive_path: string; line_start: number; line_end: number; pass: number };
        for (;;) {
          const candidates = stmt.all(EMBEDDING_VERSION, ...timeParams, blob, k) as Candidate[];
          const passing = candidates.filter((c) => c.pass);
          const turns = foldTurns(passing);
          const exhausted = candidates.length < k;
          if (turns.length >= want || exhausted || k >= VEC_KNN_K_MAX) {
            const winners = turns.slice(0, want);
            const full = fetchRows(winners.map((w) => w.rep.id));
            const rows: ExchangeRow[] = [];
            let foldedHere = 0;
            for (const w of winners) {
              const row = full.get(w.rep.id);
              // The turn's row is its most complete snapshot; its distance is the best snapshot's.
              if (row) rows.push({ ...row, distance: normalizeVecDistance(w.first.distance, vecQuant) });
              foldedHere += w.members - 1;
            }
            return {
              rows,
              folded: foldedHere,
              stats: {
                k,
                candidates: candidates.length,
                matched: passing.length,
                truncated: !exhausted && (turns.length < want || limit > want),
              },
            };
          }
          // Each round is a full scan of the index, so take as few as possible: at least ×4, and when the
          // pass rate seen so far says that cannot fill `want` either, twice what the rate implies (the
          // ceiling when nothing has passed yet).
          k = Math.min(VEC_KNN_K_MAX, Math.max(k * 4, turns.length === 0 ? VEC_KNN_K_MAX : Math.ceil((k * want * 2) / turns.length)));
        }
      };

      let vecQuant = getVecQuant(db, 'vec_exchanges');
      let vec: ReturnType<typeof vecQuery>;
      try {
        vec = vecQuery(vecQuant);
      } catch (e) {
        // The int8 migration may have swapped the table dtype between our
        // dtype read and the query (read path is not serialized by the swap
        // lock). Retry once with a fresh dtype; rethrow anything else.
        const fresh = getVecQuant(db, 'vec_exchanges');
        if (fresh.dtype === vecQuant.dtype && fresh.scale === vecQuant.scale) throw e;
        vecQuant = fresh;
        vec = vecQuery(vecQuant);
      }
      vectorRows = vec.rows;
      folded += vec.folded;
      meta.vector = vec.stats;
    }

    // In 'both' mode always run the text pass and merge: vector (semantic) and
    // text (literal/keyword) are complementary, so skipping text when vector is
    // full would drop exact matches that vector ranks lower. The text pass is now
    // cheap (FTS5), so there is no reason to skip it.
    if (mode === 'text' || mode === 'both') {
      let textResults: ExchangeRow[] = [];

      // FTS5 (BM25-ranked) — replaces the O(rows) LIKE full scan. Build a safe
      // MATCH expression by quoting each whitespace token (neutralizes FTS5
      // operators like -, *, OR, ", :). Falls back to LIKE if the FTS table is
      // absent (older DB) or the query has no usable tokens.
      //
      // Two-stage matching: AND first (precision — every token must be
      // present, identical to the original behavior), then an OR fallback
      // ONLY when AND matches nothing. Long natural-language queries almost
      // never contain ALL tokens in one exchange (measured 16% AND match rate
      // on ~20-token queries), which silently killed the text pass and capped
      // bench recall@10 at 0.930; the OR fallback rescues those (recall
      // 1.000) without letting single-token hits displace exact matches on
      // queries AND can satisfy. The OR pass caps to the longest tokens —
      // longer tokens are rarer (cheaper posting unions) and more selective
      // (better BM25 top-k).
      // Split on ANY non-alphanumeric boundary (mirroring the unicode61
      // tokenizer), not just whitespace: a whitespace-split token like
      // "sqlite-vec" quoted becomes a multi-token PHRASE query after FTS
      // tokenization, and phrase queries are unsupported under detail=column
      // (they throw → silent LIKE fallback → seconds-long full scans).
      // Single-token quoted terms can never form phrases.
      const ftsTokens = query
        .split(/[^\p{L}\p{N}]+/u)
        .map((t) => t.trim())
        .filter(Boolean);
      const ftsExpr = ftsTokens.map(ftsTerm).join(' ');
      const MAX_FTS_TOKENS = 6;
      const MAX_OR_TOKENS = 10; // hard bound on posting-list unions (latency)
      let orTokens = ftsTokens;
      if (orTokens.length > MAX_FTS_TOKENS) {
        const uniq = [...new Set(orTokens)];
        // Longest tokens are rarer (cheaper unions, better BM25 selectivity) —
        // but short identifier-like tokens (id7, R8, C4, QA) are often the
        // real discriminators, so digit-bearing tokens and short ALL-CAPS
        // acronyms are always kept alongside the longest ones.
        const identifiers = uniq.filter((t) => /\d/.test(t) || /^[A-Z]{2,4}$/.test(t));
        const longest = uniq.sort((a, b) => b.length - a.length).slice(0, MAX_FTS_TOKENS);
        orTokens = [...new Set([...longest, ...identifiers])].slice(0, MAX_OR_TOKENS);
      }
      // Rarest-token AND ladder (replaces a flat OR fallback): a flat OR over
      // capped tokens either drags in very common terms (BM25 over 100K+
      // matches — 35s measured) or, rank-degraded to newest-first, loses the
      // target in mid-sized match sets. Instead: probe each candidate token's
      // document frequency (posting-length count, ms each), sort rarest
      // first, then try AND of the 4→3→2→1 rarest tokens and return the first
      // non-empty result. The source document contains every query token, so
      // it is in every ladder rung's match set; the first non-empty rung is
      // the most selective one — small enough to BM25-rank meaningfully.

      let usedFts = false;
      // Why the keyword pass is about to scan every exchange with LIKE instead of using the index — it used
      // to switch without a word (seconds per query on a large index), so the reason travels with the result.
      let likeReason: string | null = ftsExpr ? null : 'the query has no letter or digit to look up in the keyword index';
      let textTruncated = false;
      if (ftsExpr) {
        try {
          // Readiness flag (set in db.ts / backfill-fts.mjs). On a fresh upgrade
          // the external-content FTS index is EMPTY until backfill-fts.mjs runs;
          // a row-probe would false-positive (it reads the content table), so we
          // use an explicit '1' flag and fall back to LIKE until it is set — never
          // silently hiding historical text matches.
          const built = db.prepare(`SELECT value FROM fts_meta WHERE key='exchanges_fts_built'`).get() as { value: string } | undefined;
          if (built?.value !== '1') {
            likeReason = 'the keyword index has not been built yet (scripts/backfill-fts.mjs builds it)';
          } else {
            // Unfiltered queries: sort + LIMIT happen INSIDE a subquery on
            // the FTS table and only the k winners are joined to `exchanges`
            // — joining before the sort materializes the FULL conversation
            // text of every match (a common-word query matched 17.8K rows ≈
            // 350MB pulled to keep 10; measured 34s).
            // Filtered queries (after/before/coding_agent): the filter MUST
            // apply BEFORE the limit or valid old/filtered hits vanish (an
            // inner-limit over-fetch was reproduced hiding a valid old row
            // behind 250 newer matches) — so they use the join-then-sort
            // form; filters shrink the materialized set instead.
            // That form fixes the join order with CROSS JOIN: the keyword
            // index is scanned once, each match is then looked up by rowid.
            // Left to the planner (the index has no statistics), a
            // coding_agent filter made idx_coding_agent the outer loop — one
            // keyword-index probe per row of the agent: 12 s for an English
            // query and 300 s for a Korean (prefix) one on a 341,840-row
            // index where every row is 'claude-code', the server answering
            // nothing else meanwhile. Fixed order: 10–60 ms.
            //
            // No caller filter, machine noise left out (the default): the cheap
            // inner-limit form is kept, but it reads AHEAD of `limit` and marks
            // each row noise-or-not, growing the look-ahead until `limit` rows
            // pass, the matches run out, or TEXT_LOOKAHEAD_MAX is reached (then
            // the result says the keyword pass was cut short). Putting the noise
            // condition into the join-then-sort form instead would bring back
            // the full-text materialization above for every unfiltered query.
            const ftsStatements = new Map<string, DatabaseType.Statement>();
            const ftsStatement = (key: string, sql: () => string): DatabaseType.Statement => {
              let stmt = ftsStatements.get(key);
              if (!stmt) {
                stmt = db.prepare(sql());
                ftsStatements.set(key, stmt);
              }
              return stmt;
            };
            const filteredSql = (orderBy: string) => `
                  SELECT ${cols}, 0 as distance
                  FROM exchanges_fts AS fts
                  CROSS JOIN exchanges AS e ON e.rowid = fts.rowid
                  WHERE exchanges_fts MATCH ?
                    ${ftsRowClause}
                  ORDER BY ${orderBy.replace('rowid', 'fts.rowid')}
                  LIMIT ?
                `;
            const innerLimitSql = (orderBy: string) => `
                  SELECT ${cols}, 0 as distance
                  FROM (
                    SELECT rowid FROM exchanges_fts
                    WHERE exchanges_fts MATCH ?
                    ORDER BY ${orderBy}
                    LIMIT ?
                  ) AS fts
                  JOIN exchanges AS e ON e.rowid = fts.rowid
                  LIMIT ?
                `;
            const lookAheadSql = (orderBy: string) => `
                  SELECT e.id AS id, (NOT ${NOISE_EXCHANGE_SQL}) AS pass
                  FROM (
                    SELECT rowid FROM exchanges_fts
                    WHERE exchanges_fts MATCH ?
                    ORDER BY ${orderBy}
                    LIMIT ?
                  ) AS fts
                  JOIN exchanges AS e ON e.rowid = fts.rowid
                `;
            // BM25 (ORDER BY rank) scores EVERY matching document, and under
            // detail=column with external content each bm25() call RE-READS
            // AND RE-TOKENIZES the source text (term frequencies are not in
            // the index) — measured ~1.9ms/doc, 33s over a 17.8K-match
            // common-word query. Under detail=full the frequencies are in the
            // index and ranking is orders of magnitude cheaper. Guard: count
            // matches first (posting iteration, no scoring — 12ms on 17.8K)
            // and only rank within a budget scaled to the actual detail mode;
            // over budget → newest-first (the vector pass provides semantic
            // ranking).
            const ftsSchema = (db.prepare(
              `SELECT sql FROM sqlite_master WHERE name='exchanges_fts'`
            ).get() as { sql: string } | undefined)?.sql ?? '';
            const RANK_BUDGET = /detail\s*=\s*column/i.test(ftsSchema) ? 200 : 20000;
            const countStmt = db.prepare(
              `SELECT count(*) c FROM exchanges_fts WHERE exchanges_fts MATCH ?`
            );
            // Join-before-limit: correct even when the index holds orphan rowids.
            const healRows = (expr: string, lim: number): ExchangeRow[] => db.prepare(`
                    SELECT ${cols}, 0 as distance
                    FROM exchanges_fts AS fts
                    JOIN exchanges AS e ON e.rowid = fts.rowid
                    WHERE exchanges_fts MATCH ?
                      ${noiseClause}
                    ORDER BY fts.rowid DESC
                    LIMIT ?
                  `).all(expr, lim) as ExchangeRow[];
            /** At most `lim` rows matching `expr`, under the caller's filters and the noise exclusion. */
            const ftsRows = (expr: string, lim: number): ExchangeRow[] => {
              const n = (countStmt.get(expr) as { c: number }).c;
              if (n === 0) return [];
              const orderBy = n <= RANK_BUDGET ? 'rank' : 'rowid DESC';
              if (timeClause) {
                return ftsStatement(`filtered:${orderBy}`, () => filteredSql(orderBy)).all(expr, ...timeParams, lim) as ExchangeRow[];
              }
              if (!noiseClause) {
                const rows = ftsStatement(`inner:${orderBy}`, () => innerLimitSql(orderBy)).all(expr, lim, lim) as ExchangeRow[];
                // Self-heal on index desync: every legit FTS rowid joins to an
                // exchanges row (triggers keep them in sync), so a shortfall
                // vs the counted matches means the inner LIMIT picked stale/
                // orphan rowids that the join then dropped. Retry once with
                // join-before-limit, which is correct even with orphans.
                if (rows.length < Math.min(n, lim)) return healRows(expr, lim);
                return rows;
              }
              const lookAhead = ftsStatement(`ahead:${orderBy}`, () => lookAheadSql(orderBy));
              let inner = Math.min(n, Math.max(lim * 4, 64));
              for (;;) {
                const candidates = lookAhead.all(expr, inner) as Array<{ id: string; pass: number }>;
                // Same desync signal as above: fewer joined rows than rowids asked for.
                if (candidates.length < Math.min(n, inner)) return healRows(expr, lim);
                const passing = candidates.filter((c) => c.pass).slice(0, lim);
                if (passing.length >= lim || inner >= n || inner >= TEXT_LOOKAHEAD_MAX) {
                  if (passing.length < lim && inner < n) textTruncated = true;
                  const full = fetchRows(passing.map((c) => c.id));
                  const rows: ExchangeRow[] = [];
                  for (const c of passing) {
                    const row = full.get(c.id);
                    if (row) rows.push(row);
                  }
                  return rows;
                }
                // Same stepping as the vector pass: at least ×4, or what the pass rate so far implies.
                inner = Math.min(n, TEXT_LOOKAHEAD_MAX, Math.max(
                  inner * 4,
                  passing.length === 0 ? TEXT_LOOKAHEAD_MAX : Math.ceil((inner * lim * 2) / passing.length),
                ));
              }
            };
            // Rarest-token AND ladder (see comment above orTokens): walk AND
            // of the 4→3→2→1 rarest candidate tokens and ACCUMULATE rungs
            // (dedup) until `lim` rows — most-selective hits first, but a
            // single rare distractor cannot suppress hits that match the
            // other query terms (lower rungs still contribute). df=0 tokens
            // are dropped (they match nothing).
            const orFallbackRows = (lim: number): ExchangeRow[] => {
              // A failing frequency probe is not "no matches": it reaches the handler below, which says so.
              const rare = [...new Set(orTokens)]
                .map((t) => ({ t, df: (countStmt.get(ftsTerm(t)) as { c: number }).c }))
                .filter((x) => x.df > 0)
                .sort((a, b) => a.df - b.df)
                .map((x) => x.t);
              // Rungs: AND-of-rarest prefixes (most selective first), then
              // every token individually in df order — so hits matching only
              // the OTHER query terms still surface after the rare ones.
              const rungs: string[] = [];
              for (let k = Math.min(4, rare.length); k >= 2; k--) {
                rungs.push(rare.slice(0, k).map(ftsTerm).join(' '));
              }
              for (const t of rare) rungs.push(ftsTerm(t));
              // Two-pass fill with a per-rung quota: pass 1 lets each rung
              // take at most half the slots so one populous rung (many docs
              // matching one rare token) cannot crowd out hits that match the
              // OTHER query terms; pass 2 refills any remaining slots from
              // rung leftovers in selectivity order.
              const perRung: ExchangeRow[][] = [];
              for (const expr of rungs) {
                if (expr === ftsExpr) continue; // identical to the AND pass
                perRung.push(ftsRows(expr, lim));
                const distinct = new Set(perRung.flat().map((r) => r.id));
                if (distinct.size >= lim * 2) break; // enough material
              }
              const acc: ExchangeRow[] = [];
              const seen = new Set<string>();
              const quota = Math.max(1, Math.ceil(lim / 2));
              for (const rows of perRung) {
                let took = 0;
                for (const r of rows) {
                  if (took >= quota || acc.length >= lim) break;
                  if (!seen.has(r.id)) { seen.add(r.id); acc.push(r); took++; }
                }
              }
              for (const rows of perRung) {
                for (const r of rows) {
                  if (acc.length >= lim) break;
                  if (!seen.has(r.id)) { seen.add(r.id); acc.push(r); }
                }
              }
              return acc;
            };
            // Contract: the text pass returns AT MOST `limit` rows in every
            // mode, all-token (AND/exact) matches always first — identical
            // fetch depth to the original all-AND implementation.
            if (agentRows === 0) {
              textResults = []; // no exchange carries the agent — nothing to look up
            } else if (require_all_tokens) {
              textResults = ftsRows(ftsExpr, limit);
            } else if (ftsTokens.length <= MAX_FTS_TOKENS) {
              // Short query: AND first (precision — identical to original
              // behavior), ladder fallback only when AND matches nothing.
              textResults = ftsRows(ftsExpr, limit);
              if (textResults.length === 0 && ftsTokens.length > 1) {
                textResults = orFallbackRows(limit);
              }
            } else {
              // Long query: AND pass first (full limit — exact matches are
              // never capped below the caller's limit), then the ladder
              // supplement fills only the REMAINING slots. AND results stay
              // FIRST: an exact all-token match can never be hidden by
              // partial-token hits. The ladder rescues the ~84% of long
              // queries the full AND cannot match.
              textResults = ftsRows(ftsExpr, limit);
              if (textResults.length < limit) {
                const orResults = orFallbackRows(limit);
                const seenText = new Set(textResults.map((r) => r.id));
                for (const r of orResults) {
                  if (!seenText.has(r.id) && textResults.length < limit) {
                    textResults.push(r);
                  }
                }
              }
            }
            usedFts = true;
          }
        } catch (error) {
          // FTS table missing/unsupported → LIKE fallback below, said out loud.
          usedFts = false;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`memory-bank search: keyword index query failed, scanning every exchange instead: ${message}`);
          likeReason = `the keyword index query failed: ${message}`;
        }
      }

      if (!usedFts) {
        // Escape LIKE metacharacters
        const escapedQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const likePattern = `%${escapedQuery}%`;
        const textStmt = db.prepare(`
          SELECT ${cols}, 0 as distance
          FROM exchanges AS e
          WHERE (e.user_message LIKE ? ESCAPE '\\' OR e.assistant_message LIKE ? ESCAPE '\\')
            ${rowClause}
          ORDER BY e.timestamp DESC
          LIMIT ?
        `);
        textResults = textStmt.all(likePattern, likePattern, ...timeParams, limit) as ExchangeRow[];
      }

      meta.text = usedFts
        ? { path: 'fts', truncated: textTruncated }
        : { path: 'like-scan', reason: likeReason ?? 'the keyword index was not usable', truncated: false };

      // One row per turn here too (the longest snapshot among the hits).
      const textTurns = foldTurns(textResults);
      textRows = textTurns.map((turn) => turn.rep);
      folded += textResults.length - textTurns.length;
    }
  }
  // NOTE: no db.close() — the cached connection is reused across calls (see
  // getSearchDb). CLI processes release it at exit; the MCP server keeps it.

  // Merge the two passes by reciprocal rank fusion and cut to `limit`. They used
  // to be concatenated (vector rows, then every keyword row not already there):
  // `limit` 10 returned up to 20 rows, and a row both passes agreed on was not
  // ranked any higher for it. A keyword hit has no distance — it carries no
  // similarity (it was printed as "100% match" when it borrowed distance 0).
  // The key is the turn, not the row id: the two passes can reach one turn through different snapshots.
  type Merged = { row: ExchangeRow; matchedBy: 'vector' | 'text' | 'both'; distance?: number; score: number };
  const merged = new Map<string, Merged>();
  vectorRows.forEach((row, rank) => {
    merged.set(turnKey(row), { row, matchedBy: 'vector', distance: row.distance, score: 1 / (RRF_K + rank + 1) });
  });
  textRows.forEach((row, rank) => {
    const score = 1 / (RRF_K + rank + 1);
    const hit = merged.get(turnKey(row));
    if (hit) {
      hit.matchedBy = 'both';
      hit.score += score;
      if (row.id !== hit.row.id) {
        folded++;
        if (row.line_end > hit.row.line_end) hit.row = row;
      }
    } else {
      merged.set(turnKey(row), { row, matchedBy: 'text', score });
    }
  });
  meta.folded = folded;
  // Stable sort: at equal score the vector row (inserted first) stays ahead.
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  const results = ranked.map(({ row, matchedBy, distance }) => {
    const exchange: ConversationExchange = {
      id: row.id,
      project: row.project,
      timestamp: row.timestamp,
      userMessage: row.user_message,
      assistantMessage: row.assistant_message,
      archivePath: row.archive_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      codingAgent: row.coding_agent || 'claude-code',
    };

    // Try to load summary if available
    const summaryPath = row.archive_path.replace('.jsonl', '-summary.txt');
    let summary: string | undefined;
    try { summary = readArchiveFile(summaryPath).trim(); } catch { /* absent */ }
    // A failed summary call that was written out as the summary is not shown as one.
    if (summary !== undefined && isErrorSummary(summary)) summary = undefined;

    // Create snippet (first 200 chars, collapse newlines)
    const snippetText = exchange.userMessage.substring(0, 200).replace(/\s+/g, ' ').trim();
    const snippet = snippetText + (exchange.userMessage.length > 200 ? '...' : '');

    const hit: SearchHit = {
      exchange,
      // Cosine similarity of the (unit) embeddings — the same conversion every
      // other relevance figure uses. Absent for a keyword-only hit.
      similarity: distance === undefined ? undefined : l2DistanceToSimilarity(distance),
      matchedBy,
      snippet,
      summary,
    };
    return hit;
  });

  return { results, meta };
}

/** Lines a caller should show with the results: what the search could not look at. */
export function searchNotes(meta: SearchMeta | undefined): string[] {
  const notes: string[] = [];
  if (meta?.vector?.truncated) {
    notes.push(
      `Semantic results are incomplete: only the nearest ${meta.vector.candidates} vector candidates could be examined ` +
      `(sqlite-vec ceiling) and ${meta.vector.matched} passed the filters — narrow the query or relax the date/agent filter.`
    );
  }
  if (meta?.text?.truncated) {
    notes.push(
      `Keyword results are incomplete: the first ${TEXT_LOOKAHEAD_MAX} keyword matches were mostly machine-generated turns ` +
      `and were skipped; older matches were not examined — add a date filter or more specific words.`
    );
  }
  if (meta?.text?.path === 'like-scan') {
    notes.push(`Keyword pass ran as a full scan (${meta.text.reason}) — slow on a large index.`);
  }
  return notes;
}

/** Characters of each message a json search result carries — the full exchange is one `read` away. */
export const SEARCH_JSON_MESSAGE_CHARS = 500;

const JSON_READ_HINT =
  `Messages are clipped to ${SEARCH_JSON_MESSAGE_CHARS} characters. Read a full exchange with the read tool: ` +
  'path = exchange.archivePath, startLine = exchange.lineStart, endLine = exchange.lineEnd.';

function clipMessage(text: string): string {
  if (text.length <= SEARCH_JSON_MESSAGE_CHARS) return text;
  let cut = text.slice(0, SEARCH_JSON_MESSAGE_CHARS);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

/** The fields of an exchange a json result carries: where it is, and a clipped look at both messages. */
function exchangeForJson(exchange: ConversationExchange): { exchange: Record<string, unknown>; clipped: boolean } {
  const userMessage = clipMessage(exchange.userMessage);
  const assistantMessage = clipMessage(exchange.assistantMessage);
  return {
    exchange: {
      id: exchange.id,
      project: exchange.project,
      timestamp: exchange.timestamp,
      codingAgent: exchange.codingAgent,
      archivePath: exchange.archivePath,
      lineStart: exchange.lineStart,
      lineEnd: exchange.lineEnd,
      userMessage,
      assistantMessage,
    },
    clipped: userMessage !== exchange.userMessage || assistantMessage !== exchange.assistantMessage,
  };
}

/**
 * The `search` tool's json answer. It used to serialize every exchange in full (limit 10 → up to 165K
 * characters, limit 50 → 272K); a result now carries the location, the match and a clipped look.
 */
export function searchResultsToJson(results: SearchHit[], meta: SearchMeta | undefined, mode: string): string {
  return JSON.stringify({
    results: results.map((r) => ({
      ...exchangeForJson(r.exchange),
      similarity: r.similarity,
      matchedBy: r.matchedBy,
      snippet: r.snippet,
    })),
    count: results.length,
    mode,
    notes: searchNotes(meta),
    hint: JSON_READ_HINT,
  });
}

/** The json answer of a multi-concept search, clipped the same way. */
export function multiConceptResultsToJson(results: MultiConceptResult[], concepts: string[]): string {
  return JSON.stringify({
    results: results.map((r) => ({
      ...exchangeForJson(r.exchange),
      snippet: r.snippet,
      matchedBy: r.matchedBy,
      conceptSimilarities: r.conceptSimilarities,
      averageSimilarity: r.averageSimilarity,
    })),
    count: results.length,
    concepts,
    hint: JSON_READ_HINT,
  });
}

// Helper function to count lines in a file efficiently
// The "(N lines)" hint used to SCAN the whole archive file per result —
// measured 199ms/10 results on plain files and ~1.6s when the archives are
// zst-compressed (each count = a full decompression). The indexer already
// recorded every exchange's line range, so ask the DB instead:
// MAX(line_end) over the file's exchanges (idx_archive_path — instant).
// The full scan survives only as a fallback for files the DB doesn't know,
// memoized by (path, mtime, size) with in-flight dedup so duplicate result
// rows can't trigger concurrent decompressions of the same file.
const lineCountCache = new Map<string, Promise<number>>();
const LINE_COUNT_CACHE_MAX = 2000;

async function countLines(filePath: string): Promise<number> {
  // DB-first: instant, no file I/O, no decompression.
  try {
    const row = getSearchDb().prepare(
      'SELECT MAX(line_end) AS n FROM exchanges WHERE archive_path = ?'
    ).get(filePath) as { n: number | null } | undefined;
    if (row?.n) return row.n;
  } catch { /* DB unavailable — fall through to the scan */ }

  let key = filePath;
  try {
    const st = statArchiveFile(filePath);
    if (st) key = `${filePath}:${st.mtimeMs}:${st.size}`;
  } catch { /* stat failed — fall through to an uncached scan attempt */ }
  const hit = lineCountCache.get(key);
  if (hit !== undefined) return hit;
  const scan = (async () => {
    try {
      const fileStream = createArchiveReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      let count = 0;
      for await (const line of rl) {
        if (line.trim()) count++;
      }
      return count;
    } catch {
      lineCountCache.delete(key); // not cached — may become readable later
      return 0;
    }
  })();
  if (lineCountCache.size >= LINE_COUNT_CACHE_MAX) lineCountCache.clear();
  lineCountCache.set(key, scan);
  return scan;
}

// Helper function to get file size in KB (resolves compressed variants)
function getFileSizeInKB(filePath: string): number {
  const stats = statArchiveFile(filePath);
  if (!stats) return 0;
  return Math.round(stats.size / 1024 * 10) / 10; // Round to 1 decimal place
}

export async function formatResults(results: SearchHit[], meta?: SearchMeta): Promise<string> {
  const notes = searchNotes(meta).map((note) => `_Note: ${note}_\n`).join('');
  if (results.length === 0) {
    return notes ? `No results found.\n\n${notes}` : 'No results found.';
  }

  let output = `Found ${results.length} relevant conversation${results.length > 1 ? 's' : ''}:\n\n`;

  // Pre-compute per-result file metadata in PARALLEL — the line counts are
  // independent file scans (memoized above), so first-call latency is the
  // slowest single file instead of the sum of all of them.
  const lineCounts = await Promise.all(results.map((r) => countLines(r.exchange.archivePath)));

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    const simPct = result.similarity !== undefined ? Math.round(result.similarity * 100) : null;

    // Header with match percentage and coding agent
    const agent = result.exchange.codingAgent || 'claude-code';
    const agentTag = agent !== 'claude-code' ? ` @${agent}` : '';
    output += `${index + 1}. [${result.exchange.project}, ${date}${agentTag}]`;
    // A percentage only where a vector distance exists; a keyword hit says what it is.
    if (simPct !== null) {
      output += ` - ${simPct}% match${result.matchedBy === 'both' ? ' (semantic + keyword)' : ''}`;
    } else if (result.matchedBy === 'text') {
      output += ' - keyword match';
    }
    output += '\n';

    // Show summary only if it's concise (< 300 chars)
    if (result.summary && result.summary.length < 300) {
      output += `   ${result.summary}\n`;
    }

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    // Get file metadata (line count pre-computed in parallel above)
    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const totalLines = lineCounts[index];
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;

    // File information with metadata (clean format for smart tool selection)
    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ${totalLines} lines)\n\n`;
  }

  return output + notes;
}

/**
 * Keyword side of the multi-concept search: exchanges that contain every word of every concept, one per
 * conversation — up to 5×limit of them, the nearest to the concepts first. Each carries its real similarity
 * to every concept, computed from its stored vector (NaN when the exchange has no vector row — unknown, not
 * zero; those go last).
 * The order is the similarity, not the keyword pass's: an exchange can hold every word by accident (a long
 * pasted document, a tool log), and the keyword pass ranks by word statistics or, over its ranking budget,
 * by recency.
 */
async function keywordConceptMatches(
  concepts: string[],
  options: Omit<SearchOptions, 'mode'>,
  limit: number,
): Promise<MultiConceptResult[]> {
  const { results, meta } = await searchConversationsDetailed(concepts.join(' '), {
    ...options,
    mode: 'text',
    limit: limit * 5,
    require_all_tokens: true,
  });
  if (meta.text?.path !== 'fts') {
    // Without the keyword index the pass is a LIKE scan for the joined text — not "every word". This side
    // contributes nothing then, and says so; the semantic side still answers.
    console.error(`memory-bank search: multi-concept keyword matching skipped (${meta.text?.reason ?? 'keyword index unavailable'})`);
    return [];
  }

  const perConversation = new Map<string, SearchHit>();
  for (const hit of results) {
    if (!perConversation.has(hit.exchange.archivePath)) perConversation.set(hit.exchange.archivePath, hit);
  }
  const hits = [...perConversation.values()];
  if (hits.length === 0) return [];

  await initEmbeddings();
  const embeddings: number[][] = [];
  for (const concept of concepts) embeddings.push(await generateEmbedding(concept, 'query'));

  const db = getSearchDb();
  const quant = getVecQuant(db, 'vec_exchanges');
  const distance = db.prepare(`SELECT vec_distance_l2(embedding, ${vecParamSql(quant)}) AS d FROM vec_exchanges WHERE id = ?`);
  const blobs = embeddings.map((embedding) => embeddingToVecBlob(embedding, quant));

  const matches = hits.map((hit) => {
    const conceptSimilarities = blobs.map((blob) => {
      const row = distance.get(blob, hit.exchange.id) as { d: number } | undefined;
      return row ? l2DistanceToSimilarity(normalizeVecDistance(row.d, quant)) : Number.NaN;
    });
    return {
      exchange: hit.exchange,
      snippet: hit.snippet,
      conceptSimilarities,
      averageSimilarity: conceptSimilarities.reduce((sum, sim) => sum + sim, 0) / conceptSimilarities.length,
      matchedBy: 'keyword' as const,
    };
  });
  // Nearest first; unknown similarity last. The sort is stable: equal values keep the keyword pass's order.
  const sortKey = (m: MultiConceptResult) => (Number.isFinite(m.averageSimilarity) ? m.averageSimilarity : -Infinity);
  return matches.sort((a, b) => sortKey(b) - sortKey(a));
}

/**
 * One ranking out of the two sides of a multi-concept search, by reciprocal rank fusion (the same constant
 * as the single-query merge), cut to `limit`. Both lists come best first. A conversation on both lists adds
 * its two scores and is listed once, as its keyword match (the exchange that has every word is the place to
 * read). Equal scores — the same rank on each list — put the keyword match first.
 * They used to be concatenated, keyword matches first: `limit` keyword matches left no room for any
 * semantic match, however close.
 */
function fuseConceptMatches(
  keyword: MultiConceptResult[],
  semantic: MultiConceptResult[],
  limit: number,
): MultiConceptResult[] {
  const fused = new Map<string, { result: MultiConceptResult; score: number }>();
  keyword.forEach((result, rank) => {
    fused.set(result.exchange.archivePath, { result, score: 1 / (RRF_K + rank + 1) });
  });
  semantic.forEach((result, rank) => {
    const score = 1 / (RRF_K + rank + 1);
    const hit = fused.get(result.exchange.archivePath);
    if (hit) hit.score += score;
    else fused.set(result.exchange.archivePath, { result, score });
  });
  // Stable sort: at equal score the keyword match (inserted first) stays ahead.
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.result);
}

/**
 * Conversations that match ALL concepts, at most `limit`, in one ranking (fuseConceptMatches) of
 *  - exchanges that contain every word of every concept (keyword index), nearest to the concepts first, and
 *  - conversations in which every concept has a semantically near exchange, by average similarity.
 * The second alone — intersecting each concept's nearest 5×limit exchanges — returned nothing on a large
 * index even when dozens of exchanges contained all the words (the lists rarely share a conversation).
 */
export async function searchMultipleConcepts(
  concepts: string[],
  options: Omit<SearchOptions, 'mode'> = {}
): Promise<MultiConceptResult[]> {
  const { limit = 10 } = options;

  if (concepts.length === 0) {
    return [];
  }

  // Search for each concept independently
  const conceptResults = await Promise.all(
    concepts.map(concept => searchConversations(concept, { ...options, limit: limit * 5, mode: 'vector' }))
  );

  // Build map of conversation path -> array of results (one per concept)
  const conversationMap = new Map<string, Array<SearchResult & { conceptIndex: number }>>();

  conceptResults.forEach((results, conceptIndex) => {
    results.forEach(result => {
      const key = result.exchange.archivePath;
      if (!conversationMap.has(key)) {
        conversationMap.set(key, []);
      }
      conversationMap.get(key)!.push({ ...result, conceptIndex });
    });
  });

  // Find conversations that match ALL concepts
  const multiConceptResults: MultiConceptResult[] = [];

  for (const [, results] of conversationMap.entries()) {
    // Check if all concepts are represented
    const representedConcepts = new Set(results.map(r => r.conceptIndex));
    if (representedConcepts.size === concepts.length) {
      // All concepts found in this conversation
      const conceptSimilarities = concepts.map((_concept, index) => {
        const result = results.find(r => r.conceptIndex === index);
        return result?.similarity || 0;
      });

      const averageSimilarity = conceptSimilarities.reduce((sum, sim) => sum + sim, 0) / conceptSimilarities.length;

      // Use the first result's exchange data (they're all from the same conversation)
      const firstResult = results[0];

      multiConceptResults.push({
        exchange: firstResult.exchange,
        snippet: firstResult.snippet,
        conceptSimilarities,
        averageSimilarity,
        matchedBy: 'semantic',
      });
    }
  }

  // Sort by average similarity (highest first)
  multiConceptResults.sort((a, b) => b.averageSimilarity - a.averageSimilarity);

  // Both sides in one ranking, cut to the limit.
  const keywordResults = await keywordConceptMatches(concepts, options, limit);
  return fuseConceptMatches(keywordResults, multiConceptResults, limit);
}

// === Knowledge Graph Enhanced Search ===

export interface KnowledgeContext {
  facts: Array<{
    fact: string;
    category: string;
    domain: string;
    categoryName: string;
    similarity: number;
    relatedFacts: Array<{
      fact: string;
      relationType: string;
    }>;
    /** Neighbours not listed in relatedFacts (the per-fact cap). */
    relatedOmitted?: number;
  }>;
}

/** Characters of a fact in the Related Knowledge section — the full text is one search_facts away. */
export const KNOWLEDGE_FACT_CHARS = 300;

/**
 * Enrich search results with knowledge graph context.
 * Finds related facts from the ontology and expands via graph traversal.
 */
export async function getKnowledgeContext(
  query: string,
  project?: string | null,
  limit: number = 5,
): Promise<KnowledgeContext> {
  await initEmbeddings();
  // The cached search connection, never a fresh initDatabase(): that ran the
  // migration pass (incl. a dedup DELETE — a write) on every MCP search, so a
  // worker holding the write lock stalled the search 5s and then dropped this
  // section. Owned by getSearchDb — do not close it here.
  const db = getSearchDb();

  const queryEmbedding = await generateEmbedding(query, 'query');
  const factResults = searchSimilarFacts(db, queryEmbedding, project ?? null, limit, 0.6);

  if (factResults.length === 0) {
    return { facts: [] };
  }

  // Category + domain for just the hit facts (not every category in the DB).
  const categoryStmt = db.prepare(`
    SELECT c.name AS categoryName, d.name AS domainName
    FROM ontology_categories c LEFT JOIN ontology_domains d ON d.id = c.domain_id
    WHERE c.id = ?
  `);

  const enrichedFacts: KnowledgeContext['facts'] = [];

  for (const { fact, distance } of factResults) {
    const similarity = parseFloat(l2DistanceToSimilarity(distance).toFixed(3));
    const catInfo = fact.ontology_category_id
      ? categoryStmt.get(fact.ontology_category_id) as { categoryName: string; domainName: string | null } | undefined
      : undefined;
    const domainName = catInfo ? (catInfo.domainName ?? 'Unclassified') : 'Unclassified';
    const catName = catInfo ? catInfo.categoryName : 'Unclassified';

    // Expand via 1-hop graph traversal — a few neighbours, short (a hub fact has had 106 of them, 76K chars).
    const related = summarizeRelated(getRelatedFacts(db, fact.id, 1));
    const relatedFacts = related.shown.map((line) => ({
      fact: line.text,
      relationType: line.relationType,
    }));

    enrichedFacts.push({
      fact: clipLine(fact.fact, KNOWLEDGE_FACT_CHARS),
      category: fact.category,
      domain: domainName,
      categoryName: catName,
      similarity,
      relatedFacts,
      relatedOmitted: related.omitted,
    });
  }

  return { facts: enrichedFacts };
}

/**
 * Format knowledge context as a readable section appended to search results.
 */
export function formatKnowledgeContext(context: KnowledgeContext): string {
  if (context.facts.length === 0) return '';

  let output = '\n---\n**Related Knowledge (from past decisions):**\n\n';

  for (const fact of context.facts) {
    output += `- **[${fact.domain}/${fact.categoryName}]** ${fact.fact} _(${fact.category}, ${Math.round(fact.similarity * 100)}% relevant)_\n`;
    for (const rel of fact.relatedFacts) {
      output += `  - ${rel.relationType}: ${rel.fact}\n`;
    }
    if (fact.relatedOmitted) {
      output += `  - _…and ${fact.relatedOmitted} more related facts_\n`;
    }
  }

  return output;
}

export async function formatMultiConceptResults(
  results: MultiConceptResult[],
  concepts: string[]
): Promise<string> {
  if (results.length === 0) {
    return `No conversations found matching all concepts: ${concepts.join(', ')}`;
  }

  let output = `Found ${results.length} conversation${results.length > 1 ? 's' : ''} matching all concepts [${concepts.join(' + ')}]:\n\n`;

  // Process results sequentially to get file metadata
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    // A keyword match whose exchange has no vector row has no similarity (NaN): shown as n/a, never as 0%.
    const pct = (value: number) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a');
    const avgPct = pct(result.averageSimilarity);

    // Header: how it matched, with the average semantic similarity
    output += result.matchedBy === 'keyword'
      ? `${index + 1}. [${result.exchange.project}, ${date}] - every word in one exchange (${avgPct} avg semantic)\n`
      : `${index + 1}. [${result.exchange.project}, ${date}] - ${avgPct} avg match\n`;

    // Show individual concept scores
    const scores = result.conceptSimilarities
      .map((sim, i) => `${concepts[i]}: ${pct(sim)}`)
      .join(', ');
    output += `   Concepts: ${scores}\n`;

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    // Get file metadata
    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const totalLines = await countLines(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;

    // File information with metadata (clean format for smart tool selection)
    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ${totalLines} lines)\n\n`;
  }

  return output;
}

