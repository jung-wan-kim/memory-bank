export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    pruned: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
    codingAgent?: string;
}
/** Delete archived copies (plain or compressed) whose mtime is older than the policy window. */
export declare function pruneArchive(archiveDir: string, now?: number, policy?: import("./paths.js").RetentionPolicy): number;
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
