#!/usr/bin/env node
/**
 * Batch translate facts to Korean and store in fact_kr column.
 * Uses Agent SDK (no API key needed inside Claude Code).
 * Run: node scripts/translate-facts.mjs
 */
import Database from 'better-sqlite3';
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import os from 'os';

const DB_PATH = process.env.MEMORY_BANK_DB_PATH || process.env.TEST_DB_PATH ||
  path.join(os.homedir(), '.config/superpowers/conversation-index/db.sqlite');

const db = new Database(DB_PATH);

// Ensure fact_kr column exists
try {
  const cols = db.prepare("SELECT name FROM pragma_table_info('facts')").all();
  if (!cols.some(c => c.name === 'fact_kr')) {
    db.prepare('ALTER TABLE facts ADD COLUMN fact_kr TEXT').run();
  }
} catch {}

// Get untranslated facts
const untranslated = db.prepare(
  "SELECT id, fact FROM facts WHERE is_active = 1 AND (fact_kr IS NULL OR fact_kr = '') ORDER BY consolidated_count DESC"
).all();

console.log(`Found ${untranslated.length} untranslated facts`);

if (untranslated.length === 0) {
  console.log('All facts already translated');
  db.close();
  process.exit(0);
}

// Batch translate (chunks of 20)
const BATCH = 20;
const updateStmt = db.prepare('UPDATE facts SET fact_kr = ? WHERE id = ?');

for (let i = 0; i < untranslated.length; i += BATCH) {
  const batch = untranslated.slice(i, i + BATCH);
  const texts = batch.map(f => f.fact);

  const prompt = `Translate the following English texts to natural Korean. Keep technical terms (API names, tool names, framework names, file paths, CLI commands, variable names) in English. Return ONLY a JSON array of translated strings, same order, same count. No markdown wrapper.

Texts:
${JSON.stringify(texts)}`;

  try {
    let result = '';
    for await (const message of query({
      prompt,
      options: { model: 'haiku', max_tokens: 4096 }
    })) {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'result') {
        result = message.result || '';
      }
    }

    const match = result.match(/\[[\s\S]*\]/);
    if (match) {
      const translated = JSON.parse(match[0]);
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          if (translated[j]) {
            updateStmt.run(translated[j], batch[j].id);
          }
        }
      });
      tx();
      console.log(`Translated batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(untranslated.length / BATCH)} (${batch.length} facts)`);
    }
  } catch (e) {
    console.error(`Batch ${Math.floor(i / BATCH) + 1} failed:`, e.message);
  }
}

const remaining = db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE is_active = 1 AND (fact_kr IS NULL OR fact_kr = '')").get();
console.log(`Done. Remaining untranslated: ${remaining.cnt}`);
db.close();
