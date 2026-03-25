/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 */
export declare function importFromSync(): Promise<{
    newFacts: number;
    newDomains: number;
    newCategories: number;
    newRelations: number;
}>;
