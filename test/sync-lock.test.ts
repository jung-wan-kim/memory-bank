import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * The sync command's singleton lock lives in `~/.claude/run-locks/`. Nothing in
 * the plugin created that folder: on a machine where no other tool had made
 * it, taking the lock failed with ENOENT, the command read that as "another
 * sync holds the lock", printed "already running" and exited 0 — on every
 * session start, with no line in the sync log (review UPG-3).
 *
 * The real command (dist/sync-cli.js) under a HOME of its own.
 */

const REPO = path.resolve(__dirname, '..');

describe('sync singleton lock', () => {
  let cfg: string;
  let home: string;
  const outerConfigDir = process.env.MEMORY_BANK_CONFIG_DIR;

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-synclock-'));
    home = path.join(cfg, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    process.env.MEMORY_BANK_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (outerConfigDir === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
    else process.env.MEMORY_BANK_CONFIG_DIR = outerConfigDir;
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  const runLocks = () => path.join(home, '.claude', 'run-locks');
  const lockDir = () => path.join(runLocks(), 'memory-bank-sync.lock');
  const logLines = (): Array<Record<string, unknown>> => {
    const file = path.join(cfg, 'conversation-index', 'logs', 'sync.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  };
  function sync(): { status: number | null; out: string; err: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: path.join(cfg, 'db.sqlite') };
    delete env.TEST_ARCHIVE_DIR;
    delete env.TEST_DB_PATH;
    const r = spawnSync(process.execPath, ['dist/sync-cli.js'], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it('runs on a machine that has no ~/.claude/run-locks yet: the folder is made, the run is logged', () => {
    expect(fs.existsSync(runLocks())).toBe(false);

    const r = sync();

    expect(r.status, r.err + r.out).toBe(0);
    expect(r.out).not.toMatch(/already running/);
    expect(r.out).toContain('Sync complete');
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatchObject({ action: 'ran', copied: 0 });
    expect(fs.statSync(runLocks()).isDirectory()).toBe(true);
    expect(fs.existsSync(lockDir())).toBe(false); // released on exit
    // the completion stamp the background cooldown reads is written next to the lock
    expect(Number(fs.readFileSync(path.join(runLocks(), 'memory-bank-sync.last'), 'utf8'))).toBeGreaterThan(0);
  });

  it('a lock that cannot be taken for another reason is an error — not "already running" — and leaves a log line', () => {
    fs.writeFileSync(runLocks(), 'not a folder'); // the lock folder cannot be created under a file

    const r = sync();

    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/already running/);
    expect(r.out).not.toContain('Syncing conversations');
    expect(r.err).toMatch(/cannot take the sync lock/);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatchObject({ action: 'failed' });
    expect(String(logLines()[0].error)).toMatch(/cannot take the sync lock/);
  });

  it('a lock held by a live sync of the same or a newer version is still "already running" (exit 0, nothing synced)', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    // This test process is alive; a far-future version is never preempted as older code.
    fs.writeFileSync(path.join(lockDir(), 'pid'), JSON.stringify({ pid: process.pid, version: '999.0.0', startedAt: Date.now() }));

    const r = sync();

    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Sync already running - skip/);
    expect(r.out).not.toContain('Syncing conversations');
    expect(fs.existsSync(lockDir())).toBe(true); // the holder's lock is left alone
    expect(logLines()).toEqual([]);
  });

  it('a lock left by a process that is gone is taken over', () => {
    fs.mkdirSync(lockDir(), { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(lockDir(), 'pid'), JSON.stringify({ pid: Number(gone), version: '999.0.0', startedAt: Date.now() }));

    const r = sync();

    expect(r.status, r.err + r.out).toBe(0);
    expect(r.out).toContain('Sync complete');
    expect(logLines()[0]).toMatchObject({ action: 'ran' });
  });
});
