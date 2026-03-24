import { initDatabase } from './db.js';

export interface LastSessionContext {
  sessionId: string;
  project: string;
  timestamp: string;
  exchangeCount: number;
  lastUserMessage: string;
  lastAssistantSummary: string;
  toolsUsed: string[];
  gitBranch: string | null;
}

/**
 * Get the last session's context for a project.
 * This enables "continuing where you left off" — the most direct
 * way to reduce repeated context setting at session start.
 */
export function getLastSessionContext(project: string): LastSessionContext | null {
  const db = initDatabase();

  try {
    // Find the most recent session for this project (excluding current)
    const session = db.prepare(`
      SELECT session_id, COUNT(*) as exchange_count,
             MAX(timestamp) as last_ts, MIN(timestamp) as first_ts
      FROM exchanges
      WHERE project = ? AND session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY last_ts DESC
      LIMIT 1
    `).get(project) as { session_id: string; exchange_count: number; last_ts: string; first_ts: string } | undefined;

    if (!session) return null;

    // Get the last exchange in that session
    const lastExchange = db.prepare(`
      SELECT user_message, assistant_message, git_branch
      FROM exchanges
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(session.session_id) as { user_message: string; assistant_message: string; git_branch: string | null } | undefined;

    if (!lastExchange) return null;

    // Get tools used in the session
    const tools = db.prepare(`
      SELECT DISTINCT tc.tool_name
      FROM tool_calls tc
      JOIN exchanges e ON tc.exchange_id = e.id
      WHERE e.session_id = ?
      AND tc.tool_name NOT IN ('Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob')
    `).all(session.session_id) as Array<{ tool_name: string }>;

    // Truncate for context window efficiency
    const assistantMsg = lastExchange.assistant_message;
    const assistantSummary = assistantMsg
      .split('\n')
      .filter(l => l.trim().length > 5)
      .slice(0, 5)
      .join('\n')
      .substring(0, 400);

    return {
      sessionId: session.session_id,
      project,
      timestamp: session.last_ts,
      exchangeCount: session.exchange_count,
      lastUserMessage: lastExchange.user_message.substring(0, 300),
      lastAssistantSummary: assistantSummary,
      toolsUsed: tools.map(t => t.tool_name),
      gitBranch: lastExchange.git_branch,
    };
  } finally {
    db.close();
  }
}

/**
 * Format last session context for injection at session start.
 */
export function formatSessionContinuity(ctx: LastSessionContext): string {
  const date = ctx.timestamp.slice(0, 10);
  const time = ctx.timestamp.slice(11, 16);
  const lines = [
    `📋 이전 세션 (${date} ${time}, ${ctx.exchangeCount} exchanges):`,
    `  마지막 요청: "${ctx.lastUserMessage.trim()}..."`,
  ];

  if (ctx.lastAssistantSummary) {
    lines.push(`  마지막 응답: ${ctx.lastAssistantSummary.split('\n')[0].trim()}`);
  }

  if (ctx.gitBranch) {
    lines.push(`  브랜치: ${ctx.gitBranch}`);
  }

  if (ctx.toolsUsed.length > 0) {
    lines.push(`  사용 도구: ${ctx.toolsUsed.slice(0, 5).join(', ')}`);
  }

  return lines.join('\n');
}
