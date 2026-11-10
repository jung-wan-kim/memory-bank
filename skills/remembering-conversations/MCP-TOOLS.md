# Memory Bank MCP Tools Reference

The memory-bank plugin registers 11 MCP tools. Their full names are
`mcp__plugin_memory-bank_memory-bank__<name>`. The two that restore conversation context are `search` and
`read`; the rest work on the facts extracted from conversations and on the knowledge graph built over them.

| Tool | What it answers |
|------|-----------------|
| `search` | Which past conversations talk about this? |
| `read` | What exactly was said in that conversation (or line range)? |
| `search_facts` | What did we decide / prefer / learn about this? |
| `trace_fact` | Which conversations did a fact come from? |
| `search_ontology` | How are the facts organized (domain → category → facts)? |
| `explore_graph` | What is connected to this fact, a few hops out? |
| `graph_stats` | How much has been accumulated? |
| `cross_project_insights` | How did other projects solve this? |
| `ask_avatar` | What would the user answer, given their past decisions? |
| `tag_fact` | Put a user label on a fact. |
| `list_tags` | Browse the user labels, or the facts carrying them. |

Every tool returns errors as text content with `isError: true` (invalid parameters, file not found, a
range outside the file, a failed search, and — for `ask_avatar` — an LLM call that failed).

## search

Search past conversations by meaning, by keyword, or both.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__search`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` or `string[]` | Yes | One string for a single search; an array of 2-5 strings for a multi-concept AND search |
| `mode` | `"vector"` \| `"text"` \| `"both"` | No | Default `"both"`. Single-string searches only |
| `limit` | `number` | No | Results returned, 1-50 (default 10). `both` returns at most `limit` rows in total |
| `after` | `string` | No | Only conversations on or after this date (YYYY-MM-DD, UTC timestamps) |
| `before` | `string` | No | Only conversations before this date (YYYY-MM-DD, UTC timestamps) |
| `coding_agent` | `string` | No | Only conversations of this agent (`claude-code`, `codex`, …) |
| `include_noise` | `boolean` | No | Also return machine-generated turns (default `false`) |
| `response_format` | `"markdown"` \| `"json"` | No | Default `"markdown"` |

**Modes**

- `vector` — semantic similarity over embeddings (`Xenova/multilingual-e5-small`).
- `text` — keyword search (SQLite FTS5): every word of the query must occur, word by word (not an exact
  phrase). Use it for identifiers, error codes, commit SHAs.
- `both` — the two merged by reciprocal rank; a conversation both passes found ranks first.

**What a result line means**

- `N% match` — cosine similarity of a semantic hit. `N% match (semantic + keyword)` — both passes found it.
  The number is the similarity of the two embeddings, not a confidence: with this model even unrelated text
  scores about 85-89% and a strong hit about 90%. Use it to compare the hits of one answer with each other;
  "88%" alone does not mean the result is relevant.
- `keyword match` — only the keyword pass found it (no similarity exists for it).
- `Lines A-B in <path>` — pass these to `read` as `path`, `startLine`, `endLine`.

Date and agent filters are applied to the semantic candidates themselves (the search keeps widening until
`limit` rows pass). When even the widest search allowed cannot fill `limit`, the answer ends with a
`Note:` line saying how many candidates were examined and how many passed — it is cut short, not "nothing
exists". A `Note:` line also appears when the keyword pass had to scan every exchange instead of using its
index (and why).

**What is left out by default** — machine-generated turns: sub-agent warm-up turns (a sidechain turn whose
user message is exactly `Warmup`) and other memory plugins' observer prompts (user message starting with
`<observed_from_primary_session>`). `include_noise: true` brings them back. Snapshot copies of one turn
(the same turn indexed again as the session grew) are folded into one result, the most complete copy.
A conversation summary that is really a stored error message is not shown.

**Markdown** answers end with a *Related Knowledge* section: up to 3 facts close to the query, each clipped
to 300 characters with at most 5 related facts.

**JSON** answers are compact: `{ results, count, mode, notes, hint }`. Each result has `exchange` (`id`,
`project`, `timestamp`, `codingAgent`, `archivePath`, `lineStart`, `lineEnd`, and `userMessage` /
`assistantMessage` clipped to 500 characters), `clipped`, `similarity`, `matchedBy`, `snippet`. The full
text of an exchange is read with `read`.

**Multi-concept search** — `query: ["authentication", "React Router", "error handling"]` returns at most
`limit` conversations in ONE ranking made from two lists:

- the exchanges that contain every word of every concept, one per conversation, in the keyword search's own
  order (word statistics, BM25) — shown as `every word in one exchange (N% avg semantic)`. The percentage is
  that exchange's similarity to the concepts: it is shown, it does not order this list;
- the conversations in which every concept has a semantically near exchange, by average similarity — shown
  as `N% avg match`.

The two lists are merged rank by rank (reciprocal rank, as in `both`): the best of each comes first, at the
same rank the keyword match goes ahead, and a conversation on both lists ranks higher and is shown once, as
its keyword match. So keyword matches no longer fill `limit` before any semantic match is shown. Each result
lists its similarity to every concept (`n/a` when the exchange has no vector). `mode` is ignored.

## read

Read a conversation, or a line range of it, as Markdown.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Absolute path of the `.jsonl` conversation file, as a search result reports it (a compressed `.jsonl.zst` archive is read through the same `.jsonl` path) |
| `startLine` | `number` | No | First line (1-indexed, inclusive) |
| `endLine` | `number` | No | Last line (1-indexed, inclusive) |
| `startChar` | `number` | No | Characters to skip of the first message shown (default 0) — the value a truncated answer names when it stopped inside one long message |
| `full` | `boolean` | No | Show tool inputs and tool results whole instead of clipping each (default `false`) |

- Only the requested lines are read (as a stream), so the size of the file does not matter.
- One call returns at most 40,000 characters. A longer range ends with a line that names every value the
  next call needs — pass **all** of them, not only `startLine`:

  ```
  _Output truncated at the 40000-char limit: lines 1-2 of 4 shown. Continue with startLine=3, endLine=4._
  ```

- One message longer than a whole answer is read in pieces. The answer stops inside it
  (`…[message clipped: characters 0-39906 of 90048 shown]`) and the closing line also names `startChar`:

  ```
  _Output truncated at the 40000-char limit: lines 3-3 of 4 shown, the message at line 3 up to character 39907. Without startChar the message starts over from its first character — to skip the rest of it instead, start at line 4. Continue with startLine=3, startChar=39907, endLine=4._
  ```

  The line it names is the one the call started on: `startChar` is what moves on. Calling again with only
  `startLine=3` returns the same first piece, every time. To leave the rest of the message unread, start at
  the line the closing line gives for that (here `startLine: 4`); when the message is the last line of the
  range the closing line says that nothing follows it. The next piece starts with
  `…[message at line 3 continues from character 39907 of 90048]`.
- One call also reads at most 8,000,000 characters of the file itself (a few tool results can be that large
  while their clipped rendering is short). An answer stopped by that ends the same way and says which limit
  it was:

  ```
  _Output truncated at the 8000000-char limit: lines 1-5 shown (the limit is on the file text one call reads, not on this output). Continue with startLine=6._
  ```
- A tool input or tool result longer than 2,000 characters is clipped:
  `…[+N chars not shown — read again with full: true]`. With `full: true` nothing is clipped (the 40,000
  characters per call still apply) and the closing line carries `full=true` — a `startChar` counts the text
  as that call rendered it, so keep `full` the same while following it.
- A range outside the file is an error that names the file's line count; `startLine` after `endLine` is an
  error; a `startChar` past the end of its message is an error. None returns an empty answer.
- Only files under the conversation archive (and `~/.claude/projects`) can be read. A symlink inside them
  that leads outside is refused.

## search_facts

Search the facts extracted from past conversations — project-scoped facts of the given project plus global
facts.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__search_facts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | What to look for |
| `project` | `string` | No | Project path that scopes the search (default: the server's working directory) |
| `category` | `decision` \| `preference` \| `pattern` \| `knowledge` \| `constraint` | No | Only facts of this category |
| `coding_agent` | `string` | No | Only facts extracted from this agent's conversations |
| `tags` | `string[]` | No | Only facts carrying all of these user tags |
| `include_revisions` | `boolean` | No | Add each fact's revision history |
| `limit` | `number` | No | 1-50 (default 10) |

Each result shows the fact, its id, scope, confirmation count, similarity and ontology position.

- The category, agent and tag conditions are part of the search (it widens until `limit` facts pass), so a
  filter never turns facts that exist into an empty answer. If the widest search allowed still cannot fill
  `limit`, a closing `Note:` says how many facts were examined.
- Facts whose sentence is identical (whitespace and case ignored) are shown once; the other ids are listed
  under `Same sentence also stored as:` so they can be tagged or handled together.
- `Related:` lists at most 5 related facts of the same project scope (or global), 160 characters each,
  contradicting and superseding ones first; the rest are counted. `explore_graph` lists more.

## trace_fact

Find the facts closest to a query and list the conversations each one was extracted from, its revision
history and its related facts.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__trace_fact`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Finds the fact(s) to trace |
| `project` | `string` | No | Project scope |
| `limit` | `number` | No | Facts traced, 1-10 (default 3) |

Per fact: the 5 newest source conversations (a 200-character look at the question, the path and the line
range to pass to `read`) with the count of the rest and of recorded sources no longer in the index; and at
most 5 related facts of the same project scope.

## search_ontology

Browse the ontology (Domain → Category → Facts) level by level.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__search_ontology`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | `string` | No | Domain name filter (partial, case-insensitive) |
| `category` | `string` | No | Category name filter (partial, case-insensitive) |
| `facts_per_category` | `number` | No | Facts shown per category, most confirmed first, 0-50. Default 5 with a `category` filter, otherwise 0 |
| `max_categories` | `number` | No | Categories listed per domain, largest first, 1-200. Default 8 (200 with a `domain` filter) without facts, 20 with |
| `category_offset` | `number` | No | Categories to skip per domain, largest first (default 0) — lists the ones behind `max_categories` |
| `include_relations` | `boolean` | No | Add up to 5 related facts under each fact shown |

- No filter → every domain with its fact and category totals and its largest categories (names and counts,
  no fact text).
- `domain` → up to 200 of that domain's categories (names and counts). A domain with more ends with
  `…and N more categories (…) — … or list the next ones with category_offset: 200`; call again with that
  `category_offset` to list them (`Largest first: categories 201-… of …`).
- `category` (or `facts_per_category` > 0) → the top facts of each matching category, each clipped to 300
  characters, with the count of the facts not shown.
- One answer is at most 20,000 characters. When the limit is reached the answer says how many categories and
  facts it left out — narrow `domain` / `category` to reach them. A category whose facts do not all fit shows
  as many as fit and counts the rest. Empty categories are counted, not listed.
- To find facts by meaning rather than by position in the tree, use `search_facts`.

## explore_graph

Start from the facts closest to a query and follow relations (`SUPPORTS`, `INFLUENCES`, `CONTRADICTS`,
`SUPERSEDES`) across projects.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__explore_graph`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Starting topic |
| `hops` | `number` | No | Traversal depth, 1-3 (default 2) |
| `project` | `string` | No | Project scope of the starting facts |

Up to 20 connected facts are listed per starting fact, most relevant first, each clipped to 300
characters; the rest are counted.

## graph_stats

Totals of the knowledge graph: active facts, domains, categories, relations, revisions, facts per category
type, the ten largest domains, relations per type.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__graph_stats`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | `string` | No | Accepted for compatibility; the totals cover the whole graph |

## cross_project_insights

Facts similar to a query from projects other than the current one.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__cross_project_insights`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Topic or decision |
| `current_project` | `string` | No | Project whose own facts are excluded (default: the server's working directory) |
| `limit` | `number` | No | 1-20 (default 5) |

Global facts and the current project's facts are skipped inside the search, so `limit` is filled with other
projects' facts when they exist.

## ask_avatar

Answer a question from the user's past decisions and preferences, with the supporting facts and a confidence
level. Calls an LLM.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__ask_avatar`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | `string` | Yes | The question |
| `project` | `string` | No | Project scope |

When the LLM call fails — nobody is logged in or the API key is not accepted, the model refused, or the
service keeps failing — the answer line says so (a missing login asks for `/login`) and the result is
returned with `isError: true`. The text keeps the usual layout (confidence 0%), so tell the two apart by
`isError`: an answer the stored facts cannot support is a normal result, a failed call is an error.

## tag_fact

Add, remove or replace the user tags of a fact. Tags are the one label the user controls; the automatic
pipeline never writes them.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__tag_fact`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fact_id` | `string` | Yes | Fact id from a `search_facts` result |
| `add` | `string[]` | No | Tags to add |
| `remove` | `string[]` | No | Tags to remove |
| `set` | `string[]` | No | Replace all tags (`[]` clears them) |

## list_tags

Without `tags`: the tag index (tag → number of facts). With `tags`: the facts carrying them.

**Tool name:** `mcp__plugin_memory-bank_memory-bank__list_tags`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | `string` | No | Project scope (default: the server's working directory) |
| `tags` | `string[]` | No | List the facts carrying these tags |
| `match` | `"all"` \| `"any"` | No | Default `"all"` |
| `limit` | `number` | No | 1-200 (default 50) |
