import { describe, it, expect } from 'vitest';
import { truncateFact, FACT_CHAR_CAP } from '../src/fact-text.js';

describe('truncateFact never splits an astral character', () => {
  it('drops a trailing high surrogate instead of sending a lone one to the hook client', () => {
    const head = 'a'.repeat(FACT_CHAR_CAP - 2); // length 158 → index 158/159 is where the cut lands
    const t = truncateFact(head + '😀 tail that makes it longer than the cap'); // 😀 = 2 UTF-16 units at 158..159
    expect(t.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(t)).toBe(false);
    expect(JSON.parse(JSON.stringify({ t })).t).toBe(t);
    expect([...t].every((ch) => { const c = ch.codePointAt(0)!; return c < 0xd800 || c > 0xdfff; })).toBe(true);
  });
  it('keeps a complete astral character when the cut falls after it', () => {
    const t = truncateFact('a'.repeat(FACT_CHAR_CAP - 3) + '😀' + 'b'.repeat(40));
    expect(t.includes('😀')).toBe(true);
    expect(t.length).toBe(FACT_CHAR_CAP);
  });
  it('short facts are untouched', () => {
    expect(truncateFact('  짧은   사실 ')).toBe('짧은 사실');
  });
});
