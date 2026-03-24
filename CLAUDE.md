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
| `embeddings.ts` | Local embedding generation using `@xenova/transformers` |
| `llm.ts` | Anthropic API wrapper for Haiku calls (fact extraction/consolidation) |
| `parser.ts` | JSONL conversation file parser |
| `paths.ts` | Config/data directory resolution (supports `MEMORY_BANK_CONFIG_DIR` override) |
| `sync.ts` | File sync + incremental indexing + summary generation |

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
| `MEMORY_BANK_FACT_MODEL` | Override fact extraction model (default: `claude-haiku-4-5-20251001`) |
| `MEMORY_BANK_CONFIG_DIR` | Override config directory (useful for testing) |
| `MEMORY_BANK_DB_PATH` / `TEST_DB_PATH` | Override database path |
| `TEST_ARCHIVE_DIR` | Override archive directory for tests |

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
- `require()` is forbidden — use `import` exclusively
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
