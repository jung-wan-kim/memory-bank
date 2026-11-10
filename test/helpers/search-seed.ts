/**
 * Deterministic seeding for search tests: unit vectors at a chosen angle from
 * the query axis, so "how near" a row is to the query is decided by the test
 * and not by an embedding model.
 */
import type Database from 'better-sqlite3';
import { insertExchange } from '../../src/db.js';
import type { ConversationExchange } from '../../src/types.js';

export const DIM = 384;

/** Unit vector `theta` radians away from axis 0 (the query axis), leaning toward `axis`. */
export function vecAt(theta: number, axis = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(theta);
  v[1 + ((axis - 1) % (DIM - 1))] = Math.sin(theta);
  return v;
}

/** The embedding the mocked model returns for every query. */
export const QUERY_VECTOR = vecAt(0);

export interface SeedRow {
  id: string;
  theta: number;
  axis?: number;
  timestamp?: string;
  userMessage?: string;
  assistantMessage?: string;
  archivePath?: string;
  lineStart?: number;
  lineEnd?: number;
  isSidechain?: boolean;
  codingAgent?: string;
  project?: string;
}

export function seedExchanges(db: Database.Database, rows: SeedRow[]): void {
  db.transaction(() => {
    rows.forEach((r, i) => {
      const exchange: ConversationExchange = {
        id: r.id,
        project: r.project ?? 'seed-project',
        timestamp: r.timestamp ?? '2025-01-01T00:00:00.000Z',
        userMessage: r.userMessage ?? `seed question ${r.id}`,
        assistantMessage: r.assistantMessage ?? `seed answer ${r.id}`,
        archivePath: r.archivePath ?? `/seed/archive/${r.id}.jsonl`,
        lineStart: r.lineStart ?? i * 10 + 1,
        lineEnd: r.lineEnd ?? i * 10 + 5,
        isSidechain: r.isSidechain,
        codingAgent: r.codingAgent,
      };
      insertExchange(db, exchange, vecAt(r.theta, r.axis ?? 1 + (i % 300)));
    });
  })();
}
