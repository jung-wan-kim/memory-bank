import { Marked } from 'marked';
import { readArchiveLineRange } from './archive-io.js';

interface ConversationMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  type: 'user' | 'assistant';
  isSidechain: boolean;
  sessionId?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  message: {
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: any }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: Array<{ type: string; text: string }> | string;
}

function parseJsonlMessages(lines: string[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return messages;
}

/** User/assistant messages that carry something to show (system lines and empty messages are dropped). */
function isRenderableMessage(msg: ConversationMessage): boolean {
  if (!msg || (msg.type !== 'user' && msg.type !== 'assistant')) return false;
  if (!msg.timestamp) return false;
  if (!msg.message || !msg.message.content) {
    if (msg.type === 'assistant' && msg.message?.usage) return true;
    return false;
  }
  if (Array.isArray(msg.message.content) && msg.message.content.length === 0) {
    if (msg.type === 'assistant' && msg.message?.usage) return true;
    return false;
  }
  return true;
}

/** Per-block size limits of the Markdown renderer. `blockChars: Infinity` renders everything. */
interface MarkdownCaps {
  /** Longest tool input value / tool result shown before it is clipped. */
  blockChars: number;
  /** The reader's locale for dates and numbers (undefined = the default of the process that renders). */
  locale?: string;
}

const NO_CAPS: MarkdownCaps = { blockChars: Infinity };

/**
 * `text` cut to `max` chars with a marker naming how much was left out and how to read it (never splits a
 * surrogate pair). Only the `read` tool clips (NO_CAPS never does), so the marker names its `full` argument.
 */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\n…[+${text.length - cut.length} chars not shown — read again with full: true]`;
}

function markdownHeader(firstMessage: ConversationMessage): string {
  let output = '# Conversation\n\n';

  // Add metadata
  output += '## Metadata\n\n';
  if (firstMessage.sessionId) {
    output += `**Session ID:** ${firstMessage.sessionId}\n\n`;
  }
  if (firstMessage.gitBranch) {
    output += `**Git Branch:** ${firstMessage.gitBranch}\n\n`;
  }
  if (firstMessage.cwd) {
    output += `**Working Directory:** ${firstMessage.cwd}\n\n`;
  }
  if (firstMessage.version) {
    output += `**Claude Code Version:** ${firstMessage.version}\n\n`;
  }

  output += '---\n\n';
  output += '## Messages\n\n';
  return output;
}

const SIDECHAIN_START = '\n---\n**🔀 SIDECHAIN START**\n---\n\n';
const SIDECHAIN_END = '\n---\n**🔀 SIDECHAIN END**\n---\n\n';

/**
 * Markdown of messages[i], or null when the message is not shown on its own (a user message that only
 * carries tool results — those are printed under the tool call they answer). `messages` may extend past
 * the rendered range: a tool call looks up to 5 messages ahead for its result.
 */
function renderMarkdownMessage(messages: ConversationMessage[], i: number, caps: MarkdownCaps): string | null {
  const msg = messages[i];
  const timestamp = new Date(msg.timestamp).toLocaleString(caps.locale);
  const messageId = msg.uuid || `msg-${i}`;

  // Skip user messages that are just tool results
  if (msg.type === 'user' && Array.isArray(msg.message.content)) {
    const hasOnlyToolResults = msg.message.content.every(block => block.type === 'tool_result');
    if (hasOnlyToolResults) {
      return null;
    }
  }

  // Determine role label
  let roleLabel: string;
  if (msg.isSidechain) {
    roleLabel = msg.type === 'user' ? 'Agent' : 'Subagent';
  } else {
    roleLabel = msg.type === 'user' ? 'User' : 'Agent';
  }

  let output = `### **${roleLabel}** (${timestamp}) {#${messageId}}\n\n`;

  if (msg.type === 'user') {
    // Handle tool results
    if (msg.toolUseResult) {
      output += '**Tool Result:**\n\n';
      if (typeof msg.toolUseResult === 'string') {
        output += `${clipText(msg.toolUseResult, caps.blockChars)}\n\n`;
      } else if (Array.isArray(msg.toolUseResult)) {
        for (const result of msg.toolUseResult) {
          output += `${clipText(result.text || String(result), caps.blockChars)}\n\n`;
        }
      }
    } else if (typeof msg.message.content === 'string') {
      output += `${msg.message.content}\n\n`;
    } else if (Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          output += `${block.text}\n\n`;
        }
      }
    }
  } else if (msg.type === 'assistant') {
    const content = msg.message.content;
    if (typeof content === 'string') {
      output += `${content}\n\n`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          output += `${block.text}\n\n`;
        } else if (block.type === 'tool_use') {
          output += `**Tool Use:** \`${block.name}\`\n\n`;

          // Format tool input inline
          const input = block.input;
          if (input && typeof input === 'object') {
            for (const [key, value] of Object.entries(input)) {
              if (typeof value === 'string' && value.includes('\n')) {
                output += `- **${key}:**\n\`\`\`\n${clipText(value, caps.blockChars)}\n\`\`\`\n`;
              } else if (typeof value === 'string') {
                output += `- **${key}:** ${clipText(value, caps.blockChars)}\n`;
              } else {
                output += `- **${key}:**\n\`\`\`json\n${clipText(JSON.stringify(value, null, 2), caps.blockChars)}\n\`\`\`\n`;
              }
            }
            output += '\n';
          }

          // Look for corresponding tool result
          const toolUseId = (block as any).id;
          if (toolUseId) {
            let foundResult = false;
            for (let j = i + 1; j < Math.min(i + 6, messages.length) && !foundResult; j++) {
              const laterMsg = messages[j];
              if (laterMsg.type === 'user' && Array.isArray(laterMsg.message.content)) {
                for (const resultBlock of laterMsg.message.content) {
                  if (resultBlock.type === 'tool_result' && (resultBlock as any).tool_use_id === toolUseId) {
                    const content = (resultBlock as any).content;
                    output += '**Result:**\n';
                    if (typeof content === 'string') {
                      if (content.includes('\n') || content.length > 100) {
                        output += '```\n';
                        output += clipText(content, caps.blockChars);
                        output += '\n```\n\n';
                      } else {
                        output += `${content}\n\n`;
                      }
                    } else if (Array.isArray(content)) {
                      output += '```json\n';
                      output += clipText(JSON.stringify(content, null, 2), caps.blockChars);
                      output += '\n```\n\n';
                    }
                    foundResult = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Add token usage if present
    if (msg.message.usage) {
      const usage = msg.message.usage;
      output += `_in: ${(usage.input_tokens || 0).toLocaleString(caps.locale)}`;
      if (usage.cache_read_input_tokens) {
        output += ` | cache read: ${usage.cache_read_input_tokens.toLocaleString(caps.locale)}`;
      }
      if (usage.cache_creation_input_tokens) {
        output += ` | cache create: ${usage.cache_creation_input_tokens.toLocaleString(caps.locale)}`;
      }
      output += ` | out: ${(usage.output_tokens || 0).toLocaleString(caps.locale)}_\n\n`;
    }
  }

  return output;
}

export function formatConversationAsMarkdown(jsonl: string, startLine?: number, endLine?: number): string {
  const allLines = jsonl.trim().split('\n').filter(line => line.trim());

  // Apply line range if specified (1-indexed, inclusive)
  const lines = startLine !== undefined || endLine !== undefined
    ? allLines.slice(
        startLine !== undefined ? startLine - 1 : 0,
        endLine !== undefined ? endLine : undefined
      )
    : allLines;

  const allMessages = parseJsonlMessages(lines);

  // Filter out system messages and messages with no content
  const messages = allMessages.filter(isRenderableMessage);

  if (messages.length === 0) {
    return '';
  }

  let output = markdownHeader(messages[0]);

  let inSidechain = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const body = renderMarkdownMessage(messages, i, NO_CAPS);
    if (body === null) continue;

    // Handle sidechain grouping
    if (msg.isSidechain && !inSidechain) {
      output += SIDECHAIN_START;
      inSidechain = true;
    } else if (!msg.isSidechain && inSidechain) {
      output += SIDECHAIN_END;
      inSidechain = false;
    }

    output += body;
  }

  // Close sidechain if still open
  if (inSidechain) {
    output += SIDECHAIN_END;
  }

  return output;
}

/** Most characters one `read` call returns (the continuation footer comes on top). */
export const READ_MAX_OUTPUT_CHARS = 40_000;
/** Longest tool input value / tool result `read` shows before clipping it. */
export const READ_MAX_BLOCK_CHARS = 2_000;
/** Raw JSONL characters one `read` call may hold in memory (lines can be far larger than what is rendered). */
const READ_MAX_RAW_CHARS = 8_000_000;
/** Lines read past endLine only to find the results of tool calls at the end of the range. */
const TOOL_RESULT_LOOKAHEAD_LINES = 8;

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
export async function readConversationRange(filePath: string, opts: ConversationRangeOptions = {}): Promise<string> {
  const { startLine, endLine } = opts;
  const maxChars = opts.maxChars ?? READ_MAX_OUTPUT_CHARS;
  const startChar = opts.startChar ?? 0;
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error(`Invalid line range: startLine ${startLine} is after endLine ${endLine}`);
  }

  const range = await readArchiveLineRange(filePath, {
    startLine,
    endLine,
    lookahead: TOOL_RESULT_LOOKAHEAD_LINES,
    maxChars: READ_MAX_RAW_CHARS,
  });
  const firstLine = startLine ?? 1;
  const inRangeLines = range.lines.filter((l) => endLine === undefined || l.line <= endLine);
  if (inRangeLines.length === 0) {
    throw new Error(
      `Line range ${firstLine}-${endLine ?? 'end'} is outside the file: it has ${range.totalLines} lines`
    );
  }
  const lastLineRead = inRangeLines[inRangeLines.length - 1].line;

  const entries: Array<{ line: number; msg: ConversationMessage }> = [];
  for (const { line, text } of range.lines) {
    let msg: ConversationMessage;
    try { msg = JSON.parse(text); } catch { continue; /* skip malformed */ }
    if (isRenderableMessage(msg)) entries.push({ line, msg });
  }
  const messages = entries.map((e) => e.msg);
  const shown = entries.filter((e) => e.line <= lastLineRead);
  if (shown.length === 0) {
    return `_No user or assistant messages in lines ${firstLine}-${lastLineRead}._\n`;
  }

  const caps: MarkdownCaps = { blockChars: opts.full ? Infinity : READ_MAX_BLOCK_CHARS, locale: opts.locale };
  let output = markdownHeader(shown[0].msg);
  let inSidechain = false;
  let rendered = 0;
  // Where the next call should start, once the output ceiling stops this one: a line, and — when the stop is
  // inside that line's message — the character of it to go on from (0 = the message from its start).
  let next: { line: number; char: number } | null = null;
  let startCharPending = startChar > 0;

  for (let i = 0; i < shown.length; i++) {
    const { line, msg } = shown[i];
    const body = renderMarkdownMessage(messages, i, caps);
    if (body === null) continue;

    // startChar belongs to the first message that is shown.
    let from = 0;
    if (startCharPending) {
      startCharPending = false;
      if (startChar >= body.length) {
        throw new Error(
          `startChar ${startChar} is past the end of the message at line ${line}: it has ${body.length} characters`
          + (opts.full ? '' : ' (tool inputs/results clipped — an offset from a full: true answer needs full: true)')
        );
      }
      from = startChar;
      // An offset between the two halves of a surrogate pair starts at the pair.
      if (/[\uDC00-\uDFFF]/.test(body[from]) && /[\uD800-\uDBFF]/.test(body[from - 1] ?? '')) from--;
    }

    let marker = '';
    if (msg.isSidechain && !inSidechain) marker = SIDECHAIN_START;
    else if (!msg.isSidechain && inSidechain) marker = SIDECHAIN_END;
    const lead = marker + (from > 0 ? `…[message at line ${line} continues from character ${from} of ${body.length}]\n\n` : '');
    const rest = from > 0 ? body.slice(from) : body;
    const room = maxChars - output.length - lead.length;

    if (rest.length > room) {
      if (rendered > 0) {
        next = { line, char: 0 }; // stop at the message boundary; the next call starts with this message
        break;
      }
      // The first message alone is over the ceiling: show what fits. The next call goes on inside it — it
      // used to start at the next line, and the rest of this message could not be read at all. At least
      // one character is shown, so every call moves forward.
      let cut = rest.slice(0, Math.max(1, room));
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.length > 1 ? cut.slice(0, -1) : rest.slice(0, 2);
      const upTo = from + cut.length;
      if (upTo < body.length) {
        output += `${lead}${cut}\n\n…[message clipped: characters ${from}-${upTo - 1} of ${body.length} shown]\n\n`;
        if (marker) inSidechain = !inSidechain;
        next = { line, char: upTo };
        break;
      }
      // (no room was left at all and the one character shown was the message's last: it is complete)
    }

    output += lead + rest;
    if (marker) inSidechain = !inSidechain;
    rendered++;
  }

  if (startCharPending) {
    throw new Error(`startChar ${startChar} was given, but lines ${firstLine}-${lastLineRead} show no message of their own to apply it to`);
  }

  // Close sidechain if still open
  if (inSidechain) {
    output += SIDECHAIN_END;
  }

  // Whether the file has a line after `line` that the requested range still covers. The stream is closed at
  // the last line it needs, so the file's length is often unknown; only when it was closed by the raw ceiling
  // on that very line does answering take a second look at the file.
  const lastCollected = range.lines[range.lines.length - 1].line;
  const lineFollows = async (line: number): Promise<boolean> => {
    if (endLine !== undefined && line + 1 > endLine) return false;
    if (range.totalLines !== null) return line + 1 <= range.totalLines;
    return line + 1 <= lastCollected || archiveHasLine(filePath, line + 1);
  };

  // The raw ceiling ended this call with every message it read shown. The footer used to name "last line + 1"
  // unseen: when the ceiling fell on the file's last line that was a line outside the file, and the call the
  // footer asked for was an error.
  let stoppedAtRawCeiling = false;
  if (next === null && range.stoppedEarly && await lineFollows(lastLineRead)) {
    next = { line: lastLineRead + 1, char: 0 };
    stoppedAtRawCeiling = true;
  }
  const moreToRead = next !== null && (
    next.char > 0
    || ((endLine === undefined || next.line <= endLine) && (range.totalLines === null || next.line <= range.totalLines))
  );
  if (next !== null && moreToRead) {
    const total = range.totalLines === null ? '' : ` of ${range.totalLines}`;
    let shownSoFar: string;
    if (next.char > 0) {
      // The line named below is this message's own line, not the next one: what moves the next call forward is
      // startChar.
      // A caller that passes startLine alone gets the message from its start again, on every call — so the
      // footer says so, and names the way out. (It ends with the values to continue with, as before.)
      shownSoFar = `lines ${firstLine}-${next.line}${total} shown, the message at line ${next.line} up to character ${next.char}. `
        + 'Without startChar the message starts over from its first character'
        + (await lineFollows(next.line)
          ? ` — to skip the rest of it instead, start at line ${next.line + 1}`
          : ' (nothing follows it in the requested range)');
    } else if (stoppedAtRawCeiling) {
      shownSoFar = `lines ${firstLine}-${next.line - 1} shown (the limit is on the file text one call reads, not on this output)`;
    } else {
      shownSoFar = `lines ${firstLine}-${next.line - 1}${total} shown`;
    }
    // Every value the next call needs, in one place: the offset counts the text as this call rendered it,
    // so `full` travels with it.
    const args = [`startLine=${next.line}`];
    if (next.char > 0) args.push(`startChar=${next.char}`);
    if (endLine !== undefined) args.push(`endLine=${endLine}`);
    if (opts.full) args.push('full=true');
    const limitChars = stoppedAtRawCeiling ? READ_MAX_RAW_CHARS : maxChars;
    output += `\n---\n_Output truncated at the ${limitChars}-char limit: ${shownSoFar}. Continue with ${args.join(', ')}._\n`;
  }

  return output;
}

/**
 * Whether the archive file has a line `line`. Asked only where one call could not tell (the raw ceiling
 * closed the stream on the line before): it reads the file once more, up to that line. A stream error counts
 * as "yes" — the call that then asks for the line is the one that reports it, with the error itself.
 */
async function archiveHasLine(filePath: string, line: number): Promise<boolean> {
  try {
    const probe = await readArchiveLineRange(filePath, { startLine: line, endLine: line, maxChars: 1 });
    return probe.lines.length > 0;
  } catch {
    return true;
  }
}

export function formatConversationAsHTML(jsonl: string, locale?: string): string {
  const lines = jsonl.trim().split('\n').filter(line => line.trim());
  const allMessages = parseJsonlMessages(lines);

  // Filter out system messages and messages with no content
  const messages = allMessages.filter(msg => {
    if (msg.type !== 'user' && msg.type !== 'assistant') return false;

    // Skip messages with null timestamps
    if (!msg.timestamp) return false;

    // Skip messages with no content (but keep if they have usage stats)
    if (!msg.message || !msg.message.content) {
      // Keep assistant messages that only have token usage
      if (msg.type === 'assistant' && msg.message?.usage) return true;
      return false;
    }
    if (Array.isArray(msg.message.content) && msg.message.content.length === 0) {
      // Keep assistant messages that only have token usage
      if (msg.type === 'assistant' && msg.message?.usage) return true;
      return false;
    }

    return true;
  });

  if (messages.length === 0) {
    return '';
  }

  const firstMessage = messages[0];
  let bodyContent = '';

  // Add header with metadata
  bodyContent += '<div class="header">';
  bodyContent += '<h1>Conversation</h1>';
  bodyContent += '<table class="metadata">';
  if (firstMessage.sessionId) {
    bodyContent += `<tr><th>Session ID</th><td>${escapeHtml(firstMessage.sessionId)}</td></tr>`;
  }
  if (firstMessage.gitBranch) {
    bodyContent += `<tr><th>Git Branch</th><td>${escapeHtml(firstMessage.gitBranch)}</td></tr>`;
  }
  if (firstMessage.cwd) {
    bodyContent += `<tr><th>Working Directory</th><td>${escapeHtml(firstMessage.cwd)}</td></tr>`;
  }
  if (firstMessage.version) {
    bodyContent += `<tr><th>Claude Code Version</th><td>${escapeHtml(firstMessage.version)}</td></tr>`;
  }
  bodyContent += '</table></div>';

  // Render messages
  bodyContent += '<div class="messages">';

  // Build message index for tool results
  const toolUseMap = new Map<string, any>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && (block as any).id) {
          toolUseMap.set((block as any).id, { msg, block });
        }
      }
    }
  }

  let inSidechain = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const timestamp = new Date(msg.timestamp).toLocaleString(locale);
    const messageId = `msg-${msg.uuid || i}`;

    // Skip user messages that are just tool results - they'll be rendered with their tool use
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const hasOnlyToolResults = msg.message.content.every(block => block.type === 'tool_result');
      if (hasOnlyToolResults) {
        continue;
      }
    }

    // Handle sidechain grouping
    if (msg.isSidechain && !inSidechain) {
      // Starting a sidechain group
      bodyContent += '<div class="sidechain-group">';
      inSidechain = true;
    } else if (!msg.isSidechain && inSidechain) {
      // Ending a sidechain group
      bodyContent += '</div>';
      inSidechain = false;
    }

    const messageClass = msg.type === 'user' ? 'message user-message' : 'message assistant-message';

    // Determine role label based on context
    let roleLabel: string;
    if (msg.isSidechain) {
      roleLabel = msg.type === 'user' ? 'Agent' : 'Subagent';
    } else {
      roleLabel = msg.type === 'user' ? 'User' : 'Agent';
    }

    bodyContent += `<div class="${messageClass}" id="${messageId}">`;
    bodyContent += `<div class="message-header">`;
    bodyContent += `<span class="role">${roleLabel}</span>`;
    bodyContent += `<a href="#${messageId}" class="timestamp">${escapeHtml(timestamp)}</a>`;
    bodyContent += `</div>`;
    bodyContent += `<div class="message-content">`;

    if (msg.type === 'user') {
      // Handle tool results
      if (msg.toolUseResult) {
        bodyContent += '<div class="tool-result">';
        bodyContent += '<strong>Tool Result:</strong>';
        if (typeof msg.toolUseResult === 'string') {
          bodyContent += `<p>${escapeHtml(msg.toolUseResult)}</p>`;
        } else if (Array.isArray(msg.toolUseResult)) {
          for (const result of msg.toolUseResult) {
            bodyContent += `<p>${escapeHtml(result.text || String(result))}</p>`;
          }
        }
        bodyContent += '</div>';
      } else if (typeof msg.message.content === 'string') {
        bodyContent += `<p>${escapeHtml(msg.message.content)}</p>`;
      } else if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            bodyContent += `<p>${escapeHtml(block.text)}</p>`;
          } else if (block.type === 'tool_result') {
            bodyContent += '<div class="tool-result">';
            bodyContent += '<strong>Tool Result:</strong> ';
            bodyContent += `<code>${escapeHtml(String((block as any).content || ''))}</code>`;
            bodyContent += '</div>';
          }
        }
      }
    } else if (msg.type === 'assistant') {
      const content = msg.message.content;
      if (typeof content === 'string') {
        bodyContent += `<p>${escapeHtml(content)}</p>`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            // Check if text looks like markdown and render accordingly
            if (isMarkdown(block.text)) {
              bodyContent += '<div class="markdown-content">';
              bodyContent += renderMarkdownSafely(block.text);
              bodyContent += '</div>';
            } else {
              // Plain text - preserve whitespace
              bodyContent += `<div class="plain-content">${escapeHtml(block.text)}</div>`;
            }
          } else if (block.type === 'tool_use') {
            bodyContent += '<div class="tool-use">';
            bodyContent += `<div class="tool-name"><strong>Tool Use:</strong> <code>${escapeHtml(block.name || '')}</code></div>`;

            // Format tool input inline
            const input = block.input;
            if (input && typeof input === 'object') {
              bodyContent += '<div class="tool-params">';
              for (const [key, value] of Object.entries(input)) {
                bodyContent += `<div class="tool-param">`;
                bodyContent += `<strong>${escapeHtml(key)}:</strong> `;
                if (typeof value === 'string') {
                  // Check if value has newlines or is long - format as code block
                  if (value.includes('\n') || value.length > 100) {
                    bodyContent += '<pre>';
                    bodyContent += escapeHtml(value);
                    bodyContent += '</pre>';
                  } else {
                    bodyContent += escapeHtml(value);
                  }
                } else {
                  // Format objects/arrays as JSON
                  bodyContent += '<pre>';
                  bodyContent += escapeHtml(JSON.stringify(value, null, 2));
                  bodyContent += '</pre>';
                }
                bodyContent += '</div>';
              }
              bodyContent += '</div>';
            }

            // Look for corresponding tool result in subsequent messages (not just next)
            const toolUseId = (block as any).id;
            if (toolUseId) {
              // Search forward up to 5 messages for the result
              let foundResult = false;
              for (let j = i + 1; j < Math.min(i + 6, messages.length) && !foundResult; j++) {
                const laterMsg = messages[j];
                if (laterMsg.type === 'user' && Array.isArray(laterMsg.message.content)) {
                  for (const resultBlock of laterMsg.message.content) {
                    if (resultBlock.type === 'tool_result' && (resultBlock as any).tool_use_id === toolUseId) {
                      bodyContent += '<div class="tool-result">';
                      bodyContent += '<strong>Result:</strong> ';
                      const content = (resultBlock as any).content;
                      if (typeof content === 'string') {
                        // If content has newlines or is long, format as pre
                        if (content.includes('\n') || content.length > 100) {
                          bodyContent += '<pre>';
                          bodyContent += escapeHtml(content);
                          bodyContent += '</pre>';
                        } else {
                          bodyContent += escapeHtml(content);
                        }
                      } else if (Array.isArray(content)) {
                        bodyContent += '<pre>';
                        bodyContent += escapeHtml(JSON.stringify(content, null, 2));
                        bodyContent += '</pre>';
                      }
                      bodyContent += '</div>';
                      foundResult = true;
                      break;
                    }
                  }
                }
              }
            }
            bodyContent += '</div>';
          }
        }
      }

      // Add token usage if present
      if (msg.message.usage) {
        const usage = msg.message.usage;
        bodyContent += '<div class="token-usage">';
        bodyContent += `in: ${(usage.input_tokens || 0).toLocaleString(locale)}`;
        if (usage.cache_read_input_tokens) {
          bodyContent += ` | cache read: ${usage.cache_read_input_tokens.toLocaleString(locale)}`;
        }
        if (usage.cache_creation_input_tokens) {
          bodyContent += ` | cache create: ${usage.cache_creation_input_tokens.toLocaleString(locale)}`;
        }
        bodyContent += ` | out: ${(usage.output_tokens || 0).toLocaleString(locale)}`;
        bodyContent += '</div>';
      }
    }

    bodyContent += '</div></div>';
  }

  // Close sidechain group if still open
  if (inSidechain) {
    bodyContent += '</div>';
  }

  bodyContent += '</div>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conversation</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 24px;
      line-height: 1.5;
      color: #1d1d1f;
      background: #f5f5f7;
    }
    .header {
      margin-bottom: 32px;
      padding: 24px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .header h1 {
      margin: 0 0 20px 0;
      font-size: 28px;
      font-weight: 600;
      color: #1d1d1f;
    }
    .metadata {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .metadata th {
      text-align: left;
      padding: 10px 0;
      color: #86868b;
      font-weight: 500;
      width: 180px;
      border-bottom: 1px solid #f5f5f7;
    }
    .metadata td {
      padding: 10px 0;
      font-family: 'SF Mono', Consolas, monospace;
      font-size: 12px;
      color: #1d1d1f;
      border-bottom: 1px solid #f5f5f7;
    }
    .messages {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .message {
      padding: 20px 24px;
      background: #ffffff;
    }
    .user-message {
      border-left: 3px solid #007aff;
    }
    .assistant-message {
      border-left: 3px solid #34c759;
    }
    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 12px;
    }
    .role {
      font-weight: 600;
      font-size: 14px;
      letter-spacing: -0.01em;
    }
    .user-message .role {
      color: #007aff;
    }
    .assistant-message .role {
      color: #34c759;
    }
    .plain-content {
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #1d1d1f;
      font-size: 14px;
      line-height: 1.6;
    }
    .markdown-content {
      color: #1d1d1f;
      font-size: 14px;
      line-height: 1.6;
    }
    .markdown-content p {
      margin: 0 0 12px 0;
    }
    .markdown-content p:last-child {
      margin-bottom: 0;
    }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 {
      margin: 20px 0 12px 0;
      font-weight: 600;
      color: #1d1d1f;
    }
    .markdown-content h1 {
      font-size: 20px;
      border-bottom: 1px solid #e5e5e7;
      padding-bottom: 8px;
    }
    .markdown-content h2 {
      font-size: 18px;
    }
    .markdown-content h3 {
      font-size: 16px;
    }
    .markdown-content ul, .markdown-content ol {
      margin: 12px 0;
      padding-left: 24px;
    }
    .markdown-content li {
      margin: 4px 0;
    }
    .markdown-content code {
      background: #f5f5f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Consolas, monospace;
      font-size: 13px;
      color: #5e5ce6;
    }
    .markdown-content pre {
      margin: 12px 0;
      background: #1d1d1f;
      color: #f5f5f7;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      line-height: 1.5;
    }
    .markdown-content pre code {
      background: none;
      color: #f5f5f7;
      padding: 0;
      font-size: 12px;
    }
    .markdown-content blockquote {
      margin: 12px 0;
      padding-left: 16px;
      border-left: 3px solid #e5e5e7;
      color: #6e6e73;
    }
    .markdown-content strong {
      font-weight: 600;
      color: #1d1d1f;
    }
    .markdown-content a {
      color: #007aff;
      text-decoration: none;
    }
    .markdown-content a:hover {
      text-decoration: underline;
    }
    .timestamp {
      font-size: 11px;
      color: #86868b;
      font-weight: 400;
      text-decoration: none;
    }
    .timestamp:hover {
      color: #007aff;
      text-decoration: underline;
    }
    .tool-use {
      margin: 16px 0;
      background: #f5f5f7;
      border-radius: 8px;
      padding: 16px;
      border: 1px solid #e5e5e7;
    }
    .tool-name {
      margin-bottom: 12px;
      font-size: 12px;
      font-weight: 600;
      color: #8e8e93;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tool-name code {
      color: #5e5ce6;
      background: none;
      padding: 0;
      font-weight: 600;
    }
    .tool-params {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }
    .tool-param {
      font-size: 12px;
      font-family: 'SF Mono', Consolas, monospace;
      line-height: 1.6;
    }
    .tool-param strong {
      color: #5e5ce6;
      font-weight: 600;
    }
    .tool-param pre {
      margin: 6px 0 0 0;
      padding: 8px 12px;
      background: #ffffff;
      border: 1px solid #e5e5e7;
      border-radius: 6px;
      font-size: 11px;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #1d1d1f;
      font-family: 'SF Mono', Consolas, monospace;
      line-height: 1.5;
      overflow-x: auto;
    }
    .tool-result {
      margin-top: 8px;
      font-size: 12px;
      font-family: 'SF Mono', Consolas, monospace;
      line-height: 1.6;
    }
    .tool-result strong {
      color: #5e5ce6;
      font-weight: 600;
    }
    .tool-result pre {
      margin: 6px 0 0 0;
      padding: 8px 12px;
      background: #ffffff;
      border: 1px solid #e5e5e7;
      border-radius: 6px;
      font-size: 11px;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #1d1d1f;
      font-family: 'SF Mono', Consolas, monospace;
      line-height: 1.5;
      overflow-x: auto;
    }
    .token-usage {
      margin-top: 12px;
      font-size: 10px;
      color: #86868b;
      font-family: 'SF Mono', Consolas, monospace;
    }
    .sidechain-group {
      background: #fffbf0;
      border-left: 3px solid #ffcc00;
      border-radius: 8px;
      padding: 2px;
      margin: 8px 0;
    }
    .sidechain-group .message {
      background: #ffffff;
    }
    @media (max-width: 768px) {
      body {
        padding: 12px;
      }
      .header {
        padding: 16px;
      }
      .message {
        padding: 16px;
      }
    }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function isMarkdown(text: string): boolean {
  // Detect common markdown patterns
  const markdownPatterns = [
    /^#{1,6}\s/m,           // Headers
    /\*\*[^*]+\*\*/,        // Bold
    /\*[^*]+\*/,            // Italic
    /`[^`]+`/,              // Inline code
    /```/,                  // Code blocks
    /^\s*[-*+]\s/m,         // Unordered lists
    /^\s*\d+\.\s/m,         // Ordered lists
    /^\s*>\s/m,             // Blockquotes
    /\[.+\]\(.+\)/,         // Links
  ];

  // If text has at least 2 markdown patterns, consider it markdown
  const matchCount = markdownPatterns.filter(pattern => pattern.test(text)).length;
  return matchCount >= 2;
}

/** Link targets an exported conversation may carry. Anything else (javascript:, data:, vbscript:, file:) is dropped. */
const SAFE_LINK = /^(?:https?:|mailto:|#)/i;

/**
 * Markdown renderer for conversation text. The text is whatever a model, a
 * tool result or a pasted page said, so it is rendered as markdown only:
 *  - raw HTML in it is written out as text (marked passes it through as markup
 *    by default — a `<script>` in a message ran when the export was opened);
 *  - a link keeps its target only for http(s)/mailto/#;
 *  - an image is shown as its markdown source, never loaded — an export must
 *    not call out to a URL that the conversation chose.
 */
const conversationMarkdown = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href.trim())) return label;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }) {
      return escapeHtml(`![${text}](${href})`);
    },
  },
});

function renderMarkdownSafely(text: string): string {
  try {
    return conversationMarkdown.parse(text, { async: false }) as string;
  } catch (error) {
    // Fallback to escaped HTML if markdown parsing fails
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}
