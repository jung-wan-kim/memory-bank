#!/usr/bin/env node
/**
 * MCP Server for Memory Bank.
 *
 * This server provides tools to search and explore indexed Claude Code conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startInjectDaemon } from './inject-daemon.js';
import { pluginVersion } from './inject-log.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  searchConversationsDetailed,
  searchResultsToJson,
  multiConceptResultsToJson,
  searchMultipleConcepts,
  formatResults,
  formatMultiConceptResults,
  getKnowledgeContext,
  formatKnowledgeContext,
  SearchOptions,
} from './search.js';
import { readConversationRange, READ_MAX_OUTPUT_CHARS, READ_MAX_BLOCK_CHARS } from './show.js';
import { initDatabase } from './db.js';
import {
  addFactTags,
  removeFactTags,
  setFactTags,
  listTags,
  findFactsByTags,
} from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { formatOntologyBrowse, ONTOLOGY_MAX_OUTPUT_CHARS, ONTOLOGY_MAX_CATEGORIES } from './ontology-browse.js';
import { formatFactSearch, formatFactTrace, formatCrossProjectInsights, formatGraphExploration } from './facts-tool.js';
import { clipLine, RELATED_MAX_CHARS } from './related-format.js';
import { askAvatar } from './avatar-responder.js';
import path from 'path';
import os from 'os';
import { resolveReadableConversation, ACCESS_DENIED_MESSAGE } from './read-guard.js';
import { getArchiveDir } from './paths.js';

// Zod Schemas for Input Validation

const SearchModeEnum = z.enum(['vector', 'text', 'both']);
const ResponseFormatEnum = z.enum(['markdown', 'json']);

const SearchInputSchema = z
  .object({
    query: z
      .union([
        z.string().min(2, 'Query must be at least 2 characters').max(10000, 'Query too long (max 10000 chars)'),
        z
          .array(z.string().min(2).max(10000))
          .min(2, 'Must provide at least 2 concepts for multi-concept search')
          .max(5, 'Cannot search more than 5 concepts at once'),
      ])
      .describe(
        'Search query - string for single concept, array of strings for multi-concept AND search'
      ),
    mode: SearchModeEnum.default('both').describe(
      'Search mode: "vector" for semantic similarity, "text" for exact matching, "both" for combined (default: "both"). Only used for single-concept searches.'
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
    after: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
      .optional()
      .describe('Only return conversations after this date (YYYY-MM-DD format)'),
    before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
      .optional()
      .describe('Only return conversations before this date (YYYY-MM-DD format)'),
    coding_agent: z
      .string()
      .optional()
      .describe('Filter by coding agent (e.g., "claude-code", "codex", "opencode"). Omit to search all agents.'),
    include_noise: z
      .boolean()
      .default(false)
      .describe('Also return machine-generated turns (sub-agent "Warmup" turns, other plugins\' observer prompts). Default false.'),
    response_format: ResponseFormatEnum.default('markdown').describe(
      'Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")'
    ),
  })
  .strict();

const ShowConversationInputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path is required')
      .describe('Absolute path to the JSONL conversation file to display'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Starting line number (1-indexed, inclusive). Omit to start from beginning. Must not be after endLine.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Ending line number (1-indexed, inclusive). Omit to read to the end (or to the output limit).'),
    startChar: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Characters to skip of the first message shown — the value a truncated answer names when it stopped inside one long message.'),
    full: z
      .boolean()
      .default(false)
      .describe('Show tool inputs and results whole instead of clipping each. Default false.'),
  })
  .strict();

const SearchFactsInputSchema = z
  .object({
    query: z.string().min(2, 'Query must be at least 2 characters').max(10000, 'Query too long (max 10000 chars)'),
    project: z.string().max(500).optional(),
    category: z.enum(['decision', 'preference', 'pattern', 'knowledge', 'constraint']).optional(),
    coding_agent: z.string().optional().describe('Filter facts by coding agent (e.g., "claude-code", "codex")'),
    tags: z
      .array(z.string().min(1).max(64))
      .max(32)
      .optional()
      .describe('Filter to facts carrying these user tags (all must match)'),
    include_revisions: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const TagFactInputSchema = z
  .object({
    fact_id: z.string().min(1).max(200).describe('Fact id from a search_facts result'),
    add: z.array(z.string().min(1).max(64)).max(32).optional(),
    remove: z.array(z.string().min(1).max(64)).max(32).optional(),
    set: z
      .array(z.string().min(1).max(64))
      .max(32)
      .optional()
      .describe('Replace all tags with this list; [] clears them'),
  })
  .strict();

const ListTagsInputSchema = z
  .object({
    project: z.string().max(500).optional(),
    tags: z
      .array(z.string().min(1).max(64))
      .max(32)
      .optional()
      .describe('When given, list the facts carrying these tags instead of the tag index'),
    match: z.enum(['all', 'any']).default('all'),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

const SearchOntologyInputSchema = z
  .object({
    domain: z.string().optional().describe('Filter by domain name (case-insensitive partial match)'),
    category: z.string().optional().describe('Filter by category name (case-insensitive partial match)'),
    include_relations: z.boolean().default(false).describe('Include 1-hop fact relations (at most 5 per fact)'),
    facts_per_category: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe('Facts shown per category, most confirmed first (0 = names and counts only). Default: 5 with a category filter, otherwise 0'),
    max_categories: z
      .number()
      .int()
      .min(1)
      .max(ONTOLOGY_MAX_CATEGORIES)
      .optional()
      .describe('Categories listed per domain, largest first. Default: 8 (200 with a domain filter) without facts, 20 with'),
    category_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Categories to skip per domain (largest first) — lists the ones behind max_categories. Default 0'),
  })
  .strict();

type SearchOntologyInput = z.infer<typeof SearchOntologyInputSchema>;

const AskAvatarInputSchema = z
  .object({
    question: z.string().min(2, 'Question must be at least 2 characters').max(10000, 'Question too long (max 10000 chars)').describe('Question to ask'),
    project: z.string().max(500).optional().describe('Project path to scope the search'),
  })
  .strict();

type AskAvatarInput = z.infer<typeof AskAvatarInputSchema>;

/** Related decisions listed under an ask_avatar answer. */
const AVATAR_MAX_RELATED_LISTED = 10;

/**
 * The file the `read` tool opens for `requestedPath`: inside the conversation roots, and the same file the
 * reader will pick.
 *
 * resolveReadableConversation returns the checked file with its symlinks resolved. The reader
 * (readConversationRange → archive-io) then chooses between that file and its other variant (plain / `.zst`)
 * once more, by modification time — so a link `a.jsonl` → `b.jsonl` inside the archive passed the check as
 * `b.jsonl`, and the reader opened a newer `b.jsonl.zst` that nobody had looked at (a link out of the
 * archive: its content, or for a non-conversation file its line count, came back). The check is therefore
 * repeated on its own answer until the answer stops moving: the variant the reader picks for the returned
 * path is then that path itself (or a link to it). A chain that never settles is refused.
 */
function resolveReadTarget(requestedPath: string, roots: string[]): string {
  let file = resolveReadableConversation(requestedPath, roots);
  for (let hop = 0; hop < 8; hop++) {
    const again = resolveReadableConversation(file, roots);
    if (again === file) return file;
    file = again;
  }
  throw new Error(ACCESS_DENIED_MESSAGE);
}

// Error Handling Utility

function handleError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

// Create MCP Server

const server = new Server(
  {
    name: 'memory-bank',
    // The version of the code that is running (package.json next to dist/), so a client can tell which
    // release answered. 'unknown' when the file cannot be read — never a made-up number.
    version: pluginVersion() ?? 'unknown',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tools

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search',
        description: `Gives you memory across sessions. You don't automatically remember past conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for semantic + keyword search or array of 2-5 concepts for AND matching. Returns at most \`limit\` ranked results with project, date, snippet and "Lines A-B in <path>" — pass those to the read tool for the full exchange. "N% match" is a semantic hit, "keyword match" a keyword-only hit. The percentage is the cosine similarity of the embeddings: with this model even unrelated text scores 85-89% and a strong hit about 90% — use it to compare the hits of one answer, not as a confidence. Machine-generated turns (sub-agent warm-ups, other plugins' observer prompts) are left out unless include_noise is true. A closing "Note:" line means the search was cut short, not that nothing exists.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              oneOf: [
                { type: 'string', minLength: 2 },
                { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
              ],
            },
            mode: { type: 'string', enum: ['vector', 'text', 'both'], default: 'both' },
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
            after: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            before: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            coding_agent: { type: 'string', description: 'Filter by coding agent (e.g., "claude-code", "codex", "opencode")' },
            include_noise: { type: 'boolean', default: false, description: 'Also return machine-generated turns (sub-agent "Warmup" turns, other plugins\' observer prompts)' },
            response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Episodic Memory',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'read',
        description: `Read a conversation (or a line range of it) after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Pass the "Lines A-B" range a search result reports as startLine/endLine (1-indexed, inclusive). One call returns at most ${READ_MAX_OUTPUT_CHARS} characters: a longer range ends with "Output truncated … Continue with startLine=N" — call again with the values that line names. When the answer stopped inside one message longer than the limit, the line also names startChar=M, so a message of any length can be read to its end. Tool inputs/results longer than ${READ_MAX_BLOCK_CHARS} characters are clipped ("…[+N chars not shown …]") unless full is true. A range outside the file is an error that names the file's line count.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            startLine: { type: 'number', minimum: 1 },
            endLine: { type: 'number', minimum: 1 },
            startChar: { type: 'number', minimum: 0, description: 'Characters to skip of the first message shown — the value a truncated answer names when it stopped inside one long message' },
            full: { type: 'boolean', default: false, description: 'Show tool inputs and results whole instead of clipping each' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Show Full Conversation',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'search_facts',
        description: 'Search extracted facts from past conversations. Returns project-scoped and global facts. Facts are long-term knowledge automatically extracted and consolidated from conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, description: 'Search query for facts' },
            project: { type: 'string', description: 'Project path to scope the search (defaults to cwd)' },
            category: {
              type: 'string',
              enum: ['decision', 'preference', 'pattern', 'knowledge', 'constraint'],
              description: 'Filter by fact category',
            },
            coding_agent: { type: 'string', description: 'Filter by coding agent (e.g., "claude-code", "codex", "opencode")' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter to facts carrying ALL of these user tags (see list_tags)',
            },
            include_revisions: { type: 'boolean', description: 'Include revision history', default: false },
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10, description: 'Max results' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Facts',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'tag_fact',
        description:
          'Attach or remove user tags on a fact. Tags are the one labelling axis the user controls directly — the ontology (domain/category) is LLM-generated and not user-addressable. Use for review layers ("verified", "needs-check"), grouping that crosses project scope ("mobile", "billing"), or case collection ("bug-report"). Get fact ids from search_facts.',
        inputSchema: {
          type: 'object',
          properties: {
            fact_id: { type: 'string', description: 'Fact id shown in search_facts results' },
            add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
            remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
            set: { type: 'array', items: { type: 'string' }, description: 'Replace all tags; [] clears' },
          },
          required: ['fact_id'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Tag Fact',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'list_tags',
        description:
          'Browse user tags. With no arguments, returns the tag index (tag -> fact count). With `tags`, returns the facts carrying them — this is how a tag becomes a custom group that ignores project scope.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project path to scope by (defaults to cwd)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'List facts carrying these tags' },
            match: { type: 'string', enum: ['all', 'any'], default: 'all' },
            limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
        annotations: {
          title: 'List Tags',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'search_ontology',
        description: `Browse the ontology hierarchy (Domain > Category > Facts) level by level. Without a filter: every domain with its largest categories and their fact counts (no fact text). With \`domain\`: up to ${ONTOLOGY_MAX_CATEGORIES} of that domain's categories (\`category_offset\` lists the ones after them). With \`category\` (or facts_per_category > 0): the top facts of each matching category. One answer is at most ${ONTOLOGY_MAX_OUTPUT_CHARS} characters and states what it left out — narrow the domain/category filter to reach it; use search_facts to find facts by meaning.`,
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Filter by domain name (partial, case-insensitive)' },
            category: { type: 'string', description: 'Filter by category name (partial, case-insensitive)' },
            include_relations: { type: 'boolean', default: false, description: 'Include 1-hop relations for each fact shown (at most 5 per fact)' },
            facts_per_category: { type: 'number', minimum: 0, maximum: 50, description: 'Facts shown per category, most confirmed first (0 = names and counts only). Default: 5 with a category filter, otherwise 0' },
            max_categories: { type: 'number', minimum: 1, maximum: ONTOLOGY_MAX_CATEGORIES, description: 'Categories listed per domain, largest first. Default: 8 (200 with a domain filter) without facts, 20 with' },
            category_offset: { type: 'number', minimum: 0, description: 'Categories to skip per domain (largest first) — lists the ones behind max_categories. Default 0' },
          },
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Ontology',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'ask_avatar',
        description: 'Ask the user\'s technical alter ego a question. Returns an answer grounded in past decisions and preferences, with cited sources and confidence level.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 2, description: 'Question to ask' },
            project: { type: 'string', description: 'Project path to scope the search (optional)' },
          },
          required: ['question'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Ask Avatar',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'trace_fact',
        description: 'Trace a fact back to its source conversations. Shows the original exchanges that led to a knowledge graph fact, providing full provenance and context.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, description: 'Search query to find the fact to trace' },
            project: { type: 'string', description: 'Project path to scope the search (optional)' },
            limit: { type: 'number', minimum: 1, maximum: 10, default: 3, description: 'Max facts to trace' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Trace Fact Provenance',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'graph_stats',
        description: 'Get knowledge graph statistics: total facts, domains, categories, relations, and top domains by fact count. Useful for understanding what knowledge has been accumulated.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project path to scope stats (optional, default: all)' },
          },
          additionalProperties: false,
        },
        annotations: {
          title: 'Knowledge Graph Stats',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'cross_project_insights',
        description: 'Find similar decisions and patterns from OTHER projects. Useful for knowledge transfer — see how similar problems were solved in different projects.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, description: 'Topic or decision to find cross-project insights for' },
            current_project: { type: 'string', description: 'Current project path (results from this project are excluded)' },
            limit: { type: 'number', minimum: 1, maximum: 20, default: 5, description: 'Max results' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Cross-Project Insights',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'explore_graph',
        description: 'Explore the knowledge graph starting from a fact or topic. Performs multi-hop traversal to discover indirectly connected knowledge, patterns, and decision chains.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, description: 'Starting topic or fact to explore from' },
            hops: { type: 'number', minimum: 1, maximum: 3, default: 2, description: 'Graph traversal depth (1-3 hops)' },
            project: { type: 'string', description: 'Project scope (optional)' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Explore Knowledge Graph',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
});

// Handle Tool Calls

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);
      let resultText: string;

      // Check if query is array (multi-concept) or string (single-concept)
      if (Array.isArray(params.query)) {
        // Multi-concept search
        const options = {
          limit: params.limit,
          after: params.after,
          before: params.before,
          coding_agent: params.coding_agent,
          include_noise: params.include_noise,
        };

        const results = await searchMultipleConcepts(params.query, options);

        if (params.response_format === 'json') {
          resultText = multiConceptResultsToJson(results, params.query);
        } else {
          resultText = await formatMultiConceptResults(results, params.query);
        }
      } else {
        // Single-concept search
        const options: SearchOptions = {
          mode: params.mode,
          limit: params.limit,
          after: params.after,
          before: params.before,
          coding_agent: params.coding_agent,
          include_noise: params.include_noise,
        };

        const { results, meta } = await searchConversationsDetailed(params.query, options);

        if (params.response_format === 'json') {
          resultText = searchResultsToJson(results, meta, params.mode);
        } else {
          resultText = await formatResults(results, meta);

          // Append knowledge graph context for markdown format
          try {
            const knowledgeCtx = await getKnowledgeContext(params.query, null, 3);
            resultText += formatKnowledgeContext(knowledgeCtx);
          } catch (error) {
            // Knowledge context must not fail the search — but a missing section
            // has to be visible, not silently absent (stderr + one result line).
            const message = error instanceof Error ? error.message : String(error);
            console.error(`memory-bank search: related knowledge unavailable: ${message}`);
            resultText += `\n---\n_Related knowledge unavailable: ${message}_\n`;
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    }

    if (name === 'read') {
      const params = ShowConversationInputSchema.parse(args);

      // Confine reads to conversation storage roots — this tool must not be
      // usable as an arbitrary-file reader (prompt-injected paths like
      // /tmp/secret.jsonl would otherwise be readable). The roots are checked
      // before any existence test, so a path outside them gets one answer
      // whether or not a file is there (read-guard.ts), and the file returned is
      // the one the reader opens (resolveReadTarget). A reversed or out-of-file
      // line range is reported by readConversationRange below.
      const realFile = resolveReadTarget(params.path, [
        getArchiveDir(),
        path.join(os.homedir(), '.claude', 'projects'),
      ]);

      // Read and format the requested line range as a stream: the cost follows
      // the range, not the file (whole-file reads failed on files over 512MB),
      // the output is capped with a continuation hint (a line, and a character
      // offset when the stop is inside one long message), and a range outside
      // the file is an error naming the file's line count.
      const markdownContent = await readConversationRange(realFile, {
        startLine: params.startLine,
        endLine: params.endLine,
        startChar: params.startChar,
        full: params.full,
      });

      return {
        content: [
          {
            type: 'text',
            text: markdownContent,
          },
        ],
      };
    }

    if (name === 'search_facts') {
      const params = SearchFactsInputSchema.parse(args);
      const currentProject = params.project || process.cwd();

      await initEmbeddings();
      const db = initDatabase();
      try {
        const queryEmbedding = await generateEmbedding(params.query, 'query');
        const output = formatFactSearch(db, queryEmbedding, {
          query: params.query,
          project: currentProject,
          category: params.category,
          coding_agent: params.coding_agent,
          tags: params.tags,
          include_revisions: params.include_revisions,
          limit: params.limit,
        });

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === 'tag_fact') {
      const params = TagFactInputSchema.parse(args);
      if (!params.add && !params.remove && !params.set) {
        return {
          content: [{ type: 'text', text: 'Nothing to do: pass add, remove, or set.' }],
          isError: true,
        };
      }
      const db = initDatabase();
      try {
        const lines: string[] = [];
        let tags: string[] = [];
        if (params.set) {
          tags = setFactTags(db, params.fact_id, params.set);
          lines.push(`Set tags: ${tags.length ? tags.join(', ') : '(cleared)'}`);
        }
        if (params.add) {
          const r = addFactTags(db, params.fact_id, params.add);
          tags = r.tags;
          lines.push(r.added.length ? `Added: ${r.added.join(', ')}` : 'Added: (already present)');
        }
        if (params.remove) {
          const r = removeFactTags(db, params.fact_id, params.remove);
          tags = r.tags;
          lines.push(r.removed.length ? `Removed: ${r.removed.join(', ')}` : 'Removed: (none matched)');
          if (r.absent.length) lines.push(`Not present: ${r.absent.join(', ')}`);
        }
        const text = `# Tagged ${params.fact_id}\n\n${lines.join('\n')}\n\nCurrent tags: ${tags.length ? tags.join(', ') : '(none)'}\n`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleError(error) }], isError: true };
      } finally {
        db.close();
      }
    }

    if (name === 'list_tags') {
      const params = ListTagsInputSchema.parse(args);
      const currentProject = params.project || process.cwd();
      const db = initDatabase();
      try {
        if (params.tags && params.tags.length) {
          const facts = findFactsByTags(db, params.tags, {
            project: currentProject,
            match: params.match,
            limit: params.limit,
          });
          let output = `# Facts tagged ${params.tags.join(params.match === 'any' ? ' OR ' : ' AND ')}\n\nProject: ${currentProject}\nResults: ${facts.length}\n\n`;
          if (!facts.length) output += '_No facts carry these tags._\n';
          for (const fact of facts) {
            output += `## [${fact.category}] ${fact.fact}\n`;
            output += `- ID: ${fact.id}\n`;
            output += `- Tags: ${(fact.tags ?? []).join(', ')}\n`;
            output += `- Scope: ${fact.scope_type}${fact.scope_project ? ` (${fact.scope_project})` : ''}\n\n`;
          }
          return { content: [{ type: 'text', text: output }] };
        }

        const tagIndex = listTags(db, { project: currentProject });
        let output = `# Tag index\n\nProject: ${currentProject}\nDistinct tags: ${tagIndex.length}\n\n`;
        if (!tagIndex.length) {
          output += '_No tags yet. Tags are user-assigned — the automatic pipeline never creates them._\n';
        }
        for (const { tag, count } of tagIndex) {
          output += `- ${tag} (${count})\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleError(error) }], isError: true };
      } finally {
        db.close();
      }
    }

    if (name === 'search_ontology') {
      const params = SearchOntologyInputSchema.parse(args) as SearchOntologyInput;

      const db = initDatabase();
      try {
        return { content: [{ type: 'text', text: formatOntologyBrowse(db, params) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === 'ask_avatar') {
      const params = AskAvatarInputSchema.parse(args) as AskAvatarInput;
      const project = params.project || process.cwd();

      const db = initDatabase();
      try {
        const result = await askAvatar(db, params.question, project);

        const confidenceLabel =
          result.confidence >= 0.9
            ? 'HIGH'
            : result.confidence >= 0.7
              ? 'MEDIUM'
              : result.confidence >= 0.5
                ? 'LOW'
                : 'INSUFFICIENT';

        let output = `# Avatar Response\n\n`;
        output += `**Question:** ${params.question}\n\n`;
        output += `**Answer:** ${result.answer}\n\n`;
        output += `**Confidence:** ${(result.confidence * 100).toFixed(0)}% (${confidenceLabel})\n\n`;

        if (result.sources.length > 0) {
          output += `## Supporting Decisions\n\n`;
          for (const source of result.sources) {
            output += `- **[${source.domain}/${source.category}]** ${source.fact.fact}\n`;
            output += `  - Relevance: ${(source.relevance * 100).toFixed(0)}% | Date: ${source.fact.created_at.slice(0, 10)}\n`;
          }
          output += '\n';
        }

        if (result.relatedDecisions.length > 0) {
          output += `## Related Decisions\n\n`;
          const listed = result.relatedDecisions.slice(0, AVATAR_MAX_RELATED_LISTED);
          for (const { fact, relation } of listed) {
            output += `- **[${relation}]** ${clipLine(fact.fact, RELATED_MAX_CHARS)} _(${fact.created_at.slice(0, 10)})_\n`;
          }
          if (result.relatedDecisions.length > listed.length) {
            output += `- _…and ${result.relatedDecisions.length - listed.length} more related decisions._\n`;
          }
        }

        // A failed LLM call is an error for the caller, not an answer with 0% confidence.
        return result.failure
          ? { content: [{ type: 'text', text: output }], isError: true }
          : { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === 'trace_fact') {
      const params = z.object({
        query: z.string().min(2),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(10).default(3),
      }).strict().parse(args);

      const currentProject = params.project || process.cwd();

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, 'query');
        const output = formatFactTrace(db, queryEmbedding, { query: params.query, project: currentProject, limit: params.limit });

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === 'graph_stats') {
      z.object({
        project: z.string().max(500).optional(),
      }).strict().parse(args);

      const db = initDatabase();
      try {
        const totalFacts = (db.prepare('SELECT COUNT(*) as count FROM facts WHERE is_active = 1').get() as { count: number }).count;
        const totalDomains = (db.prepare('SELECT COUNT(*) as count FROM ontology_domains').get() as { count: number }).count;
        const totalCategories = (db.prepare('SELECT COUNT(*) as count FROM ontology_categories').get() as { count: number }).count;
        const totalRelations = (db.prepare('SELECT COUNT(*) as count FROM ontology_relations').get() as { count: number }).count;
        const totalRevisions = (db.prepare('SELECT COUNT(*) as count FROM fact_revisions').get() as { count: number }).count;

        const categoryBreakdown = db.prepare(
          'SELECT category, COUNT(*) as count FROM facts WHERE is_active = 1 GROUP BY category ORDER BY count DESC'
        ).all() as Array<{ category: string; count: number }>;

        const topDomains = db.prepare(`
          SELECT d.name, COUNT(f.id) as fact_count
          FROM ontology_domains d
          JOIN ontology_categories c ON c.domain_id = d.id
          JOIN facts f ON f.ontology_category_id = c.id AND f.is_active = 1
          GROUP BY d.id ORDER BY fact_count DESC LIMIT 10
        `).all() as Array<{ name: string; fact_count: number }>;

        const relationBreakdown = db.prepare(
          'SELECT relation_type, COUNT(*) as count FROM ontology_relations GROUP BY relation_type ORDER BY count DESC'
        ).all() as Array<{ relation_type: string; count: number }>;

        let output = `# Knowledge Graph Statistics\n\n`;
        output += `| Metric | Count |\n|--------|-------|\n`;
        output += `| Active Facts | ${totalFacts} |\n`;
        output += `| Domains | ${totalDomains} |\n`;
        output += `| Categories | ${totalCategories} |\n`;
        output += `| Relations | ${totalRelations} |\n`;
        output += `| Revisions | ${totalRevisions} |\n\n`;

        if (categoryBreakdown.length > 0) {
          output += `## Fact Categories\n\n`;
          for (const { category, count } of categoryBreakdown) output += `- ${category}: ${count}\n`;
          output += '\n';
        }

        if (topDomains.length > 0) {
          output += `## Top Domains\n\n`;
          for (const { name: dn, fact_count } of topDomains) output += `- ${dn}: ${fact_count} facts\n`;
          output += '\n';
        }

        if (relationBreakdown.length > 0) {
          output += `## Relation Types\n\n`;
          for (const { relation_type, count } of relationBreakdown) output += `- ${relation_type}: ${count}\n`;
          output += '\n';
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleError(error) }], isError: true };
      } finally {
        db.close();
      }
    }

    if (name === 'cross_project_insights') {
      const params = z.object({
        query: z.string().min(2),
        current_project: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      }).strict().parse(args);

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, 'query');
        const output = formatCrossProjectInsights(db, queryEmbedding, {
          query: params.query,
          currentProject: params.current_project || process.cwd(),
          limit: params.limit,
        });

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleError(error) }], isError: true };
      } finally {
        db.close();
      }
    }

    if (name === 'explore_graph') {
      const params = z.object({
        query: z.string().min(2),
        hops: z.number().int().min(1).max(3).default(2),
        project: z.string().optional(),
      }).strict().parse(args);

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, 'query');
        const output = formatGraphExploration(db, queryEmbedding, { query: params.query, hops: params.hops, project: params.project });

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return { content: [{ type: 'text', text: handleError(error) }], isError: true };
      } finally {
        db.close();
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    // Return errors within the result (not as protocol errors)
    return {
      content: [
        {
          type: 'text',
          text: handleError(error),
        },
      ],
      isError: true,
    };
  }
});

// Main Function

async function main() {
  console.error('Episodic Memory MCP server running via stdio');

  // Warm inject sidecar BEFORE connecting the transport: it lets the
  // UserPromptSubmit hook reuse this process's loaded embedding model over a
  // unix socket (~150ms warm vs ~2.3s cold). Starting it first means it is
  // available immediately and is never gated on server.connect() completing
  // (best-effort, unref'd — adds no lifecycle and never blocks MCP traffic).
  startInjectDaemon();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
