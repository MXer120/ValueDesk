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
import { createElement, type ComponentType, type ReactElement } from 'react';
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
 * Reload to pick up the current build, unless that already happened within
 * the last minute - then a stale build is not the problem and a reload loop
 * would only hide the real error. Returns whether it reloaded.
 */
export function reloadForChunkError(): boolean {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Thrown while a reload is under way: keeps the tree suspended, no error UI. */
const NEVER = new Promise<never>(() => {});

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
