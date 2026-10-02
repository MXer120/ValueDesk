/**
 * Work that should be done before anyone needs it, but not while the page is
 * still fetching and drawing its first data.
 *
 * `arm()` schedules it: after `afterMs`, in the first idle moment of the main
 * thread (or `idleWithinMs` later if there is none). `now()` does it at once -
 * the user reached for the thing it is for. Either way it runs exactly once.
 */

export interface Later {
  /** Schedule the work, if it has neither run nor been scheduled. */
  arm(): void;
  /** Do the work now, if it has not run. */
  now(): void;
}

type IdleCallback = (cb: () => void, opts?: { timeout: number }) => unknown;

/** Test seam (and the fallback for a browser without requestIdleCallback). */
export const startLaterEnv = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
  idle: (): IdleCallback | undefined => (globalThis as { requestIdleCallback?: IdleCallback }).requestIdleCallback?.bind(globalThis),
};

export function startLater(start: () => void, afterMs: number, idleWithinMs: number): Later {
  let done = false;
  let timer: unknown;
  let armed = false;
  const now = (): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) startLaterEnv.clearTimeout(timer);
    timer = undefined;
    start();
  };
  return {
    arm(): void {
      if (done || armed) return;
      armed = true;
      timer = startLaterEnv.setTimeout(() => {
        timer = undefined;
        const idle = startLaterEnv.idle();
        // `now` checks `done`: a start that came meanwhile wins, and this is a no-op.
        if (idle) idle(now, { timeout: idleWithinMs });
        else now();
      }, afterMs);
    },
    now,
  };
}
