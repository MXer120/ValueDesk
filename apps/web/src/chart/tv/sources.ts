/**
 * Browser wiring for the datafeed: the real api.ts / ws.ts behind the
 * injectable edges of datafeed.ts. Nothing here decides anything.
 */
import { api, type Engine } from '../../api';
import { hub } from '../../ws';
import { fetchKlineRows } from '../klines';
import type { DatafeedDeps } from './datafeed';

export function browserDatafeedDeps(defaultEngine: () => Engine, resetChart?: () => void): DatafeedDeps {
  return {
    defaultEngine,
    loadSymbols: (engine) => api.symbols(engine).then((r) => r.symbols ?? []),
    // GET /api/md/{engine}/klines - the route api.klines() uses, plus the
    // `endTime` TradingView pages with and the abort signal the failsafes
    // cancel superseded and timed-out requests with (../klines.ts).
    loadKlines: (q, signal) => fetchKlineRows(q, signal ? { signal } : {}),
    // Byte-for-byte the subscription Chart.tsx makes on the shared hub:
    // `{ channel: 'candle', symbol, interval }`.
    subscribeCandles: (engine, symbol, interval, onData) =>
      hub.subscribe(engine, { channel: 'candle', symbol, interval }, (d) => onData(d)),
    ...(resetChart ? { resetChart } : {}),
  };
}

/** Hub socket open AND the venue stream behind it for this engine - the same
 *  test the klinecharts chart applies. */
export const hubStreamOpen = (engine: Engine): boolean =>
  hub.state === 'open' && (hub.upstream[engine] ?? 'open') === 'open';

/** Every hub state change (socket, or the venue stream it relays). */
export const onHubState = (cb: () => void): (() => void) => hub.onState(() => cb());

/**
 * Fires after the hub comes back from a DROPPED connection - not on the first
 * open, and not on the status pings that re-announce 'open'. Bars that closed
 * while the socket was down never arrive as ticks, so the chart has to
 * re-read history then.
 */
export function onHubReconnect(cb: () => void): () => void {
  let opened = false;
  let dropped = false;
  return hub.onState((s) => {
    if (s === 'open') {
      if (opened && dropped) cb();
      opened = true;
      dropped = false;
    } else if (opened) {
      dropped = true;
    }
  });
}
