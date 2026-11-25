/** The credit calendar's figures: credits per day and tier, and what was spent, from the wallet's credit history. Pure. */
import type { InviteMe } from '@sign/invites/claim';

export const ROWS = ['All', 'T1', 'T2', 'T3', 'Spent'] as const;
export type RowKey = (typeof ROWS)[number];
/** The server sends this many entries at most: a full page may not reach back to the first day it names. */
export const HISTORY_CAP = 300;

export interface CalCell { usd: number; /** 0 nothing, 1 low, 2 medium, 3 high, 4 best of its row. */ level: 0 | 1 | 2 | 3 | 4; /** Before what is known. */ out: boolean }
export interface CalDay { at: number; date: Date; cells: Record<RowKey, CalCell> }

/** Local midnight of the day `back` days before `now` (calendar days, so a clock change never shifts one). */
export function dayBack(now: number, back: number): Date {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}
const keyOf = (d: Date): number => d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate();

/** How far the calendar may page back: the days from the oldest known entry to today. */
export function knownDays(history: InviteMe['history'], now: number): number {
  if (!history.length) return 0;
  const oldest = Math.min(...history.map((h) => h.at));
  let n = 0;
  while (n < 3_650 && dayBack(now, n).getTime() > oldest) n += 1;
  // A full page cuts its oldest day somewhere in the middle: that day is not shown as if it were whole.
  return history.length >= HISTORY_CAP ? n : n + 1;
}

/** `cols` days ending `offset` days ago, oldest first. Levels are within each row, over the days shown. */
export function calendarDays(history: InviteMe['history'], now: number, cols: number, offset = 0): CalDay[] {
  const sums = new Map<number, Record<RowKey, number>>();
  for (const h of history) {
    if (h.kind === 'grant') continue;
    const k = keyOf(new Date(h.at));
    let s = sums.get(k);
    if (!s) { s = { All: 0, T1: 0, T2: 0, T3: 0, Spent: 0 }; sums.set(k, s); }
    if (h.kind === 'spend') s.Spent += h.usd;
    else {
      s.All += h.usd;
      s[h.tier === 3 ? 'T3' : h.tier === 2 ? 'T2' : 'T1'] += h.usd;
    }
  }
  const known = knownDays(history, now);
  const days = Array.from({ length: cols }, (_, i) => {
    const back = offset + cols - 1 - i;
    const date = dayBack(now, back);
    return { back, date, s: sums.get(keyOf(date)) };
  });
  const max = Object.fromEntries(ROWS.map((r) => [r, Math.max(0, ...days.map((d) => d.s?.[r] ?? 0))])) as Record<RowKey, number>;
  return days.map(({ back, date, s }) => ({
    at: date.getTime(),
    date,
    cells: Object.fromEntries(ROWS.map((r) => {
      const usd = s?.[r] ?? 0;
      const level = usd <= 0 ? 0 : usd >= max[r] ? 4 : usd >= max[r] * 0.6 ? 3 : usd >= max[r] * 0.25 ? 2 : 1;
      return [r, { usd, level, out: back >= known } as CalCell];
    })) as Record<RowKey, CalCell>,
  }));
}
