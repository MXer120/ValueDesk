/**
 * The Copy page's trader grid: categories, filters and sorts over the board
 * rows of both copy venues. Pure, so what the grid shows can be tested.
 *
 * Two kinds of grid. 'copy' is the boards' best (side=top), scored by the copy
 * score; 'counter' (the Counter-trade tab) is their worst (side=worst), scored
 * by the counter score, and every filter and sort reads the other way round:
 * "on the right side" is a loss, the win rate is a ceiling, the biggest loss
 * sorts first.
 */
import type { BoardWindow, TraderRow, Venue } from '../../vsApi';
import { cohortOf, copyScore, counterScore, type CopyScore, type ScoreKind } from './copyScore';

/** The venues a copy can follow. */
export const COPY_VENUES = ['sodex', 'hyperliquid'] as const satisfies readonly Venue[];

export type Category = 'top' | 'counter' | 'sodex' | 'hyperliquid' | 'btc' | 'eth' | 'sol' | 'hype';

export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; coin?: string }> = [
  { id: 'top', label: 'Top traders' },
  { id: 'counter', label: 'Counter-trade' },
  { id: 'sodex', label: 'SoDEX' },
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'btc', label: 'BTC traders', coin: 'BTC' },
  { id: 'eth', label: 'ETH traders', coin: 'ETH' },
  { id: 'sol', label: 'SOL traders', coin: 'SOL' },
  { id: 'hype', label: 'HYPE traders', coin: 'HYPE' },
];

/** The Counter-trade tab ranks the losers; every other tab the winners. */
export const kindOf = (c: Category): ScoreKind => (c === 'counter' ? 'counter' : 'copy');

export type SortKey = 'score' | 'pnl' | 'roi' | 'equity' | 'winRate';

export const SORTS: Record<ScoreKind, ReadonlyArray<{ id: SortKey; label: string }>> = {
  copy: [
    { id: 'score', label: 'Highest copy score' },
    { id: 'pnl', label: 'Highest PnL' },
    { id: 'roi', label: 'Highest return' },
    { id: 'equity', label: 'Largest account' },
    { id: 'winRate', label: 'Best win rate' },
  ],
  counter: [
    { id: 'score', label: 'Highest counter score' },
    { id: 'pnl', label: 'Biggest loss' },
    { id: 'roi', label: 'Worst return' },
    { id: 'equity', label: 'Largest account' },
    { id: 'winRate', label: 'Lowest win rate' },
  ],
};

export const GRID_WINDOWS: ReadonlyArray<{ id: BoardWindow; label: string }> = [
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'All' },
];

export interface Filters {
  /** Minimum account value, USD. 0 = any. */
  minEquity: number;
  /** Only traders on the score's side of the window: profitable to copy, losing to counter. */
  sideOnly: boolean;
  /** Win rate threshold, 0..1, 0 = any: a floor for copying, a ceiling for countering. */
  winRate: number;
  /** Minimum score. 0 = any. */
  minScore: number;
}

export const NO_FILTERS: Filters = { minEquity: 0, sideOnly: false, winRate: 0, minScore: 0 };

/** Filters stored by an older build (profitableOnly, minWinRate) read as today's. */
export function normaliseFilters(f: Partial<Filters> & { profitableOnly?: boolean; minWinRate?: number } | null | undefined): Filters {
  const o = f ?? {};
  return {
    minEquity: Number(o.minEquity) || 0,
    sideOnly: o.sideOnly ?? o.profitableOnly ?? false,
    winRate: Number(o.winRate ?? o.minWinRate) || 0,
    minScore: Number(o.minScore) || 0,
  };
}

export const EQUITY_STEPS = [0, 10_000, 100_000, 1_000_000] as const;
export const WIN_RATE_STEPS: Record<ScoreKind, readonly number[]> = { copy: [0, 0.5, 0.6, 0.7], counter: [0, 0.5, 0.4, 0.3] };
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
  (f.minEquity > 0 ? 1 : 0) + (f.sideOnly ? 1 : 0) + (f.winRate > 0 ? 1 : 0) + (f.minScore > 0 ? 1 : 0);

/** Both venues' rows in one list: deduplicated by venue and address, scored against each other. */
export function scoreRows(rows: readonly TraderRow[], w: BoardWindow, kind: ScoreKind = 'copy'): Scored[] {
  const seen = new Set<string>();
  const unique: TraderRow[] = [];
  for (const row of rows) {
    const key = `${row.venue}:${row.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const cohort = cohortOf(unique, w);
  const of = kind === 'copy' ? copyScore : counterScore;
  return unique.map((row) => ({ row, score: of(row, w, cohort) }));
}

/** The value a sort ranks by, oriented so that higher is better for this kind of grid. */
const sortValue = (s: Scored, key: SortKey, w: BoardWindow, kind: ScoreKind): number | null => {
  const flip = kind === 'counter' ? -1 : 1;
  switch (key) {
    case 'score': return s.score.score;
    case 'pnl': { const v = s.row.pnl[w]; return v == null ? null : flip * v; }
    case 'roi': return s.score.roi === null ? null : flip * s.score.roi;
    case 'equity': return s.row.accountValue;
    case 'winRate': return s.row.winRate == null ? null : flip * s.row.winRate;
  }
};

/** What the grid shows: the category, the filters and the search, then the sort (unknowns last, ties by score). */
export function shapeGrid(
  all: readonly Scored[],
  o: { category: Category; filters: Filters; sort: SortKey; window: BoardWindow; q?: string },
): Scored[] {
  const kind = kindOf(o.category);
  const cat = CATEGORIES.find((c) => c.id === o.category);
  const q = (o.q ?? '').trim().toLowerCase();
  const f = o.filters;
  const kept = all.filter(({ row, score }) => {
    if (o.category === 'sodex' || o.category === 'hyperliquid') { if (row.venue !== o.category) return false; }
    else if (cat?.coin && !tradesCoin(row, cat.coin)) return false;
    if (q && !row.address.toLowerCase().includes(q)) return false;
    if (f.minEquity > 0 && !((row.accountValue ?? 0) >= f.minEquity)) return false;
    const pnl = row.pnl[o.window] ?? 0;
    if (f.sideOnly && !(kind === 'copy' ? pnl > 0 : pnl < 0)) return false;
    if (f.winRate > 0) {
      if (row.winRate == null) return false;
      if (kind === 'copy' ? row.winRate < f.winRate : row.winRate > f.winRate) return false;
    }
    if (f.minScore > 0 && score.score < f.minScore) return false;
    return true;
  });
  return kept.sort((a, b) => {
    const va = sortValue(a, o.sort, o.window, kind);
    const vb = sortValue(b, o.sort, o.window, kind);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return b.score.score - a.score.score;
  });
}
