/**
 * Hyperliquid PnL on its leaderboard's own terms.
 *
 * HL's leaderboard file (leaderboard.ts), which the board's 1d / 7d / 30d / all come from, ranks PERP PnL - the
 * portfolio's perpDay..perpAllTime, not the spot-inclusive day..allTime - and adds a master's sub-accounts into the
 * master's row. A curve drawn beside a board figure (curves.ts), or a window the index derives from the portfolio
 * chart (90d and ytd, indexer/hlSource.ts), has to be on the same terms, or it contradicts the figure. Checked live
 * 2026-11-26:
 *   0x5b5d…c060  file 30d 114,041,785.91 = its perpMonth 114,041,786; month (spot included) 103,728,711.
 *   0xf5d8…ad53  file 30d +34,450,041 against its own perpMonth -483,367. Its 20 sub-accounts' perpMonth adds to
 *                +35,883,118, master + subs +35,399,751 (the file is up to an hour old on an account moving ~5M a
 *                day); 30d volume 49,081,556,579 in the file, 16,560,128,816 + 32,538,368,100 in the portfolios.
 *
 * A master's sub-accounts are read only when its own perp change does not explain the file's figure, so an account
 * without them costs nothing more than before.
 */
import type { EquityPoint, Window } from '../types.js';
import type { InfoBody, InfoOpts } from './info.js';
import { equitySeries, portfolioWindow } from './mappers.js';
import type { HlPortfolio } from './raw.js';

/** The perp-only portfolio window behind each leaderboard window. */
export const PERP_WINDOW: Readonly<Record<Window, string>> = { '1d': 'perpDay', '7d': 'perpWeek', '30d': 'perpMonth', all: 'perpAllTime' };

/** The hourly file against a live chart drifts by this much at most before a gap means something else. */
export const SCOPE_TOL_USD = 25_000;
export const SCOPE_TOL_SHARE = 0.1;
/** Sub-accounts read for one master at most (HL allows a master 20 today; this only bounds the weight). */
export const MAX_SUBS = 40;
const SUBS_TTL_MS = 60 * 60_000;

export type InfoPost = <T>(body: InfoBody, o?: InfoOpts) => Promise<T>;

/** Does a series' own change explain the leaderboard's figure for the window? */
export function explains(own: number, expected: number): boolean {
  return Math.abs(own - expected) <= Math.max(SCOPE_TOL_USD, SCOPE_TOL_SHARE * Math.abs(expected));
}

const changeOf = (s: readonly EquityPoint[]): number => (s.length ? (s[s.length - 1]!.pnl ?? 0) - (s[0]!.pnl ?? 0) : 0);

/**
 * Cumulative series added up by time, on every time any of them has: each held at its last point, 0 PnL before its
 * first (a window's PnL starts at 0), its account value counted from its first point on.
 */
export function sumSeries(list: ReadonlyArray<readonly EquityPoint[]>): EquityPoint[] {
  const ts = [...new Set(list.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const at = list.map(() => -1);
  return ts.map((t) => {
    let pnl = 0;
    let av: number | null = null;
    list.forEach((s, k) => {
      while (at[k]! + 1 < s.length && s[at[k]! + 1]!.t <= t) at[k]!++;
      const p = at[k]! >= 0 ? s[at[k]!]! : null;
      if (p?.pnl != null) pnl += p.pnl;
      if (p?.accountValue != null) av = (av ?? 0) + p.accountValue;
    });
    return { t, pnl, accountValue: av };
  });
}

export interface RowSeries {
  /** Perp PnL over the window (cumulative from its start), the address's own plus its sub-accounts' when read. */
  series: EquityPoint[];
  /** Sub-accounts added in (0: the address's own series alone). */
  subs: number;
  /** The series' change matches the leaderboard's figure (or there was none to match). */
  explained: boolean;
}

const perpSeries = (p: HlPortfolio | null | undefined, hlWindow: string): EquityPoint[] =>
  equitySeries(portfolioWindow(p, hlWindow)).filter((pt) => pt.pnl !== null);

/**
 * An address's perp PnL over `hlWindow` (perpDay..perpAllTime) on the leaderboard's terms: its own, plus its
 * sub-accounts' when its own change does not explain `expected` (the file's figure for that window; null = none to
 * match). A sub-account that cannot be read fails the whole read: a sum without it would be a wrong curve.
 */
export async function rowSeries(address: string, hlWindow: string, expected: number | null, post: InfoPost, opts: InfoOpts = {}): Promise<RowSeries> {
  const own = perpSeries(await post<HlPortfolio>({ type: 'portfolio', user: address }, opts), hlWindow);
  if (expected === null || !Number.isFinite(expected) || explains(changeOf(own), expected)) {
    return { series: own, subs: 0, explained: true };
  }
  const subs = await post<Array<{ subAccountUser?: string }>>({ type: 'subAccounts', user: address }, { ...opts, ttlMs: SUBS_TTL_MS });
  const list = [...new Set((Array.isArray(subs) ? subs : []).flatMap((s) => (typeof s?.subAccountUser === 'string' ? [s.subAccountUser.toLowerCase()] : [])))].slice(0, MAX_SUBS);
  if (!list.length) return { series: own, subs: 0, explained: false };
  const theirs: EquityPoint[][] = [];
  for (const sub of list) theirs.push(perpSeries(await post<HlPortfolio>({ type: 'portfolio', user: sub }, opts), hlWindow));
  const series = sumSeries([own, ...theirs]);
  return { series, subs: list.length, explained: explains(changeOf(series), expected) };
}
