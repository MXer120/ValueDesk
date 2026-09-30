/**
 * Polling that stops while the tab is hidden and catches up the moment it is
 * shown again.
 *
 * Every poll now spends the user's own IP budget at each exchange, so a tab in
 * the background must not keep paying for numbers nobody is looking at. What
 * the user sees does not change: when the tab comes back, every poll that
 * missed a tick runs at once, before the next paint settles.
 */

const doc = (): Document | null => (typeof document === 'undefined' ? null : document);

/** True while the page is in a background tab (or minimised). */
export const isHidden = (): boolean => doc()?.visibilityState === 'hidden';

const shownListeners = new Set<() => void>();
let wired = false;

function wire(): void {
  const d = doc();
  if (wired || !d) return;
  wired = true;
  d.addEventListener('visibilitychange', () => {
    if (d.visibilityState !== 'visible') return;
    for (const fn of [...shownListeners]) {
      try {
        fn();
      } catch (e) {
        console.error('[exchange] visibility listener threw', e);
      }
    }
  });
}

/** Call `fn` every time the tab becomes visible again. Returns an unsubscribe. */
export function onShown(fn: () => void): () => void {
  wire();
  shownListeners.add(fn);
  return () => shownListeners.delete(fn);
}

/**
 * `setInterval(fn, ms)` that skips ticks while the tab is hidden and runs
 * once as soon as it is shown again if a tick was skipped (or the last run is
 * older than `ms`). Returns a stop function.
 */
export function pollEvery(ms: number, fn: () => void): () => void {
  let last = Date.now();
  let missed = false;
  const run = () => {
    last = Date.now();
    missed = false;
    fn();
  };
  const id = setInterval(() => {
    if (isHidden()) {
      missed = true;
      return;
    }
    run();
  }, ms);
  const off = onShown(() => {
    if (missed || Date.now() - last >= ms) run();
  });
  return () => {
    clearInterval(id);
    off();
  };
}

/**
 * A one-shot delay that does not fire while the tab is hidden: it fires when
 * the tab is shown again instead (at once if the delay has already passed).
 */
export function visibleTimeout(ms: number, fn: () => void): () => void {
  let done = false;
  let off: (() => void) | null = null;
  const fire = () => {
    if (done) return;
    if (isHidden()) {
      off ??= onShown(() => {
        off?.();
        off = null;
        fire();
      });
      return;
    }
    done = true;
    fn();
  };
  const id = setTimeout(fire, ms);
  return () => {
    done = true;
    clearTimeout(id);
    off?.();
  };
}
