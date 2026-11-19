import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_MAX_MS, keepHeat, keptHeat, type KeptHeat } from './liveHeat';

const heat = (coin: string, at: number) => ({ coin, venues: ['sodex'], at, price: 100, step: 0.02, buckets: [[5000, 10, 20]] }) as unknown as KeptHeat['heat'];

test('a kept live snapshot is given back only while younger than the route cache window', () => {
  keepHeat('BTC|sodex|5', { heat: heat('BTC', 1_000), k: 5, fineMeta: null, keptAt: 50_000 });
  assert.equal(keptHeat('BTC|sodex|5', 50_000 + KEPT_MAX_MS)?.heat.at, 1_000);
  assert.equal(keptHeat('BTC|sodex|5', 50_000 + KEPT_MAX_MS + 1), null);
  // Dropped once too old.
  assert.equal(keptHeat('BTC|sodex|5', 50_000), null);
  assert.equal(keptHeat('ETH|sodex|5', 50_000), null);
});

test('the kept store holds the 16 newest subscriptions', () => {
  for (let i = 0; i < 20; i++) keepHeat(`C${i}|sodex|5`, { heat: heat(`C${i}`, i), k: 5, fineMeta: null, keptAt: 1_000 });
  assert.equal(keptHeat('C3|sodex|5', 1_000), null);
  assert.equal(keptHeat('C4|sodex|5', 1_000)?.heat.coin, 'C4');
  assert.equal(keptHeat('C19|sodex|5', 1_000)?.heat.coin, 'C19');
});
