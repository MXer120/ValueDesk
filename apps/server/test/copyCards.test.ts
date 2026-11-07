/**
 * The Copy page's card cache (valuedesk/copyCards.ts): who is read first, what a request gets back
 * (only held cards, each with its age), the file between starts, and the curve itself (cardPeek.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyCards, REFRESH_MS, type CardWindow, type Leader } from '../src/valuedesk/copyCards.js';
import { cardShown } from '../src/valuedesk/cardPeek.js';
import type { Venue } from '../src/valuedesk/types.js';

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const tick = () => new Promise((r) => setImmediate(r));

function harness(leaders: Leader[], o: { file?: string | null; follower?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const reads: string[] = [];
  const cards = new CopyCards({
    now: () => now,
    leaders: () => leaders,
    read: async (venue: Venue, address: string, windows: readonly CardWindow[]) => {
      reads.push(`${venue}:${address}`);
      return { cards: Object.fromEntries(windows.map((w) => [w, address === addr(99) ? null : { spark: [0, 1, 2], lastActive: 7 }])), cost: 0 };
    },
    file: o.file ?? null,
    follower: o.follower,
    sleep: () => tick() as Promise<void>,
  });
  return { cards, reads, advance: (ms: number) => { now += ms; } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

test('the default view first (30D top), then worst, 7D, All; a card on screen ahead of them all', async () => {
  const leaders: Leader[] = [
    { venue: 'hyperliquid', address: addr(1), window: 'all', side: 'top', i: 0 },
    { venue: 'hyperliquid', address: addr(2), window: '7d', side: 'top', i: 0 },
    { venue: 'hyperliquid', address: addr(3), window: '30d', side: 'worst', i: 0 },
    { venue: 'hyperliquid', address: addr(4), window: '30d', side: 'top', i: 5 },
    { venue: 'hyperliquid', address: addr(5), window: 'all', side: 'worst', i: 50 },
  ];
  const h = harness(leaders);
  h.cards.replan();
  // On screen before the lane starts: it goes first.
  h.cards.answer('all', [{ venue: 'hyperliquid', address: addr(5) }]);
  h.cards.lanes.hl.start();
  await settle();
  h.cards.stop();
  assert.deepEqual(h.reads, [5, 4, 3, 2, 1].map((i) => `hyperliquid:${addr(i)}`));
});

test('a request gets only held cards, with their age and whether that is within the venue\'s interval; none for no account', async () => {
  const leaders: Leader[] = [
    { venue: 'sodex', address: addr(1), window: '30d', side: 'top', i: 0 },
    { venue: 'sodex', address: addr(99), window: '30d', side: 'top', i: 1 },
  ];
  const h = harness(leaders);
  assert.deepEqual(h.cards.answer('30d', [{ venue: 'sodex', address: addr(1) }]), {}, 'nothing held yet');
  h.cards.replan();
  h.cards.lanes.sodex.start();
  await settle();
  h.advance(60_000);
  const a = h.cards.answer('30d', [{ venue: 'sodex', address: addr(1) }, { venue: 'sodex', address: addr(99) }, { venue: 'sodex', address: addr(2) }]);
  assert.deepEqual(a[`sodex:${addr(1)}`], { age: 60_000, fresh: true, spark: [0, 1, 2], lastActive: 7 });
  assert.deepEqual(a[`sodex:${addr(99)}`], { age: 60_000, fresh: true, none: true });
  assert.equal(a[`sodex:${addr(2)}`], undefined, 'not a leader, not read');
  assert.deepEqual(h.cards.answer('7d', [{ venue: 'sodex', address: addr(1) }]), {}, 'a window it was not read for');
  // Past its interval it is still answered, as not fresh, and read again.
  h.advance(REFRESH_MS.sodex[0]);
  const reads = h.reads.length;
  assert.equal(h.cards.answer('30d', [{ venue: 'sodex', address: addr(1) }])[`sodex:${addr(1)}`]?.fresh, false);
  h.cards.replan();
  await settle();
  h.cards.stop();
  assert.ok(h.reads.length > reads);
});

test('kept in a file between starts; a follower only reads it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cards-'));
  try {
    const file = join(dir, 'copy-cards.json');
    const leaders: Leader[] = [{ venue: 'arcus', address: addr(1), window: '7d', side: 'top', i: 0 }];
    const a = harness(leaders, { file });
    a.cards.replan();
    a.cards.lanes.arcus.start();
    await settle();
    a.cards.stop(); // saves
    const b = harness([], { file, follower: true });
    b.cards.start();
    b.cards.stop();
    assert.equal(b.cards.answer('7d', [{ venue: 'arcus', address: addr(1) }])[`arcus:${addr(1)}`] !== undefined, true);
    assert.deepEqual(b.reads, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the card is the window\'s PnL points, the 30-day curve when the window has none, the spark when neither', () => {
  const pt = (pnl: number | null) => ({ t: 1, accountValue: null, pnl });
  const p = { equity: { '7d': [pt(1), pt(null), pt(3)], '30d': [pt(5), pt(6)] }, summary: { lastActive: 9, spark: [1, 2] } };
  assert.deepEqual(cardShown(p, '7d'), { spark: [1, 3], lastActive: 9 });
  assert.deepEqual(cardShown(p, 'all'), { spark: [5, 6], lastActive: 9 });
  assert.deepEqual(cardShown({ equity: { '7d': [pt(1)] }, summary: { spark: [4, 5] } }, '7d'), { spark: [4, 5], lastActive: null });
  assert.deepEqual(cardShown({ equity: {}, summary: {} }, '90d'), { spark: null, lastActive: null });
});
