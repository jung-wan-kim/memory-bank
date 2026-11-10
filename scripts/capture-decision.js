#!/usr/bin/env node
/**
 * PostToolUse decision capture script.
 *
 * Called asynchronously by capture-decision.sh after detecting decision keywords.
 * Extracts a concise fact from the decision text and saves it to memory-bank
 * with ontology classification.
 *
 * NOT WIRED (checked 2026-11-10): the only caller is hooks/capture-decision.sh,
 * and hooks/hooks.json registers no PostToolUse hook (SessionStart, SessionEnd
 * and UserPromptSubmit only; neither file was ever listed there or in
 * .claude-plugin/plugin.json). Nothing runs this script.
 * Known defect to fix BEFORE wiring it: the classification below is started
 * and the database is closed in the same tick, so every write the classifier
 * makes after the LLM answers fails on a closed connection, and `.catch(() =>
 * {})` hides it — one LLM call per fact for nothing (the backfill classifies
 * the fact later). Await classifyAndLinkFact() and close in `finally`.
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
