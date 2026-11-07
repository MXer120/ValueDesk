/**
 * The copy cards' last-trade hint (lastTradeHints.ts): one request for a page of cards, kept a minute,
 * null for anything that is not a clean answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HINTS_PER_REQUEST, lastTradeHints } from './lastTradeHints';

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

function deps(answer: (path: string) => unknown) {
  const paths: string[] = [];
  let now = 1_000_000;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return {
    paths,
    advance: (ms: number) => { now += ms; },
    release: () => release(),
    d: {
      getJson: async (p: string) => { paths.push(p); const a = answer(p); if (a instanceof Error) throw a; return a; },
      now: () => now,
      wait: () => gate,
    },
  };
}

test('a page of cards asking together is one request; each gets its own time, unknown ones null', async () => {
  const t = deps(() => ({ ok: true, at: { [addr(1)]: 111, [addr(2)]: 222 } }));
  const hint = lastTradeHints(t.d);
  const asks = [hint(addr(1)), hint(addr(2).toUpperCase().replace('0X', '0x')), hint(addr(3)), hint(addr(1))];
  t.release();
  assert.deepEqual(await Promise.all(asks), [111, 222, null, 111]);
  assert.equal(t.paths.length, 1);
  assert.equal(t.paths[0], `/api/vs/last-trades?venue=hyperliquid&addresses=${addr(1)},${addr(2)},${addr(3)}`);
  // Kept a minute: no second request.
  assert.equal(await hint(addr(2)), 222);
  assert.equal(t.paths.length, 1);
});

test('more cards than one request takes: split at the route\'s cap', async () => {
  const t = deps(() => ({ ok: true, at: {} }));
  const hint = lastTradeHints(t.d);
  const asks = Array.from({ length: HINTS_PER_REQUEST + 3 }, (_, i) => hint(addr(i + 1)));
  t.release();
  await Promise.all(asks);
  assert.equal(t.paths.length, 2);
});

test('a failure, an error answer or a malformed one: no hint (the card searches as before)', async () => {
  for (const answer of [new Error('offline'), null, { ok: false }, { ok: true, at: { [addr(1)]: 'soon' } }]) {
    const t = deps(() => answer);
    const p = lastTradeHints(t.d)(addr(1));
    t.release();
    assert.equal(await p, null);
  }
});
