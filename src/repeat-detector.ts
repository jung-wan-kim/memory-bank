import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { initDatabase } from './db.js';

export interface RepeatMatch {
  exchangeId: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantSummary: string;
  similarity: number;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Detect if the current prompt is similar to a past exchange.
 * Returns matches above the threshold, sorted by similarity.
 *
 * This enables "You asked something similar before — here's what happened"
 * context injection, reducing repeated prompts.
 */
export async function detectRepeat(
  prompt: string,
  project: string | null,
  limit: number = 3,
  threshold: number = 0.82,
): Promise<RepeatMatch[]> {
  await initEmbeddings();
  const embedding = await generateEmbedding(prompt);
  const db = initDatabase();

  try {
    // Vector search against past user messages
    const vecResults = db.prepare(`
      SELECT id, distance
      FROM vec_exchanges
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(
      Buffer.from(new Float32Array(embedding).buffer),
      limit * 3,
    ) as Array<{ id: string; distance: number }>;

    const matches: RepeatMatch[] = [];

    for (const vr of vecResults) {
      const similarity = 1 - (vr.distance * vr.distance) / 2;
      if (similarity < threshold) continue;

      const row = db.prepare(`
        SELECT id, project, timestamp, user_message, assistant_message,
               archive_path, line_start, line_end
        FROM exchanges WHERE id = ?
      `).get(vr.id) as Record<string, unknown> | undefined;

      if (!row) continue;

      // Skip if different project (unless no project filter)
      if (project && row['project'] as string !== project) continue;

      const assistantMsg = row['assistant_message'] as string;
      // Truncate assistant message to first meaningful paragraph
      const assistantSummary = assistantMsg
        .split('\n')
        .filter(line => line.trim().length > 10)
        .slice(0, 3)
        .join('\n')
        .substring(0, 300);

      matches.push({
        exchangeId: row['id'] as string,
        project: row['project'] as string,
        timestamp: row['timestamp'] as string,
        userMessage: (row['user_message'] as string).substring(0, 200),
        assistantSummary,
        similarity,
        archivePath: row['archive_path'] as string,
        lineStart: row['line_start'] as number,
        lineEnd: row['line_end'] as number,
      });

      if (matches.length >= limit) break;
    }

    return matches;
  } finally {
    db.close();
  }
}

/**
 * Format repeat detection results for context injection.
 */
export function formatRepeatContext(matches: RepeatMatch[]): string {
  if (matches.length === 0) return '';

  const lines = ['🔄 비슷한 질문을 이전에 하신 적이 있습니다:'];

  for (const m of matches) {
    const date = m.timestamp.slice(0, 10);
    const sim = Math.round(m.similarity * 100);
    lines.push(`\n[${date}, ${sim}% 유사] "${m.userMessage.trim()}..."`);
    lines.push(`→ ${m.assistantSummary.trim()}`);
    lines.push(`  (Lines ${m.lineStart}-${m.lineEnd} in ${m.archivePath})`);
  }

  return lines.join('\n');
}
