import fs from 'fs';
import path from 'path';
import { getExcludedProjects, isExcludedProject, detectCodingAgent } from './paths.js';
import { archiveFileExists, statArchiveFile } from './archive-io.js';

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
  const summaryCandidates: string[] = [];

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

        // A file without a summary is a CANDIDATE (whether newly copied or
        // existing). Whether it really gets one — exclusion marker, anything
        // to summarize at all — is judged when it is parsed below, not here:
        // judging here meant reading every summary-less file in full on every
        // sync just to build this list.
        if (!options.skipSummaries) {
          const summaryPath = destFile.replace('.jsonl', '-summary.txt');
          if (!archiveFileExists(summaryPath) && extractSessionIdFromPath(destFile)) {
            summaryCandidates.push(destFile);
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
    const { initDatabase } = await import('./db.js');
    const { parseGuarded } = await import('./conversation-guard.js');
    const { indexExchanges } = await import('./index-exchanges.js');

    // The embedding model is loaded by the first exchange that needs a vector
    // (generateEmbedding does it) — a sync where nothing changed loads nothing.
    const db = initDatabase();

    try {
      for (const file of filesToIndex) {
        try {
          const project = path.basename(path.dirname(file));
          // One pass: parse + exclusion markers. A file that cannot be read to
          // the end throws here — it is reported below and NOT indexed this
          // run (an unreadable file was once indexed as "no marker found").
          const { exchanges, excluded } = await parseGuarded(file, project, file);
          if (excluded) {
            continue; // Skip indexing but file is already copied
          }

          // Guards, the already-indexed check and the write all live in
          // indexExchanges; the coding agent is tagged on what it writes.
          await indexExchanges(db, exchanges, { codingAgent });

          result.indexed++;
        } catch (error) {
          result.errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      db.close();
    }
  }

  // Generate summaries for files that need them
  if (!options.skipSummaries && summaryCandidates.length > 0) {
    const { parseGuarded } = await import('./conversation-guard.js');
    const { shouldIndexExchange } = await import('./noise.js');
    const { summarizeConversation } = await import('./summarizer.js');

    // The limit counts summary CALLS, not candidates. It used to be spent on
    // the first N candidates in directory order, and a file with nothing to
    // summarize (no exchange yet) never gets a summary file, so it stayed at
    // the head of the list forever: measured live, 9 of the 10 slots went to
    // such files on every sync and 23 real conversations waited 17-30 days.
    const summaryLimit = options.summaryLimit ?? 10;
    let calls = 0;
    let waiting = 0;

    for (const filePath of summaryCandidates) {
      if (calls >= summaryLimit) {
        waiting++;
        continue;
      }
      try {
        const project = path.basename(path.dirname(filePath));
        const { exchanges, excluded } = await parseGuarded(filePath, project, filePath);
        if (excluded) {
          continue; // exclusion marker: never summarized
        }
        // Summarize what the index holds: worker prompts and machine noise are not conversation.
        const toSummarize = exchanges.filter(shouldIndexExchange);
        if (toSummarize.length === 0) {
          continue; // nothing to summarize yet — takes no slot
        }

        calls++;
        console.error(`  Summarizing ${path.basename(filePath)} (${toSummarize.length} exchanges)...`);
        const summary = await summarizeConversation(toSummarize);

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

    if (waiting > 0) {
      console.error(`  (${waiting} more without a summary were not looked at — the limit of ${summaryLimit} summary calls per sync was reached)`);
    }
  }

  return result;
}
