import { describe, it, expect } from 'vitest';
import { formatKnowledgeContext } from '../src/search.js';

// formatResults requires file system access (countLines, getFileSizeInKB)
// so we test formatKnowledgeContext which is pure

describe('search formatting', () => {
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
