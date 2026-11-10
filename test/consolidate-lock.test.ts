import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireConsolidateLock, releaseConsolidateLock, consolidateLockPath } from '../src/consolidate-health.js';

/**
 * The consolidate worker's single-instance lock (2026-11-11, 2차 검수 R2-CE-05).
 *
 * The lock is a file holding its owner's pid; a lock whose owner is dead is
 * taken over. The takeover used to be "remove the stale file, then create
 * mine": two workers that both read the same stale lock both removed a file
 * and both created one — the later removal deleted the earlier worker's NEW
 * lock, and both ran (1 of 30 simultaneous starts of two workers on a copy of
 * the live store; 3 of 40 with four workers on a synthetic store; 25 of 30 when
 * eight processes ran the old lock code alone). A lock is mutual exclusion or it
 * is nothing, so the takeover is one step now: only the worker holding the claim
 * on that dead pid replaces the file, after reading that it still names that
 * pid, by rename.
 *
 * The interleavings are staged here on the real file system: "another worker"
 * is a live child process's pid written where that worker would have written.
 */

const sleepers: ChildProcess[] = [];
/** The pid of a process that is alive for the rest of this file. */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(child);
  return child.pid!;
}
/** The pid of a process that has already ended. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
afterAll(() => { for (const c of sleepers) c.kill('SIGKILL'); });

describe('the consolidate worker lock', () => {
  let dir: string;
  let lock: string;

  const content = (file = lock) => fs.readFileSync(file, 'utf8');
  /** Every file the lock code left in the directory. */
  const files = () => fs.readdirSync(dir).sort();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-consolidate-lock-'));
    lock = path.join(dir, 'fact-consolidate.lock');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is the lock file of the index directory', () => {
    const prev = process.env.MEMORY_BANK_CONFIG_DIR;
    process.env.MEMORY_BANK_CONFIG_DIR = dir;
    try {
      expect(consolidateLockPath()).toBe(path.join(dir, 'conversation-index', 'fact-consolidate.lock'));
    } finally {
      if (prev === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR; else process.env.MEMORY_BANK_CONFIG_DIR = prev;
    }
  });

  it('no lock: taken, the file holds this pid and nothing else is left; release removes it', () => {
    expect(acquireConsolidateLock(lock)).toEqual({ acquired: true });
    expect(content()).toBe(String(process.pid));
    expect(files()).toEqual(['fact-consolidate.lock']);
    releaseConsolidateLock(lock);
    expect(files()).toEqual([]);
  });

  it('a lock held by a live process is left alone', () => {
    const other = livePid();
    fs.writeFileSync(lock, String(other));
    expect(acquireConsolidateLock(lock)).toEqual({ acquired: false });
    expect(content()).toBe(String(other));
    releaseConsolidateLock(lock); // not ours: stays
    expect(files()).toEqual(['fact-consolidate.lock']);
  });

  it('a lock left by a dead process is taken over: the file holds this pid, no claim or temp file stays', () => {
    fs.writeFileSync(lock, String(deadPid()));
    expect(acquireConsolidateLock(lock)).toEqual({ acquired: true });
    expect(content()).toBe(String(process.pid));
    expect(files()).toEqual(['fact-consolidate.lock']);
  });

  it('another worker took the stale lock over between this worker\'s look at it and its own takeover: this one steps aside', () => {
    const dead = deadPid();
    const other = livePid();
    fs.writeFileSync(lock, String(dead));
    // The moment after this worker read the dead pid: the other worker finishes its takeover.
    const realRead = fs.readFileSync;
    let staged = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const value = (realRead as (...a: unknown[]) => unknown)(file, ...rest);
      if (!staged && file === lock) {
        staged = true;
        fs.writeFileSync(lock, String(other));
      }
      return value;
    }) as typeof fs.readFileSync);

    expect(acquireConsolidateLock(lock)).toEqual({ acquired: false });
    expect(staged).toBe(true);
    expect(content(), 'the other worker\'s lock is still there').toBe(String(other));
    expect(files()).toEqual(['fact-consolidate.lock']);
  });

  it('another worker is in the middle of taking the stale lock over (its claim is there): this one steps aside and touches nothing', () => {
    const dead = deadPid();
    const other = livePid();
    fs.writeFileSync(lock, String(dead));
    const claim = `${lock}.takeover-${dead}`;
    fs.writeFileSync(claim, String(other));

    expect(acquireConsolidateLock(lock)).toEqual({ acquired: false });
    expect(content()).toBe(String(dead));
    expect(content(claim)).toBe(String(other));
    expect(files()).toEqual(['fact-consolidate.lock', `fact-consolidate.lock.takeover-${dead}`]);
  });

  it('a takeover a dead process left unfinished is taken over in turn, once', () => {
    const dead = deadPid();
    const deadTaker = deadPid();
    fs.writeFileSync(lock, String(dead));
    fs.writeFileSync(`${lock}.takeover-${dead}`, String(deadTaker));

    expect(acquireConsolidateLock(lock)).toEqual({ acquired: true });
    expect(content()).toBe(String(process.pid));
    expect(files()).toEqual(['fact-consolidate.lock']);
  });

  it('two unfinished takeovers on top of each other: not started, the reason is given, nothing is changed', () => {
    const dead = deadPid();
    const taker1 = deadPid();
    const taker2 = deadPid();
    fs.writeFileSync(lock, String(dead));
    const claim1 = `${lock}.takeover-${dead}`;
    const claim2 = `${claim1}.takeover-${taker1}`;
    fs.writeFileSync(claim1, String(taker1));
    fs.writeFileSync(claim2, String(taker2));
    const before = files();

    const result = acquireConsolidateLock(lock);
    expect(result.acquired).toBe(false);
    expect(result.problem).toContain(claim2);
    expect(content()).toBe(String(dead));
    expect(files()).toEqual(before);
  });

  it('a lock file with no pid in it: held while it is fresh (an older build writes the pid after creating the file), stale later', () => {
    fs.writeFileSync(lock, '');
    expect(acquireConsolidateLock(lock)).toEqual({ acquired: false });
    expect(content()).toBe('');

    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(acquireConsolidateLock(lock)).toEqual({ acquired: true });
    expect(content()).toBe(String(process.pid));
    expect(files()).toEqual(['fact-consolidate.lock']);
  });

  it('a directory that is not there: not started, with the reason (exclusion that cannot be set up is not assumed)', () => {
    const result = acquireConsolidateLock(path.join(dir, 'missing', 'fact-consolidate.lock'));
    expect(result.acquired).toBe(false);
    expect(result.problem).toMatch(/ENOENT/);
  });

  // The built module, in separate processes: every starter finds the same dead lock at the same moment.
  it('eight processes starting on one dead lock never hold it at the same time', async () => {
    const mod = path.resolve(__dirname, '..', 'dist', 'consolidate-health.js');
    const HOLD_MS = 400;
    const script = `
      import { acquireConsolidateLock, releaseConsolidateLock } from ${JSON.stringify(mod)};
      const lock = process.argv[1];
      // start together: wait for the shared start time
      while (Date.now() < Number(process.argv[2])) {}
      const r = acquireConsolidateLock(lock);
      const from = Date.now();
      if (r.acquired) {
        await new Promise((res) => setTimeout(res, ${HOLD_MS}));
        const until = Date.now();
        releaseConsolidateLock(lock);
        process.stdout.write(JSON.stringify({ acquired: true, from, until }));
      } else {
        process.stdout.write(JSON.stringify({ acquired: false, problem: r.problem ?? null }));
      }
    `;
    for (let trial = 0; trial < 5; trial++) {
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
      fs.writeFileSync(lock, String(deadPid()));
      const startAt = Date.now() + 1500;
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => new Promise<{ acquired: boolean; from?: number; until?: number; problem?: string | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
      })));
      const held = outcomes.filter((o) => o.acquired).sort((a, b) => a.from! - b.from!);
      expect(held.length, `trial ${trial}: someone takes it`).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < held.length; i++) {
        // a later holder may only start after the earlier one released
        expect(held[i].from!, `trial ${trial}: two processes held the lock at once`).toBeGreaterThanOrEqual(held[i - 1].until!);
      }
      expect(outcomes.filter((o) => !o.acquired).map((o) => o.problem), `trial ${trial}`).toEqual(outcomes.filter((o) => !o.acquired).map(() => null));
      expect(fs.readdirSync(dir), `trial ${trial}: nothing left behind`).toEqual([]);
    }
  }, 120_000);
});
