export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
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
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
