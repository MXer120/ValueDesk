/**
 * Which part of the futures account's position margin the bots hold (the margin panel, Allocation.tsx).
 *
 * The panel used to take SoDEX's position margin and subtract each bot's own holding as its executor view reported
 * it. The two are read at different moments, and a fast bot changes its holding between them (2026-11-11: the SOL
 * bot's view said long 0.131 while SoDEX held SOL short 0.129), so bot positions kept landing in "your own
 * positions". Now the split is SoDEX's own positions, market by market: a position on a market where real bots run
 * is theirs up to what those bots can hold (their margin need), and only the rest is the user's own.
 */

type Raw = Record<string, unknown>;

const n = (x: unknown): number => {
  const v = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(v) ? v : 0;
};

export interface PositionsMargin {
  /** SoDEX's position margin: isolated (im) plus cross (cm). */
  total: number;
  /** Each market's position margin: |size| x entry price / its leverage. */
  bySymbol: Map<string, number>;
}

/** From SoDEX's perps account state (`/accounts/<address>/state`: im, cm, P = positions with s, sz, ep, l). */
export function positionsMarginOf(state: Raw | null | undefined): PositionsMargin {
  const bySymbol = new Map<string, number>();
  if (!state) return { total: 0, bySymbol };
  const ps = Array.isArray(state.P) ? (state.P as Raw[]) : [];
  for (const p of ps) {
    const sym = typeof p.s === 'string' ? p.s : '';
    const notional = Math.abs(n(p.sz)) * n(p.ep);
    if (!sym || !(notional > 0)) continue;
    const lev = Math.max(1, n(p.l) || 1);
    bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + notional / lev);
  }
  return { total: n(state.im) + n(state.cm), bySymbol };
}

/**
 * The bots' share and the user's own: per market, min(that market's position margin, what the bots running there
 * may hold). `botCaps`: each market's running real bots, their margin need added up.
 */
export function splitPositionsMargin(pm: PositionsMargin, botCaps: ReadonlyMap<string, number>): { bots: number; own: number } {
  let bots = 0;
  for (const [sym, margin] of pm.bySymbol) bots += Math.min(margin, Math.max(0, botCaps.get(sym) ?? 0));
  return { bots, own: Math.max(0, pm.total - bots) };
}
