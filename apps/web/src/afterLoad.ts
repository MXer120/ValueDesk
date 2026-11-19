/**
 * Code split out of a page's first render, fetched before anyone taps for it.
 *
 * The rule (phone pass, 2026-11-18): a part that is not drawn at the first paint - a menu's body, a widget the
 * layout does not place, the share-card builders - leaves the first render, and is fetched once the page's own
 * load event has fired, in the first idle moment after it, so a tap on it still answers within 100 ms. Before the
 * load event the line belongs to the page's own data, fonts and images. A visitor who asked to save data
 * (Save-Data) fetches it only on intent (a press, a hover, a focus on what opens it).
 */

type IdleCallback = (cb: () => void, opts?: { timeout: number }) => number;

/** Test seam: the document, the window's load event, the idle queue and the connection. */
export const afterLoadEnv = {
  loaded: (): boolean => typeof document === 'undefined' || document.readyState === 'complete',
  onLoad: (fn: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('load', fn, { once: true });
    return () => window.removeEventListener('load', fn);
  },
  idle: (fn: () => void): (() => void) => {
    const ric = (globalThis as { requestIdleCallback?: IdleCallback; cancelIdleCallback?: (h: number) => void });
    if (typeof ric.requestIdleCallback === 'function') {
      const h = ric.requestIdleCallback(fn, { timeout: IDLE_WITHIN_MS });
      return () => ric.cancelIdleCallback?.(h);
    }
    const t = setTimeout(fn, 200);
    return () => clearTimeout(t);
  },
  saveData: (): boolean => {
    const conn = (globalThis.navigator as (Navigator & { connection?: { saveData?: boolean } }) | undefined)?.connection;
    return conn?.saveData === true;
  },
};

/** At most this long after the load event, idle or not. */
export const IDLE_WITHIN_MS = 3_000;

/** The visitor asked the browser to save data. */
export const saveData = (): boolean => afterLoadEnv.saveData();

/**
 * Run `fn` once, after the page's load event, in the first idle moment (within IDLE_WITHIN_MS). Returns a cancel.
 */
export function afterLoad(fn: () => void): () => void {
  let cancel: () => void = () => {};
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const queue = () => { cancel = afterLoadEnv.idle(run); };
  if (afterLoadEnv.loaded()) queue();
  else cancel = afterLoadEnv.onLoad(queue);
  return () => {
    done = true;
    cancel();
  };
}

/** `load` after the load event (afterLoad), unless the visitor saves data: then only on intent. Returns a cancel. */
export function prefetchAfterLoad(load: () => unknown): () => void {
  return afterLoad(() => {
    if (saveData()) return;
    try {
      const p = load();
      if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
    } catch {
      /* a prefetch never throws into the page: the part loads again when it is opened */
    }
  });
}
