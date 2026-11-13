import type Database from 'better-sqlite3';
/**
 * Output of the `search_ontology` tool.
 *
 * The tool used to print every fact of every category — 8.7 million characters without a filter on the
 * live DB, up to 1.6 million with a domain filter. It now answers in levels: no filter → domains and their
 * largest categories with fact counts; a `category` filter (or facts_per_category) → the top facts of the
 * matching categories. Every level is bounded (categories per domain, facts per category, characters per
 * fact, characters in total) and says what it left out and which filter reaches it.
 */
/** Most characters one answer carries, closing note included. */
export declare const ONTOLOGY_MAX_OUTPUT_CHARS = 20000;
/** Characters of one fact line — the full text is one search_facts away. */
export declare const ONTOLOGY_FACT_CHARS = 300;
/** Facts shown per category when a `category` filter is given and facts_per_category is not. */
export declare const ONTOLOGY_DEFAULT_FACTS_PER_CATEGORY = 5;
/** Categories listed per domain: in the overview / when a `domain` filter drills into one / with facts. */
export declare const ONTOLOGY_DEFAULT_CATEGORIES_OVERVIEW = 8;
export declare const ONTOLOGY_DEFAULT_CATEGORIES_DOMAIN = 200;
export declare const ONTOLOGY_DEFAULT_CATEGORIES_WITH_FACTS = 20;
/** Largest max_categories the tool accepts. A domain with more is paged with category_offset. */
export declare const ONTOLOGY_MAX_CATEGORIES = 200;
export interface OntologyBrowseParams {
    domain?: string;
    category?: string;
    include_relations?: boolean;
    /** Facts shown per category (0 = names and counts only). Default: 5 with a `category` filter, else 0. */
    facts_per_category?: number;
    /** Categories listed per domain, largest first. Default: 8 (200 with a `domain` filter) without facts, 20 with. */
    max_categories?: number;
    /** Categories to skip per domain (largest first) — lists the ones behind max_categories. Default 0. */
    category_offset?: number;
}
/** `locale`: the order of equally large names is the reading session's, not this process's (undefined = the process default). */
export declare function formatOntologyBrowse(db: Database.Database, params: OntologyBrowseParams, locale?: string): string;
