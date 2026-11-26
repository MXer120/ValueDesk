/**
 * How the leaderboard versions shape the board on the page: sort, search, asset group and account size only narrow or
 * reorder the hundred the server sent. Two plain ratios of a row's own figures are the only things computed: edge (PnL
 * per traded dollar, bps) and the Cohorts page's account-size band (sizeCohort over the account value). Pure, so it is
 * tested without a DOM (shape.test.ts).
 */
import { sizeCohort, type CohortId } from '@sign/valuedesk/cohorts/model.js';
import type { BoardWindow, TraderRow, Venue } from '../../../vsApi';
import type { LbView } from '../lbState';

/** A board row as the versions show it: always a venue list, and its place on the board's own (PnL) order. */
export type Row = TraderRow & { venues: Venue[]; place: number };

export type SortKey = 'pnl' | 'edge' | 'winRate' | 'accountValue' | 'volume' | 'trades';
export type AssetGroup = 'all' | 'majors' | 'alts' | 'equities' | 'commodities';
export type SizeBand = 'all' | Extract<CohortId, 'apex' | 'whale' | 'large' | 'medium' | 'small'>;

export const SORT_LABEL: Record<SortKey, string> = {
  pnl: 'PnL', edge: 'Edge', winRate: 'Win rate', accountValue: 'Account value', volume: 'Volume', trades: 'Trades',
};
export const SORT_HINT: Record<SortKey, string> = {
  pnl: 'The window’s PnL: what the board ranks by',
  edge: 'PnL per traded dollar in the window, in basis points (PnL ÷ volume)',
  winRate: 'Winning closes out of closes with a result',
  accountValue: 'Account value now',
  volume: 'Traded volume in the window',
  trades: 'Closing trades in the index sample',
};
export const ASSET_GROUPS: ReadonlyArray<[AssetGroup, string]> = [
  ['all', 'All'], ['majors', 'Majors'], ['alts', 'Alts'], ['equities', 'Equities'], ['commodities', 'Commodities'],
];
/** The Cohorts page's size bands, over the row's account value. */
export const SIZE_BANDS: ReadonlyArray<[SizeBand, string, string]> = [
  ['all', 'All', 'Every account size'],
  ['apex', 'Apex', 'Account value $5M and more'],
  ['whale', 'Whale', 'Account value $1M to $5M'],
  ['large', 'Large', 'Account value $100K to $1M'],
  ['medium', 'Medium', 'Account value $10K to $100K'],
  ['small', 'Small', 'Account value under $10K'],
];
export const WINDOW_WORD: Record<BoardWindow, string> = { '1d': '24h', '7d': '7d', '30d': '30d', '90d': '90d', ytd: 'YTD', all: 'All time' };
export const WINDOW_LONG: Record<BoardWindow, string> = { '1d': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', ytd: 'this year', all: 'all time' };

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/* -------------------------------------------------------------------------------------- shaping ----- */

const COMMODITY = /^(GOLD|SILVER|OIL|WTI|BRENT|NATGAS|GAS|COPPER|XAU|XAUT|XAG|CL|NG|PAXG)$/;
const EQUITY = /^(US500|US100|US30|NAS100|SPX|SP500|NDX|DJI|GER40|UK100|JPN225|HK50|AAPL|TSLA|NVDA|MSFT|AMZN|META|GOOGL|COIN|CRWD|KORU|MSTR|HOOD|PLTR|AMD)$/;

/** `xyz:AAPL`, `BTC-USD` and `vETH` reduce to the coin the icon shows. */
export function assetBase(symbol: string): string {
  const tail = symbol.split(':').pop() ?? symbol;
  const head = tail.split(/[-/]/)[0] ?? tail;
  return head.replace(/^v(?=[A-Z])/, '').toUpperCase();
}

function assetGroup(symbol: string): Exclude<AssetGroup, 'all'> {
  const base = assetBase(symbol);
  if (COMMODITY.test(base)) return 'commodities';
  if (symbol.includes(':') || EQUITY.test(base)) return 'equities';
  if (base === 'BTC' || base === 'ETH') return 'majors';
  return 'alts';
}

/** PnL per traded dollar, bps; null without volume. */
export function edgeOf(r: TraderRow, w: BoardWindow): number | null {
  const pnl = r.pnl[w];
  const vol = r.volume[w];
  return finite(pnl) && finite(vol) && vol > 0 ? (pnl / vol) * 10_000 : null;
}

export function sizeOf(r: TraderRow): SizeBand | null {
  return finite(r.accountValue) ? (sizeCohort(r.accountValue) as SizeBand | null) : null;
}

/** The board carries volume for this window (the venues publish none for 90D and YTD). */
export const hasVolume = (rows: readonly TraderRow[] | null, w: BoardWindow): boolean => !rows || rows.some((r) => finite(r.volume[w]));

/** Without volume, edge and volume cannot order anything: PnL does. */
export const usableSort = (s: SortKey, vol: boolean): SortKey => (!vol && (s === 'edge' || s === 'volume') ? 'pnl' : s);

export function metricOf(r: TraderRow, sort: SortKey, w: BoardWindow): number | null {
  switch (sort) {
    case 'pnl': return finite(r.pnl[w]) ? r.pnl[w]! : null;
    case 'edge': return edgeOf(r, w);
    case 'winRate': return finite(r.winRate) ? r.winRate : null;
    case 'accountValue': return finite(r.accountValue) ? r.accountValue : null;
    case 'volume': return finite(r.volume[w]) ? r.volume[w]! : null;
    case 'trades': return finite(r.trades) ? r.trades : null;
  }
}

/** The worst hundred reads worst first on its own measures (PnL, edge); every other measure largest first. */
export const dirOf = (side: LbView['side'], sort: SortKey): 'asc' | 'desc' => (side === 'worst' && (sort === 'pnl' || sort === 'edge') ? 'asc' : 'desc');

export interface Shape { window: BoardWindow; side: LbView['side']; sort: SortKey; q: string; asset: AssetGroup; size: SizeBand }

export function shape(rows: readonly TraderRow[], o: Shape): Row[] {
  const q = o.q.trim().toLowerCase();
  const all: Row[] = rows.map((r, i) => ({ ...r, venues: r.venues?.length ? r.venues : [r.venue], place: finite(r.rank) ? r.rank : i + 1 }));
  const list = all.filter((r) => {
    if (q && !r.address.toLowerCase().includes(q)) return false;
    if (o.asset !== 'all' && !(r.assets ?? []).some((s) => assetGroup(s) === o.asset)) return false;
    if (o.size !== 'all' && sizeOf(r) !== o.size) return false;
    return true;
  });
  const sign = dirOf(o.side, o.sort) === 'asc' ? 1 : -1;
  const v = (r: Row) => metricOf(r, o.sort, o.window);
  // Rows without the figure go last whichever way the column reads.
  list.sort((a, b) => {
    const x = v(a);
    const y = v(b);
    if (x === null && y === null) return a.place - b.place;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || a.place - b.place;
  });
  return list;
}
