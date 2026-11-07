/**
 * The server's copy cards in the browser (copyCards.ts): one request for a page of cards, each answer
 * checked, kept for the page view with its age moving on, null for anything that is not a clean answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS_PER_REQUEST, parseCard, serverCards } from './copyCards';

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

test('a page of cards asking together is one request per window; each gets its own card, a missing one null', async () => {
  const card = { age: 1_000, fresh: true, spark: [0, 2, 1], lastActive: 5 };
  const t = deps(() => ({ ok: true, w: '30d', cards: { [`hyperliquid:${addr(1)}`]: card, [`sodex:${addr(2)}`]: { age: 9, fresh: false, none: true } } }));
  const get = serverCards(t.d);
  const asks = [get('hyperliquid', addr(1), '30d'), get('sodex', addr(2).toUpperCase().replace('0X', '0x'), '30d'), get('arcus', addr(3), '30d')];
  t.release();
  assert.deepEqual(await Promise.all(asks), [card, { age: 9, fresh: false, none: true }, null]);
  assert.deepEqual(t.paths, [`/api/vs/copy/cards?w=30d&keys=hyperliquid:${addr(1)},sodex:${addr(2)},arcus:${addr(3)}`]);
  // Kept for the page view, its age moved on.
  t.advance(4_000);
  assert.deepEqual(await get('hyperliquid', addr(1), '30d'), { ...card, age: 5_000 });
  assert.equal(t.paths.length, 1);
});

test('a window the server does not read asks nothing; more cards than a request takes are split', async () => {
  const t = deps(() => ({ ok: true, cards: {} }));
  const get = serverCards(t.d);
  assert.equal(await get('sodex', addr(1), '90d'), null);
  const asks = Array.from({ length: CARDS_PER_REQUEST + 2 }, (_, i) => get('sodex', addr(i + 1), '7d'));
  t.release();
  await Promise.all(asks);
  assert.equal(t.paths.length, 2);
});

test('a failure, an error answer or a malformed card: null (the venue\'s own read)', async () => {
  for (const answer of [new Error('offline'), null, { ok: false }, { ok: true, cards: { [`sodex:${addr(1)}`]: { age: 1, fresh: true, spark: ['x'], lastActive: 1 } } }]) {
    const t = deps(() => answer);
    const p = serverCards(t.d)('sodex', addr(1), '30d');
    t.release();
    assert.equal(await p, null);
  }
  assert.equal(parseCard({ age: -1, fresh: true, none: true }), null);
  assert.equal(parseCard({ age: 1, fresh: 'yes', none: true }), null);
  assert.deepEqual(parseCard({ age: 1, fresh: true, spark: null, lastActive: null }), { age: 1, fresh: true, spark: null, lastActive: null });
});
