/**
 * The chart library's chunk (klinecharts, ~52 KB brotli), asked for once.
 *
 * The chart used to import it in its create-once effect, which runs only after
 * the trade page has rendered and committed: on a phone on Slow 4G that put one
 * more round trip plus the chunk's transfer between the first paint and the
 * first candle request (the request waits for the library, see getBars in
 * Chart.tsx). Chart.tsx now starts this download when its module evaluates -
 * the trade chunk arriving, before React renders the page - and the effect
 * awaits the same promise.
 *
 * A failed download is not kept as a rejection: the next caller asks again, so
 * the chart's own retry (Chart.tsx, initAttempt) really retries the chunk.
 */
type KlineLib = typeof import('klinecharts');

let load: Promise<KlineLib> | null = null;

/** Test seam: what fetches the chunk. */
export const klineLibEnv = { importLib: (): Promise<KlineLib> => import('klinecharts') };

/** The library, downloaded once and shared; a failure is forgotten so the next call retries. */
export function loadKlineLib(): Promise<KlineLib> {
  if (load) return load;
  const p = klineLibEnv.importLib();
  load = p;
  p.catch(() => {
    if (load === p) load = null;
  });
  return p;
}

/** Start the download now and let the chart pick it up; a failure here is the chart's to retry. */
export function preloadKlineLib(): void {
  loadKlineLib().catch(() => undefined);
}

/** For tests: forget the promise. */
export function _resetKlineLib(): void {
  load = null;
}
