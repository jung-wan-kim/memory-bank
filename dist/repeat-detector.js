import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { initDatabase } from './db.js';
/**
 * Detect if the current prompt is similar to a past exchange.
 * Returns matches above the threshold, sorted by similarity.
 *
 * This enables "You asked something similar before — here's what happened"
 * context injection, reducing repeated prompts.
 */
export async function detectRepeat(prompt, project, limit = 3, threshold = 0.82) {
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
    `).all(Buffer.from(new Float32Array(embedding).buffer), limit * 3);
        const matches = [];
        for (const vr of vecResults) {
            const similarity = 1 - (vr.distance * vr.distance) / 2;
            if (similarity < threshold)
                continue;
            const row = db.prepare(`
        SELECT id, project, timestamp, user_message, assistant_message,
               archive_path, line_start, line_end
        FROM exchanges WHERE id = ?
      `).get(vr.id);
            if (!row)
                continue;
            // Skip if different project (unless no project filter)
            if (project && row['project'] !== project)
                continue;
            const assistantMsg = row['assistant_message'];
            // Truncate assistant message to first meaningful paragraph
            const assistantSummary = assistantMsg
                .split('\n')
                .filter(line => line.trim().length > 10)
                .slice(0, 3)
                .join('\n')
                .substring(0, 300);
            matches.push({
                exchangeId: row['id'],
                project: row['project'],
                timestamp: row['timestamp'],
                userMessage: row['user_message'].substring(0, 200),
                assistantSummary,
                similarity,
                archivePath: row['archive_path'],
                lineStart: row['line_start'],
                lineEnd: row['line_end'],
            });
            if (matches.length >= limit)
                break;
        }
        return matches;
    }
    finally {
        db.close();
    }
}
/**
 * Format repeat detection results for context injection.
 */
export function formatRepeatContext(matches) {
    if (matches.length === 0)
        return '';
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
