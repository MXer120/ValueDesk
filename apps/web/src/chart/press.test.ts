/**
 * A press starts the read its click will make (press.ts): at once with a mouse; on touch once the
 * finger stayed put, or at a quicker release - never for a press that became a scroll.
 *   npx tsx --test src/chart/press.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onPress, pressMarket, setMarketPrefetch } from './press';

/** Enough of an element for the listeners onPress adds. */
function target() {
  const ls = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, f: (e: unknown) => void) => (ls.get(t) ?? ls.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: (e: unknown) => void) => ls.get(t)?.delete(f),
    emit: (t: string, e: unknown = {}) => [...(ls.get(t) ?? [])].forEach((f) => f(e)),
    count: () => [...ls.values()].reduce((n, s) => n + s.size, 0),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('press: a mouse fires at once', () => {
  let n = 0;
  onPress({ pointerType: 'mouse', clientX: 0, clientY: 0, currentTarget: null }, () => n++);
  assert.equal(n, 1);
});

test('press: a touch fires once it stayed put, and its listeners go', async () => {
  const el = target();
  let n = 0;
  onPress({ pointerType: 'touch', clientX: 10, clientY: 10, currentTarget: el as unknown as EventTarget }, () => n++, 5);
  el.emit('pointermove', { clientX: 13, clientY: 12 });
  assert.equal(n, 0);
  await sleep(15);
  assert.equal(n, 1);
  el.emit('pointerup');
  assert.equal(n, 1, 'once');
  assert.equal(el.count(), 0);
});

test('press: a quick tap fires at its release; a scroll or a cancel never fires', async () => {
  const tap = target();
  let taps = 0;
  onPress({ pointerType: 'touch', clientX: 0, clientY: 0, currentTarget: tap as unknown as EventTarget }, () => taps++, 50);
  tap.emit('pointerup');
  assert.equal(taps, 1);

  const scroll = target();
  let scrolls = 0;
  onPress({ pointerType: 'touch', clientX: 0, clientY: 0, currentTarget: scroll as unknown as EventTarget }, () => scrolls++, 5);
  scroll.emit('pointermove', { clientX: 0, clientY: 30 });
  await sleep(15);
  scroll.emit('pointerup');
  assert.equal(scrolls, 0);

  const cancelled = target();
  let c = 0;
  onPress({ pointerType: 'touch', clientX: 0, clientY: 0, currentTarget: cancelled as unknown as EventTarget }, () => c++, 5);
  cancelled.emit('pointercancel');
  await sleep(15);
  assert.equal(c, 0);
  assert.equal(cancelled.count(), 0);
});

test('press: a market press reads only while a trade chart has said what to read', () => {
  const asked: string[] = [];
  const press = { pointerType: 'mouse', clientX: 0, clientY: 0, currentTarget: null };
  pressMarket(press, 'perps', 'ETH-USD');
  const off = setMarketPrefetch((e, s) => asked.push(`${e}:${s}`));
  pressMarket(press, 'perps', 'ETH-USD');
  off();
  pressMarket(press, 'perps', 'SOL-USD');
  assert.deepEqual(asked, ['perps:ETH-USD']);
  // An unregister from a chart that was replaced does not clear the newer one.
  const first = setMarketPrefetch(() => asked.push('first'));
  setMarketPrefetch(() => asked.push('second'));
  first();
  pressMarket(press, 'perps', 'BTC-USD');
  assert.deepEqual(asked, ['perps:ETH-USD', 'second']);
});
