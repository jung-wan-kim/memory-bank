import { type IndexSessionResult } from './indexer.js';
export interface SessionIndexState {
    exchangeCount: number;
    frontier: number | null;
    lastIndexed: number | null;
}
export interface CompactFreshnessReceipt extends SessionIndexState {
    status: 'fresh' | 'stale';
    reason: string;
}
export interface CompactFreshnessDependencies {
    indexCurrentSession(sessionId: string): Promise<IndexSessionResult>;
    readSessionState(sessionId: string): SessionIndexState;
}
export declare function readSessionIndexState(sessionId: string): SessionIndexState;
export declare function evaluateCompactFreshness(sessionId: string | null | undefined, dependencies?: CompactFreshnessDependencies): Promise<CompactFreshnessReceipt>;
export declare function formatKstTimestamp(timestamp: number | null): string;
export declare function formatCompactFreshnessReceipt(receipt: CompactFreshnessReceipt): string;
