export declare function getSyncDir(): string;
/**
 * Export facts, ontology domains/categories, and relations to JSONL files.
 * These files are small (~90KB) and safe for cloud sync (cc-sync, iCloud, etc).
 * The local SQLite DB (544MB) should NOT be synced — it's rebuilt from these + JSONL archives.
 */
export declare function exportForSync(): {
    facts: number;
    domains: number;
    categories: number;
    relations: number;
};
