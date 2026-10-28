/**
 * The algo feed's account channel under SoDEX's per-IP limit (feed.ts
 * ACCOUNT_USERS_PER_IP): one socket follows at most 10 wallets' order
 * updates, the most important first, without churn; the rest are read by REST.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_USERS_PER_IP, AlgoFeed, type WebSocketLike } from '../src/index.ts';

function rigFeed(max?: number) {
  const sent: Array<{ op: string; params: { channel: string; user?: string } }> = [];
  let ws: WebSocketLike | null = null;
  const factory = (): WebSocketLike => {
    ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as WebSocketLike;
    return ws;
  };
  const feed = new AlgoFeed({ network: 'mainnet', factory, wsOrigin: 'wss://x', ...(max !== undefined ? { maxAccountUsers: max } : {}) });
  feed.start();
  (ws as unknown as { onopen: () => void }).onopen();
  const users = (op: string) => sent.filter((m) => m.op === op && m.params.channel === 'accountOrderUpdate').map((m) => m.params.user);
  return { feed, sent, users, stop: () => feed.stop() };
}

const wallet = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

test('feed: at most 10 wallets on the account channel, most important first; the others are not followed (read by REST)', () => {
  assert.equal(ACCOUNT_USERS_PER_IP, 10);
  const f = rigFeed();
  const owners = Array.from({ length: 14 }, (_, i) => wallet(i + 1));
  f.feed.watch(['BTC-USD'], owners);
  assert.deepEqual(f.users('subscribe'), owners.slice(0, 10));
  assert.equal(f.feed.followsOrders(owners[0]!), true);
  assert.equal(f.feed.followsOrders(owners[12]!), false);
  // A wallet that leaves frees its place; the next in line gets it - those followed already keep theirs (no churn).
  f.feed.watch(['BTC-USD'], [owners[13]!, ...owners.slice(1, 13)]);
  assert.deepEqual(f.users('unsubscribe'), [owners[0]]);
  assert.deepEqual(f.users('subscribe').slice(10), [owners[13]], 'the most important waiting wallet');
  assert.equal(f.feed.followsOrders(owners[13]!), true);
  assert.equal(f.feed.followsOrders(owners[10]!), false, 'still read by REST');
  // Never more than 10 at once.
  const live = new Set<string>();
  for (const m of f.sent.filter((x) => x.params.channel === 'accountOrderUpdate')) m.op === 'subscribe' ? live.add(m.params.user!) : live.delete(m.params.user!);
  assert.equal(live.size, 10);
  f.stop();
});

test('feed: while the socket is down no wallet counts as followed (the runtime reads them all by REST)', () => {
  const f = rigFeed(2);
  f.feed.watch([], [wallet(1)]);
  assert.equal(f.feed.followsOrders(wallet(1)), true);
  f.feed.stop();
  assert.equal(f.feed.followsOrders(wallet(1)), false);
});
