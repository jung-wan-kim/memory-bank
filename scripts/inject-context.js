#!/usr/bin/env node
/**
 * UserPromptSubmit context injection script.
 *
 * Reads USER_PROMPT from env, searches memory-bank for relevant facts
 * (vector similarity), expands with 1-hop ontology relations,
 * then prints a context block to stdout.
 *
 * Environment:
 *   CWD         - current working directory
 *   USER_PROMPT - the user's message text
 */

import { initDatabase } from '../dist/db.js';
import { searchSimilarFacts } from '../dist/fact-db.js';
import { generateEmbedding, initEmbeddings } from '../dist/embeddings.js';
import { getRelatedFacts } from '../dist/ontology-db.js';
import { detectRepeat, formatRepeatContext } from '../dist/repeat-detector.js';

const TOP_K = 5;
const SIMILARITY_THRESHOLD = 0.75;
const MAX_CONTEXT_FACTS = 8;

async function main() {
  const project = process.env.CWD || process.cwd();
  const userPrompt = process.env.USER_PROMPT || '';

  if (!userPrompt || userPrompt.length < 20) {
    process.exit(0);
  }

  try {
    await initEmbeddings();
    const embedding = await generateEmbedding(userPrompt);

    const db = initDatabase();
    const results = searchSimilarFacts(db, embedding, project, TOP_K, SIMILARITY_THRESHOLD);

    if (results.length === 0) {
      db.close();
      process.exit(0);
    }

    // Expand with 1-hop relations
    const seenIds = new Set(results.map(r => r.fact.id));
    const expandedFacts = [...results.map(r => ({ fact: r.fact, note: '' }))];

    for (const { fact } of results.slice(0, 3)) {
      const related = getRelatedFacts(db, fact.id, 1);
      for (const { fact: relFact, relation } of related) {
        if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
          seenIds.add(relFact.id);
          expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
        }
      }
    }

    db.close();

    if (expandedFacts.length === 0) {
      process.exit(0);
    }

    // Format context block
    const lines = ['📌 관련 과거 결정:'];
    for (const { fact, note } of expandedFacts) {
      const dateStr = fact.created_at.slice(0, 10);
      lines.push(`- ${note ? note + ' ' : ''}[${fact.category}] ${fact.fact} (${dateStr})`);
    }

    // Detect repeated prompts
    try {
      const repeats = await detectRepeat(userPrompt, project, 2, 0.85);
      const repeatCtx = formatRepeatContext(repeats);
      if (repeatCtx) {
        lines.push('');
        lines.push(repeatCtx);
      }
    } catch {
      // Repeat detection is best-effort
    }

    process.stdout.write(lines.join('\n') + '\n');
  } catch (error) {
    // Non-fatal: don't disrupt user workflow
    process.stderr.write(`inject-context: error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(0);
  }
}

main();
