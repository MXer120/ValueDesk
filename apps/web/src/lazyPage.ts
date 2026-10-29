/**
 * Code-split pages that never show a loading state.
 *
 * React.lazy suspends on every FIRST render, even when the chunk is already in
 * memory: it cannot read a native promise synchronously. That turns every
 * first visit to a page into a Suspense fallback - a blank frame the
 * single-bundle app never had. This wrapper keeps the loaded component in a
 * plain variable instead, so once `preload()` has resolved the page renders
 * synchronously, exactly like a static import.
 *
 * How App.tsx uses it, so that no navigation shows a fallback:
 *   - the landing page's chunk starts loading as soon as the entry runs, and
 *     the whole shell waits for it under ONE top-level <Suspense>: the screen
 *     stays blank until it can paint complete, as it did when all of the app
 *     was one script;
 *   - every other page is fetched once the first one has painted (idle time),
 *     and on hover/focus of a link to it;
 *   - a navigation to a page whose code is not in yet waits for it - the
 *     current page stays up - and then changes the URL and the page together.
 *
 * A chunk that fails to load (a deploy replaced the hashed file names, or the
 * network dropped) is retried once; if a render is waiting on it and it still
 * fails, the page reloads - at most once a minute - which fetches the current
 * build. Past that, the error goes to the nearest error boundary instead of
 * looping.
 */
import { createElement, lazy, type ComponentType, type LazyExoticComponent, type ReactElement } from 'react';
import { logger } from './log';

const log = logger('pages');

export interface LazyPage<P extends object> {
  (props: P): ReactElement;
  /** Start loading, once; resolves when rendering will not suspend. */
  preload(): Promise<void>;
  /** The code is in: rendering this renders the page synchronously. */
  readonly ready: boolean;
  displayName?: string;
}

/** Test seam: the reload, the retry delay, the clock and the storage. */
export const lazyPageEnv = {
  reload: (): void => window.location.reload(),
  retryDelayMs: 400,
  now: (): number => Date.now(),
  storage: (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  },
};

const RELOAD_KEY = 'vs.chunkReloadAt';
const RELOAD_WINDOW_MS = 60_000;

/**
 * What a reload would stop: the algos and copies this tab runs (browserAlgos.ts and
 * browserCopier.ts register themselves). While one says so, an update never reloads the
 * tab by itself - it says an update is waiting instead (`vs:update-held`, UpdateHeld.tsx),
 * and the user reloads once their algo or copy can stop.
 */
const holds = new Set<() => string | null>();
/** A reason the tab must not reload now ("2 live algos"), or null. Returns the unregister. */
export function holdReloadWhile(why: () => string | null): () => void {
  holds.add(why);
  return () => holds.delete(why);
}
/** Why the tab must not reload now, or null. */
export function reloadHeldBy(): string | null {
  for (const h of holds) {
    try {
      const r = h();
      if (r) return r;
    } catch {
      return 'a running algo or copy';
    }
  }
  return null;
}
export const UPDATE_HELD_EVENT = 'vs:update-held';

/**
 * Reload to pick up the current build, unless that already happened within
 * the last minute - then a stale build is not the problem and a reload loop
 * would only hide the real error - or this tab runs something a reload would
 * stop. Returns whether it reloaded.
 */
export function reloadForChunkError(): boolean {
  const held = reloadHeldBy();
  if (held) {
    log.warn('a new build is out, not reloading: this tab runs ' + held);
    try {
      window.dispatchEvent(new CustomEvent(UPDATE_HELD_EVENT, { detail: held }));
    } catch {
      /* no window (tests): the log line is the record */
    }
    return false;
  }
  const s = lazyPageEnv.storage();
  const now = lazyPageEnv.now();
  let last = 0;
  try {
    last = Number(s?.getItem(RELOAD_KEY) ?? 0) || 0;
  } catch {
    /* unreadable storage: treat as never reloaded */
  }
  if (last && now - last < RELOAD_WINDOW_MS) return false;
  try {
    s?.setItem(RELOAD_KEY, String(now));
  } catch {
    /* storage full or disabled: the loop guard is best-effort */
  }
  log.warn('reloading to fetch the current build after a page chunk failed to load');
  lazyPageEnv.reload();
  return true;
}

/**
 * Every OTHER lazily loaded module (the trading actions behind Cancel all, the
 * wallet modal, the chart library, ...): Vite reports a failed dynamic import
 * as `vite:preloadError`. When a deploy replaced the hashed file names while
 * this tab was open, the old name answers 404 - reload once to the current
 * build (same loop guard as the pages) instead of a "Failed to fetch
 * dynamically imported module" error. Seen live on 2026-10-03 after a release.
 */
export function installChunkErrorReload(target: Pick<Window, 'addEventListener'> = window): void {
  target.addEventListener('vite:preloadError', (e: Event) => {
    if (reloadForChunkError()) e.preventDefault();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Thrown while a reload is under way: keeps the tree suspended, no error UI. */
const NEVER = new Promise<never>(() => {});

/** What a browser says when a module it was asked for is not there (a deploy renamed it). */
export const isChunkError = (e: unknown): boolean =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload/i.test(String((e as { message?: unknown })?.message ?? e));

/** In place of a part that could not load from an older build, while a reload is not wanted. */
function StaleBuild(): ReactElement {
  return createElement('p', { className: 'stale-build', role: 'status' },
    'A new version of ValueDesk is out: reload the page to open this.',
    createElement('button', { type: 'button', className: 'stale-build__btn', onClick: () => lazyPageEnv.reload() }, 'Reload'));
}

/**
 * React.lazy for a part of a page (the algo table, the algo ticket, the editors, ...),
 * with the deploy case handled here rather than left to `vite:preloadError`, which
 * does not fire for every chunk: a tab opened on build A that asks for a file of build A
 * after build B replaced it got a 404 and the error boundary ("Failed to fetch dynamically
 * imported module: /assets/AlgoTable-....js", owner's report 2026-10-29). Now: one retry,
 * then the same once-a-minute reload as the pages - or, when the tab must not reload (a
 * browser algo runs here) or just did, a line and a Reload button in place of the part.
 * Any other error is thrown as before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(() => loadChunk(load));
}

/** lazyChunk's loader (the tests drive it): the module, a reload under way (never settles), or the reload note. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): Promise<{ default: T }> {
  try {
    return await load();
  } catch (first) {
    if (!isChunkError(first)) throw first;
    await sleep(lazyPageEnv.retryDelayMs);
    try {
      return await load();
    } catch (again) {
      if (!isChunkError(again)) throw again;
      if (reloadForChunkError()) return NEVER;
      log.warn('a part of the page is from an older build and could not load; showing a reload note', { error: String(again) });
      return { default: StaleBuild as unknown as T };
    }
  }
}
export { StaleBuild };

export function lazyPage<P extends object>(name: string, load: () => Promise<ComponentType<P>>): LazyPage<P> {
  let Comp: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  let failed: Error | null = null;
  /** A render is waiting on the current attempt (not just a prefetch). */
  let renderWaiting = false;

  const attempt = async (): Promise<ComponentType<P>> => {
    try {
      return await load();
    } catch (first) {
      log.warn(`loading the ${name} page failed, retrying once`, { error: String(first) });
      await sleep(lazyPageEnv.retryDelayMs);
      return load();
    }
  };

  const preload = (): Promise<void> => {
    if (Comp) return Promise.resolve();
    pending ??= attempt().then(
      (c) => {
        Comp = c;
        failed = null;
        pending = null;
        log.debug(`${name} page loaded`);
      },
      (err: unknown) => {
        pending = null;
        failed = err instanceof Error ? err : new Error(String(err));
        log.error(`the ${name} page could not be loaded`, { error: failed.message });
        throw failed;
      },
    );
    return pending;
  };

  function Page(props: P): ReactElement {
    if (Comp) return createElement(Comp, props);
    if (!pending && failed && renderWaiting) {
      // The attempt this render waited on failed (after its own retry).
      const err = failed;
      failed = null;
      renderWaiting = false;
      if (reloadForChunkError()) throw NEVER;
      throw err;
    }
    renderWaiting = true;
    // Suspend until the chunk is in. A rejection re-renders into the branch above.
    throw preload().catch(() => undefined);
  }
  Page.displayName = `Page(${name})`;
  Page.preload = preload;
  Object.defineProperty(Page, 'ready', { get: () => Comp !== null });
  return Page as LazyPage<P>;
}
