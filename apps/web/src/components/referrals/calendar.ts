/**
 * The Referrals page's figures over time, pure: fee credits by UTC day and tier (the server's whole ledger by day), the
 * credits line, and the calendar's grids - rewards by day, SoPoints by week. UTC throughout: the claim weeks turn on a
 * Tuesday 12:00 UTC, and so do SoDEX's.
 */
import type { CreditDay, InviteMe } from '@sign/invites/claim';
import type { LinePoint, SodexClaim } from '../../invites/sodexRewards';
import type { AnyWeek } from '../sodex/soPointsV2';

export const DAY_MS = 86_400_000;
export const dayOf = (t: number): number => Math.floor(t / DAY_MS);

/** The ledger by day: the server's own, or (a server from before it) what its history lists. */
export function ledgerDays(me: InviteMe | null): CreditDay[] {
  if (!me) return [];
  if (me.days) return me.days;
  return me.history.filter((h) => h.kind !== 'grant').map((h) => ({ day: dayOf(h.at), kind: h.kind as CreditDay['kind'], tier: h.tier, usd: h.usd }));
}

/** Credits earned, added up by day: each day's sum stands from the day it was earned. */
export function creditsLine(me: InviteMe | null, now: number): LinePoint[] {
  const by = new Map<number, number>();
  for (const d of ledgerDays(me)) if (d.kind === 'earn') by.set(d.day, (by.get(d.day) ?? 0) + d.usd);
  const days = [...by].sort((a, b) => a[0] - b[0]);
  if (!me || !days.length) return [];
  // A history that does not reach back to the first credit: the line starts at what was earned before it.
  let sum = Math.max(0, me.credits.earnedUsd - days.reduce((x, [, u]) => x + u, 0));
  const out: LinePoint[] = [];
  for (const [d, usd] of days) { sum += usd; out.push({ t: Math.min(now, d * DAY_MS + DAY_MS / 2), v: sum }); }
  return out;
}

/** A step line's value at `t` (0 before its first point). */
export function valueAt(line: readonly LinePoint[], t: number): number {
  let v = 0;
  for (const p of line) { if (p.t > t) break; v = p.v; }
  return v;
}

/* -------------------------------------------------------------------------------------- grids ----- */

export interface GridCell { v: number; /** 0 nothing, 1 low, 2 medium, 3 high, 4 best of its row. */ level: 0 | 1 | 2 | 3 | 4 }
export interface GridRow { key: string; label: string; name: string; tone: 'credit' | 'usdc' | 'spent' | 'points'; cells: GridCell[] }
export interface GridCol { key: string; label: string; title: string }
export interface Grid { cols: GridCol[]; rows: GridRow[]; /** More columns before these. */ more: boolean; unit: 'usd' | 'points' }

/** Levels within one row, over the columns shown. */
export function levels(vs: readonly number[]): GridCell[] {
  const max = Math.max(0, ...vs);
  return vs.map((v) => ({ v, level: v <= 0 || max <= 0 ? 0 : v >= max ? 4 : v >= max * 0.6 ? 3 : v >= max * 0.25 ? 2 : 1 }));
}
const utc = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });

/** Rewards by day: USDC claimed, credits per tier, credits spent. `cols` days ending `offset` days ago. */
export function rewardsGrid(me: InviteMe | null, claims: readonly SodexClaim[] | null, now: number, cols: number, offset: number): Grid {
  const today = dayOf(now);
  const days = Array.from({ length: cols }, (_, i) => today - offset - (cols - 1 - i));
  const sums = new Map<string, number>();
  const add = (k: string, usd: number) => sums.set(k, (sums.get(k) ?? 0) + usd);
  let oldest = today;
  for (const d of ledgerDays(me)) {
    oldest = Math.min(oldest, d.day);
    if (d.kind === 'earn') add(`${d.tier === 3 ? 'T3' : d.tier === 2 ? 'T2' : 'T1'}|${d.day}`, d.usd);
    else if (d.kind === 'spend') add(`Spent|${d.day}`, d.usd);
  }
  for (const c of claims ?? []) { if (c.usd === null) continue; oldest = Math.min(oldest, dayOf(c.at)); add(`USDC|${dayOf(c.at)}`, c.usd); }
  const row = (key: string, name: string, tone: GridRow['tone']): GridRow => ({ key, label: key, name, tone, cells: levels(days.map((d) => sums.get(`${key}|${d}`) ?? 0)) });
  return {
    unit: 'usd',
    more: oldest < days[0]!,
    cols: days.map((d) => ({ key: String(d), label: utc(d * DAY_MS, { day: 'numeric' }), title: utc(d * DAY_MS, { month: 'short', day: 'numeric', year: 'numeric' }) })),
    rows: [
      ...(claims ? [row('USDC', 'USDC claimed', 'usdc' as const)] : []),
      row('T1', 'Credits, tier 1', 'credit'), row('T2', 'Credits, tier 2', 'credit'), row('T3', 'Credits, tier 3', 'credit'), row('Spent', 'Credits spent on fees', 'spent'),
    ],
  };
}

/** SoPoints by week, of every week SoDEX has scored: all, the wallet's own, from invitees, from its squads' boost. */
export function pointsGrid(weeks: readonly AnyWeek[], cols: number, offset: number): Grid {
  const scored = scoredWeeks(weeks);
  const end = Math.max(0, scored.length - offset);
  const shown = scored.slice(Math.max(0, end - cols), end);
  const row = (key: string, label: string, name: string, f: (w: AnyWeek) => number): GridRow => ({ key, label, name, tone: 'points', cells: levels(shown.map(f)) });
  return {
    unit: 'points',
    more: end - cols > 0,
    cols: shown.map((w) => ({ key: w.key, label: w.short, title: `${w.name}, from ${utc(w.start * 1000, { month: 'short', day: 'numeric', year: 'numeric' })}` })),
    rows: [
      row('all', 'All', 'SoPoints', (w) => w.split.week.points),
      row('ref', 'Invited', 'From invitees (25%)', (w) => w.split.referral),
    ],
  };
}

/** The weeks SoDEX has scored, oldest first: an unscored week's 0 is no result. */
export const scoredWeeks = (weeks: readonly AnyWeek[]): AnyWeek[] => weeks.filter((w) => w.split.week.pointsStatus === 'CONFIRMED');
