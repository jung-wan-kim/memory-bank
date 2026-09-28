import { initDatabase } from './db.js';
import { indexSession } from './indexer.js';
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export function readSessionIndexState(sessionId) {
    const db = initDatabase();
    try {
        const row = db.prepare(`
      SELECT
        COUNT(*) AS exchangeCount,
        MAX(line_end) AS frontier,
        MAX(last_indexed) AS lastIndexed
      FROM exchanges
      WHERE session_id = ?
    `).get(sessionId);
        return {
            exchangeCount: Number(row.exchangeCount),
            frontier: row.frontier === null ? null : Number(row.frontier),
            lastIndexed: row.lastIndexed === null ? null : Number(row.lastIndexed),
        };
    }
    finally {
        db.close();
    }
}
const DEFAULT_DEPENDENCIES = {
    indexCurrentSession: sessionId => indexSession(sessionId, 1, true),
    readSessionState: readSessionIndexState,
};
function emptyState() {
    return { exchangeCount: 0, frontier: null, lastIndexed: null };
}
function safeReadSessionState(sessionId, dependencies) {
    try {
        return dependencies.readSessionState(sessionId);
    }
    catch {
        return emptyState();
    }
}
export async function evaluateCompactFreshness(sessionId, dependencies = DEFAULT_DEPENDENCIES) {
    if (!sessionId) {
        return { status: 'stale', reason: 'missing_session_id', ...emptyState() };
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
        return { status: 'stale', reason: 'invalid_session_id', ...emptyState() };
    }
    let result;
    try {
        // Load-bearing await: compact freshness is foreground work. A detached or
        // singleton-skipped sync is not evidence that this session reached the DB.
        result = await dependencies.indexCurrentSession(sessionId);
    }
    catch {
        const observed = safeReadSessionState(sessionId, dependencies);
        return { status: 'stale', reason: 'index_error', ...observed };
    }
    const observed = safeReadSessionState(sessionId, dependencies);
    if (result.status !== 'indexed') {
        return { status: 'stale', reason: result.status, ...observed };
    }
    if (observed.exchangeCount < result.expectedExchangeCount) {
        return { status: 'stale', reason: 'exchange_count_mismatch', ...observed };
    }
    if (observed.frontier === null || observed.frontier < result.expectedFrontier) {
        return { status: 'stale', reason: 'frontier_mismatch', ...observed };
    }
    if (observed.lastIndexed === null || observed.lastIndexed < result.startedAt) {
        return { status: 'stale', reason: 'index_not_observed_after_attempt', ...observed };
    }
    return { status: 'fresh', reason: 'current_session_indexed', ...observed };
}
export function formatKstTimestamp(timestamp) {
    if (timestamp === null || !Number.isFinite(timestamp))
        return '없음';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const value = (type) => parts.find(part => part.type === type)?.value ?? '00';
    return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')} KST`;
}
export function formatCompactFreshnessReceipt(receipt) {
    const indexedAt = formatKstTimestamp(receipt.lastIndexed);
    const frontier = receipt.frontier === null ? '없음' : `L${receipt.frontier}`;
    if (receipt.status === 'fresh') {
        return `memory-bank: fresh, 현재 세션 색인 = ${indexedAt} (frontier=${frontier})`;
    }
    return `memory-bank: stale, 마지막 색인 = ${indexedAt} (reason=${receipt.reason}, frontier=${frontier})`;
}
