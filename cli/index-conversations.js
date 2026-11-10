#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

function runScript(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '../dist/index-cli.js'), command, ...args], {
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

function showHelp() {
  console.log(`index-conversations - Index and manage conversation archives

USAGE:
  index-conversations [COMMAND] [OPTIONS]

COMMANDS:
  (default)      Index all conversations
  --cleanup      Process only unindexed conversations (fast, cheap)
  --session ID   Index specific session (used by hook)
  --verify       Check index health (read-only)
  --repair       Re-index and summarize what --verify found (prints its plan first)
  --rebuild      Empty the conversation index and re-create it from the archive.
                 Facts, ontology and tags are preserved (requires confirmation)

OPTIONS:
  --concurrency N    Parallel summarization (1-16, default: 1)
  -c N               Short form of --concurrency
  --no-summaries     Skip AI summary generation (free, but no summaries in results)
  --help, -h         Show this help

REPAIR OPTIONS:
  --prune-missing    Also delete index rows whose archive file is gone
                     (they are backed up first; without it they are only reported)
  --yes              Go ahead although a count of the plan is over its limit:
                       rows to delete             5% of the indexed exchanges
                       conversations to re-index  5% of the conversations that
                                                  hold something to index
                       summary (LLM) calls        the same 5%, and never more
                                                  than 100 calls
                     (each limit is at least 20). Without --yes the repair
                     stops before changing anything and prints the count.

REBUILD:
  Close the other Claude Code sessions before a rebuild. Before anything is
  cleared it prints what is cleared and how much of it can be re-created
  ("Cleared: N exchanges, ..." / "at most M of the N cleared exchanges ..."),
  reads every indexed archive conversation to its end (a file that cannot be
  read counts as not re-creatable) and, with --allow-index-loss, backs up the
  rows that will not come back. If another process indexes one of those files
  while that backup is being written, the rebuild ends with
  "rebuild stopped — nothing was cleared": close the other sessions and run
  it again.

REBUILD OPTIONS:
  --allow-index-loss Clear exchanges that cannot be re-created too. A rebuild
                     re-reads the conversation files directly inside each
                     archive project folder; exchanges indexed from anywhere
                     else (sub-folders, files no longer archived) would be gone
                     for good, so without this flag such a rebuild is refused.
  --reset-summaries  Also delete every summary file (re-made later, one LLM call each).
                     A rebuild itself makes no summary call; existing summaries stay.

EXAMPLES:
  # Index all unprocessed (recommended for backfill)
  index-conversations --cleanup

  # Index with 8 parallel summarizations (8x faster)
  index-conversations --cleanup --concurrency 8

  # Index without AI summaries (free, fast)
  index-conversations --cleanup --no-summaries

  # Check index health
  index-conversations --verify

  # Fix any issues found (re-index + summaries; nothing is deleted)
  index-conversations --repair

  # Re-create the conversation index from the archive (facts are kept)
  index-conversations --rebuild

WORKFLOW:
  1. Initial setup: index-conversations --cleanup
  2. Ongoing: Auto-indexed by sessionEnd hook
  3. Health check: index-conversations --verify (weekly)
  4. Recovery: index-conversations --repair (if issues found)

SEE ALSO:
  docs/index-maintenance.md (in the plugin repository) - what --verify, --repair
  and --rebuild read, change and refuse to do`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;

      case undefined:
        await runScript('index-all', args);
        break;

      case '--session':
        await runScript('index-session', args);
        break;

      case '--cleanup':
        await runScript('index-cleanup', args);
        break;

      case '--verify':
        await runScript('verify', args);
        break;

      case '--repair':
        await runScript('repair', args);
        break;

      case '--rebuild':
        console.log('⚠️  This will EMPTY the conversation index (exchanges, tool calls, vectors, text index)');
        console.log('   and re-create it from the conversation archive.');
        console.log('   If some indexed exchanges cannot be re-created from the archive, the rebuild');
        console.log('   stops before changing anything and says how many (--allow-index-loss overrides).');
        console.log('   Facts are preserved — facts, ontology, relations and tags are not touched,');
        console.log('   and a backup of them is written first. Only the conversation index is regenerated.');
        console.log('   Close the other Claude Code sessions first: if another process indexes while the');
        console.log('   backup is being written, the rebuild ends with "rebuild stopped — nothing was cleared".');
        const confirmed = await askConfirmation('Are you sure? [yes/NO]: ');
        if (confirmed) {
          await runScript('rebuild', ['--yes', ...args.filter((a) => a !== '--yes')]);
        } else {
          console.log('Cancelled');
        }
        break;

      default:
        await runScript('index-all', [command, ...args]);
        break;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
