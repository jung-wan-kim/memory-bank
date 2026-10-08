import { ConversationExchange } from './types.js';
export declare function formatConversationText(exchanges: ConversationExchange[]): string;
/**
 * Written as the summary of a conversation the model declines to summarize.
 * Writing nothing would have sync retry it on every run, and sync summarizes at
 * most `summaryLimit` files per run in directory order — conversations that are
 * declined every time would hold those slots for good. The marker is final:
 * whether a refusal repeats was not measured, and only a rebuild redoes it.
 * Failures that may pass (outage, API error, no result) still throw and write
 * nothing, so they retry.
 */
export declare const REFUSED_SUMMARY = "[No summary: the model declined to summarize this conversation.]";
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
