import Database from 'better-sqlite3';
import type { Fact, FactRevision } from './types.js';
interface InsertFactParams {
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: number[] | null;
    coding_agent?: string;
    fact_kr?: string | null;
    embedding_kr?: number[] | null;
}
interface UpdateFactParams {
    /**
     * New sentence. When it differs from the stored one, the row's fact_kr — a
     * translation of the OLD sentence — does not stay: it becomes `fact_kr` when
     * that is given, and is cleared otherwise, together with its vec_facts_kr
     * row. Pass `embedding` with it: this function does not embed, and a row
     * keeps whatever vector it has.
     */
    fact?: string;
    embedding?: number[] | null;
    /**
     * Korean sentence of the sentence the row holds after this update (null =
     * none). A caller that rewrites `fact` and has the new sentence's Korean one
     * passes it here — a rewritten fact left without one is out of reach of
     * Korean queries (measured: top-10 for 92 of 92 queries before a rewrite, 26
     * after). `embedding_kr` is its vector; given without one, the row's old
     * Korean vector is removed and the re-embed worker builds the new one.
     */
    fact_kr?: string | null;
    embedding_kr?: number[] | null;
    consolidated_count_increment?: boolean;
    /** Confirmations to add — the consolidated_count of a fact merged into this one. */
    consolidated_count_add?: number;
    /** Sources to add (set union, order kept) — the sources of a fact merged into this one. */
    add_source_exchange_ids?: string[];
}
interface InsertRevisionParams {
    fact_id: string;
    previous_fact: string;
    new_fact: string;
    reason: string | null;
    source_exchange_id: string | null;
}
export declare function insertFact(db: Database.Database, params: InsertFactParams): string;
export declare function getActiveFacts(db: Database.Database): Fact[];
/** The fact as it is stored now, or null when it is gone or inactive. */
export declare function getActiveFact(db: Database.Database, id: string): Fact | null;
export declare function getFactsByProject(db: Database.Database, project: string): Fact[];
export declare function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void;
/**
 * A fact's Korean sentence with its stored Korean vector (decoded, see
 * storedFactVector), or null when the fact has no Korean sentence. `vector` is
 * null when the sentence has no vec_facts_kr row — always the case for an
 * inactive fact (deactivateFact removes it).
 */
export declare function getFactKorean(db: Database.Database, id: string): {
    text: string;
    vector: number[] | null;
} | null;
/**
 * Write a fact's Korean sentence and its vector, leaving the fact itself as it
 * is — `updated_at` included (a translation filled in later is not a change of
 * the fact; getTopFacts ranks by how recently a fact changed).
 */
export declare function setFactKorean(db: Database.Database, id: string, text: string, vector: number[]): void;
/**
 * Make sure facts.content_at exists. false when it does not and cannot be
 * added: a read-only handle or an old DB (remembered for the handle), or
 * another process holding the write lock right now (not remembered).
 */
export declare function ensureFactContentAtColumn(db: Database.Database): boolean;
/**
 * Content time of each given fact that exists: content_at, else created_at.
 * `hasColumn` is the answer ensureFactContentAtColumn just gave the caller
 * (so a caller that needs the answer itself does not ask twice).
 */
export declare function factContentTimes(db: Database.Database, ids: string[], hasColumn?: boolean): Map<string, string>;
/** Move a fact's content time forward to `time` (never back). A no-op on a store without the column. */
export declare function raiseFactContentTime(db: Database.Database, id: string, time: string): void;
export declare function deactivateFact(db: Database.Database, id: string): void;
export declare function deleteFact(db: Database.Database, id: string): void;
export declare function insertRevision(db: Database.Database, params: InsertRevisionParams): string;
export declare function getRevisions(db: Database.Database, factId: string): FactRevision[];
/** Options of searchSimilarFacts that only the injection selection (and its replay bench) passes. */
export interface FactSearchOptions {
    /** Widen the project scope to the repository family (project-family.ts). */
    scopeFamily?: boolean;
    /**
     * Replay bench only: which vector rows existed at the replayed moment. Applied
     * BEFORE the overfetch cut, so the cut sees the same top rows the index held
     * then (rows added later cannot crowd them out).
     */
    visibleId?: (id: string) => boolean;
}
export declare function searchSimilarFacts(db: Database.Database, embedding: number[], project: string | null, limit?: number, threshold?: number, opts?: FactSearchOptions): Array<{
    fact: Fact;
    distance: number;
}>;
/**
 * Distance from `embedding` to one fact's stored vectors: the smaller of its
 * English and Korean vectors — the same rule the KNN above ranks by (it keeps
 * the best distance per id across both tables), normalized for int8 tables.
 * null when the fact has no vector of the current embedding version.
 */
export declare function factVectorDistance(db: Database.Database, factId: string, embedding: number[]): number | null;
export interface SameScopeSearchOptions {
    /**
     * Called when the search stopped at the KNN k limit with fewer than `limit`
     * results while rows above the threshold were still unread — in-scope
     * matches farther than the nearest `k` rows were not examined.
     */
    onCapReached?: (info: {
        k: number;
        found: number;
    }) => void;
    /**
     * Also search with this fact's own stored Korean vector (its vec_facts_kr
     * row, when it has one). `embedding` is one language's vector, and a
     * multilingual model scores cross-language pairs well below same-language
     * ones (measured on live facts: 0.93 against 0.99) — an English sentence's
     * vector does not reach the same fact written in Korean, its Korean
     * translation's vector does. Each fact keeps its best distance over both.
     */
    krVectorOfFactId?: string;
}
/**
 * Nearest active facts restricted to EXACTLY one scope — used by consolidation
 * so a project-private fact and a global fact can never be compared/merged
 * across the boundary (which would leak private text into global memory or let
 * one project mutate shared global facts). The scope filter is applied to the
 * FULL overfetched candidate list BEFORE truncation, so a same-scope match is
 * not starved out by closer out-of-scope rows (which the general
 * searchSimilarFacts truncates first).
 *
 * scope: { type:'global' } → global facts only.
 *        { type:'project', project } → that project's own facts only (no global).
 *
 * Paging ends as soon as nothing further can pass: a KNN returns rows nearest
 * first, so once a table's last returned row is below `threshold` every row
 * behind it is too. k never exceeds VEC0_KNN_K_MAX — when more rows than that
 * pass the threshold and fewer than `limit` of the nearest ones are in scope,
 * the search returns what those nearest rows held (not a throw, not []) and
 * reports it through `opts.onCapReached`.
 */
export declare function searchSimilarFactsSameScope(db: Database.Database, embedding: number[], scope: {
    type: 'global';
} | {
    type: 'project';
    project: string;
}, limit?: number, threshold?: number, opts?: SameScopeSearchOptions): Array<{
    fact: Fact;
    distance: number;
}>;
/** Global facts in the session-start block: at most this many of `limit`; the other slots are the project's. */
export declare const TOP_FACTS_GLOBAL_MAX = 3;
/** MEMORY_BANK_KEY_FACTS_GLOBAL_MAX: a non-negative integer; anything else is the default. */
export declare function topFactsGlobalMax(raw: string | undefined): number;
/**
 * The facts of the session-start "Project Key Facts" block: the project's first,
 * then at most `globalMax` global ones.
 *
 * - Project = the repository family of `rawProject` (scopeMatcher, the predicate
 *   the per-prompt injection uses): a session in a sub-folder or a linked worktree
 *   gets the repository's facts, the repository gets its worktrees'. A path
 *   outside any repository sees its exact scope only, as before.
 * - Slots: global facts take min(globalMax, limit) slots at most, project facts
 *   the rest. A slot the global side cannot fill goes to the project; a slot the
 *   project cannot fill stays empty — the cap on global facts is a cap. (Before,
 *   the two sides competed on one score and the final order was by score: every
 *   project opened with the same heavily-merged global facts.)
 * - Score, within each side: count term 3 × (1 + log2(min(consolidated_count,
 *   TOP_FACTS_COUNT_CAP) + 1)), recency 5 / 3 / 1 / 0 for updated within 7 / 30 /
 *   90 days / older, and +2 for a fact scoped to exactly this cwd (ahead of the
 *   rest of its family).
 * - Ties: most recently updated first, then id — a total order, so the same rows
 *   give the same block. 96.6% of project facts have count 1 (measured), so most
 *   of the project side is decided here; without it the cut among equals was
 *   whatever order SQLite happened to return.
 */
export declare function getTopFacts(db: Database.Database, rawProject: string, limit?: number, opts?: {
    globalMax?: number;
}): Fact[];
/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export declare function getTopFactsByCount(db: Database.Database, project: string, limit?: number): Fact[];
export declare function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[];
/**
 * All active facts after a KEYSET cursor `(createdAt, id)`, EVERY scope/project,
 * each row once, ordered by (created_at, id). The composite key is what makes
 * the consolidate cursor strictly monotonic PER FACT: ordering by created_at
 * alone stalls when a whole timestamp group is larger than the per-run budget
 * (the cursor can't advance into a shared timestamp without risking a skip), so
 * `id` is the unique tiebreaker that lets the drain progress one fact at a time.
 *
 * cursor null → from the beginning (all active facts).
 *
 * `notAfter` (an ISO time, the drain passes "now") leaves out facts dated
 * later than it. A fact stamped while the clock was ahead sorts after every
 * fact created since: driving it moved the cursor ahead of the clock, and from
 * then on nothing created at the real time was pending. Such a fact waits
 * until its time comes; it stays a similarity candidate meanwhile.
 *
 * KNOWN LIMITATION (best-effort dedup): a fact IMPORTED mid-drain with an old
 * `created_at` that sorts before the current cursor is not re-driven by this
 * pass (it's still a similarity CANDIDATE for future facts, so a duplicate is
 * still caught opportunistically). Consolidation is a background convenience,
 * not an exhaustive guarantee, so this is accepted rather than adding a
 * full re-scan on every import.
 */
export declare function getAllNewFactsSince(db: Database.Database, cursor: {
    createdAt: string;
    id: string;
} | null, limit?: number, notAfter?: string): Fact[];
/** Active facts dated later than `after` (an ISO time) — the ones a drain bounded at that time leaves alone. */
export declare function countFactsDatedAfter(db: Database.Database, after: string): number;
/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export declare function searchAllFacts(db: Database.Database, embedding: number[], limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
/** sqlite-vec's ceiling for one KNN (`LIMIT`/k above it is refused). */
export declare const FACT_KNN_MAX = 4096;
export interface FilteredFactSearch {
    /** The project whose facts (plus global facts) are in scope; null = every scope. */
    project: string | null;
    /**
     * 'in-scope' (default): the project's facts and global facts.
     * 'other-projects': project-scoped facts of projects OTHER than `project` (cross-project insights).
     */
    scope?: 'in-scope' | 'other-projects';
    limit?: number;
    threshold?: number;
    /** A further condition on the fact (category, agent, tags …). */
    filter?: (fact: Fact) => boolean;
    /** Fold facts whose sentence is identical (whitespace and case ignored) into the best-ranked one. */
    foldSameText?: boolean;
}
export interface FilteredFactHit {
    fact: Fact;
    distance: number;
    /** Ids of the other facts that carry the same sentence (foldSameText), best-ranked first. */
    duplicateIds: string[];
}
/**
 * Nearest facts under conditions that are applied BEFORE the cut to `limit`.
 *
 * searchSimilarFacts takes a fixed number of candidates (max(limit×2, 50) per table) and filters after
 * it; the MCP tools then filtered once more after ITS cut. A project whose facts sat behind other
 * projects' facts, or a category filter, came back with a few rows or none while matching facts existed
 * (measured: 3 returned of 14 in scope; `category=decision` → 0 with 2 in the top 50). Here the candidate
 * list grows ×4 until `limit` facts pass every condition, the indexes run out, the similarity threshold is
 * crossed, or the sqlite-vec ceiling is reached — and `truncated` says when it was the ceiling.
 * Both language indexes are searched (the best distance per fact wins), like searchSimilarFacts.
 */
export declare function searchFactsFiltered(db: Database.Database, embedding: number[], opts: FilteredFactSearch): {
    results: FilteredFactHit[];
    examined: number;
    truncated: boolean;
};
/** Max characters in one tag. Long enough for "needs-verification", short
 *  enough that a tag stays a label rather than a sentence. */
export declare const MAX_TAG_LENGTH = 64;
/** Max tags on one fact. Bounds the JSON column and keeps LIKE scans cheap. */
export declare const MAX_TAGS_PER_FACT = 32;
/**
 * Normalize one user-supplied tag: trim, collapse inner whitespace to '-',
 * lowercase. Returns null when the result is empty, too long, or contains a
 * disallowed character — callers must treat null as "reject", never as "skip
 * silently", so a typo surfaces instead of vanishing.
 */
export declare function normalizeTag(raw: string): string | null;
/**
 * Parse the stored tags column. A row written by this module is always valid
 * JSON; a row hand-edited via sqlite3 may not be. Rather than throwing inside
 * every read path (which would take down search for one bad row), an
 * unparseable value degrades to [] — the fact stays fully searchable, it just
 * shows no tags. Use `memory-bank tags --verify` to find such rows.
 */
export declare function parseTags(raw: unknown): string[];
/** Tags currently on a fact. Throws when the fact does not exist. */
export declare function getFactTags(db: Database.Database, factId: string): string[];
/**
 * Add tags to a fact (set union, order-stable). Rejects the whole call when any
 * input tag is invalid or the result would exceed MAX_TAGS_PER_FACT — a partial
 * apply would leave the user unsure which tags landed.
 */
export declare function addFactTags(db: Database.Database, factId: string, rawTags: string[]): {
    tags: string[];
    added: string[];
};
/** Remove tags from a fact. Tags that were not present are reported, not an error. */
export declare function removeFactTags(db: Database.Database, factId: string, rawTags: string[]): {
    tags: string[];
    removed: string[];
    absent: string[];
};
/** Replace a fact's tags wholesale. Passing [] clears them. */
export declare function setFactTags(db: Database.Database, factId: string, rawTags: string[]): string[];
/**
 * All tags in use with their fact counts, most used first. Scans only rows that
 * actually carry tags, so cost tracks tagged facts rather than total facts.
 */
export declare function listTags(db: Database.Database, opts?: {
    project?: string;
    includeInactive?: boolean; /** Order of equally frequent tags: the reading session's locale (undefined = the process default). */
    locale?: string;
}): Array<{
    tag: string;
    count: number;
}>;
/**
 * Facts carrying the given tags. `match: 'all'` (default) requires every tag,
 * 'any' requires at least one. Matching is done on the JSON text with the
 * surrounding quotes included, so "api" never matches "api-v2".
 */
export declare function findFactsByTags(db: Database.Database, rawTags: string[], opts?: {
    project?: string;
    match?: 'all' | 'any';
    limit?: number;
    includeInactive?: boolean;
}): Fact[];
export {};
