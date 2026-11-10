import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readConversationRange,
  formatConversationAsMarkdown,
  READ_MAX_OUTPUT_CHARS,
  READ_MAX_BLOCK_CHARS,
} from '../src/show.js';

// F5 — `read` capped one answer at 40,000 characters and each tool input/result at 2,000, but offered no way
// past either: a message longer than the cap was cut and the continuation hint pointed at the NEXT line, and
// a clipped tool block had no argument that showed the rest. On the live index 690 turns hold a message over
// 40,000 characters and 9.4% of recent tool calls have an input over 2,000.

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const userLine = (i: number, text: string): string =>
  JSON.stringify({ uuid: `u${i}`, parentUuid: null, timestamp: ts(i), type: 'user', isSidechain: false, sessionId: 's1', message: { role: 'user', content: text } });
const assistantLine = (i: number, text: string): string =>
  JSON.stringify({ uuid: `a${i}`, parentUuid: `u${i}`, timestamp: ts(i), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUseLine = (i: number, id: string, input: Record<string, unknown>): string =>
  JSON.stringify({ uuid: `a${i}`, timestamp: ts(i), type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
const toolResultLine = (i: number, id: string, content: string): string =>
  JSON.stringify({ uuid: `u${i}`, timestamp: ts(i), type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/** Text that never repeats: position p reads as a 6-digit counter, so a gap or an overlap cannot go unnoticed. */
const counted = (chars: number): string => {
  let out = '';
  for (let i = 0; out.length < chars; i++) out += `${String(i).padStart(6, '0')} `;
  return out.slice(0, chars);
};

const HEADER_END = '## Messages\n\n';
const CONTINUES = /^…\[message at line (\d+) continues from character (\d+) of (\d+)\]\n\n/;
const CLIPPED = /\n\n…\[message clipped: characters (\d+)-(\d+) of (\d+) shown\]\n\n$/;
const FOOTER = /\n---\n_Output truncated at the \d+-char limit: [^\n]*\. Continue with ([^\n]*)\._\n$/;

interface Page { text: string; args: Record<string, string> | null }

/** Follows the "Continue with …" line of each answer until an answer has none. */
async function readAll(file: string, first: { startLine?: number; endLine?: number; full?: boolean } = {}, maxPages = 200): Promise<Page[]> {
  const pages: Page[] = [];
  let opts: { startLine?: number; endLine?: number; startChar?: number; full?: boolean } = { ...first };
  for (let n = 0; n < maxPages; n++) {
    const text = await readConversationRange(file, opts);
    const footer = text.match(FOOTER);
    const args = footer ? Object.fromEntries(footer[1].split(', ').map((pair) => pair.split('=') as [string, string])) : null;
    pages.push({ text, args });
    if (!args) return pages;
    opts = {
      startLine: Number(args.startLine),
      startChar: args.startChar === undefined ? undefined : Number(args.startChar),
      endLine: args.endLine === undefined ? undefined : Number(args.endLine),
      full: args.full === 'true' ? true : undefined,
    };
  }
  throw new Error(`read did not finish in ${maxPages} answers`);
}

/** The message text of the pages, with what `read` adds around it (header, notes, footer) taken out. */
function stitched(pages: Page[]): string {
  return pages.map(({ text }) => {
    let body = text.replace(FOOTER, '');
    body = body.slice(body.indexOf(HEADER_END) + HEADER_END.length);
    return body.replace(CONTINUES, '').replace(CLIPPED, '');
  }).join('');
}

const lone = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('read: past the output ceiling inside one message', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-continue-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a message longer than one answer is read to its end by following the hints, with no gap and no overlap', async () => {
    const file = join(dir, 'huge.jsonl');
    const jsonl = [userLine(1, counted(200_000)), assistantLine(1, 'after-the-huge-one')].join('\n') + '\n';
    writeFileSync(file, jsonl);
    const whole = formatConversationAsMarkdown(jsonl);

    const first = await readConversationRange(file);
    expect(first.length).toBeLessThanOrEqual(READ_MAX_OUTPUT_CHARS + 500);
    // the hint stays ON the long message (line 1) and names where in it to go on
    expect(first).toMatch(/Continue with startLine=1, startChar=\d+\._\n$/);
    expect(first).toMatch(/message clipped: characters 0-\d+ of \d+ shown/);

    const pages = await readAll(file);
    expect(pages.length).toBeGreaterThanOrEqual(5);
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(READ_MAX_OUTPUT_CHARS + 500);
    expect(stitched(pages)).toBe(whole.slice(whole.indexOf(HEADER_END) + HEADER_END.length));
    expect(pages[pages.length - 1].text).toContain('after-the-huge-one');
  });

  it('keeps the requested endLine, and goes on to the following messages once the long one is done', async () => {
    const file = join(dir, 'mixed.jsonl');
    const lines = [userLine(1, 'small-first'), assistantLine(1, counted(90_000)), userLine(2, 'small-after'), assistantLine(2, 'answer-after'), userLine(3, 'beyond-the-range')];
    writeFileSync(file, lines.join('\n') + '\n');

    const pages = await readAll(file, { startLine: 1, endLine: 4 });
    // page 1 stops before the long message (it does not fit behind 'small-first'); the long message then takes its own pages
    expect(pages[0].args).toEqual({ startLine: '2', endLine: '4' });
    expect(pages[1].args).toMatchObject({ startLine: '2', endLine: '4' });
    expect(Number(pages[1].args!.startChar)).toBeGreaterThan(30_000);
    const text = stitched(pages);
    expect(text).toBe((() => {
      const whole = formatConversationAsMarkdown(lines.slice(0, 4).join('\n') + '\n');
      return whole.slice(whole.indexOf(HEADER_END) + HEADER_END.length);
    })());
    expect(text).toContain('small-after');
    expect(text).not.toContain('beyond-the-range');
  });

  it('never cuts between the two halves of a surrogate pair, whatever the offset', async () => {
    const file = join(dir, 'emoji.jsonl');
    for (const pad of [0, 1, 2, 3]) {
      const body = 'x'.repeat(pad) + '🚨'.repeat(45_000); // 90,000 UTF-16 units, every other boundary is inside a pair
      const jsonl = userLine(1, body) + '\n';
      writeFileSync(file, jsonl);
      const pages = await readAll(file);
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages) expect(lone(page.text)).toBe(false);
      const whole = formatConversationAsMarkdown(jsonl);
      expect(stitched(pages)).toBe(whole.slice(whole.indexOf(HEADER_END) + HEADER_END.length));
    }
    // a startChar that points at the second half of a pair starts at the pair
    writeFileSync(file, userLine(1, '🚨'.repeat(30_000)) + '\n');
    const first = await readConversationRange(file);
    const next = Number(first.match(/startChar=(\d+)/)![1]);
    expect(lone(await readConversationRange(file, { startLine: 1, startChar: next + 1 }))).toBe(false);
  });

  it('startChar past the end of the message is an error that names its length', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, [userLine(1, 'hello there'), assistantLine(1, 'hi')].join('\n') + '\n');
    await expect(readConversationRange(file, { startLine: 1, startChar: 5_000 })).rejects.toThrow(/startChar 5000 is past the end of the message at line 1: it has \d+ characters/);
  });

  it('startChar inside a short message shows the rest of it and what follows', async () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(file, [userLine(1, `head-part ${'h'.repeat(300)} tail-part`), assistantLine(1, 'the-answer')].join('\n') + '\n');
    const text = await readConversationRange(file, { startLine: 1, startChar: 200 });
    expect(text).toMatch(/…\[message at line 1 continues from character 200 of \d+\]/);
    expect(text).not.toContain('head-part');
    expect(text).toContain('tail-part');
    expect(text).toContain('the-answer');
    expect(text).not.toMatch(/Output truncated/);
  });
});

describe('read: tool inputs and results longer than the block limit', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-full-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const resultText = `RESULT-START ${counted(45_000)} RESULT-END`;
  const inputText = `INPUT-START\n${counted(9_000)}\nINPUT-END`;
  function write(file: string): string {
    const jsonl = [
      userLine(1, 'run it'),
      toolUseLine(2, 'toolu_1', { command: inputText }),
      toolResultLine(3, 'toolu_1', resultText),
      assistantLine(4, 'done-marker'),
    ].join('\n') + '\n';
    writeFileSync(file, jsonl);
    return jsonl;
  }

  it('the clip marker says how to read the rest', async () => {
    const file = join(dir, 'tool.jsonl');
    write(file);
    const text = await readConversationRange(file);
    expect(text).toContain('RESULT-START');
    expect(text).not.toContain('RESULT-END');
    expect(text).not.toContain('INPUT-END');
    const markers = [...text.matchAll(/…\[\+(\d+) chars not shown — read again with full: true\]/g)];
    expect(markers.map((m) => Number(m[1]))).toEqual([inputText.length - READ_MAX_BLOCK_CHARS, resultText.length - READ_MAX_BLOCK_CHARS]);
    expect(text).toContain('done-marker');
  });

  it('full: true shows them whole — over several answers when they do not fit in one', async () => {
    const file = join(dir, 'tool.jsonl');
    const jsonl = write(file);
    const pages = await readAll(file, { full: true });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.text.length).toBeLessThanOrEqual(READ_MAX_OUTPUT_CHARS + 500);
      expect(page.text).not.toMatch(/chars not shown/);
      // every continuation keeps asking for whole blocks: the offsets count the unclipped text
      if (page.args) expect(page.args.full).toBe('true');
    }
    const text = stitched(pages);
    const whole = formatConversationAsMarkdown(jsonl);
    expect(text).toBe(whole.slice(whole.indexOf(HEADER_END) + HEADER_END.length));
    expect(text).toContain(inputText);
    expect(text).toContain(resultText);
    expect(text).toContain('done-marker');
  });

  it('one line read with full: true is that message with its whole tool result', async () => {
    const file = join(dir, 'tool.jsonl');
    write(file);
    const pages = await readAll(file, { startLine: 2, endLine: 2, full: true });
    const text = stitched(pages);
    expect(text).toContain(resultText);
    expect(text).not.toContain('done-marker');
    expect(pages[0].args).toMatchObject({ startLine: '2', endLine: '2', full: 'true' });
  });
});
