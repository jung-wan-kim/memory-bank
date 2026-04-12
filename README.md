# Memory Bank

> Conversations → Knowledge Graph. Claude Code conversations become searchable, structured knowledge.

![Memory Bank](docs/memory-bank.gif)

## Features

- **Knowledge Graph** -- Ontology classification (Domain → Category) + typed relations (INFLUENCES, SUPPORTS, SUPERSEDES, CONTRADICTS)
- **RAG Search** -- Search results auto-enriched with related facts and ontology context
- **Conversation Search** -- Semantic vector search across all past conversations
- **Fact Extraction** -- Automatic extraction of decisions, preferences, patterns from conversations
- **Fact Consolidation** -- Duplicate detection, contradiction handling, evolution tracking
- **Graph Traversal** -- Multi-hop exploration (up to 3 hops) to trace decision chains
- **Cross-Project Insights** -- Find similar decisions from other projects
- **Fact Provenance** -- Trace any fact back to its source conversation
- **Scope Isolation** -- Project facts stay in their project, global facts are shared
- **MCP Integration** -- 9 tools: `search`, `read`, `search_facts`, `search_ontology`, `ask_avatar`, `trace_fact`, `explore_graph`, `cross_project_insights`, `graph_stats`
- **3D Visualization** -- Interactive neon-style knowledge graph with data flow animation
- **Web UI** -- Dark-theme web interface for browsing and searching conversations

## How It Works

### Data Pipeline

```
▲ Prompt Input       User messages, tool calls, assistant responses
│                    → JSONL archiving → embedding (384-dim)
│
◎ User Scope         LLM extracts facts (decisions, preferences, patterns)
│                    → global facts shared across all projects
│
● Project Scope      Facts scoped per project, clustered by domain
│                    → cross-project insights available
│
◇ Ontology           Auto-classified into domains & categories
                     → typed relations: INFLUENCES / SUPPORTS / SUPERSEDES / CONTRADICTS
                     → multi-hop graph traversal (up to 3 hops)
```

```mermaid
graph LR
    A[Session End] -->|sync| B[Parse JSONL]
    B --> C[Generate Embeddings]
    C --> D[SQLite + sqlite-vec]

    A -->|extract| E[Haiku LLM]
    E --> F[Facts]
    F -->|classify| G[Ontology]
    G -->|detect| H[Relations]

    I[Session Start] -->|consolidate| J[Vector Search]
    J --> K[Haiku LLM]
    K -->|merge/replace/evolve| F

    L[Query] -->|search| D
    L -->|RAG| F
    L -->|traverse| H
```

![Architecture](docs/architecture.svg)

## Install

In Claude Code:
```
/plugin marketplace add https://github.com/jung-wan-kim/memory-bank
/plugin install memory-bank
```

## Update

```
/plugin install memory-bank
```

Re-running the install command pulls the latest version.

## Quick Start

```bash
memory-bank sync      # Sync & index conversations
memory-bank search "React auth"  # Semantic search
memory-bank stats     # Index statistics
```

## Fact System

Facts are automatically extracted at session end and consolidated at session start.

| Category | Example |
|----------|---------|
| `decision` | "Using Riverpod for state management" |
| `preference` | "Named exports only" |
| `pattern` | "Bug-fixer retries 3 times on error" |
| `knowledge` | "API endpoints at /api/v2/" |
| `constraint` | "No localStorage usage" |

### Consolidation Rules

![Fact Lifecycle](docs/fact-lifecycle.svg)

| Relation | Action |
|----------|--------|
| DUPLICATE | Merge (count++) |
| CONTRADICTION | Replace old + revision history |
| EVOLUTION | Update + revision history |
| INDEPENDENT | Keep both |

### Scope Isolation

```mermaid
graph TB
    subgraph "Project A"
        FA1[Fact: Use Riverpod]
        FA2[Fact: Flutter arch]
    end
    subgraph "Project B"
        FB1[Fact: Use Redux]
        FB2[Fact: React arch]
    end
    subgraph "Global"
        FG1[Fact: Named exports]
        FG2[Fact: Korean responses]
    end

    FG1 -.->|shared| FA1
    FG1 -.->|shared| FB1
    FA1 x--x FB1
```

Project A sees: Project A facts + Global facts (never Project B).

## MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Semantic/text search + RAG context (related facts auto-attached) |
| `read` | Display full conversation from JSONL |
| `search_facts` | Query facts with ontology context + graph relations |
| `search_ontology` | Browse ontology hierarchy (Domain → Category → Facts) |
| `ask_avatar` | Ask your technical alter ego — answers grounded in past decisions |
| `trace_fact` | Trace a fact back to its source conversations |
| `explore_graph` | Multi-hop graph traversal (1-3 hops) from any fact |
| `cross_project_insights` | Find similar decisions from other projects |
| `graph_stats` | Knowledge graph statistics and health |

### Knowledge Graph Tools

```bash
# Trace why a decision was made
trace_fact --query "state management" --limit 3

# Find how other projects solved auth
cross_project_insights --query "authentication" --current_project ./my-app

# Explore decision chains
explore_graph --query "database choice" --hops 3
```

## Web UI

A cinematic dark-theme web interface for browsing and searching your conversation history.

![Web UI](docs/ui-projects.png)

### Features

- **Projects View** -- Browse all projects grouped by category, sorted by latest/most/A-Z
- **Search** -- Full-text search across all conversations
- **User Prompts** -- Browse and search only user messages
- **Exchange Detail** -- View full user/assistant messages with tool call history

### Run

```bash
node ui/server.cjs
# Memory Bank UI: http://localhost:3847
```

Custom port:
```bash
PORT=8080 node ui/server.cjs
```

> **Note:** Requires `memory-bank sync` to have been run at least once to populate the database.

## Claude Desktop Integration

Share Claude Code's memory with Claude Desktop by adding the MCP server:

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "memory-bank": {
      "command": "node",
      "args": ["/path/to/memory-bank/cli/mcp-server-wrapper.js"]
    }
  }
}
```

Replace `/path/to/memory-bank` with the actual plugin path (check `~/.claude/plugins/`).

Claude Desktop will then have access to all your Claude Code conversations and extracted facts via the same `search`, `read`, and `search_facts` tools.

## Configuration

```bash
# Fact extraction model (default: claude-haiku-4-5-20251001)
export MEMORY_BANK_FACT_MODEL=claude-haiku-4-5-20251001
export ANTHROPIC_API_KEY=your-key

# Summarization model
export MEMORY_BANK_API_MODEL=opus
```

## 3D Knowledge Graph

Interactive visualization of the full knowledge graph with neon-style nodes and data flow animation.

![Knowledge Graph](docs/graph-3d-screenshot.png)

```bash
open docs/graph-3d.html   # Interactive 3D graph (local)
```

4 layers: **Prompt Input** → **User Scope** → **Project Scope** → **Ontology**, with animated particles showing data flow direction.

## Architecture

```
~/.config/superpowers/
├── conversation-archive/       # Archived JSONL files
└── conversation-index/
    └── db.sqlite               # SQLite + sqlite-vec
        ├── exchanges           # Conversation data + embeddings
        ├── tool_calls          # Tool usage records
        ├── facts               # Extracted facts + embeddings
        ├── fact_revisions      # Change history
        ├── ontology_domains    # Domain hierarchy
        ├── ontology_categories # Category classification
        ├── ontology_relations  # Typed fact relations
        ├── vec_exchanges       # Vector index (384-dim)
        └── vec_facts           # Vector index (384-dim)
```

## Development

```bash
npm install && npm test && npm run build
```

## License

MIT
