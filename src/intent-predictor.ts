import { initDatabase } from './db.js';

export interface IntentPrediction {
  likelyTools: Array<{ tool: string; frequency: number }>;
  commonPatterns: string[];
  projectProfile: string;
}

/**
 * Predict user intent based on historical tool usage patterns for a project.
 *
 * Analyzes: "In this project, the user usually does X, Y, Z"
 * This helps Claude proactively prepare relevant context.
 */
export function predictIntent(project: string): IntentPrediction {
  const db = initDatabase();

  try {
    // Top tools for this project (excluding generic ones)
    const tools = db.prepare(`
      SELECT tc.tool_name, COUNT(*) as cnt
      FROM tool_calls tc
      JOIN exchanges e ON tc.exchange_id = e.id
      WHERE e.project = ?
        AND tc.tool_name NOT IN ('Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
          'TaskUpdate', 'TaskCreate', 'ToolSearch', 'TaskOutput', 'TaskList', 'AskUserQuestion')
      GROUP BY tc.tool_name
      ORDER BY cnt DESC
      LIMIT 8
    `).all(project) as Array<{ tool_name: string; cnt: number }>;

    // Common 2-tool sequences (what tool follows what)
    const sequences = db.prepare(`
      SELECT
        tc1.tool_name as tool_a,
        tc2.tool_name as tool_b,
        COUNT(*) as cnt
      FROM tool_calls tc1
      JOIN tool_calls tc2 ON tc1.exchange_id = tc2.exchange_id
        AND tc1.timestamp < tc2.timestamp
        AND tc1.id != tc2.id
      JOIN exchanges e ON tc1.exchange_id = e.id
      WHERE e.project = ?
        AND tc1.tool_name NOT IN ('Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob')
        AND tc2.tool_name NOT IN ('Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob')
      GROUP BY tc1.tool_name, tc2.tool_name
      HAVING cnt >= 3
      ORDER BY cnt DESC
      LIMIT 5
    `).all(project) as Array<{ tool_a: string; tool_b: string; cnt: number }>;

    // Project activity profile
    const profile = db.prepare(`
      SELECT
        COUNT(*) as total_exchanges,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT git_branch) as branches,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM exchanges
      WHERE project = ?
    `).get(project) as { total_exchanges: number; sessions: number; branches: number; first_seen: string; last_seen: string } | undefined;

    // Build patterns description
    const patterns: string[] = [];
    for (const seq of sequences) {
      patterns.push(`${seq.tool_a.replace(/mcp__[^_]+_[^_]+__/, '')} → ${seq.tool_b.replace(/mcp__[^_]+_[^_]+__/, '')} (${seq.cnt}x)`);
    }

    // Generate profile description
    let profileDesc = '';
    if (profile) {
      const daysSinceFirst = Math.floor((Date.now() - new Date(profile.first_seen).getTime()) / 86400000);
      profileDesc = `${profile.total_exchanges} exchanges over ${daysSinceFirst} days, ${profile.sessions || '?'} sessions, ${profile.branches || '?'} branches`;
    }

    return {
      likelyTools: tools.map(t => ({
        tool: t.tool_name.replace(/mcp__[^_]+_[^_]+__/, ''),
        frequency: t.cnt,
      })),
      commonPatterns: patterns,
      projectProfile: profileDesc,
    };
  } finally {
    db.close();
  }
}

/**
 * Format intent prediction for context injection.
 */
export function formatIntentContext(prediction: IntentPrediction): string {
  if (prediction.likelyTools.length === 0) return '';

  const lines: string[] = [];

  if (prediction.projectProfile) {
    lines.push(`🎯 프로젝트: ${prediction.projectProfile}`);
  }

  if (prediction.likelyTools.length > 0) {
    const toolList = prediction.likelyTools
      .slice(0, 5)
      .map(t => `${t.tool}(${t.frequency})`)
      .join(', ');
    lines.push(`  주요 도구: ${toolList}`);
  }

  if (prediction.commonPatterns.length > 0) {
    lines.push(`  작업 패턴: ${prediction.commonPatterns.slice(0, 3).join(', ')}`);
  }

  return lines.join('\n');
}
