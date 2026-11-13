export declare function formatConversationAsMarkdown(jsonl: string, startLine?: number, endLine?: number): string;
/** Most characters one `read` call returns (the continuation footer comes on top). */
export declare const READ_MAX_OUTPUT_CHARS = 40000;
/** Longest tool input value / tool result `read` shows before clipping it. */
export declare const READ_MAX_BLOCK_CHARS = 2000;
export interface ConversationRangeOptions {
    /** First line (1-indexed, inclusive) — the physical line numbers search results report. */
    startLine?: number;
    /** Last line (1-indexed, inclusive). */
    endLine?: number;
    /**
     * Characters to skip of the first message the range shows — where an earlier answer stopped inside a
     * message longer than one answer (the value its "Continue with …" line names). Counted in that message's
     * rendered Markdown, under the same `full` setting.
     */
    startChar?: number;
    /** Show tool inputs and results whole instead of clipping each at READ_MAX_BLOCK_CHARS. */
    full?: boolean;
    /** Output ceiling in characters (default READ_MAX_OUTPUT_CHARS). */
    maxChars?: number;
    /**
     * The locale dates and numbers are written in: the reading session's, when a server renders for it.
     * undefined = the default of this process (right when the process is the reader's own).
     */
    locale?: string;
}
/**
 * The `read` tool: Markdown of a line range of an archived conversation, read as a stream (plain or
 * `.zst`) so the cost follows the range and not the file. The output is capped: when the range does not
 * fit, rendering stops at a message boundary and the footer names the startLine to continue from. A
 * message that alone is over the ceiling is shown as far as it fits, and the footer names the startChar to
 * continue from inside it — following the footers reads any range to its end, whatever one message holds.
 * A range outside the file is an error carrying the file's line count — never an empty string.
 */
export declare function readConversationRange(filePath: string, opts?: ConversationRangeOptions): Promise<string>;
export declare function formatConversationAsHTML(jsonl: string, locale?: string): string;
