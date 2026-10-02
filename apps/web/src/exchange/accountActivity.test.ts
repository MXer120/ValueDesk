/**
 * What the page knows about a wallet's account (accountActivity.ts): a kept
 * history table is taken as current only when the page listened to the
 * wallet's stream the whole time since the table was read, and heard nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountActivity, LAG_MS, SETTLE_MS, TAKEOVER_MS } from './accountActivity';
import type { KeyValueStore } from './ledger';

const W = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';
const OTHER = '0x1111111111111111111111111111111111111111';
const BOTH = ['accountOrderUpdate', 'accountTrade'];

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function page(store: KeyValueStore = memStore(), clock = { t: 1_000_000 }, scope = 'mainnet') {
  return { clock, store, a: new AccountActivity(() => clock.t, store, () => scope) };
}

test('activity: quiet only when the page listened since before the read and heard nothing', () => {
  const { a, clock } = page();
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t), false, 'not listening: nothing is known');
  a.listening('perps', W, 'accountTrade');
  const read1 = clock.t + SETTLE_MS - 1;
  const read2 = clock.t + SETTLE_MS;
  clock.t += 20_000;
  assert.equal(a.quietSince('perps', W, ['accountTrade'], read1), false, 'a read sent before the subscription could have settled');
  assert.equal(a.quietSince('perps', W, ['accountTrade'], read2), true);
  assert.equal(a.quietSince('perps', W.toUpperCase().replace('0X', '0x'), ['accountTrade'], read2), true, 'whatever the address\'s case');
  assert.equal(a.quietSince('perps', W, BOTH, read2), false, 'order history also needs the order channel');
  assert.equal(a.quietSince('spot', W, ['accountTrade'], read2), false, 'another engine is another stream');
  assert.equal(a.quietSince('perps', OTHER, ['accountTrade'], read2), false, 'another wallet too');
  assert.equal(a.quietSince('perps', W, [], read2), true, 'a history no channel changes (funding)');
  assert.equal(a.quietSince('perps', W, ['accountTrade'], 0), false, 'a table whose read time is not known');
});

test('activity: a push after the read - or just before it - means the table is not current', () => {
  const { a, clock } = page();
  a.listening('perps', W, 'accountTrade');
  a.listening('perps', W, 'accountOrderUpdate');
  clock.t += 10_000;
  const read = clock.t;
  clock.t += 5_000;
  assert.equal(a.quietSince('perps', W, BOTH, read), true);
  a.heard('perps', W, 'accountOrderUpdate'); // an order was placed
  assert.equal(a.quietSince('perps', W, BOTH, read), false, 'order history changed');
  assert.equal(a.quietSince('perps', W, ['accountTrade'], read), true, 'no fill: trade history did not');
  a.heard('perps', OTHER, 'accountTrade'); // not listened to: ignored
  a.heard('perps', W, 'accountTrade');
  assert.equal(a.quietSince('perps', W, ['accountTrade'], read), false);
  // A read sent after the push is current again - once the push is surely in its answer.
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t + LAG_MS), false);
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t + LAG_MS + 1), true);
});

test('activity: a break is unknown time - unsubscribed, the host away, a dropped connection', () => {
  const { a, clock } = page();
  a.listening('perps', W, 'accountTrade');
  a.listening('perps', OTHER, 'accountTrade');
  clock.t += 10_000;
  const read = clock.t;
  clock.t += 1_000;

  a.stopped('perps', W, 'accountTrade');
  clock.t += 1_000;
  a.listening('perps', W, 'accountTrade');
  clock.t += 10_000;
  assert.equal(a.quietSince('perps', W, ['accountTrade'], read), false, 'it was not listening for a second');
  assert.equal(a.quietSince('perps', OTHER, ['accountTrade'], read), true, 'the other wallet was');

  a.interrupted('perps', OTHER); // its connection dropped
  assert.equal(a.quietSince('perps', OTHER, ['accountTrade'], read), false);
  const later = clock.t;
  clock.t += 5_000;
  assert.equal(a.quietSince('perps', W, ['accountTrade'], later), true);
  a.interrupted('perps'); // the network: every wallet of the engine
  assert.equal(a.quietSince('perps', W, ['accountTrade'], later), false);

  a.stoppedAll(); // the link to the socket host is down
  a.listening('perps', W, 'accountTrade');
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t), false);

  a.stopped('perps', null, 'accountTrade'); // "account stream unavailable", wallet not named
  clock.t += 60_000;
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t - 1), false);
});

test('activity: a reload takes over what the page before it knew - only within the takeover time, once, and on the same network', () => {
  const store = memStore();
  const clock = { t: 1_000_000 };
  const before = page(store, clock).a;
  before.listening('perps', W, 'accountTrade');
  clock.t += 30_000;
  const read = clock.t;
  clock.t += 5_000;
  before.keep(); // pagehide

  clock.t += TAKEOVER_MS;
  const after = page(store, clock).a;
  after.listening('perps', W, 'accountTrade');
  assert.equal(after.quietSince('perps', W, ['accountTrade'], read), true, 'a quick reload: the kept table is still current');

  // A push the old page heard before it went away is known to the new one.
  const store2 = memStore();
  const old2 = page(store2, clock).a;
  old2.listening('perps', W, 'accountTrade');
  clock.t += 10_000;
  const read2 = clock.t;
  clock.t += 2_000;
  old2.heard('perps', W, 'accountTrade');
  old2.keep();
  clock.t += 1_000;
  const new2 = page(store2, clock).a;
  new2.listening('perps', W, 'accountTrade');
  assert.equal(new2.quietSince('perps', W, ['accountTrade'], read2), false);

  // Too late: the gap is unknown time.
  const store3 = memStore();
  const old3 = page(store3, clock).a;
  old3.listening('perps', W, 'accountTrade');
  clock.t += 10_000;
  const read3 = clock.t;
  old3.keep();
  clock.t += TAKEOVER_MS + 1;
  const new3 = page(store3, clock).a;
  new3.listening('perps', W, 'accountTrade');
  clock.t += 10_000;
  assert.equal(new3.quietSince('perps', W, ['accountTrade'], read3), false);

  // Only the first listen of a page takes over: after a break of its own, the break is unknown.
  after.stoppedAll();
  after.listening('perps', W, 'accountTrade');
  assert.equal(after.quietSince('perps', W, ['accountTrade'], read), false);

  // Another network's page knows nothing of this one.
  const store4 = memStore();
  const old4 = page(store4, clock, 'mainnet').a;
  old4.listening('perps', W, 'accountTrade');
  clock.t += 10_000;
  const read4 = clock.t;
  old4.keep();
  const new4 = page(store4, clock, 'testnet').a;
  new4.listening('perps', W, 'accountTrade');
  assert.equal(new4.quietSince('perps', W, ['accountTrade'], read4), false);
});

test('activity: without storage nothing is taken over and nothing fails', () => {
  const clock = { t: 1_000_000 };
  const a = new AccountActivity(() => clock.t, null, () => 'mainnet');
  a.listening('perps', W, 'accountTrade');
  a.keep();
  clock.t += 10_000;
  assert.equal(a.quietSince('perps', W, ['accountTrade'], clock.t), true);
});

test('activity: whether the wallet\'s stream is speaking - a push counts, an interruption does not', () => {
  const { a, clock } = page();
  assert.equal(a.isListening('perps', W), false);
  a.listening('perps', W, 'accountOrderUpdate');
  assert.equal(a.isListening('perps', W), true);
  assert.equal(a.isListening('spot', W), false);
  assert.equal(a.isListening('perps', OTHER), false);
  const action = clock.t + 10_000;
  clock.t = action - 1_500;
  a.heard('perps', W, 'accountOrderUpdate'); // the push can be faster than the action's own answer
  clock.t = action + 400;
  assert.equal(a.pushedSince('perps', W, action - 2_000), true);
  assert.equal(a.pushedSince('perps', W, action), false, 'nothing since the action itself');
  assert.equal(a.pushedSince('perps', OTHER, 0), false);
  a.interrupted('perps', W);
  assert.equal(a.pushedSince('perps', W, action), false, 'a dropped connection is not the stream speaking');
  a.heard('perps', W, 'accountTrade'); // not listened to: ignored
  assert.equal(a.pushedSince('perps', W, action), false);
  a.stopped('perps', W, 'accountOrderUpdate');
  assert.equal(a.isListening('perps', W), false);
  assert.equal(a.pushedSince('perps', W, 0), false, 'what a stream said before it was dropped does not count');
});
