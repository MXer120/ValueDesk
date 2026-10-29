/**
 * The entry the order ticket's TP/SL are solved from (Gain/Loss <-> trigger price, and the
 * wrong-side checks) - where this order is expected to fill, as fresh as the ticket can know it.
 *
 * MARKET: the book walk of this order's size (the average it would fill at), recomputed on every
 * book push; without a walk, the touch it would take (best ask for a buy, best bid for a sell);
 * without a book, the last trade. It used to be the last trade alone - the ticker, about one push a
 * second - so a held Gain/Loss lagged the book the owner was watching (2026-10-29), and it was not
 * where a market order fills anyway.
 * LIMIT: its own price. STOP: where it starts filling - its limit for a stop-limit, else its trigger.
 */
export interface ExitEntryInput {
  type: 'market' | 'limit' | 'stop' | 'algo';
  stopExec?: 'market' | 'limit';
  /** The limit price typed (a limit, or a stop-limit's limit). */
  limitPrice: number;
  stopPrice: number;
  walkAvg: number | null;
  touch: number;
  last: number;
}

export function exitEntryFor(x: ExitEntryInput): number {
  const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (x.type === 'limit') return pos(x.limitPrice) ? x.limitPrice : 0;
  if (x.type === 'stop') {
    if (x.stopExec === 'limit' && pos(x.limitPrice)) return x.limitPrice;
    return pos(x.stopPrice) ? x.stopPrice : 0;
  }
  if (pos(x.walkAvg)) return x.walkAvg;
  if (pos(x.touch)) return x.touch;
  return pos(x.last) ? x.last : 0;
}
