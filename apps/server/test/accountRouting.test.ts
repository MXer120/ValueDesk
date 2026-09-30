import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_CONN_CAP, Upstream, routeKeys, subKey, upstreamFor, upstreams, releaseUpstream } from '../src/sodex/ws.js';
import { accountPushFor } from '../src/hub.js';

// A connection that never dials: the tests only exercise routing and the pool.
const fake = (e: 'spot' | 'perps', u: string) => new Upstream(e, 'ws://127.0.0.1:9', u);

test('account push: delivered only to the exact wallet, never on a missing wallet', () => {
  assert.equal(accountPushFor('0xAbC', '0xabc'), true);
  assert.equal(accountPushFor('0xabc', '0xdef'), false);
  assert.equal(accountPushFor('0xabc', undefined), false); // the gateway names no wallet
  assert.equal(accountPushFor(undefined, '0xabc'), false);
});

test('account push: routed by the stamp of the connection that received it', () => {
  const keys = routeKeys({ channel: 'accountTrade', type: 'update', user: '0xABC', data: [{ s: 'BTC-USD' }] });
  assert.deepEqual(keys, [subKey({ channel: 'accountTrade', user: '0xabc' })]);
});

test('upstreamFor: market data on the shared connection, each wallet on its own, capped', () => {
  assert.equal(upstreamFor('perps', { channel: 'l2Book', symbol: 'BTC-USD' }, fake), upstreams.perps);
  assert.equal(upstreamFor('perps', { channel: 'accountTrade' }, fake), null);
  const a = upstreamFor('perps', { channel: 'accountTrade', user: '0xA1' }, fake)!;
  const a2 = upstreamFor('perps', { channel: 'accountOrderUpdate', user: '0xa1' }, fake)!;
  const b = upstreamFor('perps', { channel: 'accountTrade', user: '0xB2' }, fake)!;
  assert.equal(a, a2, 'one connection per wallet and engine');
  assert.notEqual(a, b);
  assert.equal(a.user, '0xa1');
  // Fill the pool with wallets that hold subscriptions; the next one gets no connection.
  const held: Upstream[] = [a, b];
  for (let i = 2; i < ACCOUNT_CONN_CAP; i++) held.push(upstreamFor('spot', { channel: 'accountTrade', user: `0xC${i}` }, fake)!);
  const pin = (u: Upstream) => (u as any).subs.set('pin', { params: { channel: 'accountTrade' }, refs: 1 });
  held.forEach(pin);
  assert.equal(upstreamFor('perps', { channel: 'accountTrade', user: '0xFULL' }, fake), null);
  // One wallet's connection freed: the next wallet may take its place.
  (held[2] as any).subs.clear();
  assert.ok(upstreamFor('perps', { channel: 'accountTrade', user: '0xNEXT' }, fake));
  for (const u of held) { (u as any).subs.clear(); releaseUpstream(u); u.close(); }
});
