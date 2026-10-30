/**
 * The algo ticket's field errors in the units the fields show (errorWords.ts), checked
 * against what the engine's parser really says for out-of-range drafts.
 *   npx tsx --test src/components/algo/errorWords.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec } from '@copy-engine';
import { errorInWords, errorsInWords, limitDuration } from './errorWords';
import { setNumStyle } from '../../numStyle';

const base = { symbol: 'BTC-USD', side: 'buy', quantity: '0.01', paper: true };

test('durations: the largest whole unit', () => {
  assert.equal(limitDuration(60_000), '1 min');
  assert.equal(limitDuration(900_000), '15 min');
  assert.equal(limitDuration(3_600_000), '1 h');
  assert.equal(limitDuration(604_800_000), '7 d');
  assert.equal(limitDuration(2_592_000_000), '30 d');
  assert.equal(limitDuration(5_000), '5 s');
  assert.equal(limitDuration(0), '0 s');
});

test('a TWAP of half a minute: the limit in minutes and days, not milliseconds', () => {
  setNumStyle('dot-comma');
  const { errors } = checkAlgoSpec({ ...base, kind: 'twap', durationMs: 30_000 });
  assert.equal(errors.durationMs, 'Duration must be between 60000 and 2592000000.', 'what the engine says');
  assert.equal(errorsInWords(errors).durationMs, 'Duration must be between 1 min and 30 d.');
});

test('fractions are percent, in the app number format', () => {
  setNumStyle('dot-comma');
  const pov = checkAlgoSpec({ ...base, kind: 'pov', rate: 0.9 }).errors;
  assert.equal(errorsInWords(pov).rate, 'Participation must be between 1 % and 50 %.');
  const trail = checkAlgoSpec({ ...base, kind: 'trailing', reduceOnly: true, trailPct: 0.9 }).errors;
  assert.equal(errorsInWords(trail).trailPct, 'Trail must be between 0,1 % and 50 %.');
  assert.equal(errorInWords('exits.tpPct', 'Take-profit distance must be between 0.001 and 10.'), 'Take-profit distance must be between 0,1 % and 1.000 %.');
  assert.equal(errorInWords('conditions.0.pct', 'Move must be between 0.0001 and 10.'), 'Move must be between 0,01 % and 1.000 %.');
  setNumStyle('comma-dot');
  assert.equal(errorInWords('rate', 'Participation must be between 0.01 and 0.5.'), 'Participation must be between 1 % and 50 %.');
  assert.equal(errorInWords('trailPct', 'Trail must be between 0.001 and 0.5.'), 'Trail must be between 0.1 % and 50 %.');
  setNumStyle('dot-comma');
});

test('nested time fields and basis points', () => {
  setNumStyle('dot-comma');
  assert.equal(errorInWords('conditions.0.windowMs', 'Window must be between 5000 and 3600000.'), 'Window must be between 5 s and 1 h.');
  assert.equal(errorInWords('exec.slippageBps', 'Max slippage must be between 1 and 500.'), 'Max slippage must be between 1 and 500 bp.');
  assert.equal(errorInWords('slices', 'Slices must be between 1 and 2000.'), 'Slices must be between 1 and 2.000.');
});

test('every other message passes as it is', () => {
  for (const m of ['Duration must be a number.', 'Size must be a positive amount.', 'Set the trail as a percentage or as a price distance (one of the two).']) {
    assert.equal(errorInWords('durationMs', m), m);
  }
});
