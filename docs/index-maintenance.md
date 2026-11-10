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
  index lacks (a newer mtime alone is not enough), or holding a turn the index
  has only a shorter snapshot of (whatever the mtime says).
- **Missing summaries** — has something to summarize and no summary file.
- **Index rows whose file is gone** — the file each indexed path points at is
  checked on disk, plain and `.zst`, wherever it is (sub-folders included).
- **Unreadable files** — could not be read to the end; nothing else is
  concluded about them. A `.zst` archive that stops inside a frame is one of
  them: it is not read as a shorter conversation.

Conversations that carry an exclusion marker, and files that hold nothing
indexable (no exchange yet, only the plugin's own worker prompts, only machine
noise such as agent warm-up turns), are in none of the lists.

One more line can appear above the results, and it is not a finding:

```
Compressed files with bytes after their last complete zstd frame: N (A to B bytes each) — read up to that frame; the bytes after it are not a frame and are ignored
```

These `.zst` files hold their conversation in complete frames and have a few
more bytes after the last one that do not begin a frame (on one measured
archive: 528 of 228,765 files, tails of 1 to 1,078 bytes). They are read up to
the last complete frame — by verify, repair, rebuild, search and `read` alike —
and are **not** counted as unreadable; the line only says how many there are
and how long the ignored tails are. What stays an unreadable file: one that
ends inside a frame, and one whose bytes after a complete frame *begin* like a
frame (the frame magic, or its first bytes) without being a whole one — that is
what a compressor leaves when it is interrupted.

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

The plan is checked before anything changes. Each count has its own total, and
a count over its limit stops the repair (`repair stopped before changing
anything — …`, with the count, the limit and the total it was measured
against); `--yes` runs it anyway:

| Count of the plan | Limit |
|-------------------|-------|
| rows to delete (`--prune-missing`) | 5% of the **indexed exchanges**, at least 20 |
| conversations to re-index | 5% of the **conversations with something to index**, at least 20 |
| summary (LLM) calls | 5% of the **conversations with something to index**, at least 20 and **at most 100** |

"Conversations with something to index" is not every file of the archive:
excluded conversations and files that hold only warm-up turns or observer
prompts are left out (the plan prints both numbers: `N archived conversations
(M with something to index)`). More than 100 summary calls always need `--yes`,
however large the archive — each one is a model call of 10-14 seconds. A
mistyped flag stops the command.

## `index-conversations --rebuild [--allow-index-loss] [--reset-summaries]`

Empties the conversation index **in place** and re-creates it from the archive.
The database file is never deleted. Of the fact layer one thing is written:
source ids that name an older copy of a turn are moved to the copy that comes
back (step 6) — no fact, relation, category or tag is added, removed or
reworded.

**Close the other Claude Code sessions first.** A rebuild clears every row, and
a session that keeps indexing meanwhile writes rows the rebuild has no copy of
(see step 5); the step that resets the vector table also holds the write lock
in one transaction (about 2 seconds on an index of 340,000 exchanges).

1. Prints what is preserved and what is cleared — two different numbers:

   ```
   Preserved: … facts (… active, … tagged), … relations, … revisions, … domains / … categories, … extraction log rows
   Cleared: N exchanges, … tool calls, … vectors
   Re-index source: C archive conversation(s) — at most M of the N cleared exchanges are indexed from them and can be re-created
     (fewer when today's indexing rules skip some of them: agent warm-up turns, observer sessions and the plugin's own worker prompts are not indexed again)
   Cleared and NOT re-created (file not among them): X exchanges from Y file(s)
   ```

   `M` is an upper bound (`N` minus `X`); how many of those rows today's rules
   index again is only known after the re-index.
2. Without `--yes` (the `index-conversations` wrapper passes it after its
   confirmation prompt) it stops here: `rebuild not confirmed — nothing was
   changed`.
3. Reads every archive conversation that has indexed rows **to its end**, the
   way the re-index will (`Reading the indexed conversations of the archive
   before anything is cleared...`, one progress line per 5,000). A file that
   cannot be read to the end — a `.zst` the compressor was interrupted on — is
   printed (`cannot be read to the end: <path> (<error>)`) and its rows are
   counted as not re-creatable: its path being in the archive does not mean
   its rows come back. This pass costs one read of those files (the re-index
   reads them again).
4. If any indexed exchange could not be re-created, it stops here too
   (`rebuild refused — nothing was changed. N indexed exchange(s) from M
   file(s) cannot be re-created …`, with the damaged files counted
   separately), unless `--allow-index-loss`.
5. Copies the fact layer to `backups/pre-rebuild-facts-<timestamp>.sqlite`
   and, with `--allow-index-loss`, the rows that will not come back to
   `backups/pre-rebuild-unreachable-exchanges-<timestamp>.sqlite`. Both copies
   read a snapshot and do not hold the write lock, so other processes keep
   writing while they are made — which is why the rebuild then counts the rows
   of those files again: if another process indexed one while its backup was
   being written, the rebuild stops with

   ```
   rebuild stopped — nothing was cleared. N exchange(s) of the files that cannot be re-created were indexed while their backup was being written (another process is writing to this database). Close the other Claude Code sessions and run the rebuild again.
   ```

   The backups it had written stay (the message names them). A row of such a
   file indexed later, *during* the clear, is cleared without a copy — the
   reason to close the other sessions before starting.
6. Points the facts that name an older copy of a turn at the copy the
   re-index re-creates. A turn that an older build indexed while its answer
   was still being written has several rows, each under its own id; the
   re-index makes one row per turn — the fullest copy — so a source id that
   names a shorter copy would point at nothing afterwards, and once the rows
   are cleared nothing says which turn it was. This is the step
   `dedupe-exchange-snapshots.mjs --apply` does, by the same function (the
   facts are found without the write lock and written 500 per transaction):

   ```
   Turns indexed more than once: T (R older copies) — F fact(s) that named an older copy now name the copy the re-index re-creates
   ```

   Only `facts.source_exchange_ids` changes (`updated_at` stays), and the lists
   as they were are in the fact-layer backup of step 5. If this step fails the
   rebuild stops with nothing cleared. Running `dedupe-exchange-snapshots.mjs
   --apply` before a rebuild is not needed for this; it does the same and also
   removes the older copies, which the rebuild is about to clear anyway.
7. Clears `tool_calls` and `exchanges` in batches of 2,000, pausing for other
   writers at least once a second; swaps `vec_exchanges` for an empty table of
   the same definition and rebuilds the text index (two transactions); and
   checks that the fact layer counts did not move.
8. Re-indexes the archive through the repair path. No summary is written or
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

**Run both with the other Claude Code sessions closed** (`--apply` only — the
dry runs just read). Their deletes go in short batches — 2,000 rows or 400ms,
whichever comes first, with a pause in between — so another process still
gets the write lock while rows are deleted. What that does not cover is in
each item below:

- `purge-llm-sessions.mjs --apply` appends the rows it deletes to
  `conversation-index/purge-llm-backup.sqlite`, then looks the deleted ids up
  again in `exchanges`, `tool_calls` and the vector index (exit 1 if anything
  is left). Facts extracted from purged exchanges keep those ids in
  `source_exchange_ids`; decide what to do with such facts first. Its backup
  is copied under the write lock in one transaction: for a large purge that
  is longer than the 5 seconds other processes wait, and their writes fail
  with "database is locked" meanwhile.
- `dedupe-exchange-snapshots.mjs --apply` keeps, per `(archive_path,
  line_start)`, the row with the largest `line_end`, points facts that named a
  removed row at it, and backs up rows, id map and the facts' original sources
  to `backups/dedupe-snapshots-<timestamp>.sqlite`. The facts are found
  without the write lock and written 500 per transaction (or until a batch has
  taken 400ms), each read again inside its batch, with a pause between
  batches — as one transaction that step held the write lock for 2 to 5
  seconds on a database of 46,000 facts. A session that indexes
  while it runs can leave duplicate rows the run did not see: it then ends
  with `WARNING: duplicate rows remain … run again` and exit 1. `--create-index`
  also builds the `(archive_path, line_start)` index that new databases are
  created with — on a large index that reads the whole `exchanges` table under
  the write lock.

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
- The survey that finds the markers runs without the write lock. `--apply`
  then judges the chosen sessions again under it — the same judgment, narrowed
  to them — so a session claimed, extracted or given a fact since the survey is
  left alone. Of the fact table that second judgment reads the rows stored
  since the survey (`facts read again under the write lock: N stored since the
  survey (of M)`); it reads every row again when a row the survey had read is
  gone or replaced, or when a chosen session has an exchange the survey had not
  seen (the line then says `all M` and why).
- **Cost.** Each requeued session is extracted by the backfill worker: up to
  `MEMORY_BANK_MAX_EXTRACT_CALLS` extraction batches per session (default 12,
  at most 60; a batch that fails for a transient reason is tried again). The
  facts it saves are then classified together — one classification call per 20
  facts, not one per fact (a reply whose numbering cannot be trusted is asked
  again: at most n + 3 calls for n facts) — and each saved fact gets at most
  one relation call (none when it has no close neighbour).
  `BACKFILL_EXTRACT_MAX` sessions per run, once the session has been quiet for
  `BACKFILL_QUIET_MINUTES`. Use `--limit`.

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
node scripts/reembed-rewritten-facts.mjs [--db PATH] --apply --fact-kr keep|clear   # keep unless translate-facts.mjs is run next
node scripts/reembed-rewritten-facts.mjs [--db PATH] --restore TABLE
```

- `redact-secret-facts.mjs` — a fact with a credential-shaped string (an API
  key, a bot token, a private key block, …) is refused when it is stored or
  imported; this script is for rows stored before that check existed. **Run the
  dry run once after upgrading from 1.7.9 or earlier.** It prints the fact id
  and the kind of credential, never the text. `--apply` sets `is_active = 0`
  after writing each row's previous `is_active` / `updated_at` to the undo file
  (`redact-secret-facts-undo-<UTC time>.jsonl` next to the database unless
  `--undo-file` names another path). It also removes those facts' rows from the
  vector index (`vec_facts`, `vec_facts_kr`) and keeps the removed bytes in a
  table of the same database, `redact_secret_backup_<UTC time>`, which the undo
  file names. A deactivated fact is no longer injected, found by search, or
  listed by the next sync export — the export file already on disk still has
  it until that next export. The text stays in the row, and the credential is
  still leaked: **rotate it.** `--undo FILE` reactivates the rows that are
  still as that run left them, vectors included, and drops that run's backup
  table once every row of the file is back (while a fact changed since is left
  as it is, the table stays — that fact's vectors exist only there). `--help`
  prints the usage and opens nothing.
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
  to do with the Korean sentence of a repaired fact, and **`--fact-kr keep` is
  the one to use** unless a translation run follows: it leaves `fact_kr` and
  its vector as they are (written for the old sentence, but still what a
  Korean query finds the fact by). `--fact-kr clear` removes both, and only
  part of them comes back: the run itself ends by restoring a Korean sentence
  only where a merged, deactivated fact still holds one for the same sentence
  (the pass the consolidation worker runs once per plugin version; if it
  fails, the run exits 1 and the same command repeats it). On a copy of a
  live database, of 624 rewritten active
  facts left without a Korean sentence after `clear`, that brought back 71;
  the 436 whose sentence is English only have no Korean vector until
  `scripts/translate-facts.mjs` (LLM calls, run by hand) translates them. Use
  `clear` only when you run that script next. The old bytes of every changed
  row go to a backup table first (`reembed_rewritten_backup_<UTC time>`);
  `--restore TABLE` puts them back for the facts whose sentence has not
  changed since.
