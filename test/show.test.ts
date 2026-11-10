import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatConversationAsMarkdown, formatConversationAsHTML } from '../src/show.js';

describe('show command - markdown formatting', () => {
  const fixturesDir = join(import.meta.dirname, 'fixtures');

  it('should format a simple user-assistant exchange', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should include user messages
    expect(markdown).toMatch(/\*\*User\*\*/);
    expect(markdown).toContain('being very tentative');

    // Should include assistant messages (shown as Agent in main thread)
    expect(markdown).toMatch(/\*\*Agent\*\*/);
    expect(markdown).toContain('Looking at your instructions');

    // Should show timestamps (locale-independent check)
    expect(markdown).toMatch(/2025/);
  });

  it('should include tool calls in the output', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should show tool use formatting (fixture has tool calls)
    expect(markdown).toContain('**Tool Use:**');
  });

  it('should include tool results', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should show tool results (now inline with tool use)
    expect(markdown).toContain('**Result:**');
    expect(markdown).toContain('Thoughts recorded successfully');
  });

  it('should preserve message hierarchy with parentUuid', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Messages should appear in conversation order
    const userIndex = markdown.indexOf('being very tentative');
    const assistantIndex = markdown.indexOf('Looking at your instructions');
    const toolIndex = markdown.indexOf('**Tool Use:**');

    expect(userIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeLessThan(assistantIndex);
    expect(assistantIndex).toBeLessThan(toolIndex);
  });

  it('should include metadata (session, project, git branch)', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should show metadata at top
    expect(markdown).toContain('Session ID:');
    expect(markdown).toContain('67a8478e-78dc-44ab-82ea-f65c8ead85f6');
    expect(markdown).toContain('Git Branch:');
    expect(markdown).toContain('streaming');
  });

  it('should indicate sidechains if present', () => {
    // For now we test the structure - will need a fixture with sidechains later
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should have structure that could show sidechains
    expect(markdown).toBeTruthy();
  });

  it('should handle token usage information', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const markdown = formatConversationAsMarkdown(jsonl);

    // Should include usage stats (now in compact inline format)
    expect(markdown).toMatch(/in: \d+/);
    expect(markdown).toMatch(/out: \d+/);
  });
});

describe('show command - edge cases', () => {
  it('should return empty string for empty input', () => {
    expect(formatConversationAsMarkdown('')).toBe('');
  });

  it('should return empty string for whitespace-only input', () => {
    expect(formatConversationAsMarkdown('   \n  \n  ')).toBe('');
  });

  it('should return empty string for malformed JSON lines', () => {
    expect(formatConversationAsMarkdown('not json\nalso not json')).toBe('');
  });

  it('should handle startLine and endLine range', () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures');
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const full = formatConversationAsMarkdown(jsonl);
    const partial = formatConversationAsMarkdown(jsonl, 1, 2);

    // Partial should be shorter or equal
    expect(partial.length).toBeLessThanOrEqual(full.length);
  });

  it('should handle out-of-bounds line range gracefully', () => {
    const fixturesDir = join(import.meta.dirname, 'fixtures');
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    // Lines way beyond file length
    const result = formatConversationAsMarkdown(jsonl, 9999, 10000);
    expect(result).toBe('');
  });

  it('should skip system messages (non user/assistant)', () => {
    const systemMsg = JSON.stringify({
      uuid: 'sys-1',
      parentUuid: null,
      timestamp: '2026-01-01T00:00:00Z',
      type: 'system',
      isSidechain: false,
      message: { role: 'system', content: 'System message' }
    });
    expect(formatConversationAsMarkdown(systemMsg)).toBe('');
  });

  it('should handle messages with empty content array', () => {
    const emptyContent = JSON.stringify({
      uuid: 'empty-1',
      parentUuid: null,
      timestamp: '2026-01-01T00:00:00Z',
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: [] }
    });
    expect(formatConversationAsMarkdown(emptyContent)).toBe('');
  });
});

describe('show command - HTML formatting', () => {
  const fixturesDir = join(import.meta.dirname, 'fixtures');

  it('should generate valid HTML with DOCTYPE and metadata', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const html = formatConversationAsHTML(jsonl);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('<title>');
  });

  it('should include CSS styling', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const html = formatConversationAsHTML(jsonl);

    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    expect(html).toContain('font-family');
  });

  it('should render user and assistant messages', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const html = formatConversationAsHTML(jsonl);

    expect(html).toContain('User');
    expect(html).toContain('Agent'); // Assistant shows as Agent in main thread
    expect(html).toContain('being very tentative');
    expect(html).toContain('Looking at your instructions');
  });

  it('should render tool calls with proper formatting', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const html = formatConversationAsHTML(jsonl);

    // Check for tool call formatting (fixture has tool calls)
    expect(html).toContain('Tool Use');
  });

  it('should include session metadata', () => {
    const jsonl = readFileSync(join(fixturesDir, 'tiny-conversation.jsonl'), 'utf-8');
    const html = formatConversationAsHTML(jsonl);

    expect(html).toContain('67a8478e-78dc-44ab-82ea-f65c8ead85f6');
    expect(html).toContain('streaming');
  });
});

describe('show command - HTML export does not pass conversation HTML through (SEC-09)', () => {
  // An assistant message that counts as markdown (heading, bold, list, link) and carries active content.
  const hostile = [
    '# Summary',
    '',
    '**Done.** Details:',
    '',
    '- item one',
    '- <img src=x onerror="window.__mb1=1"> inline image tag',
    '',
    '<script>window.__mb2=1</script>',
    '',
    '<details><summary>raw block</summary>hidden</details>',
    '',
    '[run me](javascript:window.__mb3=1) and [docs](https://example.com/a?b=1&c=2) and [mail](mailto:a@example.com)',
    '',
    '![pixel](https://tracker.example/p.png "t")',
    '',
    '`<b>code stays code</b>`',
  ].join('\n');
  const jsonl = [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2026-11-10T00:00:00Z', message: { role: 'user', content: 'show me' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-11-10T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: hostile }] } }),
  ].join('\n');

  it('renders the markdown but writes raw HTML as text', () => {
    const html = formatConversationAsHTML(jsonl);
    // It went through the markdown renderer (not the plain-text branch).
    expect(html).toContain('<div class="markdown-content">');
    expect(html).toMatch(/<h1[^>]*>Summary<\/h1>/);
    expect(html).toContain('<strong>Done.</strong>');
    // No element or handler from the message survives as markup.
    expect(html).not.toContain('<script>window.__mb2=1</script>');
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<details\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\sonerror\s*=/i);
    expect(html).toContain('&lt;script&gt;window.__mb2=1&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=');
    // Inline code was already escaped by the renderer and still is.
    expect(html).toContain('<code>&lt;b&gt;code stays code&lt;/b&gt;</code>');
  });

  it('keeps http(s) and mailto links, drops any other scheme, and loads no image', () => {
    const html = formatConversationAsHTML(jsonl);
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">docs</a>');
    expect(html).toContain('<a href="mailto:a@example.com" rel="noopener noreferrer">mail</a>');
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    expect(html).toContain('run me'); // the label stays, as text
    expect(html).not.toContain('src="https://tracker.example/p.png"');
    expect(html).toContain('![pixel](https://tracker.example/p.png)');
  });

  it('declares a policy that runs no script and loads nothing remote', () => {
    const html = formatConversationAsHTML(jsonl);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
    // The page itself needs neither: no script element, no external resource.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
  });
});
