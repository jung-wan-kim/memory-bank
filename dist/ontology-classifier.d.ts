import Database from 'better-sqlite3';
import type { Fact } from './types.js';
import { generateEmbedding } from './embeddings.js';
export declare function classifyFactToOntology(db: Database.Database, fact: Fact): Promise<{
    domainId: string;
    categoryId: string;
}>;
export declare function detectRelations(db: Database.Database, newFact: Fact, topK?: number): Promise<void>;
export declare function classifyAndLinkFact(db: Database.Database, factId: string, embedding?: number[]): Promise<void>;
export { generateEmbedding };
