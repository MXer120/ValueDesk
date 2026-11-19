/**
 * The Copy page's trader grid: categories, filters and sorts over the board
 * rows of both copy venues. Pure, so what the grid shows can be tested.
 *
 * The traders come from any of the indexed platforms (GRID_VENUES, chosen on
 * the page); a copy can follow SoDEX and Hyperliquid traders only
 * (COPY_VENUES): the others are shown, to look at, not to copy.
 *
 * Every trader is scored in one of two kinds. 'copy' is a trader from the
 * boards' best (side=top), scored by the copy score; 'counter' one from their
 * worst (side=worst), scored by the counter score, for trading against. Every
 * filter and sort reads a counter trader the other way round: "on the right
 * side" is a loss, the win rate is a ceiling, the biggest loss sorts first.
 *
 * A grid holds one kind (the Copy and Counter-trade tabs) or both, mixed (Top
 * traders and the venue and coin tabs): there each card is read in its own kind
 * and the two are ranked together by score.
 */
import type { BoardWindow, TraderRow, Venue } from '../../vsApi';
import { cohortOf, copyScore, counterScore, type CopyScore, type ScoreKind } from './copyScore';

/** The venues a copy can follow (the copy engine's LeaderVenue). */
export const COPY_VENUES = ['sodex', 'hyperliquid'] as const satisfies readonly Venue[];
/** The platforms the grid can show traders of: every venue the index ranks. */
export const GRID_VENUES = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'] as const satisfies readonly Venue[];

/** A copy can follow this trader's venue. */
export const isCopyable = (v: Venue): boolean => (COPY_VENUES as readonly Venue[]).includes(v);

/** The window the Copy page opens on. */
export const GRID_DEFAULT_WINDOW: BoardWindow = '30d';
/** The boards the Copy page reads for these platforms: theirs, plus the two a copy follows (the hero deals from those). */
export const boardVenues = (venues: readonly Venue[]): Venue[] => [...new Set<Venue>([...venues, ...COPY_VENUES])];

/** The chosen platforms, from what a browser stored: known venues, in GRID_VENUES order, never none. */
export function normaliseVenues(v: unknown): Venue[] {
  const got = Array.isArray(v) ? v.filter((x): x is Venue => (GRID_VENUES as readonly string[]).includes(x)) : [];
  return got.length ? GRID_VENUES.filter((x) => got.includes(x)) : [...GRID_VENUES];
}

export type Category = 'top' | 'copy' | 'counter' | 'btc' | 'eth' | 'sol' | 'hype';

export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; coin?: string }> = [
  { id: 'top', label: 'Top traders' },
  { id: 'copy', label: 'Copy' },
  { id: 'counter', label: 'Counter-trade' },
  { id: 'btc', label: 'BTC traders', coin: 'BTC' },
  { id: 'eth', label: 'ETH traders', coin: 'ETH' },
  { id: 'sol', label: 'SOL traders', coin: 'SOL' },
  { id: 'hype', label: 'HYPE traders', coin: 'HYPE' },
];

/** What a grid holds: traders to copy, traders to counter, or both. */
export type GridKind = ScoreKind | 'mixed';

/** The Copy tab ranks the winners, the Counter-trade tab the losers, every other tab both (the coin tabs too). */
export const kindOf = (c: Category): GridKind => (c === 'counter' ? 'counter' : c === 'copy' ? 'copy' : 'mixed');

export type SortKey = 'score' | 'pnl' | 'roi' | 'equity' | 'winRate';

export const SORTS: Record<GridKind, ReadonlyArray<{ id: SortKey; label: string }>> = {
  mixed: [
    { id: 'score', label: 'Highest score' },
    { id: 'pnl', label: 'Largest PnL, won or lost' },
    { id: 'roi', label: 'Largest return, up or down' },
    { id: 'equity', label: 'Largest account' },
    { id: 'winRate', label: 'Win rate: high to copy, low to counter' },
  ],
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
  /** Only traders on their score's side of the window: profitable to copy, losing to counter. */
  sideOnly: boolean;
  /**
   * Win rate, 0..1, 0 = any: the floor for a trader to copy; a trader to counter
   * must be at or below its mirror (1 - winRate: 0.6 means at most 40%).
   */
  winRate: number;
  /** Minimum score. 0 = any. */
  minScore: number;
}

export const NO_FILTERS: Filters = { minEquity: 0, sideOnly: false, winRate: 0, minScore: 0 };

/**
 * Filters stored by an older build read as today's: profitableOnly and
 * minWinRate by their new names, and a counter ceiling (0.4, 0.3: an older
 * Counter-trade tab stored the ceiling itself) as the floor it mirrors.
 */
export function normaliseFilters(f: Partial<Filters> & { profitableOnly?: boolean; minWinRate?: number } | null | undefined): Filters {
  const o = f ?? {};
  const wr = Number(o.winRate ?? o.minWinRate) || 0;
  return {
    minEquity: Number(o.minEquity) || 0,
    sideOnly: o.sideOnly ?? o.profitableOnly ?? false,
    winRate: wr > 0 && wr < 0.5 ? Math.round((1 - wr) * 100) / 100 : wr,
    minScore: Number(o.minScore) || 0,
  };
}

export const EQUITY_STEPS = [0, 10_000, 100_000, 1_000_000] as const;
export const WIN_RATE_STEPS = [0, 0.5, 0.6, 0.7] as const;
export const SCORE_STEPS = [0, 50, 70, 90] as const;

/** A win-rate step as the grid's kind reads it: "≥ 60%", "≤ 40%", or both ("≥ 60% / ≤ 40%" when `short`). */
export function winRateLabel(kind: GridKind, v: number, short = false): string {
  if (v === 0) return 'Any';
  const hi = `≥ ${Math.round(v * 100)}%`;
  const lo = `≤ ${Math.round((1 - v) * 100)}%`;
  if (kind !== 'mixed') return kind === 'copy' ? hi : lo;
  return short ? `${hi} / ${lo}` : `${hi} to copy, ${lo} to counter`;
}

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

const keyOf = (row: TraderRow) => `${row.venue}:${row.address.toLowerCase()}`;

/** Both venues' rows in one list: deduplicated by venue and address, scored against each other. */
export function scoreRows(rows: readonly TraderRow[], w: BoardWindow, kind: ScoreKind = 'copy'): Scored[] {
  const seen = new Set<string>();
  const unique: TraderRow[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const cohort = cohortOf(unique, w);
  const of = kind === 'copy' ? copyScore : counterScore;
  return unique.map((row) => ({ row, score: of(row, w, cohort) }));
}

/**
 * The traders to copy and the traders to counter in one list. A venue with
 * fewer than two hundred traders puts some on both of its boards: such a
 * trader is kept once, in the kind it scores higher in.
 */
export function mixKinds(copy: readonly Scored[], counter: readonly Scored[]): Scored[] {
  const best = new Map<string, Scored>();
  for (const s of [...copy, ...counter]) {
    const k = keyOf(s.row);
    const had = best.get(k);
    if (!had || s.score.score > had.score.score) best.set(k, s);
  }
  return [...best.values()];
}

/** The value a sort ranks by, oriented so that higher is better for the trader's own kind. */
const sortValue = (s: Scored, key: SortKey, w: BoardWindow): number | null => {
  const flip = s.score.kind === 'counter' ? -1 : 1;
  switch (key) {
    case 'score': return s.score.score;
    case 'pnl': { const v = s.row.pnl[w]; return v == null ? null : flip * v; }
    case 'roi': return s.score.roi === null ? null : flip * s.score.roi;
    case 'equity': return s.row.accountValue;
    case 'winRate': return s.row.winRate == null ? null : s.score.kind === 'counter' ? 1 - s.row.winRate : s.row.winRate;
  }
};

/** What the grid shows: the category, the filters and the search, then the sort (unknowns last, ties by score). */
export function shapeGrid(
  all: readonly Scored[],
  o: { category: Category; filters: Filters; sort: SortKey; window: BoardWindow; q?: string; venues?: readonly Venue[] },
): Scored[] {
  const kind = kindOf(o.category);
  const cat = CATEGORIES.find((c) => c.id === o.category);
  const q = (o.q ?? '').trim().toLowerCase();
  const f = o.filters;
  const kept = all.filter(({ row, score }) => {
    if (kind !== 'mixed' && score.kind !== kind) return false;
    if (o.venues && !o.venues.includes(row.venue)) return false;
    if (cat?.coin && !tradesCoin(row, cat.coin)) return false;
    if (q && !row.address.toLowerCase().includes(q)) return false;
    if (f.minEquity > 0 && !((row.accountValue ?? 0) >= f.minEquity)) return false;
    const pnl = row.pnl[o.window] ?? 0;
    const copying = score.kind === 'copy';
    if (f.sideOnly && !(copying ? pnl > 0 : pnl < 0)) return false;
    if (f.winRate > 0) {
      if (row.winRate == null) return false;
      if (copying ? row.winRate < f.winRate : row.winRate > 1 - f.winRate + 1e-9) return false;
    }
    if (f.minScore > 0 && score.score < f.minScore) return false;
    return true;
  });
  const sorted = kept.sort((a, b) => {
    const va = sortValue(a, o.sort, o.window);
    const vb = sortValue(b, o.sort, o.window);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return b.score.score - a.score.score;
  });
  return kind === 'mixed' && o.sort === 'score' ? interleave(sorted) : sorted;
}

/** In a mixed grid ranked by score, two traders to copy for every one to counter. */
const MIX_WEIGHT: Record<ScoreKind, number> = { copy: 2, counter: 1 };

/**
 * A mixed grid ranked by score, dealt by rank within each kind (copy, copy,
 * counter, ...): copy scores run higher than counter scores, and a plain sort
 * put every counter-trade below the first row.
 */
function interleave(sorted: readonly Scored[]): Scored[] {
  const seen: Record<ScoreKind, number> = { copy: 0, counter: 0 };
  const keyed = sorted.map((s) => ({ s, at: ++seen[s.score.kind] / MIX_WEIGHT[s.score.kind] }));
  // A tie (the second copy and the first counter) goes to the copy: C C K C C K.
  const first = (k: { s: Scored }) => (k.s.score.kind === 'copy' ? 0 : 1);
  return keyed.sort((a, b) => a.at - b.at || first(a) - first(b) || b.s.score.score - a.s.score.score).map((k) => k.s);
}

/**
 * The hero's deck: the best of each kind, both kinds shown - up to `n`
 * cards, the counter picks a third of them (at least one when there is one),
 * highest score first. Only traders a copy can follow are dealt.
 */
export function deckOf(copy: readonly Scored[], counter: readonly Scored[], w: BoardWindow, n = 5): Scored[] {
  const by = (list: readonly Scored[]) => shapeGrid(list.filter((s) => isCopyable(s.row.venue)), { category: 'top', filters: { ...NO_FILTERS, sideOnly: true }, sort: 'score', window: w });
  const c = by(copy);
  const k = by(counter);
  const nk = Math.min(k.length, Math.max(1, Math.round(n / 3)));
  const picks = [...c.slice(0, n - nk), ...k.slice(0, nk)];
  if (picks.length < n) picks.push(...k.slice(nk, nk + n - picks.length));
  return picks.sort((a, b) => b.score.score - a.score.score).slice(0, n);
}
