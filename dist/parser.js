import readline from 'readline';
import crypto from 'crypto';
import { createArchiveReadStream } from './archive-io.js';
export async function parseConversation(filePath, projectName, archivePath) {
    const exchanges = [];
    const fileStream = createArchiveReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });
    let lineNumber = 0;
    let currentExchange = null;
    const finalizeExchange = () => {
        if (currentExchange && currentExchange.assistantMessages.length > 0) {
            const exchangeId = crypto
                .createHash('md5')
                .update(`${archivePath}:${currentExchange.userLine}-${currentExchange.lastAssistantLine}`)
                .digest('hex');
            // Update tool call exchange IDs
            const toolCalls = currentExchange.toolCalls.map(tc => ({
                ...tc,
                exchangeId
            }));
            const exchange = {
                id: exchangeId,
                project: projectName,
                timestamp: currentExchange.timestamp,
                userMessage: currentExchange.userMessage,
                assistantMessage: currentExchange.assistantMessages.join('\n\n'),
                archivePath,
                lineStart: currentExchange.userLine,
                lineEnd: currentExchange.lastAssistantLine,
                parentUuid: currentExchange.parentUuid,
                isSidechain: currentExchange.isSidechain,
                sessionId: currentExchange.sessionId,
                cwd: currentExchange.cwd,
                gitBranch: currentExchange.gitBranch,
                claudeVersion: currentExchange.claudeVersion,
                thinkingLevel: currentExchange.thinkingLevel,
                thinkingDisabled: currentExchange.thinkingDisabled,
                thinkingTriggers: currentExchange.thinkingTriggers,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined
            };
            exchanges.push(exchange);
        }
    };
    for await (const line of rl) {
        lineNumber++;
        try {
            const parsed = JSON.parse(line);
            // Skip non-message types
            if (parsed.type !== 'user' && parsed.type !== 'assistant') {
                continue;
            }
            if (!parsed.message) {
                continue;
            }
            // Extract text from message content
            let text = '';
            const toolCalls = [];
            if (typeof parsed.message.content === 'string') {
                text = parsed.message.content;
            }
            else if (Array.isArray(parsed.message.content)) {
                // Extract text blocks
                const textBlocks = parsed.message.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text);
                text = textBlocks.join('\n');
                // Extract tool use blocks
                if (parsed.message.role === 'assistant') {
                    let blockIndex = 0;
                    for (const block of parsed.message.content) {
                        blockIndex++;
                        if (block.type === 'tool_use') {
                            // The transcript's own tool_use id (toolu_…), so tool_calls is a set
                            // keyed by call: Claude Code writes the same tool_use on several
                            // lines (measured: 212 lines for 106 calls), and a random id per
                            // parse stored every line, on every re-index — 95.8% of 15.4M rows
                            // were copies. INSERT OR REPLACE on this id keeps one row per call,
                            // and two real calls with identical input stay two rows. Scoped to
                            // the archive: a resumed or forked session copies earlier messages
                            // into a new transcript, and a bare toolu_ id would move the row
                            // out of the original conversation. Lines without an id get a
                            // stable one from their position.
                            const callKey = typeof block.id === 'string' && block.id
                                ? block.id
                                : `line:${lineNumber}:${blockIndex}`;
                            const toolCallId = crypto.createHash('md5').update(`${archivePath}:${callKey}`).digest('hex');
                            toolCalls.push({
                                id: toolCallId,
                                exchangeId: '', // Will be set when we know the exchange ID
                                toolName: block.name || 'unknown',
                                toolInput: block.input,
                                isError: false,
                                timestamp: parsed.timestamp || new Date().toISOString()
                            });
                        }
                    }
                }
                // Tool RESULTS are intentionally not associated back to their tool_use
                // here. The tool_calls table therefore stores tool_name + tool_input
                // only; `tool_result` stays NULL and `is_error` stays 0 for every row.
                // This is fine because NO feature reads those two columns — embeddings
                // include tool NAMES only ("Tools: a, b"), search shows name counts, and
                // the `read` tool returns the raw archive (which has full results). If a
                // future feature needs real result/error data, MATCH tool_result blocks
                // to the preceding tool_use by tool_use_id and populate both columns —
                // do NOT trust the current always-0 `is_error`.
            }
            // Skip empty messages
            if (!text.trim() && toolCalls.length === 0) {
                continue;
            }
            if (parsed.message.role === 'user') {
                // Finalize previous exchange before starting new one
                finalizeExchange();
                // Start new exchange
                currentExchange = {
                    userMessage: text || '(tool results only)',
                    userLine: lineNumber,
                    assistantMessages: [],
                    lastAssistantLine: lineNumber,
                    timestamp: parsed.timestamp || new Date().toISOString(),
                    parentUuid: parsed.parentUuid,
                    isSidechain: parsed.isSidechain,
                    sessionId: parsed.sessionId,
                    cwd: parsed.cwd,
                    gitBranch: parsed.gitBranch,
                    claudeVersion: parsed.version,
                    thinkingLevel: parsed.thinkingMetadata?.level,
                    thinkingDisabled: parsed.thinkingMetadata?.disabled,
                    thinkingTriggers: parsed.thinkingMetadata?.triggers ? JSON.stringify(parsed.thinkingMetadata.triggers) : undefined,
                    toolCalls: []
                };
            }
            else if (parsed.message.role === 'assistant' && currentExchange) {
                // Accumulate assistant messages
                if (text.trim()) {
                    currentExchange.assistantMessages.push(text);
                }
                currentExchange.lastAssistantLine = lineNumber;
                // Add tool calls to current exchange
                if (toolCalls.length > 0) {
                    currentExchange.toolCalls.push(...toolCalls);
                }
                // Update timestamp to last assistant message
                if (parsed.timestamp) {
                    currentExchange.timestamp = parsed.timestamp;
                }
                // Update metadata from assistant messages (use most recent)
                if (parsed.sessionId)
                    currentExchange.sessionId = parsed.sessionId;
                if (parsed.cwd)
                    currentExchange.cwd = parsed.cwd;
                if (parsed.gitBranch)
                    currentExchange.gitBranch = parsed.gitBranch;
                if (parsed.version)
                    currentExchange.claudeVersion = parsed.version;
            }
        }
        catch (error) {
            // Skip malformed JSON lines
            continue;
        }
    }
    // Finalize last exchange
    finalizeExchange();
    return exchanges;
}
/**
 * Convenience function to parse a conversation file
 * Extracts project name from the file path and returns exchanges with metadata
 */
export async function parseConversationFile(filePath) {
    // Extract project name from path (directory name before the .jsonl file)
    const pathParts = filePath.split('/');
    let project = 'unknown';
    // Find the parent directory name (second to last part)
    if (pathParts.length >= 2) {
        project = pathParts[pathParts.length - 2];
    }
    const exchanges = await parseConversation(filePath, project, filePath);
    return {
        project,
        exchanges
    };
}
