# Index maintenance commands

What each maintenance command reads, changes and refuses to do. One rule runs
through all of them: **nothing is deleted without its own flag, and a backup is
written and counted before any delete.**

The database (`conversation-index/db.sqlite`) holds two things that are not
alike:

| Side | Tables | Can it be re-created? |
|------|--------|-----------------------|
| Conversation index | `exchanges`, `tool_calls`, `vec_exchanges`, `exchanges_fts` | From the conversation archive — but only for files the indexer reads (see "What a re-index reads") |
| Fact layer | `facts`, `fact_revisions`, `ontology_*`, `extraction_log`, fact vectors | **No.** Extracted by LLM calls over months; tags are typed by the user |

## `index-conversations --verify`

Read-only apart from opening the database. Reports five separate findings:

- **Not indexed** — an archive conversation with indexable exchanges and no row.
- **Outdated** — changed after it was indexed *and* holding an exchange the
  index lacks (a newer mtime alone is not enough).
- **Missing summaries** — has something to summarize and no summary file.
- **Index rows whose file is gone** — the file each indexed path points at is
  checked on disk, plain and `.zst`, wherever it is (sub-folders included).
- **Unreadable files** — could not be read to the end; nothing else is
  concluded about them.

Conversations that carry an exclusion marker, and files that hold nothing
indexable (no exchange yet, only the plugin's own worker prompts, only machine
noise such as agent warm-up turns), are in none of the lists.

## `index-conversations --repair [--prune-missing] [--no-summaries] [--yes]`

Runs verify, prints a plan (rows to delete, conversations to re-index, summary
LLM calls), then:

- re-indexes what is not indexed or outdated — through the same guards as sync
  (excluded project, exclusion marker, worker prompts, machine noise), skipping
  exchanges that are already indexed;
- writes the missing summaries (and refreshes the summary of an outdated
  conversation) unless `--no-summaries`;
- **keeps** rows whose file is gone, unless `--prune-missing`: then they are
  copied to `conversation-index/backups/prune-missing-<timestamp>.sqlite`
  (exchanges + tool calls), re-checked on disk, and deleted.

If a count of the plan is over 5% of the index (and over 20), the repair stops
before changing anything; `--yes` runs it anyway. A mistyped flag stops the
command.

## `index-conversations --rebuild [--allow-index-loss] [--reset-summaries]`

Empties the conversation index **in place** and re-creates it from the archive.
The database file is never deleted, and the fact layer is not written.

1. Prints what is preserved (facts, tagged facts, relations, …), what is
   cleared, how many archive conversations the re-index will read, and how many
   indexed exchanges it could **not** re-create.
2. Without `--yes` (the `index-conversations` wrapper passes it after its
   confirmation prompt) it stops here.
3. If any indexed exchange could not be re-created, it stops here too, unless
   `--allow-index-loss` — in which case those rows are first copied to
   `backups/pre-rebuild-unreachable-exchanges-<timestamp>.sqlite`.
4. Copies the fact layer to `backups/pre-rebuild-facts-<timestamp>.sqlite`.
5. Clears `tool_calls` and `exchanges` in batches of 2,000 (other processes keep
   reading and writing in between), swaps `vec_exchanges` for an empty table of
   the same definition, rebuilds the text index, and checks that the fact layer
   counts did not move.
6. Re-indexes the archive through the repair path. No summary is written or
   deleted (`--reset-summaries` deletes them all; sync and `--repair` write
   them back, one LLM call each).

An interrupted rebuild is finished with `--repair` (or by running it again).

### What a re-index reads

`--repair` and `--rebuild` read the `*.jsonl` / `*.jsonl.zst` files directly
inside each project folder of the archive, minus excluded projects. Exchanges
indexed from anywhere else — sub-agent transcripts under
`<project>/<session>/subagents/`, files that are no longer in the archive — are
left alone by verify and repair, and are exactly what `--rebuild` refuses to
clear without `--allow-index-loss`.

## Session-start maintenance (automatic)

`scripts/session-start-maintenance.js`, at most once per
`MEMORY_BANK_MAINTENANCE_INTERVAL_MIN`. Each run appends one line to
`conversation-index/logs/maintenance.jsonl`:

| Field | Step |
|-------|------|
| `vec_reconcile` | Per fact vector table: vectors removed because their fact is inactive or gone, vectors written back from `facts.embedding` for active facts that had none, and active facts that still have none |
| `compaction` | Fact vector tables rebuilt without deleted slots |
| `analyze` | `ANALYZE` of the fact and ontology tables (sample capped at 1,000 rows per index); never the conversation tables |
| `probes`, `spawned` | Pending-work checks and the workers started for them |

## One-time cleanup scripts

Both default to a **dry run on a read-only connection** and stop on an unknown
flag. Neither is run automatically.

```bash
# exchanges that should never have been indexed
node scripts/purge-llm-sessions.mjs                       # slug family (the plugin's own worker sessions)
node scripts/purge-llm-sessions.mjs --legacy-prompts      # + worker prompts indexed under real project slugs
node scripts/purge-llm-sessions.mjs --warmup --observer   # + agent warm-up turns and observer prompts
node scripts/purge-llm-sessions.mjs --warmup --observer --apply

# duplicate snapshots of one turn left by older builds
node scripts/dedupe-exchange-snapshots.mjs
node scripts/dedupe-exchange-snapshots.mjs --apply [--create-index]
```

- `purge-llm-sessions.mjs --apply` appends the rows it deletes to
  `conversation-index/purge-llm-backup.sqlite`, then looks the deleted ids up
  again in `exchanges`, `tool_calls` and the vector index (exit 1 if anything
  is left). Facts extracted from purged exchanges keep those ids in
  `source_exchange_ids`; decide what to do with such facts first.
- `dedupe-exchange-snapshots.mjs --apply` keeps, per `(archive_path,
  line_start)`, the row with the largest `line_end`, points facts that named a
  removed row at it, and backs up rows, id map and the facts' original sources
  to `backups/dedupe-snapshots-<timestamp>.sqlite`. `--create-index` also
  builds the `(archive_path, line_start)` index that new databases are created
  with — on a large index that reads the whole `exchanges` table under the
  write lock, so run it when nothing else uses the database.

After a large purge the freed pages stay in the file until a `VACUUM`, and
`vec_exchanges` keeps its deleted slots (it is not compacted automatically).
