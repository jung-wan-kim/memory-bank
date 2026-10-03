import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION } from './embeddings.js';
import { initDatabase, getVecDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity } from './db.js';
import { exchangeProjectKeys } from './project-canon.js';

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
  // Warm-path options: the inject daemon already has the prompt's query
  // embedding and a cached DB handle — re-embedding the SAME prompt and
  // re-running initDatabase()'s migration pass per request is pure overhead.
  // A caller-provided db is NOT closed here (the caller owns its lifecycle).
  opts: { embedding?: number[]; db?: ReturnType<typeof initDatabase> } = {},
): Promise<RepeatMatch[]> {
  let embedding = opts.embedding;
  if (!embedding) {
    await initEmbeddings();
    embedding = await generateEmbedding(prompt, 'query');
  }
  const ownDb = !opts.db;
  const db = opts.db ?? initDatabase();
  // Callers pass the absolute cwd; exchanges store the archive slug.
  const projectKeys = project ? exchangeProjectKeys(project) : null;

  try {
    // Vector search against past user messages (dtype-aware: int8 tables need
    // quantized query blobs and return ×127-scaled distances)
    const vecDtype = getVecDtype(db);
    const vecResults = db.prepare(`
      SELECT id, distance
      FROM vec_exchanges
      WHERE embedding MATCH ${vecParamSql(vecDtype)}
      ORDER BY distance
      LIMIT ?
    `).all(
      embeddingToVecBlob(embedding, vecDtype),
      // The KNN is global (vec0 has no project column) and the project filter
      // runs afterwards, so a project-scoped call needs a wider pool or the
      // nearest rows from other projects crowd out every in-project match.
      projectKeys ? limit * 20 : limit * 3,
    ) as Array<{ id: string; distance: number }>;

    const matches: RepeatMatch[] = [];

    for (const vr of vecResults) {
      const d = normalizeVecDistance(vr.distance, vecDtype);
      const similarity = l2DistanceToSimilarity(d);
      if (similarity < threshold) continue;

      // embedding_version filter: skip rows the re-embed worker has not
      // upgraded yet — old-model vectors are incomparable with this query.
      const row = db.prepare(`
        SELECT id, project, timestamp, user_message, assistant_message,
               archive_path, line_start, line_end
        FROM exchanges WHERE id = ? AND embedding_version = ?
      `).get(vr.id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;

      if (!row) continue;

      // Skip if different project (unless no project filter)
      if (projectKeys && !projectKeys.includes(row['project'] as string)) continue;

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
    if (ownDb) db.close();
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
