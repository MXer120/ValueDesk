/**
 * The Copy page's trader grid: categories, filters and sorts over the board
 * rows of both copy venues. Pure, so what the grid shows can be tested.
 */
import type { BoardWindow, TraderRow, Venue } from '../../vsApi';
import { copyScore, type CopyScore } from './copyScore';

/** The venues a copy can follow. */
export const COPY_VENUES = ['sodex', 'hyperliquid'] as const satisfies readonly Venue[];

export type Category = 'top' | 'sodex' | 'hyperliquid' | 'btc' | 'eth' | 'sol' | 'hype';

export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; coin?: string }> = [
  { id: 'top', label: 'Top traders' },
  { id: 'sodex', label: 'SoDEX' },
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'btc', label: 'BTC traders', coin: 'BTC' },
  { id: 'eth', label: 'ETH traders', coin: 'ETH' },
  { id: 'sol', label: 'SOL traders', coin: 'SOL' },
  { id: 'hype', label: 'HYPE traders', coin: 'HYPE' },
];

export type SortKey = 'score' | 'pnl' | 'roi' | 'equity' | 'winRate';

export const SORTS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'score', label: 'Highest copy score' },
  { id: 'pnl', label: 'Highest PnL' },
  { id: 'roi', label: 'Highest return' },
  { id: 'equity', label: 'Largest account' },
  { id: 'winRate', label: 'Best win rate' },
];

export const GRID_WINDOWS: ReadonlyArray<{ id: BoardWindow; label: string }> = [
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'All' },
];

export interface Filters {
  /** Minimum account value, USD. 0 = any. */
  minEquity: number;
  profitableOnly: boolean;
  /** Minimum win rate, 0..1. 0 = any. */
  minWinRate: number;
  /** Minimum copy score. 0 = any. */
  minScore: number;
}

export const NO_FILTERS: Filters = { minEquity: 0, profitableOnly: false, minWinRate: 0, minScore: 0 };

export const EQUITY_STEPS = [0, 10_000, 100_000, 1_000_000] as const;
export const WIN_RATE_STEPS = [0, 0.5, 0.6, 0.7] as const;
export const SCORE_STEPS = [0, 50, 70, 90] as const;

export interface Scored {
  row: TraderRow;
  score: CopyScore;
}

/** A HL xyz-dex symbol ("xyz:SP500") as its ticker; perps symbols as they are ("BTC", "BTC-USD"). */
const baseOf = (sym: string): string => sym.replace(/^[a-z]+:/, '').replace(/[-_/](USD[CT]?|PERP)$/i, '').toUpperCase();

export function tradesCoin(row: TraderRow, coin: string): boolean {
  return (row.assets ?? []).some((a) => baseOf(a) === coin);
}

export const filtersActive = (f: Filters): number =>
  (f.minEquity > 0 ? 1 : 0) + (f.profitableOnly ? 1 : 0) + (f.minWinRate > 0 ? 1 : 0) + (f.minScore > 0 ? 1 : 0);

/** Both boards in one list: scored, deduplicated by venue and address. */
export function scoreRows(rows: readonly TraderRow[], w: BoardWindow): Scored[] {
  const seen = new Set<string>();
  const out: Scored[] = [];
  for (const row of rows) {
    const key = `${row.venue}:${row.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ row, score: copyScore(row, w) });
  }
  return out;
}

const sortValue = (s: Scored, key: SortKey, w: BoardWindow): number | null => {
  switch (key) {
    case 'score': return s.score.score;
    case 'pnl': return s.row.pnl[w] ?? null;
    case 'roi': return s.score.roi;
    case 'equity': return s.row.accountValue;
    case 'winRate': return s.row.winRate ?? null;
  }
};

/** What the grid shows: the category, the filters and the search, then the sort (unknowns last, ties by PnL). */
export function shapeGrid(
  all: readonly Scored[],
  o: { category: Category; filters: Filters; sort: SortKey; window: BoardWindow; q?: string },
): Scored[] {
  const cat = CATEGORIES.find((c) => c.id === o.category);
  const q = (o.q ?? '').trim().toLowerCase();
  const f = o.filters;
  const kept = all.filter(({ row, score }) => {
    if (o.category === 'sodex' || o.category === 'hyperliquid') { if (row.venue !== o.category) return false; }
    else if (cat?.coin && !tradesCoin(row, cat.coin)) return false;
    if (q && !row.address.toLowerCase().includes(q)) return false;
    if (f.minEquity > 0 && !((row.accountValue ?? 0) >= f.minEquity)) return false;
    if (f.profitableOnly && !((row.pnl[o.window] ?? 0) > 0)) return false;
    if (f.minWinRate > 0 && !((row.winRate ?? -1) >= f.minWinRate)) return false;
    if (f.minScore > 0 && score.score < f.minScore) return false;
    return true;
  });
  return kept.sort((a, b) => {
    const va = sortValue(a, o.sort, o.window);
    const vb = sortValue(b, o.sort, o.window);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return (b.row.pnl[o.window] ?? -Infinity) - (a.row.pnl[o.window] ?? -Infinity);
  });
}
