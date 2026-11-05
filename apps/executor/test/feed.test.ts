/**
 * The shared Binance feed (src/feed): the ring's layout and its reader (latest table, drain, a lapped reader, a
 * producer restart), the feed's universe, and the executor's reference on top of it - the ring while it beats, its
 * own Binance socket while the ring is silent, the ring again once it is back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAGIC, RingReader, RingWriter, TICK_BYTES } from '../src/feed/ring.ts';
import { universe } from '../src/feed/main.ts';
import { BinanceReference, binanceSymbolOf } from '../src/feed/reference.ts';
import { silentLogger, type WebSocketLike } from '../../../packages/copy-engine/src/io.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'vs-feed-'));
const SYMS = [{ market: 'BTC-USD', venue: 'BTCUSDT' }, { market: 'ETH-USD', venue: 'ETHUSDT' }];

test('ring: the trading box\'s layout - magic, tables, a tick in the ring and in the latest table', () => {
  const d = dir();
  try {
    const path = join(d, 'ring');
    const w = new RingWriter(path, ['binance_fut'], SYMS, 8);
    assert.ok(w.publish(0, 1, 2280.1, 2280.2, 3, 4, 1_793_000_000_000, 77));
    assert.equal(w.publish(0, 1, 2280.1, 2280.2, 5, 6, 1_793_000_000_001, 78), false, 'a size-only change is not written');
    const raw = readFileSync(path);
    assert.equal(raw.toString('latin1', 0, 8), MAGIC);
    assert.equal(raw.readUInt32LE(12), TICK_BYTES);
    assert.equal(raw.readBigUInt64LE(16), 8n);
    assert.equal(raw.readBigUInt64LE(88), 1n, 'head');
    const r = new RingReader(path);
    assert.deepEqual(r.feeds, ['binance_fut']);
    assert.deepEqual(r.symbols, SYMS);
    const t = r.latest(0, 1)!;
    assert.deepEqual([t.bid, t.ask, t.bidSz, t.askSz, t.eventMs, t.feed, t.symbol, t.update], [2280.1, 2280.2, 3, 4, 1_793_000_000_000, 0, 1, 77]);
    assert.equal(r.latest(0, 0), null, 'nothing for BTC yet');
    assert.ok(r.alive());
    r.close();
    w.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('ring: a reader drains what came since it opened; a lapped reader skips what was overwritten and counts it', () => {
  const d = dir();
  try {
    const path = join(d, 'ring');
    const w = new RingWriter(path, ['binance_fut'], SYMS, 8);
    w.publish(0, 0, 1, 2, 0, 0, 0, 1);
    const r = new RingReader(path);
    assert.deepEqual(r.drain(), [], 'starts at the head');
    for (let i = 0; i < 3; i++) w.publish(0, 0, 10 + i, 11 + i, 0, 0, 0, 2 + i);
    assert.deepEqual(r.drain().map((t) => t.bid), [10, 11, 12]);
    for (let i = 0; i < 20; i++) w.publish(0, i % 2, 100 + i, 101 + i, 0, 0, 0, 10 + i);
    const got = r.drain();
    assert.ok(got.length <= 8 && got.length >= 7, `at most the ring's capacity (${got.length})`);
    assert.equal(got[got.length - 1]!.bid, 119);
    assert.ok(r.lost >= 12n);
    r.close();
    w.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// Linux renames a file over one a reader holds open; Windows refuses (EPERM): the box is Linux.
test('ring: a producer restart writes a new file; the reader opens it again', { skip: process.platform === 'win32' }, () => {
  const d = dir();
  try {
    const path = join(d, 'ring');
    const w1 = new RingWriter(path, ['binance_fut'], SYMS, 8);
    w1.publish(0, 0, 1, 2, 0, 0, 0, 1);
    const r = new RingReader(path);
    const gen = r.generation;
    assert.equal(r.reopenIfReplaced(), false);
    w1.close();
    const w2 = new RingWriter(path, ['binance_fut'], [...SYMS, { market: 'SOL-USD', venue: 'SOLUSDT' }], 8);
    w2.publish(0, 2, 93, 93.01, 0, 0, 0, 5);
    assert.equal(r.reopenIfReplaced(), true);
    assert.equal(r.symbols.length, 3);
    assert.ok(r.generation >= gen);
    assert.equal(r.latest(0, 2)!.ask, 93.01);
    r.close();
    w2.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('feed universe: the SoDEX perps Binance lists, by base asset', () => {
  const bn = new Map([['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT'], ['ZEC', 'ZECUSDT']]);
  assert.deepEqual(universe(['ETH-USD', 'BTC-USD', 'MCD-USD', 'ZEC-USD'], bn, null).map((s) => `${s.market}>${s.venue}`), ['BTC-USD>BTCUSDT', 'ETH-USD>ETHUSDT', 'ZEC-USD>ZECUSDT']);
  assert.deepEqual(universe(['ETH-USD', 'BTC-USD'], bn, ['ETH-USD']).map((s) => s.market), ['ETH-USD']);
  assert.equal(binanceSymbolOf('SOL-USD'), 'SOLUSDT');
});

class FakeWs implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  book(s: string, b: number, a: number, u: number): void {
    this.onmessage?.({ data: JSON.stringify({ stream: `${s.toLowerCase()}@bookTicker`, data: { s, b: String(b), a: String(a), B: '1', A: '1', E: 1, u } }) });
  }
}

test('reference: the ring while it beats; its own Binance socket while the ring is silent; the ring again once it is back', async () => {
  const d = dir();
  try {
    const path = join(d, 'ring');
    const sockets: FakeWs[] = [];
    const ref = new BinanceReference({ path, factory: (url) => { const s = new FakeWs(url); sockets.push(s); return s; }, log: silentLogger, autoPoll: false });
    const seen: string[] = [];
    ref.onQuote((m) => seen.push(m));
    // No ring yet: the own socket serves the watched market.
    ref.watch(['ETH-USD']);
    assert.equal(sockets.length, 1);
    assert.match(sockets[0]!.url, /ethusdt@bookTicker/);
    sockets[0]!.open();
    sockets[0]!.book('ETHUSDT', 2280, 2280.1, 5);
    sockets[0]!.book('ETHUSDT', 2280, 2280.1, 5);
    assert.equal(ref.quote('ETH-USD')!.bid, 2280);
    assert.equal(seen.length, 1, 'the second copy of update 5 is a duplicate');
    // The producer comes up: seeded from its latest table at once, the own socket closes after 3 s of beats.
    const w = new RingWriter(path, ['binance_fut'], SYMS, 64);
    w.publish(0, 1, 2281, 2281.1, 0, 0, 0, 9);
    ref.check();
    assert.equal(ref.quote('ETH-USD')!.bid, 2281);
    assert.equal(ref.onRing, false, 'not before it has beaten for 3 s');
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 3_100;
    try {
      w.beat();
      ref.check();
      assert.equal(ref.onRing, true);
      assert.equal(sockets[0]!.readyState, 3, 'own socket closed');
      w.publish(0, 1, 2282, 2282.1, 0, 0, 0, 10);
      ref.poll();
      assert.equal(ref.quote('ETH-USD')!.ask, 2282.1);
    } finally {
      Date.now = realNow;
    }
    assert.ok(ref.stats.ring >= 1);
    ref.stop();
    w.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('ring: the same price is written again after half a second on a size change, so a still market does not look like a dead feed', () => {
  const d = dir();
  try {
    const w = new RingWriter(join(d, 'ring'), ['binance_fut'], SYMS, 8);
    assert.equal(w.publish(0, 1, 100, 101, 1, 1, 1, 1, 1_000_000_000n), true);
    assert.equal(w.publish(0, 1, 100, 101, 2, 2, 2, 2, 1_400_000_000n), false, 'under half a second: not written');
    assert.equal(w.publish(0, 1, 100, 101, 3, 3, 3, 3, 1_500_000_000n), true, 'half a second: written');
    assert.equal(w.publish(0, 1, 100, 101, 4, 4, 4, 4, 1_600_000_000n), false, 'and the wait starts over');
    assert.equal(w.publish(0, 1, 100, 102, 4, 4, 5, 5, 1_600_000_001n), true, 'a new price always goes in');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
