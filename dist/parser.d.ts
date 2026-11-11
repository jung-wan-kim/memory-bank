import { ConversationExchange } from './types.js';
/** Optional taps on the single pass parseConversation makes over the file. */
export interface ParseObserver {
    /**
     * Called with the text of EVERY user message (string content or its text
     * blocks — never tool results), including ones that end up in no exchange
     * because no assistant message follows them.
     */
    userText?: (text: string) => void;
}
export declare function parseConversation(filePath: string, projectName: string, archivePath: string, observer?: ParseObserver): Promise<ConversationExchange[]>;
/**
 * Convenience function to parse a conversation file
 * Extracts project name from the file path and returns exchanges with metadata
 */
export declare function parseConversationFile(filePath: string): Promise<{
    project: string;
    exchanges: ConversationExchange[];
}>;
