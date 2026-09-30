/**
 * Runtime loader for TradingView Advanced Charts.
 *
 * The library is NOT a dependency and is never bundled: it is licensed, lives
 * in TradingView's private repository, and must not be pulled from an npm
 * package or a mirror that redistributes it. The owner copies it into
 * apps/web/public/charting_library/ (gitignored), and this file finds it there
 * at runtime:
 *
 *   1. PROBE  HEAD {library_path}charting_library.standalone.js
 *   2. LOAD   a classic <script> for it (same origin, so `script-src 'self'`
 *             in index.html already allows it)
 *   3. CHECK  window.TradingView.widget is a constructor
 *
 * THE PROBE HAS TO READ THE CONTENT TYPE, not just the status. The dev server
 * (and any SPA host) answers a missing file with index.html and a 200 -
 * verified against this repo's Vite: `200 text/html` for the missing path.
 * Loading that as a script would throw a SyntaxError into the console; treating
 * it as "present" would leave an empty chart. HTML means "not installed".
 *
 * The result is cached for the page's lifetime. Copying the files in is
 * followed by a reload anyway, and a failed probe must not be retried by every
 * chart instance (desktop panel + mobile carousel mount two).
 */
import type { TradingViewGlobal } from './types';

const base = (): string => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
};

/** Where the owner puts the library. Must end with a slash - the widget
 *  resolves its own bundles and iframe page relative to it. */
export const LIBRARY_PATH = `${base()}charting_library/`;
export const STANDALONE_FILE = 'charting_library.standalone.js';

const SCRIPT_TIMEOUT_MS = 20_000;

export type ProbeVerdict = { ok: true } | { ok: false; reason: string };
export type LoadResult = { ok: true; tv: TradingViewGlobal } | { ok: false; reason: string };

/** Pure: is this response the library script? */
export function judgeProbe(status: number, contentType: string | null | undefined): ProbeVerdict {
  if (status === 404 || status === 410) return { ok: false, reason: 'library files not found' };
  if (status < 200 || status >= 300) return { ok: false, reason: `library probe answered HTTP ${status}` };
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('html')) {
    return { ok: false, reason: 'library files not found (the server answered with the app page instead)' };
  }
  if (ct && !ct.includes('javascript') && !ct.includes('ecmascript')) {
    return { ok: false, reason: `library probe returned ${ct}, not JavaScript` };
  }
  return { ok: true };
}

function globalTv(): TradingViewGlobal | null {
  const tv = (globalThis as { TradingView?: Partial<TradingViewGlobal> }).TradingView;
  return tv && typeof tv.widget === 'function' ? (tv as TradingViewGlobal) : null;
}

async function probe(url: string): Promise<ProbeVerdict> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    // A static host that refuses HEAD is not proof the file is missing.
    if (res.status === 405 || res.status === 501) res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    return { ok: false, reason: `library probe failed: ${(e as Error).message}` };
  }
  return judgeProbe(res.status, res.headers.get('content-type'));
}

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const timer = window.setTimeout(() => reject(new Error('library script timed out')), SCRIPT_TIMEOUT_MS);
    s.src = url;
    s.async = true;
    s.dataset.vsTradingview = '';
    s.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      window.clearTimeout(timer);
      s.remove();
      reject(new Error('library script failed to load'));
    };
    document.head.appendChild(s);
  });
}

let cached: Promise<LoadResult> | null = null;
let settled: LoadResult | null = null;

/** The settled result, if the loader has finished - lets a remount skip the
 *  "loading" frame. */
export function peekTradingView(): LoadResult | null {
  return settled;
}

export function loadTradingView(): Promise<LoadResult> {
  if (!cached) {
    cached = (async (): Promise<LoadResult> => {
      const ready = globalTv();
      if (ready) return { ok: true, tv: ready };
      const url = `${LIBRARY_PATH}${STANDALONE_FILE}`;
      const verdict = await probe(url);
      if (!verdict.ok) return verdict;
      try {
        await injectScript(url);
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
      const tv = globalTv();
      return tv ? { ok: true, tv } : { ok: false, reason: 'library loaded but window.TradingView.widget is missing' };
    })().then((r) => (settled = r));
  }
  return cached;
}
