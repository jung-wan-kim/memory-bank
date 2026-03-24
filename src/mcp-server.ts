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
  getKnowledgeContext,
  formatKnowledgeContext,
  SearchOptions,
} from './search.js';
import { formatConversationAsMarkdown } from './show.js';
import { initDatabase } from './db.js';
import { searchSimilarFacts, searchAllFacts, getRevisions } from './fact-db.js';
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

          // Append knowledge graph context for markdown format
          try {
            const knowledgeCtx = await getKnowledgeContext(params.query, null, 3);
            resultText += formatKnowledgeContext(knowledgeCtx);
          } catch {
            // Knowledge context is best-effort, don't fail the search
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
        const queryEmbedding = await generateEmbedding(params.query);
        const results = searchSimilarFacts(db, queryEmbedding, currentProject, params.limit, 0.5);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching facts found to trace.' }] };
        }

        let output = `# Fact Provenance Trace\n\nQuery: "${params.query}"\n\n`;

        for (const { fact, distance } of results) {
          const similarity = (1 - distance * distance / 2).toFixed(3);
          output += `## ${fact.fact}\n`;
          output += `- Category: ${fact.category} | Scope: ${fact.scope_type}\n`;
          output += `- Similarity: ${similarity} | Confirmed: ${fact.consolidated_count}x\n`;
          output += `- Created: ${fact.created_at}\n`;

          // Trace back to source exchanges
          if (fact.source_exchange_ids && fact.source_exchange_ids.length > 0) {
            output += `\n### Source Conversations\n\n`;
            for (const exchangeId of fact.source_exchange_ids) {
              const exchange = db.prepare(
                'SELECT id, project, timestamp, user_message, archive_path, line_start, line_end FROM exchanges WHERE id = ?'
              ).get(exchangeId) as Record<string, unknown> | undefined;

              if (exchange) {
                const userMsg = (exchange['user_message'] as string).substring(0, 200).replace(/\s+/g, ' ');
                output += `- **[${exchange['project']}, ${(exchange['timestamp'] as string).slice(0, 10)}]**\n`;
                output += `  "${userMsg}..."\n`;
                output += `  Lines ${exchange['line_start']}-${exchange['line_end']} in ${exchange['archive_path']}\n\n`;
              }
            }
          } else {
            output += `\n_Source exchanges not available._\n\n`;
          }

          // Show ontology context
          const revisions = getRevisions(db, fact.id);
          if (revisions.length > 0) {
            output += `### Revision History\n\n`;
            for (const rev of revisions) {
              output += `- ${rev.created_at.slice(0, 10)}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
            }
            output += '\n';
          }

          // Show graph relations
          const related = getRelatedFacts(db, fact.id, 1);
          if (related.length > 0) {
            output += `### Related Facts (1-hop)\n\n`;
            for (const { fact: relFact, relation } of related) {
              output += `- **[${relation.relation_type}]** ${relFact.fact}\n`;
            }
            output += '\n';
          }
        }

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
      const params = z.object({
        project: z.string().optional(),
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
        const queryEmbedding = await generateEmbedding(params.query);
        const allResults = searchAllFacts(db, queryEmbedding, params.limit * 3, 0.5);

        // Filter out current project facts, keep only OTHER projects
        const currentProject = params.current_project || process.cwd();
        const crossProjectResults = allResults.filter(
          r => r.fact.scope_type === 'project' && r.fact.scope_project !== currentProject
        ).slice(0, params.limit);

        if (crossProjectResults.length === 0) {
          return { content: [{ type: 'text', text: `No cross-project insights found for "${params.query}". Similar decisions may not exist in other projects yet.` }] };
        }

        // Group by project
        const byProject = new Map<string, Array<{ fact: typeof crossProjectResults[0]['fact']; distance: number }>>();
        for (const { fact, distance } of crossProjectResults) {
          const proj = fact.scope_project || 'global';
          if (!byProject.has(proj)) byProject.set(proj, []);
          byProject.get(proj)!.push({ fact, distance });
        }

        let output = `# Cross-Project Insights\n\nQuery: "${params.query}"\nExcluding: ${currentProject}\n\n`;

        for (const [project, facts] of byProject) {
          output += `## Project: ${project}\n\n`;
          for (const { fact, distance } of facts) {
            const similarity = Math.round((1 - distance * distance / 2) * 100);
            output += `- **[${fact.category}]** ${fact.fact} _(${similarity}% relevant, ${fact.created_at.slice(0, 10)})_\n`;
          }
          output += '\n';
        }

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
        const queryEmbedding = await generateEmbedding(params.query);
        const seedFacts = searchSimilarFacts(db, queryEmbedding, params.project ?? null, 3, 0.5);

        if (seedFacts.length === 0) {
          return { content: [{ type: 'text', text: `No facts found related to "${params.query}" to start graph exploration.` }] };
        }

        // Build domain/category maps
        const domains = listDomains(db);
        const categories = listCategories(db);
        const domainMap = new Map(domains.map(d => [d.id, d.name]));
        const categoryMap = new Map(categories.map(c => [c.id, { name: c.name, domainId: c.domain_id }]));

        let output = `# Knowledge Graph Exploration\n\nSeed: "${params.query}" | Depth: ${params.hops} hops\n\n`;

        const allDiscovered = new Set<string>();

        for (const { fact: seedFact, distance } of seedFacts) {
          const similarity = Math.round((1 - distance * distance / 2) * 100);
          const catInfo = seedFact.ontology_category_id ? categoryMap.get(seedFact.ontology_category_id) : undefined;
          const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? '?') : '?';
          const catName = catInfo ? catInfo.name : '?';

          output += `## Seed: ${seedFact.fact}\n`;
          output += `- [${domainName}/${catName}] ${seedFact.category} | ${similarity}% relevant\n\n`;

          allDiscovered.add(seedFact.id);

          // Multi-hop traversal
          const related = getRelatedFacts(db, seedFact.id, params.hops);

          if (related.length === 0) {
            output += `_No connected facts found._\n\n`;
            continue;
          }

          // Group by hop distance (approximate via order)
          output += `### Connected Facts (${related.length} found, up to ${params.hops} hops)\n\n`;

          for (const { fact: relFact, relation } of related) {
            if (allDiscovered.has(relFact.id)) continue;
            allDiscovered.add(relFact.id);

            const relCatInfo = relFact.ontology_category_id ? categoryMap.get(relFact.ontology_category_id) : undefined;
            const relDomain = relCatInfo ? (domainMap.get(relCatInfo.domainId) ?? '?') : '?';
            const relCat = relCatInfo ? relCatInfo.name : '?';

            output += `- **[${relation.relation_type}]** ${relFact.fact}\n`;
            output += `  [${relDomain}/${relCat}] ${relFact.category} | ${relFact.created_at.slice(0, 10)}\n`;
            if (relation.reasoning) {
              output += `  _${relation.reasoning}_\n`;
            }
          }
          output += '\n';
        }

        output += `\n_Total unique facts discovered: ${allDiscovered.size}_\n`;

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
