# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Memory Bank is a Claude Code plugin that provides semantic search and fact extraction across past conversations. It runs as an MCP server exposing `search`, `read`, and `search_facts` tools.

## Build & Test Commands

```bash
npm install              # Install dependencies (runs postinstall: rebuild better-sqlite3)
npm run build            # TypeScript compile + esbuild bundle
npm test                 # Run all tests (vitest)
npx vitest run test/parser.test.ts  # Run single test file
npx vitest --watch       # Watch mode
```

The build is two-step: `tsc` compiles `src/` → `dist/`, then `esbuild` bundles `src/mcp-server.ts` → `dist/mcp-server.js` with native modules externalized.

## Architecture

### Data Flow

1. **Sync** (`src/sync.ts`): Copies JSONL conversation files from `~/.claude/projects/` to `~/.config/superpowers/conversation-archive/`, indexes new files into SQLite
2. **Index** (`src/indexer.ts`): Parses JSONL → generates 384-dim embeddings via `Xenova/all-MiniLM-L6-v2` → stores in SQLite with `sqlite-vec`
3. **Search** (`src/search.ts`): Vector search (cosine similarity), text search (FTS), or combined mode
4. **Fact Extraction** (`src/fact-extractor.ts`): LLM (Haiku) extracts decisions/preferences/patterns from exchanges at session end
5. **Consolidation** (`src/consolidator.ts`): Deduplicates, resolves contradictions, and tracks evolution of facts via LLM comparison

### Key Modules

| Module | Purpose |
|--------|---------|
| `mcp-server.ts` | MCP server entry point — registers `search`, `read`, `search_facts` tools |
| `db.ts` | SQLite schema init, migrations, CRUD for exchanges |
| `fact-db.ts` | CRUD and vector search for facts table |
| `inject-select.ts` | Which facts a prompt's block carries (KNN → baseline gate → 1-hop) — shared by the live hook and the replay bench; `PRODUCTION_SELECT_OPTIONS` is the bench's decision |
| `project-family.ts` | Repository family of a cwd (git top-level + linked worktree's main repo, fs only) and the scope predicate both searches use |
| `inject-log.ts` | `inject-context.jsonl` lines: status, timings, margins, gated/injected ids, session_key, plugin_version, SessionStart lines |
| `embeddings.ts` | Local embedding generation using `@xenova/transformers` |
| `llm.ts` | Anthropic API wrapper for Haiku calls (fact extraction/consolidation) |
| `parser.ts` | JSONL conversation file parser |
| `vec-compact.ts` | Rebuild a fact-side vec0 table without deleted slots (same ids, bytes, dtype, scale) |
| `vec-migrate-guard.ts` | Refuses a vec format change while processes or install dirs run older code |
| `node-abi.ts` | Finds a node whose ABI matches better-sqlite3 and re-runs a hook under it |
| `native/inject-client/` (Rust) | Optional thin client of the UserPromptSubmit hook — the warm path of `scripts/inject-context.js` field for field (envelope, prompt gate with UTF-16 lengths, daemon socket, ledger, skipped log); built by `scripts/build-native-client.sh` at SessionStart when cargo exists, run by the wrapper only when `<indexDir>/bin/…srchash` equals `native/inject-client/SRC_HASH` (`scripts/native-src-hash.mjs` is the one definition over `Cargo.toml`·`Cargo.lock`·`src/**` — rerun `--write` after touching the crate); hands the prompt to the node client with `MEMORY_BANK_INJECT_DAEMON_FAILED` + the same `MEMORY_BANK_INJECT_REQ_ID` when the daemon does not answer |
| `cli-args.ts` | Strict argument parsing for scripts that write the live DB |
| `paths.ts` | Config/data directory resolution (supports `MEMORY_BANK_CONFIG_DIR` override) |
| `sync.ts` | File sync + incremental indexing + summary generation |

### Injection replay bench

`bench/inject-replay.mjs` (sample from the inject log ∩ indexed prompts, read-only snapshot, replay of selection
variants) and `bench/inject-judge.mjs` (isolated `callHaiku` judge, random-fact controls, bootstrap CIs,
pre-registered decisions). Private text stays in `.bench-out/` (gitignored); `docs/bench/` holds aggregates only and
its decisions block pins `PRODUCTION_SELECT_OPTIONS` (test/inject-select.test.ts). Plan:
`docs/plans/2026-10-19-memorilla-applicability.md`.

### Plugin Structure

```
.claude-plugin/plugin.json  # Plugin manifest (MCP server config, agents)
hooks/hooks.json            # SessionStart hook: background sync
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

Schema migrations are handled inline in `db.ts` via `migrateSchema()` — idempotent column additions.

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
| `MEMORY_BANK_MAINTENANCE_INTERVAL_MIN` | Session-start maintenance interval in minutes (default 360, 0 = every start; a partial run retries after 60) |
| `MEMORY_BANK_NODE` | Node binary for hooks when the default node's ABI does not match better-sqlite3 |
| `MEMORY_BANK_INJECT_HOOK_BUDGET_MS` | Injection hook time budget that bounds its native-ABI re-run (default 30000 = Claude Code's UserPromptSubmit default) |
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
- Classification runs asynchronously after fact insertion via `classifyAndLinkFact()`

### Avatar Responder

`ask_avatar` tool — answers questions grounded in the user's past decisions and facts with confidence scoring and cited sources.

## Tech Stack

- TypeScript 5.9+ (ES2022, ESM modules — `"type": "module"` in package.json)
- SQLite via `better-sqlite3` 12.x + `sqlite-vec` 0.1.x for vector search
- `@xenova/transformers` 2.17+ for local embedding generation (all-MiniLM-L6-v2, 384-dim)
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
- Fixtures in `test/fixtures/*.jsonl`
- Each test creates/destroys its own temp directory
- 30s timeout per test (embedding model loading)
