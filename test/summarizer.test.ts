import { describe, it, expect } from 'vitest';
import { formatConversationText } from '../src/summarizer.js';
import type { ConversationExchange } from '../src/types.js';

function makeExchange(user: string, assistant: string): ConversationExchange {
  return {
    id: 'test-id',
    project: 'test',
    timestamp: '2026-01-01T00:00:00Z',
    userMessage: user,
    assistantMessage: assistant,
    archivePath: '/tmp/test.jsonl',
    lineStart: 1,
    lineEnd: 2,
  };
}

describe('summarizer', () => {
  describe('formatConversationText', () => {
    it('should format single exchange', () => {
      const result = formatConversationText([makeExchange('Hello', 'Hi there')]);
      expect(result).toBe('User: Hello\n\nAgent: Hi there');
    });

    it('should join multiple exchanges with separator', () => {
      const result = formatConversationText([
        makeExchange('Q1', 'A1'),
        makeExchange('Q2', 'A2'),
      ]);
      expect(result).toBe('User: Q1\n\nAgent: A1\n\n---\n\nUser: Q2\n\nAgent: A2');
    });

    it('should handle empty array', () => {
      const result = formatConversationText([]);
      expect(result).toBe('');
    });

    it('should preserve multiline messages', () => {
      const result = formatConversationText([makeExchange('Line1\nLine2', 'Reply\nMultiline')]);
      expect(result).toContain('Line1\nLine2');
      expect(result).toContain('Reply\nMultiline');
    });

    it('should handle empty messages', () => {
      const result = formatConversationText([makeExchange('', '')]);
      expect(result).toBe('User: \n\nAgent: ');
    });
  });
});
