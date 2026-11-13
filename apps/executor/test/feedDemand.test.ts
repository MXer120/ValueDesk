/**
 * The feed on demand (src/feed/demand.ts, main.ts OnDemandFeed, reference.ts): a reader tells the feed what it watches,
 * the feed carries exactly that (and nothing while nobody wants anything), a change swaps the ring without a gap,
 * a market leaves after its linger, and a market watched again never takes its old price for a fresh one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemandWriter, LINGER_MS, STALE_MS, TOUCH_MS, carryNow, readDemand, wantDirOf } from '../src/feed/demand.ts';
import { OnDemandFeed } from '../src/feed/main.ts';
import { RingReader } from '../src/feed/ring.ts';
import { BinanceReference } from '../src/feed/reference.ts';
import { silentLogger, type WebSocketLike } from '../../../packages/copy-engine/src/io.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'vs-demand-'));

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

test('demand: a reader writes its markets at once, rewrites them while it watches, removes them when done; nothing without the directory', () => {
  const d = dir();
  try {
    const want = join(d, 'ring.want');
    const w = new DemandWriter(want, () => {}, 4242);
    w.set(['ETH-USD', 'BTC-USD'], 1_000);
    assert.equal(existsSync(want), false, 'no directory (a feed that carries every market): nothing written');
    mkdirSync(want);
    w.tick(1_250);
    assert.equal(readFileSync(join(want, '4242'), 'utf8'), 'BTC-USD,ETH-USD', 'written once the feed made the directory');
    writeFileSync(join(want, '4242'), 'stale');
    w.tick(1_250 + TOUCH_MS - 1);
    assert.equal(readFileSync(join(want, '4242'), 'utf8'), 'stale', 'not before TOUCH_MS');
    w.tick(1_250 + TOUCH_MS);
    assert.equal(readFileSync(join(want, '4242'), 'utf8'), 'BTC-USD,ETH-USD', 'rewritten every TOUCH_MS');
    w.set(['SOL-USD'], 20_000);
    assert.equal(readFileSync(join(want, '4242'), 'utf8'), 'SOL-USD', 'a change at once');
    w.set([], 21_000);
    assert.equal(existsSync(join(want, '4242')), false, 'watching nothing: removed');
    w.set(['ETH-USD'], 22_000);
    w.clear();
    assert.equal(existsSync(join(want, '4242')), false, 'stopped: removed');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('demand: the feed reads fresh files of live processes only; a market lingers after its last want', () => {
  const d = dir();
  try {
    const now = Date.now();
    writeFileSync(join(d, '100'), 'ETH-USD,BTC-USD');
    writeFileSync(join(d, '200'), 'SOL-USD');
    writeFileSync(join(d, '300'), 'XRP-USD');
    writeFileSync(join(d, '400.tmp'), 'DOGE-USD');
    writeFileSync(join(d, 'notes'), 'ADA-USD');
    writeFileSync(join(d, '500'), 'eth-usd,../x,');
    const old = (now - STALE_MS - 1_000) / 1000;
    utimesSync(join(d, '300'), old, old);
    const r = readDemand(d, now, (pid) => pid !== 200);
    assert.deepEqual([...r.markets].sort(), ['BTC-USD', 'ETH-USD'], 'dead pid 200, stale 300, a temp file, other names and junk ignored');
    assert.equal(r.readers, 1);
    assert.deepEqual(readDemand(join(d, 'missing'), now).markets.size, 0);

    const last = new Map<string, number>();
    assert.deepEqual(carryNow(new Set(['ETH-USD']), last, 0), ['ETH-USD']);
    assert.deepEqual(carryNow(new Set(['BTC-USD']), last, 1_000), ['BTC-USD', 'ETH-USD'], 'ETH lingers');
    assert.deepEqual(carryNow(new Set(), last, LINGER_MS), ['BTC-USD'], 'ETH gone LINGER_MS after its last want');
    assert.deepEqual(carryNow(new Set(), last, 1_000 + LINGER_MS), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reference: tells the feed what it watches; a market watched again does not take its old price for a fresh one', () => {
  const d = dir();
  try {
    const path = join(d, 'ring');
    mkdirSync(wantDirOf(path));
    const sockets: FakeWs[] = [];
    const ref = new BinanceReference({ path, factory: (url) => { const s = new FakeWs(url); sockets.push(s); return s; }, log: silentLogger, autoPoll: false });
    ref.watch(['ETH-USD']);
    const file = join(wantDirOf(path), String(process.pid));
    assert.equal(readFileSync(file, 'utf8'), 'ETH-USD', 'written the moment the market is watched');
    assert.equal(sockets.length, 1, 'and its own socket serves it meanwhile');
    sockets[0]!.open();
    sockets[0]!.book('ETHUSDT', 2280, 2280.1, 5);
    assert.equal(ref.quote('ETH-USD')!.bid, 2280);
    ref.watch([]);
    assert.equal(existsSync(file), false, 'nothing watched: the file goes');
    assert.equal(ref.quote('ETH-USD'), null, 'and the price is forgotten');
    ref.watch(['ETH-USD']);
    assert.equal(ref.quote('ETH-USD'), null, 'watched again: no old price passed off as a still market\'s');
    ref.stop();
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('feed on demand: nothing while unwanted; a want opens its sockets and a ring; a second market swaps the ring with the first one\'s price carried; idle after the linger', { skip: process.platform === 'win32' }, async () => {
  const d = dir();
  let now = 1_000_000;
  const sockets: FakeWs[] = [];
  const path = join(d, 'ring');
  const wantDir = wantDirOf(path);
  const feed = new OnDemandFeed({
    path,
    wantDir,
    copies: 2,
    only: null,
    factory: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      queueMicrotask(() => s.open());
      return s;
    },
    lists: async () => ({ sodex: ['BTC-USD', 'ETH-USD', 'MCD-USD'], binance: new Map([['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT']]) }),
    log: silentLogger,
    now: () => now,
    alive: () => true,
    upWaitMs: 1_000,
  });
  try {
    mkdirSync(wantDir, { recursive: true });
    await feed.evaluate();
    assert.equal(sockets.length, 0, 'nobody wants anything: no socket');
    assert.equal(existsSync(path), false, 'and no ring');

    writeFileSync(join(wantDir, '111'), 'ETH-USD');
    await feed.evaluate();
    assert.equal(feed.carried, 'ETH-USD');
    assert.equal(sockets.length, 2, 'two raced copies of the one market');
    assert.ok(sockets.every((s) => /ethusdt@bookTicker/.test(s.url) && !/btcusdt/.test(s.url)));
    const r = new RingReader(path);
    assert.deepEqual(r.symbols.map((s) => s.market), ['ETH-USD']);
    assert.ok(r.alive(500), 'beating: its streams are up');
    sockets[0]!.book('ETHUSDT', 2280, 2280.1, 7);
    sockets[1]!.book('ETHUSDT', 2280, 2280.1, 7);
    assert.equal(r.latest(0, 0)!.bid, 2280);
    assert.equal(r.drain().length, 1, 'the raced copy of update 7 written once');

    writeFileSync(join(wantDir, '222'), 'BTC-USD,MCD-USD');
    await feed.evaluate();
    assert.equal(feed.carried, 'BTC-USD,ETH-USD', 'MCD-USD is not on Binance: not carried');
    assert.equal(sockets.slice(0, 2).every((s) => s.readyState === 3), true, 'the old sockets closed after the swap');
    assert.equal(r.reopenIfReplaced(), true, 'a new ring');
    assert.deepEqual(r.symbols.map((s) => s.market), ['BTC-USD', 'ETH-USD']);
    assert.equal(r.latest(0, r.bySymbol.get('ETH-USD')!)!.ask, 2280.1, 'ETH\'s price carried into the new ring');
    const fresh = sockets.slice(2);
    fresh[0]!.book('BTCUSDT', 99_000, 99_001, 3);
    assert.equal(r.latest(0, r.bySymbol.get('BTC-USD')!)!.bid, 99_000);

    rmSync(join(wantDir, '111'));
    rmSync(join(wantDir, '222'));
    now += LINGER_MS - 1;
    await feed.evaluate();
    assert.equal(feed.carried, 'BTC-USD,ETH-USD', 'kept for the linger');
    now += 2;
    await feed.evaluate();
    assert.equal(feed.carried, '', 'idle after it');
    assert.equal(existsSync(path), false, 'the ring removed');
    assert.equal(sockets.every((s) => s.readyState === 3), true, 'every socket closed');
    r.close();
  } finally {
    feed.stop();
    rmSync(d, { recursive: true, force: true });
  }
});
