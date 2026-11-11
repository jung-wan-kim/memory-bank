import Database from 'better-sqlite3';
import type { OntologyDomain, OntologyCategory, OntologyRelation, RelationType, DomainTree, Fact } from './types.js';
export declare function createDomain(db: Database.Database, name: string, description?: string): OntologyDomain;
export declare function listDomains(db: Database.Database): OntologyDomain[];
export declare function getDomain(db: Database.Database, id: string): OntologyDomain | null;
export declare function getDomainByName(db: Database.Database, name: string): OntologyDomain | null;
/**
 * Identity of a domain/category name: NFKC, lower case, "&" read as "and",
 * every other character that is not a letter or digit dropped. "Memory-Bank
 * Architecture", "memory bank architecture" and "MemoryBank  Architecture" are
 * one name; "CI/CD" and "CI CD" are one name.
 *
 * Why: lookups were an exact match (NOCASE), so the classifier's spelling
 * variants of one name became separate rows — 792 names existed under several
 * domains (1,974 rows) and 44 pairs inside one domain (live DB, 2026-11-10).
 *
 * The stored `ontology_categories.name_key` is this function's output. Changing
 * the rule means rebuilding the column (`UPDATE ontology_categories SET
 * name_key = NULL` — the next lookup refills it).
 */
export declare function ontologyNameKey(name: string): string;
/**
 * Looser identity, for one use only: the model said it was reusing a category
 * but spelled no existing name (classifier, `is_new_category: false`). Also
 * folds a plural "s", the word "and" and word order — "State Managements" and
 * "Management State" both mean "State Management". Too loose for general
 * lookups; compared only against the candidates shown for that fact.
 */
export declare function looseOntologyNameKey(name: string): string;
/**
 * Idempotent migration of `ontology_categories.name_key` (+ its index), run by
 * the category lookups below rather than initDatabase(): only code that writes
 * the taxonomy needs it. Every call also fills rows whose key is NULL — a
 * process running older code and the sync import insert categories without
 * the column, and such a row must not stay invisible to the lookup (it would
 * be created a second time). With the index that check is one probe.
 *
 * Returns how many rows were filled.
 */
export declare function ensureCategoryNameKeys(db: Database.Database): number;
/** A category with the number of active facts filed under it. */
export interface CategoryUsage extends OntologyCategory {
    active_facts: number;
}
/**
 * Every category whose name has this key (in one domain when `domainId` is
 * given), most used first: active facts, then the oldest row, then id. The
 * order is the tie-break wherever one name has several rows — the first row is
 * the one a lookup returns and new facts go to, so the same name resolves to
 * the same row on every call.
 */
export declare function findCategoriesByNameKey(db: Database.Database, key: string, domainId?: string): CategoryUsage[];
/**
 * Active fact count per category id (ids with no facts are absent).
 *
 * `+is_active`, here and in the other statements of this file that name a
 * category next to it: an older process sharing the database re-creates
 * idx_facts_active(is_active) and this version leaves it for hours (db.ts,
 * FACTS_ACTIVE_INDEX_REDROP_MS). With no table statistics the planner then
 * answers `ontology_category_id = ? AND is_active = 1` from that two-valued
 * index — every active fact read per call, and classification calls this for
 * each candidate category of each saved fact (measured at 30,584 active
 * facts: 29-51ms a call against under 0.1ms through idx_facts_ontology; one
 * extraction run that saved 6 facts took 9.3s instead of 2.1s). The unary
 * plus keeps the term out of index selection; the rows counted are the same.
 */
export declare function activeFactCounts(db: Database.Database, categoryIds: string[]): Map<string, number>;
/**
 * Create a category, or return the one this domain already has under the same
 * name key — idempotent on (domain, key) the way createRelation is on its
 * triple. The lookup and the insert share one write transaction, so two
 * processes classifying at once cannot both insert the name. (No UNIQUE index
 * enforces this: 44 pairs of same-name rows inside one domain predate the key
 * and are not merged here.)
 */
export declare function createCategory(db: Database.Database, domainId: string, name: string, description?: string): OntologyCategory;
export declare function listCategories(db: Database.Database, domainId?: string): OntologyCategory[];
/**
 * The category of this name (by ontologyNameKey — case, spacing and
 * punctuation do not matter), inside one domain when `domainId` is given.
 * Several rows can carry one name (see createCategory); the most used one is
 * returned, the same row on every call.
 */
export declare function getCategoryByName(db: Database.Database, name: string, domainId?: string): OntologyCategory | null;
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export declare function upsertCategoryEmbedding(db: Database.Database, categoryId: string, embedding: number[]): void;
export declare function deleteCategoryEmbedding(db: Database.Database, categoryId: string): void;
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export declare function searchSimilarCategories(db: Database.Database, embedding: number[], k?: number): Array<{
    category: OntologyCategory;
    domainName: string;
    distance: number;
}>;
export declare function classifyFact(db: Database.Database, factId: string, categoryId: string): void;
export declare function getFactsByCategory(db: Database.Database, categoryId: string): Fact[];
export declare function getFactsByDomain(db: Database.Database, domainId: string): Fact[];
/** createRelation declined to write a relation that cannot be true (see createRelation). */
export declare class RelationRefusedError extends Error {
    readonly reason: 'self-relation' | 'supersedes-cycle';
    constructor(reason: 'self-relation' | 'supersedes-cycle', detail: string);
}
export declare function createRelation(db: Database.Database, sourceFactId: string, relationType: RelationType, targetFactId: string, reasoning?: string): OntologyRelation;
/** True when `sourceFactId SUPERSEDES targetFactId` is stored. */
export declare function hasSupersedes(db: Database.Database, sourceFactId: string, targetFactId: string): boolean;
/** Options of getRelatedFacts that only the injection selection (and its replay bench) passes. */
export interface RelatedFactsOptions {
    /** Widen scopeProject to its repository family (project-family.ts). */
    scopeFamily?: boolean;
    /** Replay bench only: facts that existed at the replayed moment. */
    visibleFact?: (id: string) => boolean;
    /** Replay bench only: relations that existed at the replayed moment. */
    visibleRelation?: (relation: OntologyRelation) => boolean;
}
/**
 * Get related facts with relevance decay.
 *
 * Each hop reduces relevance by the decay factor:
 * - hop 0 (direct): relevance = 1.0
 * - hop 1: relevance = decay (default 0.6)
 * - hop 2: relevance = decay^2 (default 0.36)
 *
 * Results are sorted by relevance descending.
 * Facts below minRelevance are pruned.
 */
/**
 * @param scopeProject - If provided, only return facts from this project or global scope.
 *                       Prevents cross-project noise in graph traversal.
 *                       Pass null/undefined to allow cross-project traversal (e.g., explore_graph).
 */
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number, decay?: number, minRelevance?: number, scopeProject?: string | null, opts?: RelatedFactsOptions): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
/** What getOntologyTree returns: everything by default, or a filtered / fact-capped view. */
export interface OntologyTreeOptions {
    /** Keep domains whose name contains this (case-insensitive for ASCII; `%` and `_` are literal). */
    domain?: string;
    /** Keep categories whose name contains this (same matching). Domains left with no category are dropped. */
    category?: string;
    /** Keep only these categories. */
    categoryIds?: string[];
    /** Facts loaded per category, most confirmed first. Omitted = every active fact; 0 = counts only. */
    factsPerCategory?: number;
}
/**
 * Domain → category → active facts, with each category's active-fact total (`factCount`).
 *
 * Two statements whatever the size of the ontology: one aggregate JOIN for the tree and the counts, one
 * ranked query for the facts. It used to run one facts query per category, and with no table statistics
 * the planner served each of them from the two-valued idx_facts_active — every active fact was visited
 * once per category (7,146 categories × 30K facts on the live DB: minutes, with the MCP server blocked).
 * The unary plus on is_active keeps that index out of the plan; facts are reached through
 * idx_facts_ontology (ontology_category_id).
 */
export declare function getOntologyTree(db: Database.Database, opts?: OntologyTreeOptions): DomainTree[];
