#!/usr/bin/env node
/**
 * Translation worker - reads texts from stdin, translates via Agent SDK, writes to stdout.
 * Used by server.cjs to translate content without needing API key.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const input = [];
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', async () => {
  try {
    const texts = JSON.parse(input.join(''));
    if (!texts.length) { console.log(JSON.stringify([])); process.exit(0); }

    const prompt = `Translate the following English texts to natural Korean. Keep technical terms (API names, tool names, framework names, file paths, CLI commands, variable names) in English. Return ONLY a JSON array of translated strings, same order, same count. No markdown wrapper.

Texts:
${JSON.stringify(texts)}`;

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
      console.log(match[0]);
    } else {
      console.log(JSON.stringify(texts));
    }
  } catch (e) {
    console.error('translate-worker error:', e.message);
    try {
      console.log(JSON.stringify(JSON.parse(input.join(''))));
    } catch { console.log('[]'); }
  }
});
