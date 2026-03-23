#!/usr/bin/env node
/**
 * MCP Server for Memory Bank.
 *
 * This server provides tools to search and explore indexed Claude Code conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  searchConversations,
  searchMultipleConcepts,
  formatResults,
  formatMultiConceptResults,
  SearchOptions,
} from './search.js';
import { formatConversationAsMarkdown } from './show.js';
import { initDatabase } from './db.js';
import { searchSimilarFacts, getRevisions } from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { getOntologyTree, listDomains, listCategories, getFactsByCategory, getRelatedFacts } from './ontology-db.js';
import { askAvatar } from './avatar-responder.js';
import fs from 'fs';
import path from 'path';

// Zod Schemas for Input Validation

const SearchModeEnum = z.enum(['vector', 'text', 'both']);
const ResponseFormatEnum = z.enum(['markdown', 'json']);

const SearchInputSchema = z
  .object({
    query: z
      .union([
        z.string().min(2, 'Query must be at least 2 characters'),
        z
          .array(z.string().min(2))
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
      .describe('Starting line number (1-indexed, inclusive). Omit to start from beginning.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Ending line number (1-indexed, inclusive). Omit to read to end.'),
  })
  .strict();

const SearchFactsInputSchema = z
  .object({
    query: z.string().min(2, 'Query must be at least 2 characters'),
    project: z.string().optional(),
    category: z.enum(['decision', 'preference', 'pattern', 'knowledge', 'constraint']).optional(),
    include_revisions: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const SearchOntologyInputSchema = z
  .object({
    domain: z.string().optional().describe('Filter by domain name (case-insensitive partial match)'),
    category: z.string().optional().describe('Filter by category name (case-insensitive partial match)'),
    include_relations: z.boolean().default(false).describe('Include 1-hop fact relations'),
  })
  .strict();

type SearchOntologyInput = z.infer<typeof SearchOntologyInputSchema>;

const AskAvatarInputSchema = z
  .object({
    question: z.string().min(2, 'Question must be at least 2 characters').describe('Question to ask'),
    project: z.string().optional().describe('Project path to scope the search'),
  })
  .strict();

type AskAvatarInput = z.infer<typeof AskAvatarInputSchema>;

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
    version: '1.0.0',
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
        description: `Gives you memory across sessions. You don't automatically remember past conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for semantic search or array of 2-5 concepts for precise AND matching. Returns ranked results with project, date, snippets, and file paths.`,
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
        description: `Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            startLine: { type: 'number', minimum: 1 },
            endLine: { type: 'number', minimum: 1 },
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
        name: 'search_ontology',
        description: 'Browse the ontology hierarchy (Domain > Category > Facts). Use to understand how past decisions are organized, or to find all facts in a specific domain/category.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Filter by domain name (partial, case-insensitive)' },
            category: { type: 'string', description: 'Filter by category name (partial, case-insensitive)' },
            include_relations: { type: 'boolean', default: false, description: 'Include 1-hop relations for each fact' },
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
        };

        const results = await searchMultipleConcepts(params.query, options);

        if (params.response_format === 'json') {
          resultText = JSON.stringify(
            {
              results: results,
              count: results.length,
              concepts: params.query,
            },
            null,
            2
          );
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
        };

        const results = await searchConversations(params.query, options);

        if (params.response_format === 'json') {
          resultText = JSON.stringify(
            {
              results: results.map((r) => ({
                exchange: r.exchange,
                similarity: r.similarity,
                snippet: r.snippet,
              })),
              count: results.length,
              mode: params.mode,
            },
            null,
            2
          );
        } else {
          resultText = await formatResults(results);
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

      // Validate path: must be absolute and a .jsonl file
      const resolvedPath = path.resolve(params.path);
      if (!resolvedPath.endsWith('.jsonl')) {
        throw new Error(`Invalid file type: only .jsonl files are supported`);
      }

      // Verify file exists
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }

      // Read and format conversation with optional line range
      const jsonlContent = fs.readFileSync(resolvedPath, 'utf-8');
      const markdownContent = formatConversationAsMarkdown(
        jsonlContent,
        params.startLine,
        params.endLine
      );

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
        const queryEmbedding = await generateEmbedding(params.query);
        const results = searchSimilarFacts(db, queryEmbedding, currentProject, params.limit);

        // Apply category filter if specified
        const filtered = params.category
          ? results.filter(r => r.fact.category === params.category)
          : results;

        let output = `# Facts Search Results\n\nQuery: "${params.query}"\nProject: ${currentProject}\nResults: ${filtered.length}\n\n`;

        if (filtered.length === 0) {
          output += '_No matching facts found._\n';
        }

        for (const { fact, distance } of filtered) {
          const similarity = (1 - distance * distance / 2).toFixed(3);
          output += `## [${fact.category}] ${fact.fact}\n`;
          output += `- Scope: ${fact.scope_type}${fact.scope_project ? ` (${fact.scope_project})` : ''}\n`;
          output += `- Confirmed: ${fact.consolidated_count}x | Similarity: ${similarity}\n`;
          output += `- Created: ${fact.created_at}\n`;

          if (params.include_revisions) {
            const revisions = getRevisions(db, fact.id);
            if (revisions.length > 0) {
              output += '- Revisions:\n';
              for (const rev of revisions) {
                output += `  - ${rev.created_at}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
              }
            }
          }
          output += '\n';
        }

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

    if (name === 'search_ontology') {
      const params = SearchOntologyInputSchema.parse(args) as SearchOntologyInput;

      try {
        const db = initDatabase();
        const tree = getOntologyTree(db);

        // Apply domain/category filters
        const domainFilter = params.domain?.toLowerCase();
        const categoryFilter = params.category?.toLowerCase();

        const filtered = tree.filter((entry) => {
          if (domainFilter && !entry.domain.name.toLowerCase().includes(domainFilter)) return false;
          return true;
        });

        let output = `# Ontology Tree\n\n`;

        if (filtered.length === 0) {
          output += '_No ontology data found. Facts are classified automatically as they are extracted._\n';
        }

        for (const { domain, categories } of filtered) {
          output += `## ${domain.name}\n`;
          if (domain.description) output += `> ${domain.description}\n`;
          output += '\n';

          const filteredCategories = categories.filter(({ category }) => {
            if (categoryFilter && !category.name.toLowerCase().includes(categoryFilter)) return false;
            return true;
          });

          if (filteredCategories.length === 0) {
            output += '_No matching categories._\n\n';
            continue;
          }

          for (const { category, facts } of filteredCategories) {
            output += `### ${category.name}`;
            if (category.description) output += ` — ${category.description}`;
            output += `\n(${facts.length} facts)\n\n`;

            for (const fact of facts) {
              output += `- **[${fact.category}]** ${fact.fact}\n`;
              output += `  - ID: ${fact.id} | Confirmed: ${fact.consolidated_count}x | ${fact.created_at.slice(0, 10)}\n`;

              if (params.include_relations) {
                const related = getRelatedFacts(db, fact.id, 1);
                if (related.length > 0) {
                  for (const { fact: relFact, relation } of related) {
                    output += `  - ↔ [${relation.relation_type}] "${relFact.fact}"\n`;
                  }
                }
              }
            }
            output += '\n';
          }
        }

        db.close();
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
      }
    }

    if (name === 'ask_avatar') {
      const params = AskAvatarInputSchema.parse(args) as AskAvatarInput;
      const project = params.project || process.cwd();

      try {
        const db = initDatabase();
        const result = await askAvatar(db, params.question, project);
        db.close();

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
          for (const { fact, relation } of result.relatedDecisions) {
            output += `- **[${relation}]** ${fact.fact} _(${fact.created_at.slice(0, 10)})_\n`;
          }
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: handleError(error) }],
          isError: true,
        };
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
