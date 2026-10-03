import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readHookInput } from '../src/hook-stdin.js';

/**
 * 훅 입력 읽기 (2026-10-03, v1.7.4 독립 검토 지적).
 * 프로세스로 띄워 파이프에 나눠 쓰는 시험은 자식이 언제 읽느냐에 따라 두 조각이 한 번에
 * 읽힐 수 있어, 수정을 되돌려도 통과할 수 있었다. 여기서는 스트림에 조각을 직접 넣는다.
 */

describe('readHookInput', () => {
  it('조각 경계에 걸린 다바이트 문자를 깨지 않는다', async () => {
    const text = JSON.stringify({ prompt: '배포 파이프라인 \u{1F600}\u{1F680} 프리뷰 확인' });
    const buf = Buffer.from(text);
    const k = buf.indexOf(Buffer.from('\u{1F600}')) + 2; // 4바이트 이모지의 가운데
    const input = new PassThrough();
    const t0 = Date.now();
    const reading = readHookInput(input, 2000);
    let chunks = 0;
    input.on('data', () => { chunks++; });
    input.write(buf.subarray(0, k));
    await new Promise((r) => setImmediate(r));
    input.end(buf.subarray(k));
    expect(await reading).toBe(text);
    expect(chunks, '두 조각으로 나뉘어 읽혔다(양성 대조)').toBeGreaterThanOrEqual(2);
    expect(Date.now() - t0, '입력이 끝나면(end) 한도를 기다리지 않는다').toBeLessThan(1000);
  });

  it('끝나지 않는 입력은 한도에서 읽은 만큼 돌려준다', async () => {
    const input = new PassThrough();
    const reading = readHookInput(input, 50);
    input.write('{"prompt":"half');
    expect(await reading).toBe('{"prompt":"half');
  });

  it('터미널이면 기다리지 않고 빈 문자열', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const t0 = Date.now();
    expect(await readHookInput(tty, 5000)).toBe('');
    expect(Date.now() - t0, '한도(5초)까지 멈추지 않는다').toBeLessThan(500);
  });
});
