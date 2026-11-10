import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_MIN_FILLS, TakerTally, clearTakerClasses, setTakerClasses, takerClasses } from '../src/flow/takerClass.js';
import { adoptClassed, type MinuteSeries } from '../src/flow/botMarkets.js';

test('an account the makers lose on beyond 2 s.e. is informed, one they gain on is uninformed, the rest stay unidentified', () => {
  const t = new TakerTally();
  // 7: makers lose ~1.8 bp per fill with noise (the new-id accounts against 23342); 8: makers gain ~1 bp; 9: no sign; 10: too few fills.
  let seed = 1;
  const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 4; };
  for (let i = 0; i < 400; i++) t.add(7, 200, -1.8 + noise());
  for (let i = 0; i < 400; i++) t.add(8, 200, 1 + noise());
  for (let i = 0; i < 400; i++) t.add(9, 200, noise() * 0.1);
  for (let i = 0; i < CLASS_MIN_FILLS - 1; i++) t.add(10, 200, -30);
  const c = t.classify();
  assert.deepEqual([...c.inf], [7]);
  assert.deepEqual([...c.uni], [8]);
  assert.ok(!c.inf.has(9) && !c.uni.has(9), 'no clear sign: unidentified');
  assert.ok(!c.inf.has(10), 'too few fills: unidentified');
});

test('one bad tick does not class an account (markouts are clipped)', () => {
  const t = new TakerTally();
  for (let i = 0; i < 100; i++) t.add(5, 100, i % 2 ? 0.5 : -0.5);
  t.add(5, 100, -100_000);
  assert.equal(t.classify().inf.size, 0);
});

test('classes carry SoDEX account ids for the tape', () => {
  clearTakerClasses();
  const c = setTakerClasses({ inf: new Set([3]), uni: new Set([4, 6]) }, (id) => (id === 6 ? null : `acct${id}`), 1, false);
  assert.deepEqual([...c.infKeys], ['acct3']);
  assert.deepEqual([...c.uniKeys], ['acct4']);
  assert.equal(takerClasses().uni.size, 2);
  clearTakerClasses();
});

test('the kept board takes the classed minutes of each compute, never more than its unidentified volume', () => {
  const mk = (m0: number, n: number, inf: number, uni: number): MinuteSeries => ({ m0, tot: new Float32Array(n).fill(100), u: new Float32Array(n).fill(30), f: new Float32Array(n).fill(20), inf: new Float32Array(n).fill(inf), uni: new Float32Array(n).fill(uni), vol: new Float32Array(n), held: new Uint8Array(n).fill(1) });
  const kept = mk(100, 10, 0, 0);
  const fresh = mk(102, 10, 30, 40);
  fresh.held[0] = 0;
  adoptClassed(kept, fresh);
  assert.equal(kept.inf[1], 0, 'before the compute\'s window: kept');
  assert.equal(kept.inf[2], 0, 'not held in the compute: kept');
  assert.equal(kept.inf[3], 30);
  assert.equal(kept.uni[3], 20, 'capped at what is left unidentified (100 - 30 - 20 - 30)');
});
