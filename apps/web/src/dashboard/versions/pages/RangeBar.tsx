/**
 * Pulse's line under the coin row (localhost version): where the price sits between its 24-hour low and high.
 *
 * Every figure is SoDEX's own, read exactly as the coin row reads them (Market.tsx TickerBar): the ticker channel's
 * last, high and low (`c`, `h`, `l`), else the shared REST tickers' lastPx / highPx / lowPx. Nothing is drawn while
 * either end is missing - a bar with an invented end would place the price nowhere.
 */
import { useState } from 'react';
import type { Engine, Symbol as MarketSymbol } from '../../../api';
import { fmtPrice, pick } from '../../../format';
import { useChannel, useTickers } from '../../../hooks';

/** The coin row's REST poll (Market.tsx TICKERS_POLL_MS): one shared read, not a second one. */
const POLL_MS = 30_000;

export function RangeBar({ engine, symbol, sym }: { engine: Engine; symbol: string; sym?: MarketSymbol }) {
  const [live, setLive] = useState<any>(null);
  useChannel(engine, { channel: 'ticker', symbols: [symbol] }, (d) => {
    const row = Array.isArray(d) ? d.find((e: any) => e.s === symbol) : d;
    if (row) setLive(row);
  });
  const rest = useTickers(engine, { pollMs: POLL_MS }).data?.tickers?.find((t) => t.symbol === symbol);
  const last = Number(pick(live, 'c') ?? rest?.lastPx);
  const high = Number(pick(live, 'h') ?? rest?.highPx);
  const low = Number(pick(live, 'l') ?? rest?.lowPx);
  if (!(high > 0) || !(low > 0) || !(last > 0) || high < low) return null;
  const span = high - low;
  const at = span > 0 ? Math.min(1, Math.max(0, (last - low) / span)) : 0.5;
  const tick = sym?.tickSize;
  return (
    <div className="pls-range" role="group" aria-label="24 hour range">
      <span className="pls-range__k">24h low</span>
      <b className="pls-range__v">{fmtPrice(low, tick)}</b>
      <span className="pls-range__bar" role="meter" aria-valuemin={low} aria-valuemax={high} aria-valuenow={last} aria-label="Price within the 24 hour range">
        <span className="pls-range__fill" style={{ width: `${at * 100}%` }} />
        <span className="pls-range__dot" style={{ left: `${at * 100}%` }} />
      </span>
      <b className="pls-range__v">{fmtPrice(high, tick)}</b>
      <span className="pls-range__k">24h high</span>
    </div>
  );
}
