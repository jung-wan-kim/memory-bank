import { describe, it, expect } from 'vitest';
import {
  LineSplitter,
  SupervisorState,
  isInitializeResponse,
  decideSwap,
} from '../src/wrapper-core.js';

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const INIT_RES = JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } });

describe('LineSplitter', () => {
  it('reassembles lines across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.push(':3}\n')).toEqual(['{"c":3}']);
  });
});

describe('SupervisorState', () => {
  it('records the handshake and tracks outstanding requests', () => {
    const st = new SupervisorState();
    expect(st.canReplay()).toBe(false);
    st.onClientLine(INIT);
    st.onClientLine(INITIALIZED);
    expect(st.canReplay()).toBe(true);
    expect(st.initializeLine).toBe(INIT);
    expect(st.initializedLine).toBe(INITIALIZED);
    expect(st.idle()).toBe(false); // initialize itself outstanding
    st.onServerLine(INIT_RES);
    expect(st.idle()).toBe(true);
  });

  it('initializeAnswered distinguishes startup crash from mid-session crash', () => {
    const st = new SupervisorState();
    st.onClientLine(INIT);
    expect(st.initializeAnswered()).toBe(false); // client still waiting
    st.onServerLine(INIT_RES);
    expect(st.initializeAnswered()).toBe(true);
  });

  it('ignores server-initiated requests and client responses to them', () => {
    const st = new SupervisorState();
    st.onClientLine(INIT);
    st.onServerLine(INIT_RES);
    // server request (id + method) must not settle anything
    st.onServerLine(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'roots/list' }));
    expect(st.idle()).toBe(true);
    // client response to it (id, no method) must not be tracked as a request
    st.onClientLine(JSON.stringify({ jsonrpc: '2.0', id: 99, result: [] }));
    expect(st.idle()).toBe(true);
  });

  it('resetOutstanding clears in-flight after a crash respawn', () => {
    const st = new SupervisorState();
    st.onClientLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call' }));
    expect(st.idle()).toBe(false);
    st.resetOutstanding();
    expect(st.idle()).toBe(true);
  });
});

describe('isInitializeResponse', () => {
  it('matches only the response with the initialize id', () => {
    expect(isInitializeResponse(INIT_RES, INIT)).toBe(true);
    expect(isInitializeResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), INIT)).toBe(false);
    expect(isInitializeResponse(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'x' }), INIT)).toBe(false);
    expect(isInitializeResponse('garbage', INIT)).toBe(false);
  });
});

describe('decideSwap', () => {
  const ready = { idle: () => true, canReplay: () => true };
  it('swaps only on version change + handshake + idle', () => {
    expect(decideSwap('1.4.5', '1.4.6', ready)).toBe('swap');
    expect(decideSwap('1.4.5', '1.4.5', ready)).toBe('same-version');
    expect(decideSwap('1.4.5', null, ready)).toBe('same-version');
    expect(decideSwap('1.4.5', '1.4.6', { idle: () => false, canReplay: () => true })).toBe('wait-busy');
    expect(decideSwap('1.4.5', '1.4.6', { idle: () => true, canReplay: () => false })).toBe('no-handshake');
  });
});
