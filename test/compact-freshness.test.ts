import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateCompactFreshness,
  formatCompactFreshnessReceipt,
  type CompactFreshnessDependencies,
  type SessionIndexState,
} from '../src/compact-freshness.js';
import type { IndexSessionResult } from '../src/indexer.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function indexedResult(overrides: Partial<Extract<IndexSessionResult, { status: 'indexed' }>> = {}) {
  return {
    status: 'indexed' as const,
    sessionId: SESSION_ID,
    startedAt: 1_000,
    sourcePath: `/tmp/${SESSION_ID}.jsonl`,
    expectedExchangeCount: 2,
    expectedFrontier: 42,
    ...overrides,
  };
}

function dependencies(
  indexResult: IndexSessionResult | Error,
  observed: SessionIndexState
): CompactFreshnessDependencies {
  return {
    indexCurrentSession: vi.fn(async () => {
      if (indexResult instanceof Error) throw indexResult;
      return indexResult;
    }),
    readSessionState: vi.fn(() => observed),
  };
}

describe('SessionStart:compact freshness', () => {
  it('marks fresh only after foreground indexing is awaited and the DB frontier confirms it', async () => {
    let observed: SessionIndexState = { exchangeCount: 1, frontier: 10, lastIndexed: 900 };
    const deps: CompactFreshnessDependencies = {
      indexCurrentSession: vi.fn(async () => {
        await Promise.resolve();
        observed = { exchangeCount: 2, frontier: 42, lastIndexed: 1_001 };
        return indexedResult();
      }),
      readSessionState: vi.fn(() => observed),
    };

    const receipt = await evaluateCompactFreshness(SESSION_ID, deps);

    expect(receipt).toMatchObject({
      status: 'fresh',
      reason: 'current_session_indexed',
      exchangeCount: 2,
      frontier: 42,
      lastIndexed: 1_001,
    });
  });

  it('does not promote a missing session to fresh', async () => {
    const deps = dependencies(
      { status: 'not_found', sessionId: SESSION_ID, startedAt: 1_000 },
      { exchangeCount: 0, frontier: null, lastIndexed: null }
    );

    await expect(evaluateCompactFreshness(SESSION_ID, deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'not_found',
      lastIndexed: null,
    });
  });

  it('reports stale with the last observed index when foreground indexing throws', async () => {
    const deps = dependencies(
      new Error('embedding unavailable'),
      { exchangeCount: 4, frontier: 38, lastIndexed: 900 }
    );

    await expect(evaluateCompactFreshness(SESSION_ID, deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'index_error',
      frontier: 38,
      lastIndexed: 900,
    });
  });

  it('rejects a stale DB observation even when the indexer returned indexed', async () => {
    const deps = dependencies(
      indexedResult(),
      { exchangeCount: 2, frontier: 41, lastIndexed: 1_001 }
    );

    await expect(evaluateCompactFreshness(SESSION_ID, deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'frontier_mismatch',
    });
  });

  it('requires last_indexed to come from this foreground attempt', async () => {
    const deps = dependencies(
      indexedResult(),
      { exchangeCount: 2, frontier: 42, lastIndexed: 999 }
    );

    await expect(evaluateCompactFreshness(SESSION_ID, deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'index_not_observed_after_attempt',
    });
  });

  it('fails closed when session_id is missing or invalid without invoking the indexer', async () => {
    const deps = dependencies(indexedResult(), { exchangeCount: 2, frontier: 42, lastIndexed: 1_001 });

    await expect(evaluateCompactFreshness(null, deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'missing_session_id',
    });
    await expect(evaluateCompactFreshness('../escape', deps)).resolves.toMatchObject({
      status: 'stale',
      reason: 'invalid_session_id',
    });
    expect(deps.indexCurrentSession).not.toHaveBeenCalled();
  });

  it('formats the explicit stale receipt contract', () => {
    const text = formatCompactFreshnessReceipt({
      status: 'stale',
      reason: 'index_error',
      exchangeCount: 1,
      frontier: 38,
      lastIndexed: Date.UTC(2026, 7, 13, 9, 30, 0),
    });

    expect(text).toBe(
      'memory-bank: stale, 마지막 색인 = 2026-08-13 18:30:00 KST (reason=index_error, frontier=L38)'
    );
  });

  it('registers a synchronous compact-only hook that points at a packaged cli entry', () => {
    const hooks = JSON.parse(fs.readFileSync(path.resolve('hooks/hooks.json'), 'utf8'));
    const compact = hooks.hooks.SessionStart.find((entry: { matcher: string }) => entry.matcher === 'compact');
    expect(compact).toBeDefined();
    expect(compact.hooks).toContainEqual({
      type: 'command',
      command: 'node ${CLAUDE_PLUGIN_ROOT}/cli/compact-freshness-hook.js',
      timeout: 180,
    });
    expect(compact.hooks[0].async).not.toBe(true);
    expect(fs.existsSync(path.resolve('cli/compact-freshness-hook.js'))).toBe(true);
  });

  it('does not substitute an ambient SESSION_ID when the compact event omits its id', () => {
    const child = spawnSync(process.execPath, ['cli/compact-freshness-hook.js'], {
      cwd: process.cwd(),
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }),
      encoding: 'utf8',
      env: { ...process.env, SESSION_ID },
    });

    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toContain('stale, 마지막 색인 = 없음');
    expect(child.stdout.trim()).toContain('reason=missing_session_id');
  });

  it('keeps the packaged dist hook logic in parity with the TypeScript source', async () => {
    const dist = await import('../dist/compact-freshness.js');
    const sourceDeps = dependencies(
      indexedResult(),
      { exchangeCount: 2, frontier: 42, lastIndexed: 1_001 }
    );
    const distDeps = dependencies(
      indexedResult(),
      { exchangeCount: 2, frontier: 42, lastIndexed: 1_001 }
    );

    const sourceReceipt = await evaluateCompactFreshness(SESSION_ID, sourceDeps);
    const distReceipt = await dist.evaluateCompactFreshness(SESSION_ID, distDeps);

    expect(distReceipt).toEqual(sourceReceipt);
    expect(distReceipt.status).toBe('fresh');
  });
});
