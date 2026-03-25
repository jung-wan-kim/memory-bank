import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from '../src/llm.js';

describe('LLM Module', () => {
  describe('parseJsonResponse', () => {
    it('should parse raw JSON array', () => {
      const result = parseJsonResponse<any[]>('[{"fact": "test"}]');
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should parse JSON in code block', () => {
      const text = 'Here are the facts:\n```json\n[{"fact": "test"}]\n```';
      const result = parseJsonResponse<any[]>(text);
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should return null for invalid JSON', () => {
      expect(parseJsonResponse<any>('not json at all')).toBeNull();
    });

    it('should parse JSON object', () => {
      const result = parseJsonResponse<any>('{"relation": "DUPLICATE"}');
      expect(result).toEqual({ relation: 'DUPLICATE' });
    });

    it('should handle nested JSON in text', () => {
      const text = 'Analysis complete.\n{"relation": "EVOLUTION", "merged_fact": "updated", "reason": "changed"}';
      const result = parseJsonResponse<any>(text);
      expect(result?.relation).toBe('EVOLUTION');
    });

    it('should return null for empty string', () => {
      expect(parseJsonResponse<any>('')).toBeNull();
    });

    it('should throw or return null for null/undefined input', () => {
      // null/undefined causes .match() to throw - this is expected behavior
      // since callers always pass string from LLM response
      expect(() => parseJsonResponse<any>(null as any)).toThrow();
    });

    it('should parse JSON with markdown wrapper', () => {
      const text = '```\n{"key": "value"}\n```';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
    });

    it('should handle JSON with trailing text', () => {
      const text = '{"answer": "yes", "confidence": 0.9}\n\nSome trailing explanation';
      const result = parseJsonResponse<any>(text);
      expect(result?.answer).toBe('yes');
    });

    it('should prefer array match over object match', () => {
      // regex chain: json code block > array > object
      // input with both array and object: array regex matches first
      const text = '{"a": {"b": {"c": [1, 2, 3]}}}';
      const result = parseJsonResponse<any>(text);
      // Array regex [...]  matches [1, 2, 3] before {...} regex
      expect(result).toEqual([1, 2, 3]);
    });

    it('should parse pure object when no array present', () => {
      const text = '{"key": "value", "nested": {"n": 1}}';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
      expect(result?.nested?.n).toBe(1);
    });
  });
});
