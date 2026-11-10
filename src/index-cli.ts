#!/usr/bin/env node
import { verifyIndex, repairIndex, RepairAbortedError } from './verify.js';
import { indexSession, indexUnprocessed, indexConversations } from './indexer.js';
import { parseCliArgs } from './cli-args.js';
import { rebuildConversationIndex, RebuildNotConfirmedError, RebuildWouldLoseIndexError } from './rebuild.js';

const command = process.argv[2];

// Parse --concurrency flag from remaining args
function getConcurrency(): number {
  const concurrencyIndex = process.argv.findIndex(arg => arg === '--concurrency' || arg === '-c');
  if (concurrencyIndex !== -1 && process.argv[concurrencyIndex + 1]) {
    const value = parseInt(process.argv[concurrencyIndex + 1], 10);
    if (value >= 1 && value <= 16) return value;
  }
  return 1; // default
}

// Parse --no-summaries flag
function getNoSummaries(): boolean {
  return process.argv.includes('--no-summaries');
}

const concurrency = getConcurrency();
const noSummaries = getNoSummaries();

/**
 * Arguments of the commands that delete or empty things. Strict: an unknown or
 * misspelled flag stops the command instead of being ignored — `--prune-mising`
 * must not run a repair that silently keeps the rows, and `--yse` must not be
 * read as "no --yes given, but go on anyway".
 */
function strictArgs(flags: string[]) {
  try {
    return parseCliArgs(process.argv.slice(3), { flags, values: ['--concurrency', '-c'] });
  } catch (error) {
    // A typo is the user's to fix, not a crash: the message and what is accepted, no stack.
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Accepted for ${command}: ${flags.join(' ')}`);
    process.exit(1);
  }
}

async function main() {
  try {
    switch (command) {
      case 'index-session':
        const sessionId = process.argv[3];
        if (!sessionId) {
          console.error('Usage: index-cli index-session <session-id>');
          process.exit(1);
        }
        await indexSession(sessionId, concurrency, noSummaries);
        break;

      case 'index-cleanup':
        await indexUnprocessed(concurrency, noSummaries);
        break;

      case 'verify': {
        console.log('Verifying conversation index...');
        const issues = await verifyIndex();

        console.log('\n=== Verification Results ===');
        console.log(`Not indexed: ${issues.notIndexed.length}`);
        console.log(`Outdated files: ${issues.outdated.length}`);
        console.log(`Missing summaries: ${issues.missingSummary.length}`);
        console.log(`Index rows whose file is gone: ${issues.orphaned.length} (of ${issues.totals.exchanges})`);
        console.log(`Unreadable files: ${issues.corrupted.length}`);

        if (issues.notIndexed.length > 0) {
          console.log('\nNot indexed:');
          issues.notIndexed.forEach(m => console.log(`  ${m.path}`));
        }
        if (issues.missingSummary.length > 0) {
          console.log('\nMissing summaries:');
          issues.missingSummary.forEach(m => console.log(`  ${m.path}`));
        }
        if (issues.corrupted.length > 0) {
          console.log('\nUnreadable files:');
          issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
        }

        if (issues.notIndexed.length + issues.missingSummary.length + issues.orphaned.length + issues.outdated.length + issues.corrupted.length > 0) {
          console.log('\nRun with --repair to re-index and summarize; it prints its plan (rows, files, LLM calls) first.');
          console.log('Rows whose file is gone are only reported. --repair --prune-missing backs them up and deletes them.');
          process.exit(1);
        } else {
          console.log('\n✅ Index is healthy!');
        }
        break;
      }

      case 'repair': {
        const args = strictArgs(['--prune-missing', '--yes', '--no-summaries']);
        const repairOptions = {
          pruneMissing: args.flags.has('--prune-missing'),
          yes: args.flags.has('--yes'),
          noSummaries: args.flags.has('--no-summaries'),
        };
        console.log('Verifying conversation index...');
        const repairIssues = await verifyIndex();

        const work = repairIssues.notIndexed.length + repairIssues.outdated.length
          + (repairOptions.noSummaries ? 0 : repairIssues.missingSummary.length)
          + (repairOptions.pruneMissing ? repairIssues.orphaned.length : 0);
        if (work > 0) {
          const outcome = await repairIndex(repairIssues, repairOptions);
          if (outcome.failed.length > 0) process.exit(1);
        } else {
          if (repairIssues.orphaned.length > 0) {
            console.log(`${repairIssues.orphaned.length} index row(s) point at a file that is gone — kept (run with --prune-missing to back them up and delete them)`);
          }
          console.log('✅ No issues to repair!');
        }
        break;
      }

      case 'rebuild': {
        const args = strictArgs(['--yes', '--no-summaries', '--reset-summaries', '--allow-index-loss']);
        console.log('Rebuilding the conversation index (facts, ontology and tags are preserved)...');
        const rebuilt = await rebuildConversationIndex({
          yes: args.flags.has('--yes'),
          allowIndexLoss: args.flags.has('--allow-index-loss'),
          resetSummaries: args.flags.has('--reset-summaries'),
        });
        if (rebuilt.reindex.failed.length > 0) {
          console.error('Some conversations failed to index. Run --repair to retry them.');
          process.exit(1);
        }
        break;
      }

      case 'index-all':
      default:
        await indexConversations(undefined, undefined, concurrency, noSummaries);
        break;
    }
  } catch (error) {
    if (error instanceof RepairAbortedError || error instanceof RebuildNotConfirmedError || error instanceof RebuildWouldLoseIndexError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('Error:', error);
    }
    process.exit(1);
  }
}

main();
