export declare function processBatch<T, R>(items: T[], processor: (item: T) => Promise<R>, concurrency: number): Promise<R[]>;
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
