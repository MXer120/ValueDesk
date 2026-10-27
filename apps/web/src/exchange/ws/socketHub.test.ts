/**
 * The socket host (socketHub.ts + sodexSocket.ts) against fake WebSockets:
 *
 *  - fills and order updates reach ONLY the wallet whose connection received
 *    them (a scanned wallet never feeds the connected user's notifications);
 *  - tabs share connections and subscriptions (the gateway allows 10 per IP);
 *  - the per-wallet connection cap, idle close, tab sweep;
 *  - only SoDEX's own gateways over wss;
 *  - the server's subscribe-param rules (sodex/wsProtocol.ts), keepalive and
 *    re-subscribe after a drop.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_CONN_CAP, ACCOUNT_IDLE_CLOSE_MS, KEEPALIVE_MS, normaliseSubParams, type SubParams } from '@sign/sodex/wsProtocol.js';
import { CLIENT_TIMEOUT_MS, MARKET_IDLE_CLOSE_MS, SocketHub } from './socketHub';
import { WS_PROTOCOL_VERSION, type ToTab } from './messages';
import type { SocketLike } from './sodexSocket';

const BASE = 'wss://mainnet-gw.sodex.dev';
const OWN = '0x1111111111111111111111111111111111111111';
const SCANNED = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: any[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    const m = JSON.parse(d);
    this.sent.push(m);
    // The gateway answers every ping (the watchdog in sodexSocket.ts relies on it).
    if (m.op === 'ping') this.push({ op: 'pong' });
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  subscribes(): SubParams[] {
    return this.sent.filter((m) => m.op === 'subscribe').map((m) => m.params);
  }
}

const live = () => FakeSocket.all.filter((s) => !s.closed);
/** The connection that was asked to stream this wallet's account channels. */
const walletSocket = (user: string) => FakeSocket.all.find((s) => s.subscribes().some((p) => p.user === user))!;

function newHub() {
  return new SocketHub({ factory: (url) => new FakeSocket(url), host: 'worker' });
}

function tab(hub: SocketHub, id: string) {
  const got: ToTab[] = [];
  const port = { id, send: (m: ToTab) => void got.push(m) };
  hub.handle({ op: 'hello', client: id, v: WS_PROTOCOL_VERSION }, port);
  return {
    got,
    sub(params: SubParams, engine: 'spot' | 'perps' = 'perps', wsBase = BASE) {
      hub.handle({ op: 'subscribe', client: id, engine, params, wsBase }, port);
    },
    unsub(params: SubParams, engine: 'spot' | 'perps' = 'perps') {
      hub.handle({ op: 'unsubscribe', client: id, engine, params }, port);
    },
    bye() {
      hub.handle({ op: 'bye', client: id }, port);
    },
    ping() {
      hub.handle({ op: 'ping', client: id }, port);
    },
    pushes(filter?: (m: Extract<ToTab, { type: 'push' }>) => boolean) {
      return got.filter((m): m is Extract<ToTab, { type: 'push' }> => m.type === 'push' && (!filter || filter(m)));
    },
    errors() {
      return got.filter((m): m is Extract<ToTab, { type: 'error' }> => m.type === 'error');
    },
  };
}

beforeEach(() => {
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
});
afterEach(() => {
  mock.timers.reset();
});

test('fills reach ONLY the wallet whose connection received them: a scanned wallet never feeds your notifications', () => {
  const hub = newHub();
  const a = tab(hub, 'tab-a'); // the connected user: fill toasts + a Scan page on the same tab
  const b = tab(hub, 'tab-b'); // another tab scanning the same wallet
  a.sub({ channel: 'accountTrade', user: OWN });
  a.sub({ channel: 'accountTrade', user: SCANNED });
  b.sub({ channel: 'accountTrade', user: SCANNED });
  for (const s of FakeSocket.all) s.open();

  const own = walletSocket(OWN);
  const scanned = walletSocket(SCANNED);
  assert.notEqual(own, scanned, 'one connection per wallet');
  assert.equal(FakeSocket.all.length, 2, 'two wallets, two connections - shared by both tabs');

  // The gateway's account push: a bare array, no wallet named anywhere.
  scanned.push({ channel: 'accountTrade', type: 'update', data: [{ s: 'BTC-USD', p: '84000', q: '1' }] });
  assert.equal(a.pushes((m) => m.user === OWN).length, 0, 'your fill toasts hear nothing of the scanned wallet');
  assert.equal(a.pushes((m) => m.user === SCANNED).length, 1);
  assert.equal(b.pushes((m) => m.user === SCANNED).length, 1);

  // Even a payload that NAMES your wallet, arriving on the scanned wallet's connection, is the scanned wallet's.
  scanned.push({ channel: 'accountTrade', type: 'update', user: OWN, data: [{ s: 'ETH-USD', user: OWN }] });
  assert.equal(a.pushes((m) => m.user === OWN).length, 0, 'the connection decides whose push it is, never the payload');

  own.push({ channel: 'accountTrade', type: 'update', data: [{ s: 'SOL-USD' }] });
  assert.equal(a.pushes((m) => m.user === OWN).length, 1, 'your own fill reaches you');
  assert.equal(b.pushes((m) => m.user === OWN).length, 0, 'and only the tab that asked for it');
});

test('account channels without a wallet get no stream (the pages poll instead)', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  a.sub({ channel: 'accountOrderUpdate' });
  assert.equal(FakeSocket.all.length, 0);
  assert.match(a.errors()[0]!.message, /account stream unavailable/);
});

test('tabs share one market connection and one upstream subscription; the last to leave unsubscribes', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  const b = tab(hub, 'b');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  b.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  const [sock] = FakeSocket.all;
  assert.equal(FakeSocket.all.length, 1);
  sock!.open();
  assert.equal(sock!.subscribes().length, 1, 'one upstream subscription for both tabs');
  sock!.push({ channel: 'l2Book', type: 'snapshot', data: { s: 'BTC-USD', b: [['84000', '1']], a: [] } });
  assert.equal(a.pushes().length, 1);
  assert.equal(b.pushes().length, 1);

  // A late joiner is seeded from the cached snapshot at once.
  const c = tab(hub, 'c');
  c.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  assert.equal(c.pushes().length, 1);
  assert.equal(c.pushes()[0]!.pushType, 'snapshot');

  a.unsub({ channel: 'l2Book', symbol: 'BTC-USD' });
  b.bye();
  assert.equal(sock!.sent.filter((m) => m.op === 'unsubscribe').length, 0, 'c still reads it');
  c.unsub({ channel: 'l2Book', symbol: 'BTC-USD' });
  assert.equal(sock!.sent.filter((m) => m.op === 'unsubscribe').length, 1);
  assert.equal(sock!.closed, false, 'kept a while in case a panel comes back');
  mock.timers.tick(MARKET_IDLE_CLOSE_MS + 1);
  assert.equal(sock!.closed, true);
});

test('array channels are narrowed to the symbols a tab asked for; candles to its interval', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  const b = tab(hub, 'b');
  a.sub({ channel: 'markPrice', symbols: ['BTC-USD'] });
  b.sub({ channel: 'markPrice', symbols: ['ETH-USD'] });
  a.sub({ channel: 'candle', symbol: 'BTC-USD', interval: '1m' });
  b.sub({ channel: 'candle', symbol: 'BTC-USD', interval: '1h' });
  const [sock] = FakeSocket.all;
  sock!.open();
  sock!.push({ channel: 'markPrice', type: 'update', data: [{ s: 'BTC-USD', p: '1' }, { s: 'ETH-USD', p: '2' }] });
  assert.deepEqual(a.pushes((m) => m.channel === 'markPrice')[0]!.data, [{ s: 'BTC-USD', p: '1' }]);
  assert.deepEqual(b.pushes((m) => m.channel === 'markPrice')[0]!.data, [{ s: 'ETH-USD', p: '2' }]);
  sock!.push({ channel: 'candle', type: 'update', data: { s: 'BTC-USD', i: '1h', c: '84000' } });
  assert.equal(a.pushes((m) => m.channel === 'candle').length, 0);
  assert.equal(b.pushes((m) => m.channel === 'candle').length, 1);
});

test(`wallet connections are capped at ${ACCOUNT_CONN_CAP} (with 2 market connections: within the gateway's 10 per IP)`, () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' }, 'perps');
  a.sub({ channel: 'ticker', symbols: ['vBTC_vUSDC'] }, 'spot');
  const wallets = Array.from({ length: ACCOUNT_CONN_CAP + 1 }, (_, i) => `0x${String(i + 1).padStart(40, 'a')}`);
  for (const w of wallets) a.sub({ channel: 'accountUpdate', user: w });
  for (const s of FakeSocket.all) s.open();
  assert.equal(live().length, 2 + ACCOUNT_CONN_CAP);
  assert.equal(a.errors().filter((e) => /account stream unavailable/.test(e.message)).length, 1, 'the one beyond the cap polls instead');
  assert.ok(hub.connectionCount().total <= 10);

  // A wallet nobody watches any more closes after a while, and a newcomer may take its place meanwhile.
  a.unsub({ channel: 'accountUpdate', user: wallets[0]! });
  a.sub({ channel: 'accountUpdate', user: '0x' + 'f'.repeat(40) });
  for (const s of FakeSocket.all) if (!s.closed && s.readyState === 0) s.open();
  assert.equal(live().length, 2 + ACCOUNT_CONN_CAP, 'the idle one made room');
  a.unsub({ channel: 'accountUpdate', user: wallets[1]! });
  mock.timers.tick(ACCOUNT_IDLE_CLOSE_MS + 1);
  assert.equal(live().length, 2 + ACCOUNT_CONN_CAP - 1, 'an unused wallet connection closes after the idle delay');
});

test('a tab that disappears without a word is swept, and its subscriptions go with it', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  const b = tab(hub, 'b');
  a.sub({ channel: 'accountTrade', user: OWN });
  b.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  for (const s of FakeSocket.all) s.open();
  mock.timers.tick(CLIENT_TIMEOUT_MS - 1_000);
  b.ping();
  mock.timers.tick(2_000);
  hub.sweep();
  assert.equal(hub.clientCount, 1, 'a is gone, b pinged');
  assert.equal(walletSocket(OWN).sent.filter((m) => m.op === 'unsubscribe').length, 1);
});

test('only SoDEX\'s own gateways, over wss, are ever opened', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' }, 'perps', 'wss://evil.example');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' }, 'perps', 'ws://mainnet-gw.sodex.dev');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' }, 'perps', 'wss://mainnet-gw.sodex.dev/evil');
  assert.equal(FakeSocket.all.length, 0);
  assert.equal(a.errors().filter((e) => /gateway not allowed/.test(e.message)).length, 3);
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' }, 'perps', 'wss://testnet-gw.sodex.dev');
  assert.equal(FakeSocket.all[0]!.url, 'wss://testnet-gw.sodex.dev/ws/perps');
});

test('a tab of another protocol version is not served', () => {
  const hub = newHub();
  const got: ToTab[] = [];
  hub.handle({ op: 'hello', client: 'old', v: WS_PROTOCOL_VERSION + 1 }, { id: 'old', send: (m) => void got.push(m) });
  assert.equal(hub.clientCount, 0);
  assert.equal(got.length, 0);
});

test('the gateway gets the server\'s subscribe shapes (wsProtocol.normaliseSubParams); {symbol} and {symbols} share one subscription', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  const b = tab(hub, 'b');
  a.sub({ channel: 'trade', symbol: 'BTC-USD' });
  b.sub({ channel: 'trade', symbols: ['BTC-USD'] });
  a.sub({ channel: 'l2Book', symbols: ['ETH-USD'] });
  a.sub({ channel: 'accountTrade', user: OWN, symbol: 'IGNORED' } as SubParams);
  for (const s of FakeSocket.all) s.open();
  const market = FakeSocket.all[0]!;
  assert.deepEqual(market.subscribes(), [
    { channel: 'trade', symbols: ['BTC-USD'] },
    { channel: 'l2Book', symbol: 'ETH-USD' },
  ]);
  assert.deepEqual(walletSocket(OWN).subscribes(), [{ channel: 'accountTrade', user: OWN }]);
  // The rules themselves, as the server documents them (trade/markPrice take a list, candle one symbol).
  assert.deepEqual(normaliseSubParams({ channel: 'markPrice', symbol: 'X' }), { channel: 'markPrice', symbols: ['X'] });
  assert.deepEqual(normaliseSubParams({ channel: 'candle', symbols: ['X'], interval: '1m' }), { channel: 'candle', symbol: 'X', interval: '1m' });
});

test('the server has ONE copy of those rules: its ws.ts re-exports wsProtocol.ts instead of defining its own', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../../server/src/sodex/ws.ts', import.meta.url)), 'utf8');
  assert.match(src, /from '\.\/wsProtocol\.js'/);
  assert.doesNotMatch(src, /export const CHANNEL_PARAM_STYLE/);
  assert.doesNotMatch(src, /export function normaliseSubParams/);
});

test('keepalive every 30 s; after a drop the connection comes back and re-arms every subscription', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  a.sub({ channel: 'ticker', symbols: ['BTC-USD'] });
  const first = FakeSocket.all[0]!;
  first.open();
  mock.timers.tick(KEEPALIVE_MS);
  assert.equal(first.sent.filter((m) => m.op === 'ping').length, 1);
  assert.equal(a.got.filter((m) => m.type === 'status' && m.status === 'open').length, 1, 'the tab hears the market connection is up');
  first.drop();
  assert.equal(a.got.filter((m) => m.type === 'status' && m.status === 'reconnecting').length, 1);
  mock.timers.tick(10_000);
  const second = FakeSocket.all[1]!;
  assert.ok(second, 'reconnected');
  second.open();
  assert.deepEqual(second.subscribes(), [{ channel: 'l2Book', symbol: 'BTC-USD' }, { channel: 'ticker', symbols: ['BTC-USD'] }]);
});

test('the last tab to say bye closes every connection at once; the next tab starts afresh', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  const b = tab(hub, 'b');
  a.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  b.sub({ channel: 'accountUpdate', user: OWN });
  for (const s of FakeSocket.all) s.open();
  assert.equal(live().length, 2);
  a.bye();
  assert.equal(live().length, 2, 'b is still here');
  b.bye();
  assert.equal(live().length, 0, 'no tab left: nothing stays open');
  const c = tab(hub, 'c');
  c.sub({ channel: 'l2Book', symbol: 'BTC-USD' });
  assert.equal(live().length, 1, 'a new tab gets a new connection');
});

test('a wallet connection that drops tells the tabs listening on it - when it drops, and when it is back', () => {
  const hub = newHub();
  const a = tab(hub, 'tab-a');
  const b = tab(hub, 'tab-b');
  a.sub({ channel: 'accountTrade', user: OWN });
  a.sub({ channel: 'accountOrderUpdate', user: OWN });
  b.sub({ channel: 'accountTrade', user: SCANNED });
  for (const s of FakeSocket.all) s.open();
  const gaps = (t: { got: ToTab[] }) => t.got.filter((m) => m.type === 'gap');
  assert.equal(gaps(a).length + gaps(b).length, 0, 'a first connection is not a gap');

  const before = FakeSocket.all.length;
  walletSocket(OWN).drop();
  assert.deepEqual(gaps(a), [{ type: 'gap', engine: 'perps', user: OWN }], 'once per tab, whatever it subscribed to');
  mock.timers.tick(10_000);
  const again = FakeSocket.all[before]!;
  assert.ok(again, 'reconnected');
  again.open();
  assert.equal(gaps(a).length, 2, 'back: what was pushed in between is unknown');
  assert.equal(gaps(b).length, 0, 'the other wallet\'s tab hears nothing of it');
  assert.equal(a.got.filter((m) => m.type === 'status' && m.status === 'reconnecting').length, 0, 'and it is not an outage of the engine');
});

test('"account stream unavailable" names the wallet it is for', () => {
  const hub = newHub();
  const a = tab(hub, 'a');
  for (let i = 0; i < ACCOUNT_CONN_CAP; i++) a.sub({ channel: 'accountTrade', user: `0x${String(i + 1).padStart(40, '0')}` });
  a.sub({ channel: 'accountTrade', user: SCANNED });
  const refused = a.errors().find((e) => /account stream unavailable/.test(e.message));
  assert.equal(refused?.user, SCANNED);
});
