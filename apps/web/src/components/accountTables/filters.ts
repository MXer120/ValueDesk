/**
 * The account band's row filters - pure, covered by filters.test.ts.
 *
 * Every filter is applied to the rows the tables ALREADY hold (client-side);
 * the only thing that ever fetches because of a filter is the history tables'
 * auto "load more" toward a timeframe start older than what is loaded, capped
 * (AUTO_PAGES) so a "90D" on a market maker's account cannot turn into a
 * request storm against SoDEX's rate limit.
 */

export type BandTab =
  | 'positions' | 'orders' | 'balances' | 'order-history' | 'trade-history'
  | 'funding-history' | 'position-history' | 'account-history';

export type MarginFilter = 'all' | 'cross' | 'isolated';
export type SideFilter = 'all' | 'long' | 'short';
export type SourceFilter = 'all' | 'manual' | 'copy';
export type Preset = 'all' | '24H' | '7D' | '30D' | '90D' | 'custom';

export interface TableFilter {
  margin: MarginFilter;
  side: SideFilter;
  source: SourceFilter;
  preset: Preset;
  /** ms, only for preset 'custom'. */
  from: number | null;
  /** ms, only for preset 'custom'. */
  to: number | null;
}

export const DEFAULT_FILTER: TableFilter = { margin: 'all', side: 'all', source: 'all', preset: 'all', from: null, to: null };

/** Which controls apply to which tab. A control that cannot bite on a tab is not shown there. */
export interface TabCaps {
  /** The "Current market" checkbox: rows carry a market. */
  market: boolean;
  margin: boolean;
  side: boolean;
  source: boolean;
  time: boolean;
}

export const TAB_CAPS: Record<BandTab, TabCaps> = {
  positions:          { market: true,  margin: true,  side: true,  source: false, time: false },
  orders:             { market: true,  margin: false, side: true,  source: true,  time: false },
  balances:           { market: false, margin: false, side: false, source: false, time: false },
  'order-history':    { market: true,  margin: false, side: true,  source: true,  time: true },
  'trade-history':    { market: true,  margin: false, side: true,  source: true,  time: true },
  'funding-history':  { market: true,  margin: false, side: true,  source: false, time: true },
  'position-history': { market: true,  margin: true,  side: true,  source: false, time: true },
  'account-history':  { market: false, margin: false, side: false, source: false, time: true },
};

/** A tab with anything to put in the View panel. */
export const hasView = (c: TabCaps): boolean => c.margin || c.side || c.source || c.time;

/** How many View filters are narrowing the rows (the badge on the View button). */
export function activeCount(f: TableFilter, caps: TabCaps): number {
  return (caps.margin && f.margin !== 'all' ? 1 : 0)
    + (caps.side && f.side !== 'all' ? 1 : 0)
    + (caps.source && f.source !== 'all' ? 1 : 0)
    + (caps.time && f.preset !== 'all' ? 1 : 0);
}

// --- copy orders -------------------------------------------------------------

/**
 * HOW A COPY ORDER IS TOLD APART.
 *
 * SoDEX keeps exactly one free-form tag per order: `clOrdID`
 * (`^[0-9a-zA-Z_-]{1,36}$`, echoed on the order AND on every fill). The builder
 * fee cannot separate them - this app attaches the same builder to manual
 * tickets (trading/actions.ts) - so the copy executor must prefix its
 * deterministic ids (docs/research/03 C.6: base62(H(...))[:30]) with this.
 * Manual tickets use `vs-` (browser, trading/orderParams.ts genClOrdID) and
 * `ot-` / `tp-` / `sl-` / `cx-` / `rp-` (server routes/trade.ts); none of them
 * start with it. SoDEX's own liquidation fills carry `liquidation:<orderID>`.
 */
export const COPY_CLORDID_PREFIX = 'vcp';

export type OrderSource = 'manual' | 'copy' | 'liquidation';

export function sourceOf(clOrdID: unknown): OrderSource {
  const id = typeof clOrdID === 'string' ? clOrdID : '';
  if (id.startsWith(COPY_CLORDID_PREFIX)) return 'copy';
  if (id.startsWith('liquidation:')) return 'liquidation';
  return 'manual';
}

// --- row facts ---------------------------------------------------------------

export type Direction = 'long' | 'short';

/** CROSS / ISOLATED (string or the venue's enum 2 / 1). */
export function marginOf(v: unknown): 'cross' | 'isolated' | null {
  const s = typeof v === 'string' ? v.toUpperCase() : v;
  return s === 'CROSS' || s === 2 ? 'cross' : s === 'ISOLATED' || s === 1 ? 'isolated' : null;
}

/** An order or fill: BUY opens / adds long, SELL short (the venue's enum 1 / 2). */
export function directionOfSide(v: unknown): Direction | null {
  const s = typeof v === 'string' ? v.toUpperCase() : v;
  return s === 'BUY' || s === 1 ? 'long' : s === 'SELL' || s === 2 ? 'short' : null;
}

/**
 * A position: explicit LONG / SHORT (2 / 3) first; under one-way mode (BOTH)
 * the sign of `size`. null when neither says.
 */
export function directionOfPosition(positionSide: unknown, size?: unknown): Direction | null {
  const s = typeof positionSide === 'string' ? positionSide.toUpperCase() : positionSide;
  if (s === 'LONG' || s === 2) return 'long';
  if (s === 'SHORT' || s === 3) return 'short';
  const n = typeof size === 'number' ? size : typeof size === 'string' ? Number(size) : NaN;
  if (n > 0) return 'long';
  if (n < 0) return 'short';
  return null;
}

export interface RowFacts {
  symbol?: string | null;
  margin?: 'cross' | 'isolated' | null;
  side?: Direction | null;
  source?: OrderSource | null;
  /** ms */
  time?: number | null;
}

// --- time --------------------------------------------------------------------

export const PRESET_MS: Record<Exclude<Preset, 'all' | 'custom'>, number> = {
  '24H': 86_400_000,
  '7D': 7 * 86_400_000,
  '30D': 30 * 86_400_000,
  '90D': 90 * 86_400_000,
};

/** The window a filter selects, in ms; null ends are open. */
export function timeWindow(f: TableFilter, now: number): { from: number | null; to: number | null } {
  if (f.preset === 'all') return { from: null, to: null };
  if (f.preset === 'custom') {
    const from = f.from ?? null;
    const to = f.to ?? null;
    // A reversed range is read the way it was meant, not as "nothing".
    if (from !== null && to !== null && from > to) return { from: to, to: from };
    return { from, to };
  }
  return { from: now - PRESET_MS[f.preset], to: null };
}

/** A stable key for "where the window starts" - changes only when the reader changes it. */
export const windowKey = (f: TableFilter): string => (f.preset === 'custom' ? `c:${f.from ?? ''}` : f.preset);

// --- matching ----------------------------------------------------------------

export interface MatchOpts {
  /** The symbol the "Current market" checkbox narrows to, or null when it is off. */
  market: string | null;
  now: number;
}

export function matches(r: RowFacts, f: TableFilter, caps: TabCaps, o: MatchOpts): boolean {
  if (caps.market && o.market && r.symbol !== o.market) return false;
  if (caps.margin && f.margin !== 'all' && r.margin !== f.margin) return false;
  if (caps.side && f.side !== 'all' && r.side !== f.side) return false;
  if (caps.source && f.source !== 'all' && r.source !== f.source) return false;
  if (caps.time) {
    const w = timeWindow(f, o.now);
    const t = r.time ?? null;
    if ((w.from !== null || w.to !== null) && (t === null || !Number.isFinite(t))) return false;
    if (w.from !== null && t! < w.from) return false;
    if (w.to !== null && t! > w.to) return false;
  }
  return true;
}

export function applyFilter<T>(rows: T[], facts: (r: T) => RowFacts, f: TableFilter, caps: TabCaps, o: MatchOpts): T[] {
  return rows.filter((r) => matches(facts(r), f, caps, o));
}

// --- persistence ---------------------------------------------------------------

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const msOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** A stored filter, read defensively: anything unreadable falls back to the default. */
export function readFilter(v: unknown): TableFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const preset = oneOf(o.preset, ['all', '24H', '7D', '30D', '90D', 'custom'] as const, 'all');
  const from = msOrNull(o.from);
  const to = msOrNull(o.to);
  return {
    margin: oneOf(o.margin, ['all', 'cross', 'isolated'] as const, 'all'),
    side: oneOf(o.side, ['all', 'long', 'short'] as const, 'all'),
    source: oneOf(o.source, ['all', 'manual', 'copy'] as const, 'all'),
    // A custom window with no ends is no window.
    preset: preset === 'custom' && from === null && to === null ? 'all' : preset,
    from: preset === 'custom' ? from : null,
    to: preset === 'custom' ? to : null,
  };
}

export const filterKey = (tab: BandTab): string => `vs.acct.filter.${tab}`;

// --- the range slider ------------------------------------------------------------

/**
 * The slider's span: from the oldest row loaded (or the chosen start, if that is
 * older - it is where "load more" is heading) to now.
 */
export function sliderDomain(oldest: number | null, chosenFrom: number | null, now: number): [number, number] {
  const candidates = [oldest, chosenFrom].filter((v): v is number => v !== null && Number.isFinite(v) && v < now);
  const lo = candidates.length ? Math.min(...candidates) : now - PRESET_MS['30D'];
  // Never a zero-width track.
  return [Math.min(lo, now - 3_600_000), now];
}

/** Local midnight of a yyyy-mm-dd, or null. */
export function dayStart(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}
/** The last millisecond of a yyyy-mm-dd (local), or null. */
export function dayEnd(ymd: string): number | null {
  const s = dayStart(ymd);
  return s === null ? null : new Date(new Date(s).getFullYear(), new Date(s).getMonth(), new Date(s).getDate() + 1).getTime() - 1;
}
/** ms -> yyyy-mm-dd (local). */
export function ymd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
