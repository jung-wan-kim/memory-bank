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

// R2-SEARCH-1 — a stop inside a message names the line the call started on, with a startChar. A caller that
// carries only startLine over (what the plugin's own agent notes described until this release) is given the
// message from its start again, on every call: the same 40,000 characters, with nothing in them that says
// why. The line now says it, and names the line that skips the rest of the message.
describe('read: a stop inside a message says what startLine alone does', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-escape-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const lastLine = (text: string): string => text.trimEnd().split('\n').pop()!;

  it('names startChar as what moves on, and the line to start at to skip the rest of the message', async () => {
    const file = join(dir, 'mixed.jsonl');
    writeFileSync(file, [userLine(1, 'small-first'), assistantLine(1, counted(90_000)), userLine(2, 'small-after')].join('\n') + '\n');

    const first = await readConversationRange(file, { startLine: 2 });
    expect(lastLine(first)).toMatch(/the message at line 2 up to character \d+\. Without startChar the message starts over from its first character — to skip the rest of it instead, start at line 3\. Continue with startLine=2, startChar=\d+\._$/);

    // startLine alone: the same page, word for word — and that page carries the way out
    const again = await readConversationRange(file, { startLine: 2 });
    expect(again).toBe(first);
    // a later page of the same message says the same (startLine alone would go back to the message's start)
    const second = await readConversationRange(file, { startLine: 2, startChar: Number(first.match(/startChar=(\d+)/)![1]) });
    expect(lastLine(second)).toMatch(/Without startChar the message starts over from its first character — to skip the rest of it instead, start at line 3\. Continue with startLine=2, startChar=\d+\._$/);

    // the line it names is the way out
    const skipped = await readConversationRange(file, { startLine: 3 });
    expect(skipped).toContain('small-after');
    expect(skipped).not.toMatch(/Output truncated/);
  });

  it('keeps the requested endLine and full in the values to continue with; the skip hint stays inside the range', async () => {
    const file = join(dir, 'mixed.jsonl');
    writeFileSync(file, [userLine(1, 'small-first'), assistantLine(1, counted(90_000)), userLine(2, 'small-after'), assistantLine(2, 'beyond')].join('\n') + '\n');

    const inRange = await readConversationRange(file, { startLine: 2, endLine: 3, full: true });
    expect(lastLine(inRange)).toMatch(/to skip the rest of it instead, start at line 3\. Continue with startLine=2, startChar=\d+, endLine=3, full=true\._$/);

    // the long message is the last line of the requested range: there is no line to skip to
    const atRangeEnd = await readConversationRange(file, { startLine: 2, endLine: 2 });
    expect(lastLine(atRangeEnd)).toMatch(/Without startChar the message starts over from its first character \(nothing follows it in the requested range\)\. Continue with startLine=2, startChar=\d+, endLine=2\._$/);
    expect(atRangeEnd).not.toMatch(/start at line/);
  });

  it('says nothing follows when the long message is the last line of the file', async () => {
    const file = join(dir, 'tail.jsonl');
    writeFileSync(file, [userLine(1, 'small-first'), assistantLine(1, counted(90_000))].join('\n') + '\n');
    const text = await readConversationRange(file, { startLine: 2 });
    expect(lastLine(text)).toMatch(/\(nothing follows it in the requested range\)\. Continue with startLine=2, startChar=\d+\._$/);
    expect(text).not.toMatch(/start at line/);
  });

  it('a stop between two messages is worded as before: startLine alone is all it takes there', async () => {
    const file = join(dir, 'pairs.jsonl');
    const lines: string[] = [];
    for (let k = 1; k <= 30; k++) lines.push(userLine(k, `q-${k} ${'q'.repeat(1500)}`), assistantLine(k, `a-${k} ${'a'.repeat(1500)}`));
    writeFileSync(file, lines.join('\n') + '\n');
    const text = await readConversationRange(file, { startLine: 1, endLine: 60 });
    expect(lastLine(text)).toMatch(/^_Output truncated at the 40000-char limit: lines 1-\d+ of 60 shown\. Continue with startLine=\d+, endLine=60\._$/);
    expect(text).not.toMatch(/Without startChar/);
  });

  it('the line still ends with the values to continue with, the first startLine= in it being the one to pass', async () => {
    const file = join(dir, 'mixed.jsonl');
    writeFileSync(file, [userLine(1, 'small-first'), assistantLine(1, counted(90_000)), userLine(2, 'small-after')].join('\n') + '\n');
    const text = await readConversationRange(file, { startLine: 2 });
    // one "name=value" list, at the very end; the skip hint is prose so that a pattern looking for
    // startLine=<n> finds only the value to continue with
    expect([...lastLine(text).matchAll(/startLine=(\d+)/g)].map((m) => m[1])).toEqual(['2']);
    expect(text.match(FOOTER)![1]).toMatch(/^startLine=2, startChar=\d+$/);
  });

  // The stream is closed at the last line a call needs, so the file's length is usually not known. One line
  // can be larger than everything one call reads (8,000,000 characters): the stream then ends on that very
  // line, and whether a line follows takes a second look at the file.
  it('a message on a line larger than one call reads still knows whether a line follows it', async () => {
    const big = userLine(1, counted(8_100_000));
    const alone = join(dir, 'one-line.jsonl');
    writeFileSync(alone, big + '\n');
    expect(await readConversationRange(alone)).toMatch(/\(nothing follows it in the requested range\)\. Continue with startLine=1, startChar=\d+\._\n$/);

    const followed = join(dir, 'two-lines.jsonl');
    writeFileSync(followed, [big, assistantLine(1, 'after-it')].join('\n') + '\n');
    expect(await readConversationRange(followed)).toMatch(/to skip the rest of it instead, start at line 2\. Continue with startLine=1, startChar=\d+\._\n$/);
  });
});

// R2-SEARCH-3 — one call reads at most 8,000,000 characters of the file. When that ceiling stopped a call it
// named "the last line read + 1" without knowing whether the file went on, and called it the 40000-char output
// limit: on the file's last line the named line did not exist and the call the footer asked for was an error.
describe('read: the ceiling on the file text one call reads', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mb-read-rawcap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // 2 × (a tool call + its 4,100,000-character result): the second result is where the 8,000,000 are passed
  const heavy = (): string[] => [
    userLine(1, 'run both'),
    toolUseLine(2, 'toolu_1', { command: 'cat one.log' }),
    toolResultLine(3, 'toolu_1', `ONE ${'r'.repeat(4_100_000)}`),
    toolUseLine(4, 'toolu_2', { command: 'cat two.log' }),
    toolResultLine(5, 'toolu_2', `TWO ${'r'.repeat(4_100_000)}`),
  ];

  it('on the last line of the file the answer just ends — no line outside the file is named', async () => {
    const file = join(dir, 'raw-tail.jsonl');
    writeFileSync(file, heavy().join('\n') + '\n');
    const text = await readConversationRange(file);
    expect(text).toContain('cat two.log');
    expect(text.length).toBeLessThan(READ_MAX_OUTPUT_CHARS);
    expect(text).not.toMatch(/Output truncated|Continue with/);
    // (what the old footer asked for)
    await expect(readConversationRange(file, { startLine: 6 })).rejects.toThrow(/outside the file: it has 5 lines/);
  });

  it('before the last line it names the next line, which exists, and says which limit stopped it', async () => {
    const file = join(dir, 'raw-more.jsonl');
    writeFileSync(file, [...heavy(), assistantLine(6, 'tail-marker')].join('\n') + '\n');
    const first = await readConversationRange(file);
    expect(first).not.toContain('tail-marker');
    expect(first).toMatch(/\n---\n_Output truncated at the 8000000-char limit: lines 1-5 shown \(the limit is on the file text one call reads, not on this output\)\. Continue with startLine=6\._\n$/);

    const pages = await readAll(file);
    expect(pages.length).toBe(2);
    expect(pages[1].text).toContain('tail-marker');
    expect(pages[1].args).toBeNull();
  });

  it('with an endLine: nothing is named past it, and the endLine is carried when the range goes on', async () => {
    const file = join(dir, 'raw-range.jsonl');
    writeFileSync(file, [...heavy(), assistantLine(6, 'tail-marker'), userLine(7, 'beyond')].join('\n') + '\n');
    expect(await readConversationRange(file, { startLine: 1, endLine: 5 })).not.toMatch(/Output truncated/);
    expect(await readConversationRange(file, { startLine: 1, endLine: 6 })).toMatch(/Continue with startLine=6, endLine=6\._\n$/);
  });
});
