/**
 * GET /api/md/{engine}/klines for both charts, with the two things api.klines()
 * does not take: an AbortSignal (so a superseded or timed-out request is
 * really cancelled, not just ignored) and `endTime` (TradingView paging).
 *
 * The route and its answer are exactly the ones api.klines() uses:
 * `{ klines: Kline[] }`, newest first, decimal strings.
 */
import { ApiError, type Engine } from '../api';

export interface KlineQuery {
  engine: Engine;
  symbol: string;
  interval: string;
  limit: number;
  /** Inclusive upper bound, ms. */
  endTime?: number;
}

/**
 * The chart asks for a price SOURCE through the symbol: `BTC-USD` is the latest
 * traded price, `BTC-USD@mark` / `BTC-USD@index` the mark and index candles
 * (Chart.tsx). Everything keyed by the chart's ticker - loads, paging, the
 * live-candle guard - then follows the source without further plumbing.
 */
export function klinesPath(q: KlineQuery): string {
  const [symbol, source] = q.symbol.split('@');
  const params = new URLSearchParams({ symbol: symbol!, interval: q.interval, limit: String(q.limit) });
  if (source === 'mark' || source === 'index') params.set('source', source);
  if (q.endTime !== undefined) params.set('endTime', String(q.endTime));
  return `/api/md/${q.engine}/klines?${params}`;
}

/**
 * The raw rows. Rejects with ApiError on an HTTP error, with a message that
 * says what happened on a timeout, and with the AbortError itself when the
 * CALLER aborted (so a caller can tell "cancelled" from "failed").
 */
export async function fetchKlineRows(
  q: KlineQuery,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown[]> {
  const path = klinesPath(q);
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          ctl.abort();
        }, opts.timeoutMs)
      : undefined;
  try {
    let res: Response;
    try {
      res = await fetch(path, { signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw new ApiError(`${path} did not respond within ${Math.round(opts.timeoutMs! / 1000)}s`, 0);
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError(`Cannot reach the Valuescan backend (${(e as Error).message})`, 0);
    }
    const body = (await res.json().catch(() => null)) as { klines?: unknown; error?: string } | null;
    // An abort while the body was streaming must not read as "no bars".
    if (ctl.signal.aborted) {
      if (timedOut) throw new ApiError(`${path} did not respond within ${Math.round(opts.timeoutMs! / 1000)}s`, 0);
      throw new DOMException('aborted', 'AbortError');
    }
    if (!res.ok) throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status);
    return Array.isArray(body?.klines) ? body.klines : [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
