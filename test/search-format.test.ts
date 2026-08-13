import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { formatKnowledgeContext, serializeSearchResult } from '../src/search.js';

// formatResults requires file system access (countLines, getFileSizeInKB)
// so we test formatKnowledgeContext which is pure

describe('search formatting', () => {
  it('should preserve provenance and explicit null scores in MCP JSON projection', () => {
    const json = serializeSearchResult({
      exchange: {
        id: 'text-only',
        project: 'fixture',
        timestamp: '2026-08-13T00:00:00.000Z',
        userMessage: 'literal query',
        assistantMessage: 'literal answer',
        archivePath: '/tmp/fixture.jsonl',
        lineStart: 1,
        lineEnd: 2,
      },
      similarity: null,
      matchSource: 'text',
      textScore: null,
      vectorScore: null,
      snippet: 'literal query',
    });

    expect(json).toMatchObject({
      similarity: null,
      matchSource: 'text',
      textScore: null,
      vectorScore: null,
    });
    expect(Object.hasOwn(json, 'similarity')).toBe(true);
  });

  it('should route MCP JSON results through the tested provenance projection', () => {
    const source = fs.readFileSync('src/mcp-server.ts', 'utf-8');
    expect(source.includes('results: results.map(serializeSearchResult)')).toBe(true);

    const bundle = fs.readFileSync('dist/mcp-server.js', 'utf-8');
    expect(bundle.includes('results: results.map(serializeSearchResult)')).toBe(true);
    expect(bundle.includes('similarity: provenance.vectorScore')).toBe(true);
  });

  it('should keep the filter-starvation fallback in source and shipped bundles', () => {
    const source = fs.readFileSync('src/search.ts', 'utf-8');
    const distSearch = fs.readFileSync('dist/search.js', 'utf-8');
    const bundle = fs.readFileSync('dist/mcp-server.js', 'utf-8');

    for (const artifact of [source, distSearch, bundle]) {
      expect(artifact).toContain('if (filterParts.length > 0 && rows.length < limit)');
      expect(artifact).toContain('vec_distance_l2(vec.embedding');
      expect(artifact).toContain('ORDER BY distance ASC');
    }
  });

  describe('formatKnowledgeContext', () => {
    it('should return empty string for no facts', () => {
      expect(formatKnowledgeContext({ facts: [] })).toBe('');
    });

    it('should format single fact with domain and category', () => {
      const result = formatKnowledgeContext({
        facts: [{
          fact: 'Use Vitest for testing',
          category: 'decision',
          domain: 'Testing',
          categoryName: 'Framework',
          similarity: 0.95,
          relatedFacts: [],
        }],
      });

      expect(result).toContain('Testing/Framework');
      expect(result).toContain('Use Vitest for testing');
      expect(result).toContain('95%');
      expect(result).toContain('decision');
    });

    it('should include related facts with relation type', () => {
      const result = formatKnowledgeContext({
        facts: [{
          fact: 'Use React for UI',
          category: 'decision',
          domain: 'Frontend',
          categoryName: 'Framework',
          similarity: 0.9,
          relatedFacts: [
            { fact: 'Use TypeScript strictly', relationType: 'SUPPORTS' },
            { fact: 'Prefer hooks over classes', relationType: 'INFLUENCES' },
          ],
        }],
      });

      expect(result).toContain('SUPPORTS');
      expect(result).toContain('Use TypeScript strictly');
      expect(result).toContain('INFLUENCES');
      expect(result).toContain('Prefer hooks over classes');
    });

    it('should format multiple facts', () => {
      const result = formatKnowledgeContext({
        facts: [
          {
            fact: 'Fact 1',
            category: 'pattern',
            domain: 'Backend',
            categoryName: 'API',
            similarity: 0.8,
            relatedFacts: [],
          },
          {
            fact: 'Fact 2',
            category: 'preference',
            domain: 'Frontend',
            categoryName: 'UI',
            similarity: 0.7,
            relatedFacts: [],
          },
        ],
      });

      expect(result).toContain('Fact 1');
      expect(result).toContain('Fact 2');
      expect(result).toContain('Backend/API');
      expect(result).toContain('Frontend/UI');
      expect(result).toContain('80%');
      expect(result).toContain('70%');
    });

    it('should include Related Knowledge header', () => {
      const result = formatKnowledgeContext({
        facts: [{
          fact: 'Test fact',
          category: 'knowledge',
          domain: 'General',
          categoryName: 'Misc',
          similarity: 0.6,
          relatedFacts: [],
        }],
      });

      expect(result).toContain('Related Knowledge');
    });

    it('should handle zero similarity', () => {
      const result = formatKnowledgeContext({
        facts: [{
          fact: 'Low relevance fact',
          category: 'constraint',
          domain: 'Infra',
          categoryName: 'Limits',
          similarity: 0,
          relatedFacts: [],
        }],
      });

      expect(result).toContain('0%');
    });
  });
});
