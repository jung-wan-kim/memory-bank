#!/usr/bin/env node
/**
 * PostToolUse decision capture script.
 *
 * Called asynchronously by capture-decision.sh after detecting decision keywords.
 * Extracts a concise fact from the decision text and saves it to memory-bank
 * with ontology classification.
 *
 * Environment:
 *   SESSION_ID    - current session ID
 *   CWD           - current working directory
 *   TOOL_NAME     - tool that triggered this (Edit / Write)
 *   DECISION_TEXT - the tool input/result text containing the decision
 */

import { initDatabase } from '../dist/db.js';
import { insertFact } from '../dist/fact-db.js';
import { generateEmbedding, initEmbeddings } from '../dist/embeddings.js';
import { classifyAndLinkFact } from '../dist/ontology-classifier.js';
import { callHaiku, parseJsonResponse } from '../dist/llm.js';

const EXTRACT_DECISION_SYSTEM_PROMPT = `Extract a single concise technical decision fact from the provided tool call context.

## Rules
- 1 fact = 1 sentence (max 150 chars)
- Focus on WHY a decision was made, not just what changed
- Only extract if a clear decision/rationale is present
- If no clear decision, return null

## Output format (JSON only)
{
  "fact": "Decision statement",
  "category": "decision|preference|pattern|knowledge|constraint",
  "scope_type": "project|global",
  "confidence": 0.0-1.0
}
or null if no decision detected`;

async function main() {
  const sessionId = process.env.SESSION_ID;
  const project = process.env.CWD || process.cwd();
  const toolName = process.env.TOOL_NAME || 'Edit';
  const decisionText = process.env.DECISION_TEXT || '';

  if (!decisionText || decisionText.length < 30) {
    process.exit(0);
  }

  try {
    const response = await callHaiku(
      EXTRACT_DECISION_SYSTEM_PROMPT,
      `Tool: ${toolName}\nContext:\n${decisionText.slice(0, 3000)}`,
      512,
    );

    const parsed = parseJsonResponse(response);
    if (!parsed || !parsed.fact || parsed.confidence < 0.7) {
      process.exit(0);
    }

    await initEmbeddings();
    const embedding = await generateEmbedding(parsed.fact);

    const db = initDatabase();
    const factId = insertFact(db, {
      fact: parsed.fact,
      category: parsed.category || 'decision',
      scope_type: parsed.scope_type || 'project',
      scope_project: parsed.scope_type === 'project' ? project : null,
      source_exchange_ids: sessionId ? [sessionId] : [],
      embedding,
    });

    // Ontology classification (fire and forget)
    classifyAndLinkFact(db, factId, embedding).catch(() => {});

    db.close();
    console.log(`capture-decision: saved fact ${factId}`);
  } catch (error) {
    // Non-fatal: don't disrupt the user workflow
    console.error('capture-decision: error:', error instanceof Error ? error.message : error);
    process.exit(0);
  }
}

main();
