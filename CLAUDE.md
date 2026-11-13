# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Memory Bank is a Claude Code plugin that provides semantic search and fact extraction across past conversations. It runs as an MCP server exposing 11 tools — `search`, `read`, `search_facts`, `search_ontology`, `ask_avatar`, `trace_fact`, `explore_graph`, `cross_project_insights`, `graph_stats`, `tag_fact`, `list_tags` (reference: `skills/remembering-conversations/MCP-TOOLS.md`).

## Build & Test Commands

```bash
npm install              # Install dependencies (runs postinstall: rebuild better-sqlite3)
npm run build            # TypeScript compile + esbuild bundle
npm test                 # Run all tests (vitest); pretest fails if dist/ is stale or was bundled through a symlinked node_modules — see below
npx vitest run test/parser.test.ts  # Run single test file
npx vitest --watch       # Watch mode
```

The build is two-step: `tsc` compiles `src/` → `dist/`, then `esbuild` bundles `src/mcp-server.ts` → `dist/mcp-server.js` with native modules externalized and `scripts/stamp-bundle.mjs` writes a stamp on the bundle's last line. Since 1.9.0 that bundle is the per-session **relay** only (Node built-ins, about 31 KB): it must stay free of the database, the model and the MCP SDK, so the two servers it can start — `dist/shared-server.js` and `dist/stdio-server.js`, both plain `tsc` output — are reached by a path worked out at run time, never by a static import (`test/shared-server-e2e.test.ts` checks the bundle's imports).

`npm test` does not build: `pretest` runs `scripts/check-dist-fresh.mjs` and fails (exit 1, nothing written) when `dist/` is not a build of the current sources (tests import `dist/`; the old `pretest` rewrote it on every run). Two kinds of file, two ways to tell:

- What `tsc` emits is compiled into a temp dir and compared with `dist/` byte for byte.
- The bundle `dist/mcp-server.js` is **not** compared by bytes: it inlines third-party packages, and with no lock file tracked a fresh `npm install` resolves other versions of them. It is judged by its stamp (`// memory-bank-bundle-stamp v1 inputs=<sha256> body=<sha256>`): `inputs` — the first-party sources esbuild read, the esbuild arguments of package.json `bundle`, and the `dependencies` ranges — must be the digest of the current ones, and `body` the digest of the bundle's bytes up to the stamp line.
- A bundle built where `node_modules` is a symlink to another directory (a git worktree sharing the main checkout's install) names its inlined modules by paths outside the project and carries that machine's directory names. The build warns (rc 0); `pretest` refuses the bundle even when it is fresh. Build the `dist/` you commit in a checkout with its own `node_modules`; in such a worktree run tests with `npx vitest run` (no `pretest`).

## Architecture

### Data Flow

1. **Sync** (`src/sync.ts`): Copies JSONL conversation files from `~/.claude/projects/` to `~/.config/superpowers/conversation-archive/`, indexes new files into SQLite
2. **Index** (`src/indexer.ts`): Parses JSONL → generates 384-dim embeddings via `Xenova/multilingual-e5-small` (`src/embedding-version.ts`) → stores in SQLite with `sqlite-vec`
3. **Search** (`src/search.ts`): Vector search (cosine similarity), text search (FTS), or combined mode
4. **Fact Extraction** (`src/fact-extractor.ts`): LLM (Haiku) extracts decisions/preferences/patterns from exchanges at session end
5. **Consolidation** (`src/consolidator.ts`): Deduplicates, resolves contradictions, and tracks evolution of facts via LLM comparison

### Key Modules

| Module | Purpose |
|--------|---------|
| `mcp-server.ts` | The stdio entry a session starts (the esbuild bundle). Decides with `sharedMode()` and either relays to the shared server (`runRelay`) or — shared server off — imports `stdio-server.js` by run-time path and says why in one stderr line |
| `server-core.ts` | The 11 tools: declarations and handlers, `createMemoryBankServer(ctx)` — one MCP `Server` per session, no side effect on import. Their text is built in `search.ts` (`search`), `show.ts` (`read`), `facts-tool.ts` (fact tools) and `ontology-browse.ts` (`search_ontology`). A tool's default project is `sessionProject(ctx, params.project)` and nothing else |
| `session-context.ts` | `SessionContext { cwd, childEnv?, locale? }` — what a server knows about the session a call belongs to: its working directory, the settings of the LLM child its calls start, the locale its output is written in. `validSessionCwd`, `validSessionLocale`, and `sessionProject` — the only place a default project comes from; `cwd: null` makes that one call fail, never "every project" |
| `shared-server.ts` / `shared-server-core.ts` | The shared server process and its logic: probe the name → load the heavy modules (failure = exit 70 before binding) → bind (one server per name; exit 76 when another holds it, 75 to retry) → hello check per connection → one `Server` per session → idle end, self-check (name lost / version or code on disk changed → retire; an orphan start lock is removed), pid file. A server that lost its name never closes its listener (libuv unlinks by name). The hello carries the session's `cwd`, `env` (LLM child settings, `validChildEnv`) and `locale`; a hello without them is refused (`bad-env`) |
| `relay.ts` | The session side: connect or start the server under a start lock (detached, cwd = index dir, allow-listed environment, log `logs/shared-server.log`), hello, replay of the client's handshake after a reconnect, ping for a server that stopped answering (ended only when pid file + command line name it), error answers while no server can be started. A listener that answers the hello with something else is given up on at once (`not-ours`); a server that keeps ending within `MEMORY_BANK_RELAY_STABLE_MS` of connecting is restarted after 2 s, 4 s, … 30 s, not at once; a call that arrives while the relay waits is answered with the reason, not held |
| `shared-identity.ts` | How a session's variable reaches a shared server (`serverEnvKind`: `identity` — the server's own settings, part of its name · `passthrough` — operating variables · `child` — the session's LLM settings and locale, declared per connection, never in the server process · null — not passed). `serverEnvFor`, `childEnvFor` / `validChildEnv`, `distFingerprint`, `sharedServerIdentity` (version + code + identity environment), socket / pid / lock paths, start-lock helpers (`startLockHolder`, `removeOrphanStartLock`) |
| `shared-mode.ts` / `own-cwd.ts` / `shared-protocol.ts` | Session-side only: `sharedMode()` → `shared`, `session-local` (switch, switch file, Windows, run from source, relative path with no cwd, socket path too long) or `broken` (no `shared-server.js` next to the entry, no readable version — the entry exits 1, it does not fall back); the one read of a process working directory and default locale (`ownCwd`, `ownLocale`); the hello shape + server exit codes (no imports, so the relay bundle pulls nothing in) |
| `stdio-server.ts` | The session-local server (what every session ran before 1.9.0): inject daemon + `StdioServerTransport` over `createMemoryBankServer` |
| `socket-transport.ts` / `unix-socket.ts` | MCP `Transport` over a `net.Socket` with control lines (`{"mb_relay":…}` ping/pong); socket liveness helpers shared with the inject daemon (`probeSocket`, `removeIfDead`, `socketIdentity`) |
| `db.ts` | SQLite schema init, migrations, CRUD for exchanges. `insertExchange` keeps one row per turn and refuses a shorter snapshot of a turn that is indexed in full; the snapshots it replaces are written to the `exchange_repoints` queue table and `repointQueuedExchangeSources` moves what named them (fact sources, revisions) afterwards, outside the write transaction. `deleteExchanges` deletes in batches bounded by rows and by time (`DELETE_BATCH_MAX_MS`) with a pause between them (`pauseForOtherWriters`) |
| `fact-db.ts` | CRUD and vector search for facts table |
| `consolidator.ts` | One pass over the facts after the cursor: nearest same-scope fact → LLM verdict → applied in one transaction (older fact = "existing"); returns the run's last failure (`lastError`) for the worker to log |
| `consolidate-health.ts` | Consolidation cursor reader, "anything pending?" probe, and `state/fact-consolidate-health.json` (consecutive held runs → backoff) — shared by the SessionStart hook's gate and the worker; also the worker's single-run lock (`acquireConsolidateLock` / `releaseConsolidateLock` — a dead pid's lock is taken over atomically, so two workers never hold it together) |
| `vec-limits.ts` | `VEC0_KNN_K_MAX` (4096): the largest k a vec0 KNN accepts |
| `inject-select.ts` | Which facts a prompt's block carries (KNN → baseline gate → 1-hop) — shared by the live hook and the replay bench; `PRODUCTION_SELECT_OPTIONS` is the bench's decision |
| `project-family.ts` | Repository family of a cwd (git top-level + linked worktree's main repo, fs only) and the scope predicate both searches use |
| `inject-log.ts` | `inject-context.jsonl` lines: status, timings, margins, gated/injected ids, session_key, plugin_version, SessionStart lines |
| `inject-ledger.ts` | Per-session "already injected" keys (id + text key); cleared for that session after a compaction (`scripts/ledger-reset-hook.js`, SessionStart `compact`) |
| `inject-daemon.ts` | Warm unix-socket sidecar in the MCP server: one owner per plugin version, the others re-check every 45s and take over when it leaves; dead socket files are removed. Off when no socket name fits a unix socket path under the index dir (`version-guard.ts` `injectSocketPathIn` returns null: 103 bytes on macOS, 107 on Linux) — the hook then computes the block itself and logs `fallback_reason: socket-path-too-long` |
| `embeddings.ts` | Local embedding generation using `@xenova/transformers` |
| `llm.ts` | Anthropic API wrapper for Haiku calls (fact extraction/consolidation, `ask_avatar`). `callHaiku(…, { childEnv })`: a shared server passes the calling session's settings to the LLM child and to the API-key fallback client (`fallbackClientOptions`); without it the process is the caller's own and the child inherits it |
| `parser.ts` | JSONL conversation file parser |
| `vec-compact.ts` | Rebuild a fact-side vec0 table without deleted slots (same ids, bytes, dtype, scale) |
| `vec-migrate-guard.ts` | Refuses a vec format change while processes or install dirs run older code |
| `node-abi.ts` | Finds a node whose ABI matches better-sqlite3 and re-runs a hook under it |
| `native/inject-client/` (Rust) | Optional thin client of the UserPromptSubmit hook — the warm path of `scripts/inject-context.js` field for field (envelope, prompt gate with UTF-16 lengths, daemon socket, ledger, skipped log); built by `scripts/build-native-client.sh` at SessionStart when cargo exists, run by the wrapper only when `<indexDir>/bin/…srchash` equals `native/inject-client/SRC_HASH` (`scripts/native-src-hash.mjs` is the one definition over `Cargo.toml`·`Cargo.lock`·`src/**` — rerun `--write` after touching the crate); hands the prompt to the node client with `MEMORY_BANK_INJECT_DAEMON_FAILED` + the same `MEMORY_BANK_INJECT_REQ_ID` when the daemon does not answer |
| `cli-args.ts` | Strict argument parsing for scripts that write the live DB |
| `paths.ts` | Config/data directory resolution (supports `MEMORY_BANK_CONFIG_DIR` override) |
| `sync.ts` | File sync + incremental indexing + summary generation |
| `index-exchanges.ts` | The one place a parsed exchange enters the index (`indexExchanges`): guards → skip if already indexed → skip a shorter snapshot of a turn indexed in full (`hasFullerSnapshot`) → `insertExchange`, then — after the writes, outside their transactions — `repointQueuedExchangeSources` for the snapshots that were replaced (a busy lock leaves the queue for the next run). sync, the three indexer entry points and repair all call it — the call sites are pinned in `test/noise.test.ts` |
| `noise.ts` | `isNoiseExchange` (agent warm-up turns, another plugin's observer prompts) and `shouldIndexExchange`; its SQL twin for the purge is in `pollution-predicate.ts` |
| `conversation-guard.ts` | Exclusion markers and `parseGuarded` — parse + marker check in one pass, user-message text only; an unreadable file rejects (never "not excluded") |
| `verify.ts` | `--verify` / `--repair`: orphan = file gone on disk (per path), report-only unless `pruneMissing`; outdated = changed since it was indexed, or a turn indexed shorter than the file holds it. The repair plan is checked before anything runs and needs `--yes` when a count is over 5% of its total and over 20: rows to delete against the indexed exchanges, conversations to re-index and summary (LLM) calls against the conversations that hold something to index — and summary calls over 100 whatever the share (`REPAIR_LLM_CALLS_MAX`) |
| `rebuild.ts` | `--rebuild`: empties the conversation tables in place (never the DB file). Before anything is cleared it reads every indexed archive conversation to its end (an unreadable one counts as not re-creatable), refuses when indexed exchanges could not be re-created, backs up the fact layer, and — with `--allow-index-loss` — the rows that will not come back; rows of those files indexed by another process while that backup was written stop it (`rebuild stopped — nothing was cleared`). The clear pauses for other writers at least every second and resets the vectors and the text index in two transactions |
| `row-backup.ts` | Row backups written and counted before a maintenance command deletes (`<indexDir>/backups/`). The copy reads one read snapshot of the source — it does not take the write lock, so other processes keep writing — and a caller that deletes more than the ids it backed up checks for rows that arrived meanwhile |
| `db-maintenance.ts` | Session-start housekeeping on the fact side: `ANALYZE` of fact/ontology tables, fact-vector reconcile |
| `snapshot-dedupe.ts` | One-time cleanup of duplicate snapshots of a turn (`scripts/dedupe-exchange-snapshots.mjs`, dry-run by default) |
| `sync-log.ts` | One line per sync run in `<indexDir>/logs/sync.jsonl` (the hook runs sync detached, stdio ignored) |

### Injection replay bench

`bench/inject-replay.mjs` (sample from the inject log ∩ indexed prompts, read-only snapshot, replay of selection
variants) and `bench/inject-judge.mjs` (isolated `callHaiku` judge, random-fact controls, bootstrap CIs,
pre-registered decisions). Private text stays in `.bench-out/` (gitignored); `docs/bench/` holds aggregates only and
its decisions block pins `PRODUCTION_SELECT_OPTIONS` (test/inject-select.test.ts). Plan:
`docs/plans/2026-10-19-memorilla-applicability.md`.

### Plugin Structure

```
.claude-plugin/plugin.json  # Plugin manifest (MCP server config, agents)
hooks/hooks.json            # SessionStart (startup|resume: sync, key facts, drift check; compact: ledger reset), SessionEnd, UserPromptSubmit
agents/                     # Agent definitions for Claude Code
commands/                   # Slash command definitions
skills/                     # Skill definitions
scripts/                    # Hook scripts (fact extraction/consolidation)
cli/                        # CLI entry points (memory-bank, mcp-server)
```

### Database

Single SQLite database at `~/.config/superpowers/conversation-index/db.sqlite` with `sqlite-vec` extension:

- `exchanges` — Conversation user/assistant pairs with metadata
- `tool_calls` — Tool usage records linked to exchanges
- `vec_exchanges` — 384-dim vector index for semantic search
- `facts` — Extracted long-term facts with scope (project/global) and category
- `fact_revisions` — Change history for evolved/contradicted facts
- `vec_facts` — 384-dim vector index for fact search
- `exchange_repoints` — queue of replaced turn snapshots (`from_id` → `to_id`) whose fact sources still have to be moved; created when the database is opened (`CREATE TABLE IF NOT EXISTS`, and again by `insertExchange` for a database opened by older code), filled by `insertExchange`, emptied by `repointQueuedExchangeSources`

Schema migrations are handled inline in `db.ts` via `migrateSchema()` — idempotent column additions.

What each maintenance command (`--verify`, `--repair`, `--rebuild`, the purge and dedupe scripts, session-start
maintenance) reads, changes and refuses to do: `docs/index-maintenance.md`. Rule: nothing is deleted without its own
flag, and a backup is written and counted before any delete.

### Fact System

Facts have 5 categories: `decision`, `preference`, `pattern`, `knowledge`, `constraint`.
Scope isolation: project facts stay within their project, global facts are shared.
Consolidation relations: `DUPLICATE` (merge), `CONTRADICTION` (replace), `EVOLUTION` (update), `INDEPENDENT` (keep both).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` / `MEMORY_BANK_API_TOKEN` | API key for Haiku LLM calls |
| `MEMORY_BANK_FACT_MODEL` | Override fact extraction model (default: `claude-haiku-5-5`) |
| `MEMORY_BANK_CONFIG_DIR` | Override config directory (useful for testing) |
| `MEMORY_BANK_DB_PATH` / `TEST_DB_PATH` | Override database path |
| `TEST_ARCHIVE_DIR` | Override archive directory for tests |
| `MEMORY_BANK_TEST_GUARD` | `1` (set by `test/setup.ts`) = `initDatabase()` throws on a database under the real `~/.config/superpowers` (`src/test-guard.ts`) |
| `MEMORY_BANK_TEST_LLM_BASE_URL` | Test runs only: the `ANTHROPIC_BASE_URL` tests get instead of the closed local port |
| `MEMORY_BANK_MAX_EXTRACT_CALLS` | Extraction batches per session (default 12, at most 60 — a larger value is read as 60, a non-positive-integer as 12). Batches, not LLM calls: per-batch retries (3 attempts by default) and the classification and relation calls for the stored facts are separate |
| `BACKFILL_QUIET_MINUTES` | The backfill extracts a session only when its last exchange is at least this many minutes old (default 60; `0` = no wait; above 10080 = 7 days, or not a number, means the default) |
| `MEMORY_BANK_UI_HOST` / `MEMORY_BANK_UI_TOKEN` | Web UI (`ui/server.cjs`) listen address (default `127.0.0.1`) and access token; a non-loopback address without a 16+ character token refuses to start (`ui/server-guards.cjs`) |
| `MEMORY_BANK_UI_TRUST_PROXY` | `1` = the dashboard port counts the Hue OS login limit and daily quota per `X-Forwarded-For` address instead of the connection's own (set only behind a proxy you run — otherwise the caller types the header); the Hue OS public listener always reads it |
| `HUE_OS_PUBLIC_PORT` / `REPLACEMENT_OS_ACCESS_PASSWORD` | Second loopback listener with the Hue OS chat routes only (the one port a tunnel may point at), and the Hue OS login password — no default; unset = login off |
| `MEMORY_BANK_MAINTENANCE_INTERVAL_MIN` | Session-start maintenance interval in minutes (default 360, 0 = every start; a partial run retries after 60) |
| `MEMORY_BANK_NODE` | Node binary for hooks when the default node's ABI does not match better-sqlite3 |
| `MEMORY_BANK_SHARED_SERVER` | `0`/`false`/`off`/`no` = this session runs its own MCP server instead of using the shared one (same effect: a file `shared-server.off` in the index dir). `test/setup.ts` sets `0` unless a test sets it — a test that wants the shared server builds its environment with `sharedEnv()` |
| `MEMORY_BANK_SHARED_IDLE_MS` / `MEMORY_BANK_SHARED_TICK_MS` / `MEMORY_BANK_SHARED_RETIRE_GRACE_MS` | Shared server: time with no session before it ends (default 600000), self-check interval (45000), wait after the last session of a retiring server (5000). Read by the server, so part of its identity |
| `MEMORY_BANK_RELAY_YOUNG_MS` / `MEMORY_BANK_RELAY_START_WAIT_MS` / `MEMORY_BANK_RELAY_HELLO_MS` / `MEMORY_BANK_RELAY_PING_AFTER_MS` / `MEMORY_BANK_RELAY_DEBUG` | Relay only (never passed to a server): how long a relay counts as "just begun" (8000 — a start failure then exits 1 for the wrapper's rescue), wait for a started server (30000), hello deadline (10000), silence before a ping (30000), `1` = connection events on stderr. `MEMORY_BANK_RELAY_STABLE_MS` (10000): a connection that ends sooner counts as a server that ended right after it started |
| `MEMORY_BANK_INJECT_HOOK_BUDGET_MS` | Injection hook time budget that bounds its cold fallback and native-ABI re-run (default 30000 = the hook's `timeout` in hooks.json) |
| `MEMORY_BANK_INJECT_HEADLESS` / `MEMORY_BANK_INJECT_CODEX` | `0` = no injection for `claude -p`/Agent SDK sessions (entry point `sdk-*`) / for Codex prompts; unset = inject as before. Judged twice and either says no (`inject-host-skip.ts`): by the hook client on its own environment before it asks the daemon, and where the block is computed. The hook's environment alone is enough — settings.json `env`, or one run (`MEMORY_BANK_INJECT_HEADLESS=0 claude -p …`) |
| `MEMORY_BANK_INJECT_COLD_ON_TIMEOUT` | `0` = when the warm daemon did not answer in time, skip the cold recomputation (default: run it) |
| `MEMORY_BANK_KEY_FACTS_GLOBAL_MAX` | Global facts in the session-start key-facts block, after the project's (default 3; a non-negative integer) |
| `MEMORY_BANK_DRIFT_REMOTE` | Session-start version check: `off` = never ask the upstream repository for tags; another value = the repository to ask instead of package.json's |
| `MEMORY_BANK_INJECT_RECLAIM_MS` / `MEMORY_BANK_DRIFT_SWEEP` | Test-only: how often an MCP server looks at the inject-daemon socket again (default 45000) / `0` = the drift check skips its process sweep |
| `MEMORY_BANK_NATIVE_CLIENT` | Path of the native inject client the hook wrapper runs (default `<indexDir>/bin/memory-bank-inject-client`; used only when its `.srchash` matches `SRC_HASH`) |
| `MEMORY_BANK_SQLITE_MMAP_BYTES` | `PRAGMA mmap_size` of the search connection (writable, used only for reads) (default 268435456; `0` turns mmap off; a non-integer falls back to the default with one stderr line) |
| `MEMORY_BANK_CARGO` | `build-native-client.sh`: explicit cargo path, or `none` to behave as if cargo were absent (tests) |
| `MEMORY_BANK_SESSION_START_SPAWN` | `0` = maintenance logs the workers it would spawn instead of spawning them (tests) |
| `MEMORY_BANK_PLUGIN_CACHE_DIR` / `MEMORY_BANK_PROCESS_SCAN_ROOT` | Test-only: narrow the int8 migration guard's install-dir / process scan (the migration prints them when set) |

### Ontology System

Automatic classification of facts into domain/category hierarchy:
- `ontology_domains` — Top-level groupings (e.g., "Infrastructure", "Frontend")
- `ontology_categories` — Sub-groupings within domains
- `ontology_relations` — Typed relations between facts: `INFLUENCES`, `SUPERSEDES`, `SUPPORTS`, `CONTRADICTS`
- Classification runs after the facts of a save are committed, via `classifyAndLinkFacts()` — one LLM call for the whole save (20 facts per call), then one relation call per fact. A fact the reply left out takes an attempt and waits for the backfill worker; a failed call burns no attempt
- A category is identified by its name key (`ontologyNameKey()`: case, spacing and punctuation folded; stored in `ontology_categories.name_key`). The column and its index are added by `ensureCategoryNameKeys()` in `src/ontology-db.ts` the first time taxonomy code runs on a connection — not by `initDatabase()` — and rows without a key (written by older code or the sync import) are filled on every lookup. A name the model returns is matched to an existing category (named domain → candidates shown → any domain) before anything is created; `createCategory()` is idempotent on (domain, key). There is no UNIQUE index: same-name rows that predate the key are not merged
- `createRelation()` refuses a `SUPERSEDES` whose mirror exists and a relation of a fact to itself (`RelationRefusedError`). `detectRelations()` writes no `SUPERSEDES` between siblings — facts of one extraction (same source exchanges) or lines of one memory document — because no order in time exists between them

### Avatar Responder

`ask_avatar` tool — answers questions grounded in the user's past decisions and facts with confidence scoring and cited sources.

## Tech Stack

- TypeScript 5.9+ (ES2022, ESM modules — `"type": "module"` in package.json)
- SQLite via `better-sqlite3` 12.x + `sqlite-vec` 0.1.x for vector search
- `@xenova/transformers` 2.17+ for local embedding generation (multilingual-e5-small, 384-dim)
- `@anthropic-ai/sdk` 0.78+ for LLM calls (Haiku)
- `@modelcontextprotocol/sdk` 1.20+ for MCP server
- `zod` 3.x for input validation
- `marked` 16.x for Markdown rendering
- Vitest 3.x for testing (30s timeout per test)
- esbuild for MCP server bundling (native modules externalized)

## Coding Conventions

### ESM Module System
- All imports use `.js` extension: `import { foo } from './bar.js'`
- `require()` is forbidden — use `import` exclusively. One exception: `src/node-abi.ts` loads better-sqlite3 through `createRequire` to catch an ABI mismatch synchronously, before a hook reads stdin (an `import` of a mismatched addon fails at module load, where no hook code can catch it)
- CommonJS files use `.cjs` extension (e.g., `ui/server.cjs`)

### Database Patterns
- Always call `db.close()` in `finally` blocks to prevent connection leaks
- Use `db.pragma('busy_timeout = 5000')` for concurrent access
- Schema migrations are idempotent — check column existence before ALTER
- Vector tables (sqlite-vec) require DELETE before INSERT (no REPLACE support)
- A vec0 KNN's `LIMIT` must not exceed `VEC0_KNN_K_MAX` (`vec-limits.ts`) — a larger k throws. Page up to it and stop once the last row is past the threshold (rows come back nearest first)
- `tool_calls.exchange_id` has no `ON DELETE CASCADE` in the schema this code creates (some older DBs carry one) — delete children first: `deleteExchange` / `deleteExchanges` do tool_calls → vector → exchange per row. `deleteExchange` is one transaction; `deleteExchanges` commits a batch at 2,000 rows or after `DELETE_BATCH_MAX_MS` (400ms), whichever comes first, and pauses `DELETE_BATCH_PAUSE_MS` (120ms) before the next — a maintenance delete must not hold the write lock past the 5s other processes wait. Use it (or `pauseForOtherWriters`) instead of a row-count-only loop
- One turn of one file is one row: `insertExchange` removes older snapshots of the same `(archive_path, line_start)`, refuses a shorter snapshot when a fuller one is indexed, and queues the removed ids in `exchange_repoints`; the facts and revisions that named them are re-pointed afterwards by `repointQueuedExchangeSources` (called by `indexExchanges`), not under the insert's write lock
- A check added to `initDatabase()` runs on every open, next to 1.7.x processes sharing the DB: it must be a no-op once applied and must not fight what older code re-creates. Known exception: `idx_facts_active` — a 1.7.x process re-creates that index on its next open, so it is dropped at most once per `FACTS_ACTIVE_INDEX_REDROP_MS` (6 hours, recorded in `fts_meta`) instead of on every open
- Escape LIKE metacharacters (`%`, `_`) with `ESCAPE '\\'`
- Use parameterized queries — never interpolate user input into SQL

### Error Handling
- `try { ... } catch { /* skip malformed */ }` for JSONL line parsing
- `handleError()` utility wraps unknown errors into string messages
- LLM failures logged but non-fatal — extraction continues with partial results
- File operations use atomic copy: temp file + rename pattern

### Type Patterns
- Zod schemas for all MCP tool input validation
- Interface types in `src/types.ts` for shared data structures
- DB row types defined as local interfaces near usage (e.g., `ExchangeRow`)
- `(row as Type)` casting for `better-sqlite3` query results

### Testing Patterns
- Test utilities in `test/test-utils.ts`: `createTestDb()`, `suppressConsole()`, `getFixturePath()`
- Environment overrides via `TEST_DB_PATH`, `TEST_ARCHIVE_DIR` for isolation
- `test/setup.ts` (vitest `setupFiles`) gives every test file temp defaults for `MEMORY_BANK_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `TEST_PROJECTS_DIR` (kept when already set, put back before each test), points `ANTHROPIC_BASE_URL` at a closed local port (a value inherited from the shell is replaced) and turns the live-database guard on — a test never opens the real database or calls a real model
- Fixtures in `test/fixtures/*.jsonl`
- Shared-server tests use `test/helpers/shared-harness.ts`: a config dir under `/tmp` (a unix socket path is short — `os.tmpdir()` on macOS is too long and the session would quietly run its own server), `sharedEnv()`, `expectedServer()` (socket + the `--mb-shared=<id>` marker of the one server that environment may use), `StdioSession`, `makePluginRoot()` (a throwaway install to change the version or break a file in) and `cleanup()`. Every test ends what it started; the suite must leave no `shared-server.js` process behind
- Code a server loads is closed over by `test/server-scope-guard.test.ts`: no `process.cwd(` / `process.chdir(`; every environment name it reads from its process is `identity` or `passthrough` (add a new server setting to the allow-list in `shared-identity.ts`, not to the test's exceptions); a session's LLM settings are read only from the environment of its call (`llmEnv` in `llm.ts`); a process is started in two registered places (`deps-heal.ts`, `llm.ts`); nothing is formatted or ordered in the process default locale (`toLocaleString(locale)`, `localeCompare(x, locale)`); and a one-argument `path.resolve` must be on the registered list
- Each test creates/destroys its own temp directory
- 30s timeout per test (embedding model loading)
