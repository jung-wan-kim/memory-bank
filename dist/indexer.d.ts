export declare function processBatch<T, R>(items: T[], processor: (item: T) => Promise<R>, concurrency: number): Promise<R[]>;
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
export type IndexSessionResult = {
    status: 'indexed';
    sessionId: string;
    startedAt: number;
    sourcePath: string;
    expectedExchangeCount: number;
    expectedFrontier: number;
} | {
    status: 'not_found' | 'no_indexable_exchanges';
    sessionId: string;
    startedAt: number;
    sourcePath?: string;
};
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<IndexSessionResult>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
