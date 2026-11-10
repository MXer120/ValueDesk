/** The board's own tape (flow/boardTape.ts) and how the board fills from it what the flow does not hold. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardTape } from '../src/flow/boardTape.js';
import { fillFromTape, type MinuteSeries } from '../src/flow/botMarkets.js';
import { clearTakerClasses, setTakerClasses } from '../src/flow/takerClass.js';

const M = 60_000;
const t0 = Date.UTC(2026, 10, 10, 11, 0);
const tr = (t: number, S: 'BUY' | 'SELL', p: number, q: number, bi: number, si: number, id: number) => ({ t: id, T: t, s: 'BTC-USD', S, p: String(p), q: String(q), bi, si });

test('the tape sums each minute by taker (1002, 23342, the rest) and holds only minutes its feed was up for whole', () => {
  const tape = new BoardTape(null);
  tape.markUp(t0 - 10 * M);
  // Account 55 is classed informed (takerClass.ts): its taking counts as informed.
  setTakerClasses({ inf: new Set([1]), uni: new Set() }, () => '55', 1, false);
  tape.add(tr(t0 + 1_000, 'BUY', 100, 2, 1002, 7, 1));      // 1002 takes $200
  tape.add(tr(t0 + 2_000, 'SELL', 100, 1, 9, 23342, 2));    // 23342 takes $100
  tape.add(tr(t0 + 3_000, 'BUY', 101, 1, 55, 7, 3));        // someone else $101
  tape.closeMinute(t0 / M, t0 + M + 1_000);
  const x = tape.minute('BTC-USD', t0 / M)!;
  assert.equal(x.tot, 401); assert.equal(x.u, 200); assert.equal(x.f, 100); assert.equal(x.inf, 101); assert.equal(x.uni, 0);
  clearTakerClasses();
  assert.ok(x.mid > 0);
  // A quiet held minute is zeros, not unknown.
  tape.add(tr(t0 + 2 * M + 1_000, 'BUY', 100, 1, 55, 7, 4)); // keeps the feed "delivering"
  tape.closeMinute(t0 / M + 1, t0 + 2 * M + 1_500);
  assert.deepEqual({ ...tape.minute('BTC-USD', t0 / M + 1)!, mid: 0 }, { tot: 0, u: 0, f: 0, inf: 0, uni: 0, mid: 0 });
  // The feed came up mid-minute: that minute is not held.
  const late = new BoardTape(null);
  late.markUp(t0 + 30_000);
  late.add(tr(t0 + 40_000, 'BUY', 100, 1, 1002, 7, 9));
  late.closeMinute(t0 / M, t0 + M + 1_000);
  assert.equal(late.minute('BTC-USD', t0 / M), null);
});

test('the board takes from the tape only the minutes the flow does not hold', () => {
  const now = t0 + 10 * M;
  const m0 = t0 / M;
  const n = 10;
  const ms: MinuteSeries = { m0, tot: new Float32Array(n).fill(5), u: new Float32Array(n), f: new Float32Array(n), inf: new Float32Array(n), uni: new Float32Array(n), vol: new Float32Array(n), held: new Uint8Array(n).fill(1) };
  for (let i = 6; i < n; i++) ms.held[i] = 0; // the indexer behind for the last 4 minutes
  const tape = { minute: (_s: string, m: number) => (m >= m0 + 5 ? { tot: 1000, u: 400, f: 100, inf: 200, uni: 150, mid: 100 + (m - m0) * 0.01 } : null) };
  const filled = fillFromTape(ms, 'BTC-USD', tape, now);
  assert.equal(filled, 4);
  assert.equal(ms.tot[5], 5, 'a minute the flow holds is the flow\'s');
  for (let i = 6; i < n; i++) { assert.equal(ms.held[i], 1); assert.equal(ms.tot[i], 1000); assert.equal(ms.u[i], 400); assert.equal(ms.inf[i], 200); assert.equal(ms.uni[i], 150); assert.ok(ms.vol[i]! > 0); }
});
