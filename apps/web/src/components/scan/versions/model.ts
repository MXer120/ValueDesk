/**
 * The arithmetic the new Scan versions add on top of hlModel.ts. Pure, so it is tested on its own (model.test.ts).
 *
 * The same rules as hlModel.ts: a figure with no source is null and renders as a dash, never as zero; a figure
 * computed here is called derived where it is shown; nothing is filled in.
 */
import { SCAN_VENUES, type TraderProfile, type Venue, type VsPosition, type Window } from '../../../vsApi';
import type { VenueCard } from '../addressVenues';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** A venue's standing for a switch or a row: what the card says, in one word. */
export type Standing = 'loading' | 'active' | 'inactive' | 'none' | 'unknown';

export function standingOf(c: VenueCard): Standing {
  if (c.pending) return 'loading';
  if (c.unknown) return 'unknown';
  if (!c.exists) return 'none';
  return c.inactive ? 'inactive' : 'active';
}

export const STANDING_TEXT: Record<Standing, string> = {
  loading: 'Checking',
  active: 'Active',
  inactive: 'Inactive',
  none: 'No account',
  unknown: "Couldn't check",
};

/**
 * The venue to open when nobody said which: the active account with the largest account value, then any account,
 * in SCAN_VENUES order on a tie. Null while a venue is still answering, and when the wallet has no account at all.
 */
export function bestVenue(cards: readonly VenueCard[]): Venue | null {
  if (cards.some((c) => c.pending)) return null;
  const at = (v: Venue) => SCAN_VENUES.indexOf(v);
  const eq = (c: VenueCard) => (finite(c.equity) ? c.equity : -1);
  const active = cards.filter((c) => c.exists && !c.inactive).sort((a, b) => eq(b) - eq(a) || at(a.venue) - at(b.venue));
  if (active[0]) return active[0].venue;
  const any = cards.filter((c) => c.exists).sort((a, b) => at(a.venue) - at(b.venue));
  return any[0]?.venue ?? null;
}

/* ---------------------------------------------------------------------------
 * POSITIONS ACROSS VENUES
 * ------------------------------------------------------------------------ */

export interface CrossPosition extends VsPosition {
  /** Every venue that reported this same position (trade.xyz's markets are a dex on Hyperliquid: both report them). */
  venues: Venue[];
}

/**
 * Every venue's open positions in one list, a position reported by two venues kept once.
 *
 * trade.xyz is a market set (a HIP-3 dex) on Hyperliquid, and the Hyperliquid profile reads that dex too
 * (hyperliquid/trader.ts: clearinghouseState on '' and 'xyz'). The same position then arrives twice, with the same
 * symbol, side and size. It is one position: listed once, with both venues named. Largest value first.
 */
export function crossPositions(profiles: Partial<Record<Venue, TraderProfile | null>>): CrossPosition[] {
  const out = new Map<string, CrossPosition>();
  for (const v of SCAN_VENUES) {
    for (const p of profiles[v]?.positions ?? []) {
      const key = `${p.symbol}|${p.side}|${p.size}`;
      const hit = out.get(key);
      if (hit) {
        if (!hit.venues.includes(v)) hit.venues.push(v);
      } else out.set(key, { ...p, venues: [v] });
    }
  }
  return [...out.values()].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
}

export interface BookTotals {
  long: number;
  short: number;
  gross: number;
  net: number;
  /** Sum of the venues' own unrealised PnL; null when any position came without one. */
  upnl: number | null;
  /** Positions left out of the sums because their value is not a number. */
  unpriced: number;
}

export function bookTotals(positions: readonly VsPosition[]): BookTotals | null {
  if (!positions.length) return null;
  let long = 0;
  let short = 0;
  let unpriced = 0;
  let upnl: number | null = 0;
  for (const p of positions) {
    if (!finite(p.notional)) unpriced++;
    else if (p.side === 'long') long += Math.abs(p.notional);
    else short += Math.abs(p.notional);
    upnl = upnl !== null && finite(p.uPnl) ? upnl + p.uPnl : null;
  }
  return { long, short, gross: long + short, net: long - short, upnl, unpriced };
}

/** The ticker of a venue symbol: xyz:AAPL -> AAPL, BTC-USD -> BTC, HYPE/USDC -> HYPE. */
export const baseOf = (symbol: string): string => (symbol.split(':').pop() ?? symbol).split(/[-/]/)[0] ?? symbol;

export interface MarketExposure {
  coin: string;
  long: number;
  short: number;
  net: number;
  gross: number;
  venues: Venue[];
}

/** Long and short value per coin, summed over venues (AAPL on SoDEX and xyz:AAPL on Hyperliquid are one coin). */
export function exposureByCoin(positions: readonly CrossPosition[]): MarketExposure[] {
  const m = new Map<string, MarketExposure>();
  for (const p of positions) {
    if (!finite(p.notional)) continue;
    const coin = baseOf(p.symbol);
    const e = m.get(coin) ?? { coin, long: 0, short: 0, net: 0, gross: 0, venues: [] };
    const n = Math.abs(p.notional);
    if (p.side === 'long') e.long += n; else e.short += n;
    for (const v of p.venues) if (!e.venues.includes(v)) e.venues.push(v);
    m.set(coin, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e, net: e.long - e.short, gross: e.long + e.short }))
    .sort((a, b) => b.gross - a.gross);
}

/* ---------------------------------------------------------------------------
 * ONE POSITION
 * ------------------------------------------------------------------------ */

/** Margin as the venue sizes it: value ÷ leverage. Null without a leverage. */
export function marginOf(p: VsPosition): number | null {
  return finite(p.notional) && finite(p.leverage) && p.leverage > 0 ? Math.abs(p.notional) / p.leverage : null;
}

/** Unrealised PnL against the position's margin (what the band's "%" is). */
export function roeOf(p: VsPosition): number | null {
  const m = marginOf(p);
  return m && finite(p.uPnl) ? p.uPnl / m : null;
}

/**
 * How far the mark can move against the position before its liquidation price, as a fraction of the mark.
 * Long: (mark − liq) ÷ mark. Short: (liq − mark) ÷ mark. Null without both prices. Negative would mean the mark is
 * past the venue's own liquidation price: kept as it is rather than hidden.
 */
export function liqDistance(p: VsPosition): number | null {
  if (!finite(p.markPx) || !finite(p.liqPx) || p.markPx <= 0 || p.liqPx <= 0) return null;
  return p.side === 'long' ? (p.markPx - p.liqPx) / p.markPx : (p.liqPx - p.markPx) / p.markPx;
}

/** Price change from entry to mark, in the position's favour when positive. */
export function moveOf(p: VsPosition): number | null {
  if (!finite(p.entryPx) || !finite(p.markPx) || p.entryPx <= 0) return null;
  const m = (p.markPx - p.entryPx) / p.entryPx;
  return p.side === 'long' ? m : -m;
}

/** Positions nearest to liquidation first; those without a liquidation price last, by value. */
export function byRisk(positions: readonly VsPosition[]): VsPosition[] {
  return [...positions].sort((a, b) => {
    const da = liqDistance(a);
    const db = liqDistance(b);
    if (da === null && db === null) return Math.abs(b.notional) - Math.abs(a.notional);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

/* ---------------------------------------------------------------------------
 * WINDOW FIGURES
 * ------------------------------------------------------------------------ */

export interface WindowFigures {
  pnl: number | null;
  roi: number | null;
  volume: number | null;
}

/** The venue's own figures for a window; PnL falls back to the curve's change (as HlPnlCard does). */
export function windowFigures(p: TraderProfile | null | undefined, w: Window, curveChange: number | null): WindowFigures {
  const s = p?.summary;
  const pnl = s?.pnl[w];
  const roi = s?.roi[w];
  const vol = s?.volume[w];
  return {
    pnl: finite(pnl) ? pnl : curveChange,
    roi: finite(roi) ? roi : null,
    volume: finite(vol) ? vol : null,
  };
}
