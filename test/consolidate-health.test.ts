import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import {
  CONSOLIDATE_BACKOFF_AFTER,
  consolidateBackoffMs,
  consolidateBackoffUntil,
  consolidateCursorPath,
  consolidateHealthPath,
  consolidateStartCursor,
  consolidateWorkerGate,
  hasPendingConsolidation,
  loadConsolidateHealth,
  nextConsolidateHealth,
  saveConsolidateHealth,
  type ConsolidateHealth,
} from '../src/consolidate-health.js';

/**
 * The consolidate worker's memory of runs that ended stuck, and the gate the
 * SessionStart hook asks before starting it. Without them one failing fact was
 * retried on every session start for 25 days (up to 839 runs a day).
 */

const MIN = 60_000;
const NOW = new Date('2026-11-10T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const INTERNAL = { factId: 'fact-1', kind: 'internal' as const, message: 'k value in knn query too large' };

describe('consolidate health', () => {
  let dir: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-health-'));
    prevConfig = process.env.MEMORY_BANK_CONFIG_DIR;
    process.env.MEMORY_BANK_CONFIG_DIR = dir;
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
  });

  afterEach(() => {
    if (prevConfig === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR; else process.env.MEMORY_BANK_CONFIG_DIR = prevConfig;
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** n runs in a row that end held on the same fact, each `stepMs` after the previous one. */
  function streak(n: number, stepMs = MIN): ConsolidateHealth {
    let h: ConsolidateHealth | null = null;
    for (let i = 0; i < n; i++) h = nextConsolidateHealth(h, { progressed: false, failure: INTERNAL }, later(i * stepMs), '1.8.0');
    return h!;
  }

  describe('the record after a run', () => {
    it('a first held failure starts a streak of 1 with no backoff', () => {
      expect(nextConsolidateHealth(null, { progressed: false, failure: INTERNAL }, NOW, '1.8.0')).toEqual({
        firstFailureAt: NOW.toISOString(), lastFailureAt: NOW.toISOString(), consecutiveFailures: 1,
        factId: 'fact-1', kind: 'internal', message: 'k value in knn query too large',
        nextAttemptAt: null, pluginVersion: '1.8.0',
      });
    });

    it('the same stuck run again counts up and keeps the first failure time', () => {
      const h = streak(3);
      expect(h.consecutiveFailures).toBe(3);
      expect(h.firstFailureAt).toBe(NOW.toISOString());
      expect(h.lastFailureAt).toBe(later(2 * MIN).toISOString());
      expect(h.nextAttemptAt).toBeNull();
    });

    it(`runs 1..${CONSOLIDATE_BACKOFF_AFTER} are retried at once; from the next on attempts are spaced 5 min doubling, at most 6 h`, () => {
      expect([1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 40].map((n) => consolidateBackoffMs(n) / MIN))
        .toEqual([0, 0, 5, 10, 20, 40, 80, 160, 320, 360, 360]);
      expect(streak(5).nextAttemptAt).toBeNull();
      const sixth = streak(6);
      expect(sixth.nextAttemptAt).toBe(new Date(Date.parse(sixth.lastFailureAt) + 5 * MIN).toISOString());
    });

    it('a held failure after the cursor moved is a new streak (another fact is stuck)', () => {
      const h = nextConsolidateHealth(streak(4), { progressed: true, failure: { ...INTERNAL, factId: 'fact-2' } }, later(60 * MIN), '1.8.0')!;
      expect(h.consecutiveFailures).toBe(1);
      expect(h.firstFailureAt).toBe(later(60 * MIN).toISOString());
      expect(h.factId).toBe('fact-2');
    });

    it('a run that does not end held clears the record', () => {
      expect(nextConsolidateHealth(streak(9), { progressed: true, failure: null }, later(60 * MIN), '1.8.0')).toBeNull();
      expect(nextConsolidateHealth(streak(9), { progressed: false, failure: null }, later(60 * MIN), '1.8.0')).toBeNull();
    });

    it('a very long message is cut, not written whole', () => {
      const h = nextConsolidateHealth(null, { progressed: false, failure: { ...INTERNAL, message: 'x'.repeat(5000) } }, NOW, '1.8.0')!;
      expect(h.message).toHaveLength(500);
    });
  });

  describe('the file', () => {
    it('lives in state/ under the index directory, round-trips, and null removes it', () => {
      expect(consolidateHealthPath()).toBe(path.join(dir, 'conversation-index', 'state', 'fact-consolidate-health.json'));
      expect(loadConsolidateHealth()).toEqual({ health: null, problem: null });

      const h = streak(6);
      saveConsolidateHealth(h);
      expect(JSON.parse(fs.readFileSync(consolidateHealthPath(), 'utf8'))).toEqual(h);
      expect(loadConsolidateHealth()).toEqual({ health: h, problem: null });

      saveConsolidateHealth(null);
      expect(fs.existsSync(consolidateHealthPath())).toBe(false);
      saveConsolidateHealth(null); // already absent — still fine
    });

    it('a file that is not a usable record is reported, not read as "no failures"', () => {
      fs.mkdirSync(path.dirname(consolidateHealthPath()), { recursive: true });
      fs.writeFileSync(consolidateHealthPath(), '{"consecutiveFailures": 7');
      expect(loadConsolidateHealth()).toEqual({ health: null, problem: 'not JSON' });

      for (const broken of [
        { ...streak(2), consecutiveFailures: '2' },
        { ...streak(2), nextAttemptAt: 'soon' },
        { ...streak(2), firstFailureAt: undefined },
        { ...streak(2), kind: 'mystery' },
        null,
        [],
      ]) {
        fs.writeFileSync(consolidateHealthPath(), JSON.stringify(broken));
        expect(loadConsolidateHealth(), JSON.stringify(broken)).toEqual({ health: null, problem: 'unexpected shape' });
      }
    });
  });

  describe('backoff', () => {
    it('holds a run back until nextAttemptAt, for the version that recorded it only', () => {
      const h = streak(6, 0); // nextAttemptAt = NOW + 5 min
      expect(consolidateBackoffUntil(h, later(4 * MIN), '1.8.0')).toBe(later(5 * MIN).toISOString());
      expect(consolidateBackoffUntil(h, later(5 * MIN), '1.8.0'), 'the wait is over').toBeNull();
      expect(consolidateBackoffUntil(h, later(4 * MIN), '1.8.1'), 'new code may carry the fix').toBeNull();
      expect(consolidateBackoffUntil(streak(5, 0), later(MIN), '1.8.0'), 'short streak').toBeNull();
      expect(consolidateBackoffUntil(null, NOW, '1.8.0')).toBeNull();
    });
  });

  describe('the hook\'s gate (read-only handle)', () => {
    function seedFacts(): string[] {
      const db = initDatabase();
      try {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const id = insertFact(db, { fact: `Gate fixture fact number ${i}`, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: null });
          const at = new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1000).toISOString();
          db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(at, id);
          ids.push(id);
        }
        return ids;
      } finally {
        db.close();
      }
    }
    const readOnly = () => new Database(process.env.TEST_DB_PATH!, { readonly: true, fileMustExist: true });
    const writeCursor = (createdAt: string, id: string) => fs.writeFileSync(consolidateCursorPath(), JSON.stringify({ createdAt, id }));
    const at = (i: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1000).toISOString();

    it('no cursor: any active fact is pending', () => {
      seedFacts();
      const db = readOnly();
      try {
        expect(consolidateStartCursor({})).toBeNull();
        expect(consolidateWorkerGate(db, NOW, '1.8.0', {})).toEqual({ start: true, reason: 'pending facts' });
      } finally { db.close(); }
    });

    it('cursor before the last fact: pending; cursor on the last fact: nothing to do', () => {
      const ids = seedFacts();
      const db = readOnly();
      try {
        writeCursor(at(1), ids[1]);
        expect(consolidateWorkerGate(db, NOW, '1.8.0', {})).toEqual({ start: true, reason: 'pending facts' });
        writeCursor(at(2), ids[2]);
        expect(consolidateWorkerGate(db, NOW, '1.8.0', {})).toEqual({ start: false, reason: 'no pending facts' });
      } finally { db.close(); }
    });

    it('same creation time: the id decides, as in the drain itself', () => {
      const ids = seedFacts();
      const setup = initDatabase();
      setup.prepare('UPDATE facts SET created_at = ?').run(at(0));
      setup.close();
      const sorted = [...ids].sort();
      const db = readOnly();
      try {
        expect(hasPendingConsolidation(db, { createdAt: at(0), id: sorted[1] })).toBe(true);
        expect(hasPendingConsolidation(db, { createdAt: at(0), id: sorted[2] })).toBe(false);
      } finally { db.close(); }
    });

    it('a deactivated fact after the cursor is not pending', () => {
      const ids = seedFacts();
      const setup = initDatabase();
      setup.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(ids[2]);
      setup.close();
      writeCursor(at(1), ids[1]);
      const db = readOnly();
      try {
        expect(consolidateWorkerGate(db, NOW, '1.8.0', {})).toEqual({ start: false, reason: 'no pending facts' });
      } finally { db.close(); }
    });

    it('a running backoff keeps the worker from starting even with pending facts; another version starts it', () => {
      seedFacts();
      const h = streak(6, 0);
      saveConsolidateHealth(h);
      const db = readOnly();
      try {
        expect(consolidateWorkerGate(db, later(MIN), '1.8.0', {})).toEqual({ start: false, reason: `backoff until ${h.nextAttemptAt}` });
        expect(consolidateWorkerGate(db, later(6 * MIN), '1.8.0', {})).toEqual({ start: true, reason: 'pending facts' });
        expect(consolidateWorkerGate(db, later(MIN), '1.8.1', {})).toEqual({ start: true, reason: 'pending facts' });
      } finally { db.close(); }
    });

    it('LAST_CONSOLIDATED_AT seeds the start only when there is no cursor file', () => {
      const ids = seedFacts();
      expect(consolidateStartCursor({ LAST_CONSOLIDATED_AT: at(5) })).toEqual({ createdAt: at(5), id: '' });
      const db = readOnly();
      try {
        expect(consolidateWorkerGate(db, NOW, '1.8.0', { LAST_CONSOLIDATED_AT: at(5) })).toEqual({ start: false, reason: 'no pending facts' });
        writeCursor(at(0), ids[0]);
        expect(consolidateStartCursor({ LAST_CONSOLIDATED_AT: at(5) })).toEqual({ createdAt: at(0), id: ids[0] });
        expect(consolidateWorkerGate(db, NOW, '1.8.0', { LAST_CONSOLIDATED_AT: at(5) })).toEqual({ start: true, reason: 'pending facts' });
      } finally { db.close(); }
    });

    it('a corrupt cursor file reads as "from the beginning"', () => {
      seedFacts();
      fs.writeFileSync(consolidateCursorPath(), 'not a cursor');
      expect(consolidateStartCursor({})).toBeNull();
    });
  });
});
