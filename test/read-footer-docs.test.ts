import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readConversationRange } from '../src/show.js';

// R2-SEARCH-1 — the notes the plugin ships for callers of `read` (the search agent's instructions, the tool
// reference, the READMEs) told them to carry only startLine over from a truncated answer, while `read` had
// started to stop inside long messages and name a startChar: followed as written, the notes returned the
// same page on every call. Nothing tied the two together. Here the closing lines the notes quote are
// compared with the ones `read` really writes (digits aside), so the next change to either shows up.

const REPO = path.resolve(__dirname, '..');
const doc = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const userLine = (i: number, text: string): string =>
  JSON.stringify({ uuid: `u${i}`, timestamp: ts(i), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: text } });
const assistantLine = (i: number, text: string): string =>
  JSON.stringify({ uuid: `a${i}`, timestamp: ts(i), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUseLine = (i: number, id: string, command: string): string =>
  JSON.stringify({ uuid: `a${i}`, timestamp: ts(i), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResultLine = (i: number, id: string, content: string): string =>
  JSON.stringify({ uuid: `u${i}`, timestamp: ts(i), type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/** A line with its numbers taken out: what the wording is, whatever the fixture's sizes are. */
const shape = (line: string): string => line.trim().replace(/\d+/g, 'N');
const closingLine = (answer: string): string => answer.trimEnd().split('\n').pop()!;

describe('the notes shipped with the plugin describe the closing line `read` really writes', () => {
  let dir: string;
  /** Closing lines of real answers, by what stopped the answer. */
  const real: Record<string, string> = {};
  let insideAnswer = '';
  let insideNextAnswer = '';
  let clippedToolAnswer = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-read-docs-'));
    const four = path.join(dir, 'four.jsonl');
    fs.writeFileSync(four, [
      userLine(1, 'q'.repeat(15_000)), assistantLine(1, 'a'.repeat(15_000)),
      userLine(2, 'L'.repeat(90_000)), assistantLine(2, 'short answer'),
    ].join('\n') + '\n');
    real.between = closingLine(await readConversationRange(four, { startLine: 1, endLine: 4 }));
    insideAnswer = await readConversationRange(four, { startLine: 3, endLine: 4 });
    real.inside = closingLine(insideAnswer);
    insideNextAnswer = await readConversationRange(four, {
      startLine: 3, endLine: 4, startChar: Number(real.inside.match(/startChar=(\d+)/)![1]),
    });
    real.insideLast = closingLine(await readConversationRange(four, { startLine: 3, endLine: 3 }));

    const tool = path.join(dir, 'tool.jsonl');
    fs.writeFileSync(tool, [
      userLine(1, 'run it'), toolUseLine(2, 'toolu_1', 'cat big.log'), toolResultLine(3, 'toolu_1', 'r'.repeat(6_000)),
    ].join('\n') + '\n');
    clippedToolAnswer = await readConversationRange(tool);
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('the fixtures produce a stop between two messages and a stop inside one', () => {
    expect(real.between).toMatch(/^_Output truncated at the 40000-char limit: lines 1-2 of 4 shown\. Continue with startLine=3, endLine=4\._$/);
    expect(real.inside).toMatch(/^_Output truncated at the 40000-char limit: lines 3-3 of 4 shown, the message at line 3 up to character \d+\. .*Continue with startLine=3, startChar=\d+, endLine=4\._$/);
    expect(real.insideLast).toMatch(/nothing follows it in the requested range/);
  });

  it('MCP-TOOLS.md quotes closing lines that `read` writes, and shows both a stop between messages and one inside a message', () => {
    const text = doc('skills/remembering-conversations/MCP-TOOLS.md');
    const quoted = text.split('\n').filter((line) => line.trim().startsWith('_Output truncated')).map(shape);
    const written = new Set(Object.values(real).map(shape));
    expect(quoted.length).toBeGreaterThanOrEqual(2);
    expect(quoted.filter((line) => !written.has(line))).toEqual([]);
    expect(quoted).toContain(shape(real.between));
    expect(quoted).toContain(shape(real.inside));

    // the markers it quotes around a message read in pieces, and for a clipped tool block
    // (the notes write the clipped-block count as the letter N already; the others carry example numbers)
    const markers = text.match(/`…\[[^`]+\]`/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(3);
    const answers = [insideAnswer, insideNextAnswer, clippedToolAnswer].map((a) => a.replace(/\d+/g, 'N'));
    for (const marker of markers) {
      const wanted = shape(marker.slice(1, -1));
      expect(answers.some((a) => a.includes(wanted)), marker).toBe(true);
    }

    // what to do with the line: every value, and what startLine alone does
    expect(text).toMatch(/pass \*\*all\*\* of them, not only `startLine`/);
    expect(text).toMatch(/only\s+`startLine=3` returns the same first piece/);
    const read = text.slice(text.indexOf('\n## read'), text.indexOf('\n## search_facts'));
    for (const arg of ['`path`', '`startLine`', '`endLine`', '`startChar`', '`full`']) expect(read, arg).toContain(`| ${arg} |`);
  });

  it.each(['agents/search-conversations.md', 'prompts/search-agent.md'])('%s tells the search agent to pass every value the closing line names', (file) => {
    const text = doc(file);
    // the example it gives is the values of a stop inside a message, as `read` lists them
    const example = text.match(/`Output truncated … Continue with ([^`]+)`/);
    expect(example, 'an example closing line').not.toBeNull();
    const listed = real.inside.match(/Continue with ([^.]+)\._$/)![1];
    expect(shape(example![1])).toBe(shape(listed));

    expect(text).toMatch(/\*\*every\*\* value that line names/);
    for (const arg of ['`startLine`', '`startChar`', '`endLine`', '`full`']) expect(text, arg).toContain(arg);
    expect(text).toMatch(/with `startLine` alone you get the same piece again/);
    // …and not the old instruction, which named startLine as the one value to carry over
    expect(text).not.toMatch(/call `read` again with that `startLine`/);
  });

  it('what the notes say startLine alone does is what it does: the same answer again, which names the way out', async () => {
    const four = path.join(dir, 'four.jsonl');
    expect(await readConversationRange(four, { startLine: 3, endLine: 4 })).toBe(insideAnswer);
    expect(real.inside).toMatch(/Without startChar the message starts over from its first character — to skip the rest of it instead, start at line 4\./);
    // the agent notes point at that sentence
    expect(doc('agents/search-conversations.md')).toMatch(/the same line says which line to start at to skip it/);
    expect(await readConversationRange(four, { startLine: 4, endLine: 4 })).toContain('short answer');
  });

  it('the READMEs name startChar and say to pass every value', () => {
    const row = (file: string): string => doc(file).split('\n').find((line) => line.startsWith('| `read` |')) ?? '';
    const en = row('README.md');
    expect(en).toContain('`startLine`');
    expect(en).toContain('`startChar`');
    expect(en).toMatch(/pass every value it names/);
    const kr = row('README-KR.md');
    expect(kr).toContain('`startLine`');
    expect(kr).toContain('`startChar`');
    expect(kr).toMatch(/알려 준 값을 전부 넘긴다/);
  });
});
