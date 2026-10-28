/**
 * Limit notices in the bell (limitNotices.ts): a hold or a cut by SoDEX's
 * position limit or open-interest cap, from this browser's runner or an
 * executor's list, goes in the bell once - with how much can still be added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlgoLimitNotice, AlgoView } from '@copy-engine';
import { notices } from '../notices';
import { noteLimitNotices, resetLimitNotices } from './limitNotices';

const view = (id: string, n: AlgoLimitNotice | null): AlgoView => ({ algo: { id, k: n ? { limitNotice: n } : {} } } as unknown as AlgoView);

test('a limit notice goes in the bell once, with its words and where the algo runs', () => {
  resetLimitNotices();
  const now = Date.now();
  const held: AlgoLimitNotice = { id: 'n1', at: now, kind: 'oi', what: 'held', title: 'TWAP on ETH-USD is held', text: "Open interest on ETH-USD is at 77% of SoDEX's cap: about $2.3M (612 ETH) can still be added market-wide." };
  assert.equal(noteLimitNotices([view('a1', held), view('a2', null)], 'on the ValueDesk executor', now), 1);
  const row = notices().find((x) => x.id === 'algo-limit:n1')!;
  assert.equal(row.title, 'TWAP on ETH-USD is held');
  assert.equal(row.body, `${held.text} (on the ValueDesk executor)`);
  assert.equal(row.important, true);
  assert.equal(row.kind, 'error');
  // Read again (the next poll, another tab's views): not told twice.
  assert.equal(noteLimitNotices([view('a1', held)], 'on the ValueDesk executor', now + 30_000), 0);
  // A new one (a cut) is.
  const cut: AlgoLimitNotice = { ...held, id: 'n2', what: 'cut', title: 'TWAP on ETH-USD: an order was cut', text: 'Slice 3/10 was cut from 1 to 0.4 ETH.' };
  assert.equal(noteLimitNotices([view('a1', cut)], undefined, now), 1);
  assert.equal(notices().find((x) => x.id === 'algo-limit:n2')!.kind, 'info');
});
