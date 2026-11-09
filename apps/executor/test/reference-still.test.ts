/**
 * A still Binance market (owner 2026-11-09, MCD outside US hours): Binance pushes no book tick while nothing
 * changes, and the bot held "waiting for the Binance price" for as long as the market stayed still. The reference
 * confirms such a market by one REST read of the book; no answer leaves it stale (a dead feed never quotes).
 * Run (from apps/executor): npx tsx --test test/reference-still.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceReference, CONFIRM_AFTER_MS, CONFIRM_MAX } from '../src/feed/reference.ts';
import { REF_MAX_AGE_MS } from '../../../packages/copy-engine/src/algo/reference.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = () => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(answer: (sym: string) => unknown | Error) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    const sym = new URL(url).searchParams.get('symbol')!;
    asked.push(sym);
    const a = answer(sym);
    if (a instanceof Error) throw a;
    return { ok: true, json: async () => a };
  };
  const ref = new BinanceReference({ path: 'Z:/no/such/ring', factory: noWs as never, log: silent, autoPoll: false, fetch });
  return { ref, asked };
}

test('a still market is confirmed by REST and counts as fresh; a quiet one is read again later', async () => {
  const { ref, asked } = make(() => ({ symbol: 'MCDUSDT', bidPrice: '277.11', askPrice: '277.27' }));
  ref.watch(['MCD-USD']);
  assert.equal(ref.quote('MCD-USD'), null);
  assert.equal(await ref.confirmStill(), 1);
  assert.deepEqual(asked, ['MCDUSDT']);
  const q = ref.quote('MCD-USD')!;
  assert.equal(q.bid, 277.11);
  assert.equal(q.ask, 277.27);
  assert.ok(Date.now() - q.at < REF_MAX_AGE_MS, 'fresh by the engine\'s rule');
  // Just confirmed: nothing to read now; once it is still again, read again.
  assert.equal(await ref.confirmStill(), 0);
  assert.equal(await ref.confirmStill(Date.now() + CONFIRM_AFTER_MS + 10), 1);
  ref.stop();
});

test('no answer, a bad book or a crossed one: nothing is refreshed, the market stays stale', async () => {
  for (const a of [new Error('blocked'), { bidPrice: '0', askPrice: '1' }, { bidPrice: '10', askPrice: '9' }, null]) {
    const { ref } = make(() => a);
    ref.watch(['MCD-USD']);
    assert.equal(await ref.confirmStill(), 0);
    assert.equal(ref.quote('MCD-USD'), null);
    ref.stop();
  }
});

test('at most CONFIRM_MAX markets a round, the stillest first', async () => {
  const { ref, asked } = make((s) => ({ symbol: s, bidPrice: '1', askPrice: '1.01' }));
  const markets = Array.from({ length: CONFIRM_MAX + 3 }, (_, i) => `M${i}-USD`);
  ref.watch(markets);
  assert.equal(await ref.confirmStill(), CONFIRM_MAX);
  assert.equal(asked.length, CONFIRM_MAX);
  ref.stop();
});

test('a still market is marked still (the same book confirmed again), a moved one is not: a still market is no stale feed', async () => {
  let book = { bidPrice: '277.11', askPrice: '277.27' };
  const { ref } = make(() => book);
  ref.watch(['MCD-USD']);
  await ref.confirmStill();
  assert.equal(ref.quote('MCD-USD')!.still, false, 'the first read has nothing to compare with');
  await ref.confirmStill(Date.now() + CONFIRM_AFTER_MS + 10);
  const q = ref.quote('MCD-USD')!;
  assert.equal(q.still, true);
  assert.ok(q.stillSince! <= q.at);
  book = { bidPrice: '277.20', askPrice: '277.30' };
  await ref.confirmStill(Date.now() + 2 * (CONFIRM_AFTER_MS + 10));
  assert.equal(ref.quote('MCD-USD')!.still, false, 'the book moved');
  ref.stop();
});

test('Katana\'s rule: while the market\'s socket is connected, a market with no tick keeps its price as a still market; a tick after it always counts; a dropped socket lets it age', async () => {
  const opened: Array<{ onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null; onclose: (() => void) | null; readyState: number; send(): void; close(): void }> = [];
  const factory = () => {
    const ws = { readyState: 1, onopen: null as (() => void) | null, onmessage: null as ((e: { data: string }) => void) | null, onclose: null as (() => void) | null, onerror: null, send() {}, close() {} };
    opened.push(ws as never);
    return ws as never;
  };
  const ref = new BinanceReference({ path: 'Z:/no/such/ring', factory, log: silent, autoPoll: false });
  ref.watch(['HYPE-USD']); // not in any ring: its own socket
  assert.ok(opened.length >= 1);
  for (const ws of opened) ws.onopen?.();
  const tick = (bid: number, ask: number, u: number) => { for (const ws of opened) ws.onmessage?.({ data: JSON.stringify({ data: { s: 'HYPEUSDT', b: String(bid), a: String(ask), B: '1', A: '1', E: Date.now(), u } }) }); };
  tick(40.1, 40.11, 1);
  const first = ref.quote('HYPE-USD')!;
  assert.equal(first.bid, 40.1);
  // Quiet for longer than the still threshold: the check keeps it as a still market, fresh.
  await new Promise((r) => setTimeout(r, 450));
  ref.check();
  const still = ref.quote('HYPE-USD')!;
  assert.equal(still.still, true);
  assert.ok(Date.now() - still.at < 100, 'confirmed now');
  assert.equal(still.bid, 40.1);
  // A real move right after: counted, even though its receipt time is a moment older than the confirmation.
  tick(40.2, 40.21, 2);
  assert.equal(ref.quote('HYPE-USD')!.bid, 40.2);
  assert.ok(!ref.quote('HYPE-USD')!.still);
  // The socket drops: nothing keeps it fresh any more.
  for (const ws of opened) ws.onclose?.();
  await new Promise((r) => setTimeout(r, 450));
  ref.check();
  assert.ok(Date.now() - ref.quote('HYPE-USD')!.at >= 400, 'it ages: a dropped feed is not a still market');
  ref.stop();
});
