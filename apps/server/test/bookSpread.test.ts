/**
 * The bots' market data from SoDEX's sampled book (owner 2026-11-09: KORU read 0 bp and "quotes 100% of the time"
 * from the prints while its book was ~29 bp wide).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SAMPLES, addSamples, clearSamples, shareUnder, spreadsOf, typicalBps } from '../src/flow/bookSpread.js';

test('a bookTickers answer becomes each market\'s spread in bp; bad rows are left out', () => {
  const m = spreadsOf([{ symbol: 'KORU-USD', bidPx: '7.56', askPx: '7.57' }, { symbol: 'X-USD', bidPx: '0', askPx: '1' }, { symbol: 'Y-USD', bidPx: '2', askPx: '1' }]);
  assert.equal(m.size, 1);
  assert.ok(Math.abs(m.get('KORU-USD')! - 13.22) < 0.01);
  assert.equal(spreadsOf({ data: [{ symbol: 'a-usd', bidPx: '99', askPx: '101' }] }).get('A-USD'), 200);
});

test('the typical spread and the share of time under a limit, only with enough samples', () => {
  clearSamples();
  const t0 = 1_000_000;
  addSamples(new Map([['KORU-USD', 29]]), t0);
  assert.equal(typicalBps('KORU-USD', 0), null, 'too few samples: the prints stand');
  for (let i = 1; i < MIN_SAMPLES; i++) addSamples(new Map([['KORU-USD', i % 4 === 0 ? 12 : 29]]), t0 + i * 30_000);
  assert.equal(typicalBps('KORU-USD', 0), 29);
  const share = shareUnder('KORU-USD', 20, 0)!;
  assert.equal(share, 0.2, 'under 20 bp in 4 of 20 samples');
  assert.equal(shareUnder('KORU-USD', 50, 0), 1);
  clearSamples();
});
