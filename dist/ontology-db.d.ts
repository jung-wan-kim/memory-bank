import Database from 'better-sqlite3';
import type { OntologyDomain, OntologyCategory, OntologyRelation, RelationType, DomainTree, Fact } from './types.js';
export declare function createDomain(db: Database.Database, name: string, description?: string): OntologyDomain;
export declare function listDomains(db: Database.Database): OntologyDomain[];
export declare function getDomain(db: Database.Database, id: string): OntologyDomain | null;
export declare function getDomainByName(db: Database.Database, name: string): OntologyDomain | null;
export declare function createCategory(db: Database.Database, domainId: string, name: string, description?: string): OntologyCategory;
export declare function listCategories(db: Database.Database, domainId?: string): OntologyCategory[];
export declare function getCategoryByName(db: Database.Database, name: string, domainId?: string): OntologyCategory | null;
export declare function classifyFact(db: Database.Database, factId: string, categoryId: string): void;
export declare function getFactsByCategory(db: Database.Database, categoryId: string): Fact[];
export declare function getFactsByDomain(db: Database.Database, domainId: string): Fact[];
export declare function createRelation(db: Database.Database, sourceFactId: string, relationType: RelationType, targetFactId: string, reasoning?: string): OntologyRelation;
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
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number, decay?: number, minRelevance?: number, scopeProject?: string | null): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
export declare function getOntologyTree(db: Database.Database): DomainTree[];
