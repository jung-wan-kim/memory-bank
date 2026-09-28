import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every memory-bank query() must be tool-less (2026-09-28). Worker sessions
 * summarize user transcripts; with the default toolset they followed
 * instructions inside those transcripts (Task subagent spawns, Bash, Read).
 */

const seen: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    seen.push(args.options);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', result: '<summary>ok</summary>' } as never;
      },
    };
  },
}));

function expectToolless(opts: Record<string, unknown>) {
  expect(opts.tools).toEqual([]);
  expect(opts.permissionMode).toBe('dontAsk');
  expect(opts.maxTurns).toBe(1);
}

beforeEach(() => {
  seen.length = 0;
});

describe('memory-bank query() tool containment', () => {
  it('callHaiku passes no tools, dontAsk, one turn', async () => {
    const { callHaiku } = await import('../src/llm.js');
    await callHaiku('sys', 'user');
    expect(seen).toHaveLength(1);
    expectToolless(seen[0]);
  });

  it('summarizer passes no tools, dontAsk, one turn — also when resuming', async () => {
    const { summarizeConversation } = await import('../src/summarizer.js');
    const ex = [{ userMessage: 'x'.repeat(200), assistantMessage: 'y'.repeat(200) }] as never;
    await summarizeConversation(ex);
    await summarizeConversation(ex, 'some-session-id');
    expect(seen).toHaveLength(2);
    seen.forEach(expectToolless);
    expect(seen[1].resume).toBe('some-session-id');
  });
});
