import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { appendSyncLog, syncLogPath, SYNC_LOG_ERROR_SAMPLES } from '../src/sync-log.js';

// The hook starts the sync detached with stdio ignored: whatever it printed —
// counts, per-file errors — went nowhere, so a file that could not be indexed
// left no trace. Every run now appends one line to logs/sync.jsonl.

const REPO = path.resolve(__dirname, '..');

describe('sync log', () => {
  let cfg: string;
  // The runner's own MEMORY_BANK_CONFIG_DIR (it keeps tests off the real config dir) is put back, not deleted.
  const outerConfigDir = process.env.MEMORY_BANK_CONFIG_DIR;

  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-synclog-'));
    process.env.MEMORY_BANK_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (outerConfigDir === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
    else process.env.MEMORY_BANK_CONFIG_DIR = outerConfigDir;
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  const lines = () => fs.readFileSync(path.join(cfg, 'conversation-index', 'logs', 'sync.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('appends one JSON line per run with the counts', () => {
    expect(syncLogPath()).toBe(path.join(cfg, 'conversation-index', 'logs', 'sync.jsonl'));
    appendSyncLog({ action: 'ran', version: '9.9.9', duration_ms: 1234, copied: 3, skipped: 10, indexed: 2, summarized: 1, errors: [] });
    appendSyncLog({ action: 'failed', version: '9.9.9', duration_ms: 5, error: 'boom' });
    const [a, b] = lines();
    expect(a).toMatchObject({ action: 'ran', version: '9.9.9', duration_ms: 1234, copied: 3, skipped: 10, indexed: 2, summarized: 1, errors: 0, pid: process.pid });
    expect(a.error_samples).toBeUndefined();
    expect(Number.isNaN(Date.parse(a.ts))).toBe(false);
    expect(b).toMatchObject({ action: 'failed', error: 'boom' });
  });

  it('keeps the error COUNT and the first errors only (a broken archive must not flood the log)', () => {
    const errors = Array.from({ length: SYNC_LOG_ERROR_SAMPLES + 15 }, (_, i) => ({ file: `/arch/p/f${i}.jsonl`, error: `cannot read ${i}` }));
    appendSyncLog({ action: 'ran', version: '9.9.9', duration_ms: 1, copied: 0, skipped: 0, indexed: 0, summarized: 0, errors });
    const [l] = lines();
    expect(l.errors).toBe(SYNC_LOG_ERROR_SAMPLES + 15);
    expect(l.error_samples).toHaveLength(SYNC_LOG_ERROR_SAMPLES);
    expect(l.error_samples[0]).toEqual({ file: '/arch/p/f0.jsonl', error: 'cannot read 0' });
  });

  it('rotates the file to .1 once it is over 1MB', () => {
    const file = path.join(cfg, 'conversation-index', 'logs', 'sync.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1) + '\n');
    appendSyncLog({ action: 'ran', version: '9.9.9', duration_ms: 1, copied: 0, skipped: 0, indexed: 0, summarized: 0, errors: [] });
    expect(fs.statSync(`${file}.1`).size).toBe(1024 * 1024 + 2);
    expect(lines()).toHaveLength(1);
  });

  // The real command, under a HOME of its own (it reads ~/.claude/projects and locks under ~/.claude/run-locks —
  // a folder the command makes itself, so this HOME starts without one: test/sync-lock.test.ts).
  it('the sync command logs its run — including a conversation it could not read and therefore did not index', () => {
    const home = path.join(cfg, 'home');
    const project = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(project, { recursive: true });
    const src = path.join(project, 'unreadable.jsonl');
    fs.writeFileSync(src, JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }) + '\n');
    // A newer compressed copy in the archive wins over the plain copy the sync writes — and it is not zstd.
    const dest = path.join(cfg, 'conversation-archive', 'proj', 'unreadable.jsonl');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.zst`, 'this is not zstd data');
    const soon = new Date(Date.now() + 3_600_000);
    fs.utimesSync(`${dest}.zst`, soon, soon);
    const later = new Date(Date.now() + 7_200_000);
    fs.utimesSync(src, later, later);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: path.join(cfg, 'db.sqlite') };
    delete env.TEST_ARCHIVE_DIR;
    delete env.TEST_DB_PATH;
    const r = spawnSync(process.execPath, ['dist/sync-cli.js'], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // it ran against the HOME given to it, not this machine's
    expect(r.stdout).toContain(`Source: ${path.join(home, '.claude', 'projects')}`);
    expect(r.stdout).toContain(`Destination: ${path.join(cfg, 'conversation-archive')}`);

    const [l] = lines();
    expect(l).toMatchObject({ action: 'ran', copied: 1, indexed: 0, errors: 1 });
    expect(l.error_samples).toHaveLength(1);
    expect(l.error_samples[0].file).toBe(dest);
    expect(l.error_samples[0].error).not.toBe('');
    expect(typeof l.duration_ms).toBe('number');
  });
});
