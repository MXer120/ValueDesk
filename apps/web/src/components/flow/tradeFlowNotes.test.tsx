/**
 * What Who traded says above its table: nothing while a candle only waits for its check, one short line per venue for a known
 * shortfall with its details kept for a hover or a tap. The browser's side of it is e2e/ui/flowCoverage.spec.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from '../macro/testEnv';
import { setNumStyle } from '../../numStyle';

setNumStyle('comma-dot');
installViteStubs();
const { createElement } = await import('react');
const render = await staticMarkup();
const { Partial } = await import('./TradeFlow');

const FROM = Date.UTC(2026, 10, 6, 10);
const TO = FROM + 300_000;
const win = { from: FROM, to: TO };
const base = { from: FROM, to: TO, since: FROM - 86_400_000, gaps: [], down: [], coverage: null, checks: [] };
const check = (o: object) => ({ venue: 'arcus', unit: 'prints', from: FROM, to: TO, held: 0, expected: 0, holes: [], holeSlots: 0, overSlots: 0, unchecked: [], ...o });
const html = (d: object) => render(createElement(Partial, { d: d as never, win: win as never }));

test('a candle only waiting for its check says nothing, on any venue', () => {
  assert.equal(html({ ...base, coverage: check({ venue: 'sodex', unchecked: [[FROM, TO]] }), checks: [check({ unchecked: [[FROM, TO]] }), check({ venue: 'hyperliquid', pending: true, unchecked: [[FROM, TO]] })] }), '');
});

test('a whole candle says nothing', () => {
  assert.equal(html({ ...base, checks: [check({ held: 329, expected: 329 })] }), '');
});

test('a shortfall is one short line per venue, the details not on the page until asked for', () => {
  const out = html({
    ...base,
    checks: [
      check({ held: 314, expected: 329, holeSlots: 1, holes: [{ from: FROM, to: TO, held: 314, venue: 329 }] }),
      check({ venue: 'hyperliquid', held: 900, expected: 1000, holeSlots: 1, holes: [{ from: FROM, to: TO, held: 900, venue: 1000 }] }),
      check({ venue: 'lighter', unchecked: [[FROM, TO]] }),
    ],
  });
  assert.match(out, /Arcus: held 314 of 329 trades/);
  assert.match(out, /Hyperliquid: held 900 of 1,000 trades/);
  assert.equal(out.match(/class="tfl-note"/g)?.length, 2);
  assert.doesNotMatch(out, /counted/);
  assert.doesNotMatch(out, /Lighter/);
  assert.match(out, /tfl-holes/);
  assert.doesNotMatch(out, /border-left/);
});

test('no strip without a known hole, and the recorder being down stays a line', () => {
  const out = html({ ...base, down: [[FROM, FROM + 120_000]] });
  assert.match(out, /2 min not recorded/);
  assert.doesNotMatch(out, /tfl-holes/);
});
