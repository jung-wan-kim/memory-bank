import fs from 'fs';
import path from 'path';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getExcludedProjects, isExcludedProject, isWorkerPromptMessage, detectCodingAgent } from './paths.js';
import { archiveFileExists, readArchiveFile, statArchiveFile } from './archive-io.js';

const EXCLUSION_MARKERS = [
  '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
  'Only use NO_INSIGHTS_FOUND',
  SUMMARIZER_CONTEXT_MARKER,
];

function shouldSkipConversation(filePath: string): boolean {
  try {
    const content = readArchiveFile(filePath);
    for (const line of content.split(/\r?\n/)) {
      let entry: {
        type?: unknown;
        message?: { role?: unknown; content?: unknown };
      };

      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'user' || entry.message?.role !== 'user') {
        continue;
      }

      const messageContent = entry.message.content;
      const directText = typeof messageContent === 'string'
        ? messageContent
        : Array.isArray(messageContent)
          ? messageContent
              .filter(block => block?.type === 'text' && typeof block.text === 'string')
              .map(block => block.text)
              .join('\n')
          : '';

      // A Claude tool result is also encoded as a `user` event. Only a direct
      // text prompt can establish that the session itself belongs to an
      // internal summarizer; quoted markers in tool results or assistant data
      // must not suppress the rest of an ordinary conversation.
      if (!directText.trim()) {
        continue;
      }

      return EXCLUSION_MARKERS.some(marker => directText.includes(marker));
    }

    return false;
  } catch (error) {
    // If we can't read the file, don't skip it
    return false;
  }
}

export interface SyncResult {
  copied: number;
  skipped: number;
  indexed: number;
  summarized: number;
  errors: Array<{ file: string; error: string }>;
}

export interface SyncOptions {
  skipIndex?: boolean;
  skipSummaries?: boolean;
  summaryLimit?: number; // Max summaries to generate per run (default: 10)
  codingAgent?: string;  // Override coding agent detection (e.g., 'codex', 'opencode')
}

function copyIfNewer(src: string, dest: string): boolean {
  // Ensure destination directory exists
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Check if destination exists and is up-to-date. The archive may have been
  // compressed out-of-band (dest.zst) — treat a current compressed copy as
  // up-to-date, otherwise every sync re-copies the whole history.
  const destStat = statArchiveFile(dest);
  if (destStat) {
    const srcStat = fs.statSync(src);
    if (destStat.mtimeMs >= srcStat.mtimeMs) {
      return false; // Dest (plain or compressed) is current, skip
    }
  }

  // Atomic copy: temp file + rename
  const tempDest = dest + '.tmp.' + process.pid;
  try {
    fs.copyFileSync(src, tempDest);
    fs.renameSync(tempDest, dest); // Atomic on same filesystem
  } catch (e) {
    try { fs.unlinkSync(tempDest); } catch { /* cleanup best effort */ }
    throw e;
  }
  return true;
}

function extractSessionIdFromPath(filePath: string): string | null {
  // Extract session ID from filename: /path/to/abc-123-def.jsonl -> abc-123-def
  const basename = path.basename(filePath, '.jsonl');
  // Session IDs are UUIDs, validate format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename)) {
    return basename;
  }
  return null;
}

export async function syncConversations(
  sourceDir: string,
  destDir: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    copied: 0,
    skipped: 0,
    indexed: 0,
    summarized: 0,
    errors: []
  };

  // Detect coding agent from source directory or use override
  const codingAgent = options.codingAgent || detectCodingAgent(sourceDir);

  // Ensure source directory exists
  if (!fs.existsSync(sourceDir)) {
    return result;
  }

  // Collect files to index and summarize
  const filesToIndex: string[] = [];
  const filesToSummarize: Array<{ path: string; sessionId: string }> = [];

  // Walk source directory
  const projects = fs.readdirSync(sourceDir);
  const excludedProjects = getExcludedProjects();

  for (const project of projects) {
    if (isExcludedProject(project, excludedProjects)) {
      console.error("\nSkipping excluded project: " + project);
      continue;
    }

    const projectPath = path.join(sourceDir, project);
    const stat = fs.statSync(projectPath);

    if (!stat.isDirectory()) continue;

    const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const srcFile = path.join(projectPath, file);
      const destFile = path.join(destDir, project, file);

      try {
        const wasCopied = copyIfNewer(srcFile, destFile);
        if (wasCopied) {
          result.copied++;
          filesToIndex.push(destFile);
        } else {
          result.skipped++;
        }

        // Check if this file needs a summary (whether newly copied or existing)
        if (!options.skipSummaries) {
          const summaryPath = destFile.replace('.jsonl', '-summary.txt');
          if (!archiveFileExists(summaryPath) && !shouldSkipConversation(destFile)) {
            const sessionId = extractSessionIdFromPath(destFile);
            if (sessionId) {
              filesToSummarize.push({ path: destFile, sessionId });
            }
          }
        }
      } catch (error) {
        result.errors.push({
          file: srcFile,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // Index copied files (unless skipIndex is set)
  if (!options.skipIndex && filesToIndex.length > 0) {
    const { initDatabase, insertExchange } = await import('./db.js');
    const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
    const { parseConversation } = await import('./parser.js');

    const db = initDatabase();
    await initEmbeddings();

    for (const file of filesToIndex) {
      try {
        // Check for DO NOT INDEX marker
        if (shouldSkipConversation(file)) {
          continue; // Skip indexing but file is already copied
        }

        const project = path.basename(path.dirname(file));
        const exchanges = await parseConversation(file, project, file);

        for (const exchange of exchanges) {
          // Worker-prompt exchange = ephemeral state, not knowledge — never index.
          if (isWorkerPromptMessage(exchange.userMessage)) continue;
          // Tag each exchange with the coding agent
          exchange.codingAgent = codingAgent;

          const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage,
            exchange.assistantMessage,
            toolNames
          );
          insertExchange(db, exchange, embedding, toolNames);
        }

        result.indexed++;
      } catch (error) {
        result.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    db.close();
  }

  // Generate summaries for files that need them
  if (!options.skipSummaries && filesToSummarize.length > 0) {
    const { parseConversation } = await import('./parser.js');
    const { summarizeConversation } = await import('./summarizer.js');

    const summaryLimit = options.summaryLimit ?? 10;
    const toSummarize = filesToSummarize.slice(0, summaryLimit);
    const remaining = filesToSummarize.length - toSummarize.length;

    console.error(`Generating summaries for ${toSummarize.length} conversation(s)...`);
    if (remaining > 0) {
      console.error(`  (${remaining} more need summaries - will process on next sync)`);
    }

    for (const { path: filePath } of toSummarize) {
      try {
        const project = path.basename(path.dirname(filePath));
        const exchanges = await parseConversation(filePath, project, filePath);

        if (exchanges.length === 0) {
          continue; // Skip empty conversations
        }

        console.error(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
        const summary = await summarizeConversation(exchanges);

        const summaryPath = filePath.replace('.jsonl', '-summary.txt');
        fs.writeFileSync(summaryPath, summary, 'utf-8');
        result.summarized++;
      } catch (error) {
        result.errors.push({
          file: filePath,
          error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  return result;
}
