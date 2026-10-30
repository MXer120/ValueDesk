/**
 * The order ticket's price seed after a market switch (priceSeed.ts): the book's
 * price fills the box unless the user set one while it was on its way.
 *   npx tsx --test src/priceSeed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSeeder } from './priceSeed';

test('nothing typed since the switch: the book seeds the price', () => {
  const s = priceSeeder();
  s.start();
  assert.equal(s.settle(), true);
});

test('a price typed before the switch does not stop the new market being seeded', () => {
  const s = priceSeeder();
  s.typed();
  s.start();
  assert.equal(s.settle(), true);
});

test('a price typed after the switch, before the book answered, is kept', () => {
  const s = priceSeeder();
  s.start();
  s.typed();
  assert.equal(s.settle(), false);
});

test('Futures -> Spot is one switch: engine, then the fallback market; a price typed between is kept', () => {
  const s = priceSeeder();
  s.start(); // the engine changed (its book read is cancelled by the next change)
  s.typed();
  s.start(); // the market fell back to the engine's default
  assert.equal(s.settle(), false);
  // The next switch starts afresh.
  s.start();
  assert.equal(s.settle(), true);
});

test('settle without a switch seeds nothing', () => {
  assert.equal(priceSeeder().settle(), false);
});
