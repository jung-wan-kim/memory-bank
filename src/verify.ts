import fs from 'fs';
import path from 'path';
import { initDatabase, getFileLastIndexed, isExchangeCurrent, deleteExchanges } from './db.js';
import { getArchiveDir, getExcludedProjects, isExcludedProject } from './paths.js';
import { archiveFileExists, canonicalArchiveName, removeArchiveFile, statArchiveFile } from './archive-io.js';
import { parseGuarded } from './conversation-guard.js';
import { shouldIndexExchange } from './noise.js';
import { backupExchangeRows, newBackupPath } from './row-backup.js';

export interface VerificationResult {
  /** Conversations with something to summarize and no summary file. Fixing one is an LLM call. */
  missingSummary: Array<{ path: string }>;
  /** Conversations with indexable exchanges and no row in the index. */
  notIndexed: Array<{ path: string }>;
  /**
   * Index rows whose archive file is gone from disk (neither `.jsonl` nor
   * `.jsonl.zst`). Reported only — repair deletes them just with pruneMissing.
   */
  orphaned: Array<{ uuid: string; path: string }>;
  /** Conversations changed after they were indexed, holding an exchange the index does not have. */
  outdated: Array<{ path: string; fileTime: number; dbTime: number }>;
  /** Files that could not be read to the end — never re-indexed, never judged "clean". */
  corrupted: Array<{ path: string; error: string }>;
  /** What the repair thresholds are measured against. */
  totals: { exchanges: number; conversations: number };
}

/**
 * The conversation files verify, repair and rebuild look at: every `.jsonl`
 * (plain or `.zst`, canonical name) directly inside a project folder of the
 * archive that is not excluded. Sub-folders are not descended into — rows
 * indexed from files below that level are never judged by this listing (their
 * file is checked on disk instead) and never re-created by a re-index.
 */
export function listArchiveConversations(
  opts: { onExcludedProject?: (project: string) => void } = {},
): Array<{ project: string; path: string }> {
  const archiveDir = getArchiveDir();
  const out: Array<{ project: string; path: string }> = [];
  if (!fs.existsSync(archiveDir)) return out;
  const excludedProjects = getExcludedProjects();

  for (const project of fs.readdirSync(archiveDir)) {
    if (isExcludedProject(project, excludedProjects)) {
      opts.onExcludedProject?.(project);
      continue;
    }

    const projectPath = path.join(archiveDir, project);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    // Archive files may be compressed out-of-band (.jsonl.zst) — canonicalize
    // to the .jsonl name the database stores.
    const files = [...new Set(
      fs.readdirSync(projectPath)
        .filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'))
        .map(f => canonicalArchiveName(f)),
    )];
    for (const file of files) out.push({ project, path: path.join(projectPath, file) });
  }
  return out;
}

export async function verifyIndex(): Promise<VerificationResult> {
  const result: VerificationResult = {
    missingSummary: [],
    notIndexed: [],
    orphaned: [],
    outdated: [],
    corrupted: [],
    totals: { exchanges: 0, conversations: 0 }
  };

  const archiveDir = getArchiveDir();

  // Find all conversation files
  if (!fs.existsSync(archiveDir)) {
    return result;
  }

  // Initialize database once for all checks
  const db = initDatabase();

  try {
    const conversations = listArchiveConversations({
      onExcludedProject: (project) => console.log("\nSkipping excluded project: " + project),
    });

    for (const { project, path: conversationPath } of conversations) {
      result.totals.conversations++;

      if (result.totals.conversations % 100 === 0) {
        console.log(`  Checked ${result.totals.conversations} conversations...`);
      }

      // One pass: parse + exclusion markers. A file that cannot be read is
      // "could not judge" — reported, and nothing else is concluded about it.
      let indexable;
      try {
        const { exchanges, excluded } = await parseGuarded(conversationPath, project, conversationPath);
        if (excluded) continue; // opted out: nothing to index, nothing to summarize
        indexable = exchanges.filter(shouldIndexExchange);
      } catch (error) {
        result.corrupted.push({
          path: conversationPath,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      // Nothing a repair would index or summarize (no exchange yet, or only
      // worker prompts / machine noise): neither "missing" nor "not indexed".
      // Counting these made repair plan one LLM summary per warm-up file.
      if (indexable.length === 0) continue;

      const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
      if (!archiveFileExists(summaryPath)) {
        result.missingSummary.push({ path: conversationPath });
      }

      const lastIndexed = getFileLastIndexed(db, conversationPath);
      if (lastIndexed === null) {
        result.notIndexed.push({ path: conversationPath });
        continue;
      }

      // Outdated = modified after last_indexed AND holding an exchange the
      // index lacks. The mtime alone is not enough: indexing skips exchanges
      // that are already current, so a file that grew by a line that forms
      // no new exchange keeps its old last_indexed.
      const fileStat = statArchiveFile(conversationPath);
      if (fileStat && fileStat.mtimeMs > lastIndexed && indexable.some(e => !isExchangeCurrent(db, e.id))) {
        result.outdated.push({
          path: conversationPath,
          fileTime: fileStat.mtimeMs,
          dbTime: lastIndexed
        });
      }
    }

    console.log(`Verified ${result.totals.conversations} conversations.`);

    // Orphaned rows: the file each indexed path points at is checked ON DISK,
    // path by path. The walk above only lists the top level of each project
    // folder, while the index also holds deeper paths
    // (<project>/<session>/subagents/agent-*.jsonl) — "not in my listing" once
    // judged 131,380 rows (38% of one index) orphaned, 121,971 of them with
    // their file sitting right there.
    result.totals.exchanges = (db.prepare('SELECT count(*) AS n FROM exchanges').get() as { n: number }).n;
    const indexedPaths = db.prepare('SELECT DISTINCT archive_path AS p FROM exchanges').all() as Array<{ p: string }>;
    const idsOfPath = db.prepare('SELECT id FROM exchanges WHERE archive_path = ?');
    for (const { p } of indexedPaths) {
      if (archiveFileExists(p)) continue;
      for (const row of idsOfPath.all(p) as Array<{ id: string }>) {
        result.orphaned.push({ uuid: row.id, path: p });
      }
    }
  } finally {
    db.close();
  }

  return result;
}

export interface RepairOptions {
  /** Delete index rows whose archive file is gone (backed up first). Default: report them only. */
  pruneMissing?: boolean;
  /** Make no summary (LLM) call. */
  noSummaries?: boolean;
  /** Go ahead although a count of the plan is over its threshold. */
  yes?: boolean;
}

/** A count needs `yes` when it is over BOTH this share of the total and the floor. */
export const REPAIR_THRESHOLD_RATIO = 0.05;
/** Chosen, not measured: below this many items a share of a small index means nothing. */
export const REPAIR_THRESHOLD_FLOOR = 20;

export interface RepairPlan {
  /** Rows whose file is gone. */
  missingFileRows: number;
  /** Of those, rows this run deletes (0 unless pruneMissing). */
  deleteRows: number;
  /** Conversations to parse and index (not indexed + outdated). */
  reindexFiles: number;
  /** Summary (LLM) calls: no summary file + outdated (0 with noSummaries). */
  summaryCalls: number;
  totals: { exchanges: number; conversations: number };
  /** One line per count over its threshold; empty = the plan runs without `yes`. */
  overThreshold: string[];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function planRepair(issues: VerificationResult, opts: RepairOptions = {}): RepairPlan {
  const reindex = unique([...issues.notIndexed.map(n => n.path), ...issues.outdated.map(o => o.path)]);
  const summarize = opts.noSummaries
    ? []
    : unique([...issues.missingSummary.map(m => m.path), ...issues.outdated.map(o => o.path)]);
  const plan: RepairPlan = {
    missingFileRows: issues.orphaned.length,
    deleteRows: opts.pruneMissing ? issues.orphaned.length : 0,
    reindexFiles: reindex.length,
    summaryCalls: summarize.length,
    totals: issues.totals,
    overThreshold: [],
  };
  const check = (count: number, total: number, what: string, of: string) => {
    const limit = Math.max(REPAIR_THRESHOLD_FLOOR, Math.floor(total * REPAIR_THRESHOLD_RATIO));
    if (count > limit) {
      plan.overThreshold.push(`${what}: ${count} is over ${limit} (${REPAIR_THRESHOLD_RATIO * 100}% of ${total} ${of}, at least ${REPAIR_THRESHOLD_FLOOR})`);
    }
  };
  check(plan.deleteRows, plan.totals.exchanges, 'rows to delete', 'indexed exchanges');
  check(plan.reindexFiles, plan.totals.conversations, 'conversations to re-index', 'archived conversations');
  check(plan.summaryCalls, plan.totals.conversations, 'summary (LLM) calls', 'archived conversations');
  return plan;
}

export function formatRepairPlan(plan: RepairPlan, opts: RepairOptions = {}): string[] {
  return [
    'Repair plan:',
    `  index rows whose file is gone: ${plan.missingFileRows}` + (
      plan.missingFileRows === 0 ? ''
        : opts.pruneMissing ? ` — ${plan.deleteRows} will be backed up, then deleted (--prune-missing)`
          : ' — kept (reported only; pass --prune-missing to back them up and delete them)'),
    `  conversations to re-index: ${plan.reindexFiles}`,
    `  summary (LLM) calls: ${plan.summaryCalls}` + (opts.noSummaries ? ' (--no-summaries)' : ''),
    `  index size: ${plan.totals.exchanges} exchanges, ${plan.totals.conversations} archived conversations`,
  ];
}

/** Thrown before anything is changed when the plan is over a threshold and `yes` was not given. */
export class RepairAbortedError extends Error {
  constructor(public readonly plan: RepairPlan) {
    super(`repair stopped before changing anything — ${plan.overThreshold.join('; ')}. Re-run with --yes to go ahead.`);
    this.name = 'RepairAbortedError';
  }
}

export interface RepairOutcome {
  plan: RepairPlan;
  deletedRows: number;
  /** Backup of the deleted rows, null when nothing was deleted. */
  backupPath: string | null;
  reindexedFiles: number;
  indexedExchanges: number;
  summariesWritten: number;
  /** Conversations left alone: excluded project or exclusion marker. */
  skippedFiles: number;
  failed: Array<{ path: string; error: string }>;
}

export async function repairIndex(issues: VerificationResult, opts: RepairOptions = {}): Promise<RepairOutcome> {
  const plan = planRepair(issues, opts);
  for (const line of formatRepairPlan(plan, opts)) console.log(line);
  if (plan.overThreshold.length > 0 && !opts.yes) {
    throw new RepairAbortedError(plan);
  }

  console.log('Repairing index...');

  // To avoid circular dependencies, we import the indexer functions dynamically
  const { indexExchanges } = await import('./index-exchanges.js');
  const { summarizeConversation, REFUSED_SUMMARY } = await import('./summarizer.js');

  const outcome: RepairOutcome = {
    plan, deletedRows: 0, backupPath: null, reindexedFiles: 0, indexedExchanges: 0,
    summariesWritten: 0, skippedFiles: 0, failed: [],
  };
  const db = initDatabase();

  try {
    // Rows whose file is gone: only on request, and only after a backup that
    // holds every row about to go.
    if (opts.pruneMissing && issues.orphaned.length > 0) {
      // Judge again right before deleting: verify may be minutes old, and a
      // file that is back (re-synced, decompressed) keeps its rows.
      const stillMissing = issues.orphaned.filter(o => !archiveFileExists(o.path));
      if (stillMissing.length > 0) {
        const ids = stillMissing.map(o => o.uuid);
        const backupPath = newBackupPath('prune-missing');
        const backedUp = backupExchangeRows(db, ids, backupPath);
        console.log(`Backed up ${backedUp.exchanges} exchange row(s) and ${backedUp.toolCalls} tool call(s) to ${backupPath}`);
        outcome.backupPath = backupPath;
        outcome.deletedRows = deleteExchanges(db, ids);
        console.log(`Deleted ${outcome.deletedRows} index row(s) whose archive file is gone`);
      }
    } else if (issues.orphaned.length > 0) {
      console.log(`${issues.orphaned.length} index row(s) point at a file that is gone — kept (run with --prune-missing to back them up and delete them)`);
    }

    // Re-index what is not indexed or outdated; summarize what has no summary
    // (and, as before, refresh the summary of an outdated conversation).
    const toReindex = new Set([...issues.notIndexed.map(n => n.path), ...issues.outdated.map(o => o.path)]);
    const toSummarize = new Set(opts.noSummaries
      ? []
      : [...issues.missingSummary.map(m => m.path), ...issues.outdated.map(o => o.path)]);
    const excludedProjects = getExcludedProjects();
    const archiveDir = getArchiveDir();

    for (const conversationPath of unique([...toReindex, ...toSummarize])) {
      console.log(`${toReindex.has(conversationPath) ? 'Re-indexing' : 'Summarizing'}: ${conversationPath}`);
      try {
        // Extract project name from path
        const relativePath = conversationPath.replace(archiveDir + path.sep, '');
        const project = relativePath.split(path.sep)[0];

        // The same guards sync applies: excluded project, exclusion marker,
        // and (inside indexExchanges) worker prompts and machine noise.
        if (isExcludedProject(project, excludedProjects)) {
          console.log(`  Skipped (excluded project)`);
          outcome.skippedFiles++;
          continue;
        }
        const { exchanges, excluded } = await parseGuarded(conversationPath, project, conversationPath);
        if (excluded) {
          console.log(`  Skipped (exclusion marker)`);
          outcome.skippedFiles++;
          continue;
        }
        const indexable = exchanges.filter(shouldIndexExchange);

        if (indexable.length === 0) {
          console.log(`  Skipped (no exchanges)`);
          outcome.skippedFiles++;
          continue;
        }

        // Generate/update summary
        // A failed summary must not block re-indexing the exchanges. The stale
        // summary is removed (plain and compressed): kept, it would never be
        // redone, since the file exists and the exchanges are indexed as current
        // again. A missing one is written by the next sync while the source
        // conversation is still in the projects dir, else by the next repair.
        if (toSummarize.has(conversationPath)) {
          const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
          try {
            const summary = await summarizeConversation(indexable);
            if (summary === REFUSED_SUMMARY && archiveFileExists(summaryPath)) {
              // An older summary of this conversation beats the refusal marker.
              console.log(`  Summary refused, keeping the existing one`);
            } else {
              fs.writeFileSync(summaryPath, summary, 'utf-8');
              outcome.summariesWritten++;
              console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
            }
          } catch (error) {
            removeArchiveFile(summaryPath);
            console.error(`  Summary failed (re-indexing continues; the summary is redone later): ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Index exchanges
        if (toReindex.has(conversationPath)) {
          const indexed = await indexExchanges(db, indexable);
          outcome.reindexedFiles++;
          outcome.indexedExchanges += indexed.indexed;
          console.log(`  Indexed ${indexed.indexed} exchanges (${indexed.unchanged} already current)`);
        }
      } catch (error) {
        outcome.failed.push({ path: conversationPath, error: error instanceof Error ? error.message : String(error) });
        console.error(`Failed to re-index ${conversationPath}:`, error);
      }
    }
  } finally {
    db.close();
  }

  // Report corrupted files (manual intervention needed)
  if (issues.corrupted.length > 0) {
    console.log('\n⚠️  Unreadable files (manual review needed):');
    issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
  }

  console.log(outcome.failed.length > 0
    ? `⚠️  Repair finished with ${outcome.failed.length} failed conversation(s).`
    : '✅ Repair complete.');
  return outcome;
}
