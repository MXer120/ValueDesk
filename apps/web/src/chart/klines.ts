/**
 * Candles for both charts, straight from SoDEX (the gateway, or the data host
 * for mark / index candles) - the same answer /api/md/{engine}/klines gave,
 * read in this browser - with the two things api.klines()
 * does not take: an AbortSignal (so a superseded or timed-out request is
 * really cancelled, not just ignored) and `endTime` (TradingView paging).
 *
 * The route and its answer are exactly the ones api.klines() uses:
 * `{ klines: Kline[] }`, newest first, decimal strings.
 */
import { SodexApiError } from '@sodex-core';
import { ApiError, type Engine } from '../api';
import { MarketRequestError, market } from '../exchange/sodexMarket';
import { RateLimitedError, UnreachableError } from '../exchange/errors';

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
 *
 * The read itself is shared (identical concurrent reads are one request, and
 * the answer is kept 2 s), so a caller's abort stops waiting for it rather
 * than cancelling it for everyone else.
 */
export async function fetchKlineRows(
  q: KlineQuery,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown[]> {
  const path = klinesPath(q);
  const [symbol, source] = q.symbol.split('@');
  if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () => reject(new ApiError(`${path} did not respond within ${Math.round(opts.timeoutMs! / 1000)}s`, 0)),
        opts.timeoutMs,
      );
    }
    onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const r = await Promise.race([
      market.klines(q.engine, symbol!, q.interval, q.limit, {
        endTime: q.endTime,
        source: source === 'mark' || source === 'index' ? source : undefined,
      }),
      stop,
    ]);
    return Array.isArray(r.klines) ? r.klines : [];
  } catch (e) {
    if ((e as Error).name === 'AbortError' || e instanceof ApiError) throw e;
    if (e instanceof MarketRequestError) throw new ApiError(e.message, e.status);
    if (e instanceof SodexApiError) throw new ApiError(e.message, e.httpStatus >= 400 ? e.httpStatus : 400, e.hint, e.code, 'sodex');
    if (e instanceof RateLimitedError) throw new ApiError(e.message, 429);
    if (e instanceof UnreachableError) throw new ApiError(`Cannot reach SoDEX (${e.message})`, 0);
    throw new ApiError((e as Error)?.message ?? String(e), 0);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}
