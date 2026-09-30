/**
 * The order book's grouping menu, matching SoDEX's own trade UI.
 *
 * Their bundle builds `depthPrecisionMerge` steps of
 * 10^(-pricePrecision + i) (function RSt), which is the symbol tick times
 * 1, 10, 100, … Asks ceil into the step and bids floor (function zSt) — the
 * same edges `aggregate` uses, and a price already on a boundary stays there.
 *
 * Checked 2026-09-27, not assumed:
 *
 * - GET https://mainnet-gw.sodex.dev/api/v1/perps/markets/symbols?symbol=BTC-USD
 *   reports tickSize "1" and pricePrecision 0. The menu for that tick is
 *   exactly 1, 10, 100.
 * - GET https://alpha-biz.sodex.dev/biz/futures/symbols?env=mainnet (91 perps)
 *   and .../biz/spot/symbols?env=mainnet (31 spot pairs): every symbol has
 *   depthPrecisionMerge 3, and where minStepPrice is set it equals
 *   10^(-pricePrecision) (BTC minStepPrice "1"). No per-symbol ladder is
 *   published beyond that count, so the steps are tick * 10^i for i = 0..2.
 * - GET .../markets/BTC-USD/orderbook?limit=5 and the same URL with scale=10,
 *   step=10, level=10, aggregation=10, or tick=10 all returned the raw
 *   one-tick ladder (consecutive integer prices). REST does not group.
 * - The l2Book stream does. Schema WsL2BookSubscriptionParams: tickSize is
 *   symbol.tickSize * (1, 2, 5, 10, 100, 1000), and the channel only pushes
 *   the top 20 levels. Subscribing BTC-USD at tickSize "10" came back grouped
 *   (bids 84600, 84590, … and asks 84610, 84620, … — floor and ceil) but
 *   still 20/20. At the same moment REST limit=500 held the whole book
 *   (232 bids, 148 asks). Feeding the rows from that 20-level push would
 *   throw away the tail `mergeBookSide` keeps, so the selected step is
 *   applied here, on the merged book, not by re-subscribing.
 *
 * A step finer than the tick, or not a multiple of it, is not offered.
 * SoDEX rejects an off-tick price, and an l2Book tickSize has to be a
 * multiple of the symbol tick.
 */

/** How many steps SoDEX's menu builds. 3 on every symbol checked above. */
export const SODEX_DEPTH_PRECISION_MERGE = 3;

/** 8 decimal places — past any tick this venue lists, and inside a safe integer. */
const STEP_SCALE = 1e8;

/**
 * Grouping steps for a symbol whose minimum price increment is `tick`,
 * finest first. Empty when `tick` is not a positive finite number; the
 * caller then falls back to the tick itself.
 */
export function groupingSteps(tick: number): number[] {
  if (!(tick > 0) || !Number.isFinite(tick)) return [];
  const tickU = Math.round(tick * STEP_SCALE);
  if (tickU <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < SODEX_DEPTH_PRECISION_MERGE; i++) {
    const stepU = tickU * 10 ** i;
    // tick * 10^i is a multiple of the tick by construction; the modulus
    // drops a step the scale could not represent as one.
    if (stepU % tickU !== 0) continue;
    const step = stepU / STEP_SCALE;
    if (step < tick) continue;
    if (out.length && out[out.length - 1] === step) continue;
    out.push(step);
  }
  return out;
}
