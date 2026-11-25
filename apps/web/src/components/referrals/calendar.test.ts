import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InviteEntry } from '@sign/invites/claim';
import { HISTORY_CAP, calendarDays, dayBack, knownDays } from './calendar';

const now = new Date(2026, 10, 25, 15).getTime();
const at = (back: number) => dayBack(now, back).getTime() + 3_600_000;
const earn = (back: number, usd: number, tier: number): InviteEntry => ({ at: at(back), kind: 'earn', usd, tier, from: null });

test('credits add up per day and tier; spending is its own row; a grant is neither', () => {
  const h: InviteEntry[] = [earn(0, 1, 1), earn(0, 0.5, 2), earn(1, 4, 1), { at: at(1), kind: 'spend', usd: 2, tier: null, from: null }, { at: at(1), kind: 'grant', usd: 9, tier: null, from: null }];
  const d = calendarDays(h, now, 3);
  assert.deepEqual(d.map((x) => x.cells.All.usd), [0, 4, 1.5]);
  assert.deepEqual(d.map((x) => x.cells.T2.usd), [0, 0, 0.5]);
  assert.deepEqual(d.map((x) => x.cells.Spent.usd), [0, 2, 0]);
  assert.deepEqual(d.map((x) => x.cells.All.level), [0, 4, 2]);
  assert.equal(d[2]!.date.getDate(), 25);
});

test('days before the oldest entry are out; a full page does not count its cut-off oldest day', () => {
  const h = [earn(0, 1, 1), earn(2, 1, 1)];
  assert.equal(knownDays(h, now), 3);
  assert.deepEqual(calendarDays(h, now, 5).map((x) => x.cells.All.out), [true, true, false, false, false]);
  const full = [...Array.from({ length: HISTORY_CAP - 1 }, () => earn(0, 0.01, 1)), earn(2, 1, 1)];
  assert.equal(knownDays(full, now), 2);
  assert.equal(knownDays([], now), 0);
});
