/**
 * Stream the file looking for an exclusion marker, carrying an overlap between
 * chunks so a marker split across a boundary is still found (obra #152).
 * readFileSync(…, 'utf-8') throws ERR_STRING_TOO_LONG above ~512 MB, and the
 * old catch returned false — a large transcript was indexed without its
 * DO NOT INDEX marker ever being read. A read error now fails closed (skip).
 * `.zst` archives are capped by the decompression limit, so they are read whole.
 */
export declare function shouldSkipConversation(filePath: string): boolean;
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
