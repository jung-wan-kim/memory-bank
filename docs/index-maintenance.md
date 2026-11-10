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

An interrupted rebuild is finished by running it again. Until then text search
uses its slower scan path (the text index is marked "not built" for the
duration of the clear), and what was not re-indexed yet shows up in `--verify`.

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

Run by hand; none of them runs automatically. Every one of them

- defaults to a **dry run on a read-only connection** — it reports what it
  would change and cannot write;
- stops on an unknown flag, and on a flag that belongs to another of its modes
  (a typo of `--apply` must not look like a dry run that found nothing);
- changes rows only with `--apply`, and first writes what it is about to
  change to a place it can be put back from.

| Script | `--apply` changes | Put back with |
|--------|-------------------|---------------|
| `purge-llm-sessions.mjs` | deletes exchanges that should never have been indexed | the backup file (no undo command) |
| `dedupe-exchange-snapshots.mjs` | deletes the older snapshots of one turn | the backup file (no undo command) |
| `requeue-zero-markers.mjs` | removes "done, 0 facts" markers written before the session was indexed | `--undo FILE` |
| `redact-secret-facts.mjs` | deactivates facts that carry a credential-shaped string | `--undo FILE` |
| `dedupe-exact-facts.mjs` | deactivates same-scope facts with the same sentence | `--restore TABLE` |
| `reembed-rewritten-facts.mjs` | rewrites the vector of facts whose sentence was rewritten | `--restore TABLE` |

The last four take `--db PATH` for a database other than the live one.

### Conversation index

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

Neither has an undo command: the deleted rows are in the backup file, and
embeddings are not backed up (they are re-created from the text). After a large
purge the freed pages stay in the file until a `VACUUM`, and `vec_exchanges`
keeps its deleted slots (it is not compacted automatically).

### Extraction queue: `requeue-zero-markers.mjs`

Until the SessionEnd worker indexed the session itself, extraction could run
against an index that did not hold the session yet, find nothing, and write a
"done, 0 facts" marker — which keeps the session out of the backfill for good.
This script removes those markers; the backfill worker then extracts the
sessions like any other pending session.

```bash
node scripts/requeue-zero-markers.mjs [--db PATH]                                         # dry run: counts only
node scripts/requeue-zero-markers.mjs [--db PATH] --apply [--limit N] [--undo-file PATH]  # remove the markers, newest sessions first
node scripts/requeue-zero-markers.mjs [--db PATH] --undo FILE                             # put them back
```

- A marker is removed only when all of this holds: it says 0 extracted / 0
  saved with no dropped batch and no "exchanges read" count; every main-chain
  exchange of the session was indexed after the marker was written; without the
  marker the session is pending by the backfill's own rule (enough exchanges,
  not an excluded project) and the extractor would not exclude it straight
  away; and no stored fact names one of the session's exchanges as its source
  (an earlier extraction did save facts — extracting again would store them
  twice).
- `--apply` writes every marker row it is about to remove to the undo file
  before any row changes — `requeue-zero-markers-undo-<UTC time>.jsonl` next to
  the database unless `--undo-file` names another path (an existing file is
  refused). If the file cannot be written, no row changes.
- `--undo FILE` puts the markers back for the sessions nothing has touched
  since (no marker and no claim today) and says how many it left alone.
- **Cost.** Each requeued session is extracted by the backfill worker: up to
  `MEMORY_BANK_MAX_EXTRACT_CALLS` LLM calls per session plus one
  classification call per saved fact, `BACKFILL_EXTRACT_MAX` sessions per run,
  once the session has been quiet for `BACKFILL_QUIET_MINUTES`. Use `--limit`.

### Facts

```bash
# facts that carry a credential-shaped string
node scripts/redact-secret-facts.mjs [--db PATH]                              # dry run: id, kind of credential, active/inactive
node scripts/redact-secret-facts.mjs [--db PATH] --apply [--undo-file PATH]   # deactivate the active ones
node scripts/redact-secret-facts.mjs [--db PATH] --undo FILE                  # put back what that run changed

# same-scope facts with the same sentence
node scripts/dedupe-exact-facts.mjs [--db PATH] [--list]                      # dry run: group counts (--list: one line per group)
node scripts/dedupe-exact-facts.mjs [--db PATH] --apply --counts sum|keep
node scripts/dedupe-exact-facts.mjs [--db PATH] --restore TABLE

# facts whose vector still describes a sentence consolidation rewrote (≤1.7.9)
node scripts/reembed-rewritten-facts.mjs [--db PATH]                          # dry run: embeds the candidates, reports how many are stale
node scripts/reembed-rewritten-facts.mjs [--db PATH] --apply --fact-kr clear|keep
node scripts/reembed-rewritten-facts.mjs [--db PATH] --restore TABLE
```

- `redact-secret-facts.mjs` — a fact with a credential-shaped string (an API
  key, a bot token, a private key block, …) is refused when it is stored or
  imported; this script is for rows stored before that check existed. **Run the
  dry run once after upgrading from 1.7.9 or earlier.** It prints the fact id
  and the kind of credential, never the text. `--apply` sets `is_active = 0`
  after writing each row's previous `is_active` / `updated_at` to the undo file
  (`redact-secret-facts-undo-<UTC time>.jsonl` next to the database unless
  `--undo-file` names another path). A deactivated fact is no longer injected,
  found by search, or listed by the next sync export — the export file already
  on disk still has it until that next export. The text stays in the row, and
  the credential is still leaked: **rotate it.** `--undo FILE` reactivates the
  rows that are still as that run left them.
- `dedupe-exact-facts.mjs` — merges active facts of one scope whose sentences
  are equal after collapsing whitespace and case. No LLM and no embedding
  model; the oldest fact of a group stays and the rest are deactivated (nothing
  is deleted). `--apply` must say what happens to the confirmation counts:
  `--counts sum` gives the survivor the removed facts' confirmations (the
  largest groups are session boilerplate — summed, exactly those rise to the
  top of the session-start facts), `--counts keep` leaves its own count.
  Sources are united either way; ontology relations of a deactivated fact are
  not re-pointed. Every changed row is copied to a backup table in the same
  transaction (`dedupe_exact_backup_<UTC time>`, printed at the end);
  `--restore TABLE` undoes the run, leaving alone the rows changed since.
- `reembed-rewritten-facts.mjs` — up to 1.7.9 consolidation rewrote a fact's
  sentence without re-embedding it. The dry run embeds each candidate's
  sentence with the local model and compares it with the stored vector, so a
  fact whose vector already matches is never touched. `--apply` must say what
  to do with the Korean sentence of a repaired fact: `--fact-kr clear` removes
  `fact_kr` and its vector (they were written for the old sentence;
  `scripts/translate-facts.mjs` fills it again, with LLM calls), `--fact-kr
  keep` leaves them. The old bytes of every changed row go to a backup table
  first (`reembed_rewritten_backup_<UTC time>`); `--restore TABLE` puts them
  back for the facts whose sentence has not changed since.
