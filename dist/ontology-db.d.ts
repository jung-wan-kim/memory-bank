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
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number): Array<{
    fact: Fact;
    relation: OntologyRelation;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
export declare function getOntologyTree(db: Database.Database): DomainTree[];
