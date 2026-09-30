/**
 * The local hub's fan-out, now routed by the shared protocol core
 * (sodex/wsProtocol.ts pushFor). Subscriptions are placed directly on the
 * client, so no upstream socket is ever opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';

import { HubClient } from '../src/hub.js';
import { wantedSymbols, type SubParams } from '../src/sodex/wsProtocol.js';

function client() {
  const sent: any[] = [];
  const ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as WebSocket;
  const c = new HubClient(ws);
  const sub = (engine: 'spot' | 'perps', params: SubParams) =>
    (c as any).subs.set(`${engine}:${JSON.stringify(params)}`, { engine, up: null, params, key: 'k', wanted: wantedSymbols(params) });
  return { c, sent, sub };
}

test('hub: an account push reaches only the wallet whose connection received it, stamped with it', () => {
  const { c, sent, sub } = client();
  sub('perps', { channel: 'accountTrade', user: '0xAbC' });
  c.deliver('perps', { channel: 'accountTrade', type: 'update', user: '0xabc', data: [{ s: 'BTC-USD' }] });
  c.deliver('perps', { channel: 'accountTrade', type: 'update', user: '0xdef', data: [{ s: 'BTC-USD' }] });
  c.deliver('perps', { channel: 'accountTrade', type: 'update', data: [{ s: 'BTC-USD' }] });
  c.deliver('spot', { channel: 'accountTrade', type: 'update', user: '0xabc', data: [] });
  assert.deepEqual(sent, [{ type: 'push', engine: 'perps', channel: 'accountTrade', pushType: 'update', data: [{ s: 'BTC-USD' }], user: '0xabc' }]);
});

test('hub: array channels are narrowed to the symbols asked for; none asked means all', () => {
  const { c, sent, sub } = client();
  sub('perps', { channel: 'ticker', symbols: ['BTC-USD'] });
  sub('spot', { channel: 'allTicker' });
  const tick = { channel: 'ticker', type: 'update', data: [{ s: 'BTC-USD', p: '1' }, { s: 'ETH-USD', p: '2' }] };
  c.deliver('perps', tick);
  c.deliver('perps', { channel: 'ticker', type: 'update', data: [{ s: 'ETH-USD', p: '2' }] });
  c.deliver('spot', { channel: 'allTicker', type: 'snapshot', data: [{ s: 'A' }, { s: 'B' }] });
  assert.deepEqual(sent, [
    { type: 'push', engine: 'perps', channel: 'ticker', pushType: 'update', data: [{ s: 'BTC-USD', p: '1' }] },
    { type: 'push', engine: 'spot', channel: 'allTicker', pushType: 'snapshot', data: [{ s: 'A' }, { s: 'B' }] },
  ]);
});

test('hub: object channels need a symbol asked for, and a candle the interval asked for', () => {
  const { c, sent, sub } = client();
  sub('perps', { channel: 'candle', symbol: 'BTC-USD', interval: '1m' });
  sub('perps', { channel: 'l2Book', symbol: 'ETH-USD' });
  c.deliver('perps', { channel: 'candle', type: 'update', data: { s: 'BTC-USD', i: '1m', c: '1' } });
  c.deliver('perps', { channel: 'candle', type: 'update', data: { s: 'BTC-USD', i: '5m', c: '2' } });
  c.deliver('perps', { channel: 'candle', type: 'update', data: { s: 'SOL-USD', i: '1m', c: '3' } });
  c.deliver('perps', { channel: 'l2Book', type: 'snapshot', data: { s: 'ETH-USD', b: [] } });
  c.deliver('perps', { channel: 'l2Book', type: 'snapshot', data: { s: 'BTC-USD', b: [] } });
  c.deliver('perps', { type: 'update', data: { s: 'ETH-USD' } });
  assert.deepEqual(sent, [
    { type: 'push', engine: 'perps', channel: 'candle', pushType: 'update', data: { s: 'BTC-USD', i: '1m', c: '1' } },
    { type: 'push', engine: 'perps', channel: 'l2Book', pushType: 'snapshot', data: { s: 'ETH-USD', b: [] } },
  ]);
});
