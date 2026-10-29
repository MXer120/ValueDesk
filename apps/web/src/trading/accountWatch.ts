/**
 * Waiting for a first deposit to open the account, app-wide.
 *
 * A wallet SoDEX has never seen shows "deposit first" in several places (the
 * order button, Transfer, the address menu). Whichever way the first deposit
 * comes in - the Deposit sheet, sodex.com, an exchange - every one of them must
 * turn into the normal view by itself, without a reload. So while the
 * connected wallet's account status is 'none', the session looks it up again:
 *
 *   - after 5 s, then each wait doubles up to once a minute;
 *   - at once when the window gets focus or the tab is shown again (the user
 *     coming back from the wallet or another site), at most once per 5 s;
 *   - back to the fast start when something says a deposit is under way
 *     (`nudge`: the Deposit sheet opened on this wallet, or saw a deposit land).
 *
 * Nothing is looked up while the tab is hidden. One look is the subaccounts
 * read plus at most two engine-state reads (weight 15 of the 1200/min per-IP
 * budget): the steady once a minute is about 1% of it.
 *
 * Read-only; the caller's `check` does the looking and updates the status,
 * which ends the watch (`follow(null)`).
 */

export const WATCH_FIRST_MS = 5_000;
export const WATCH_MAX_MS = 60_000;

export interface AccountWatchDeps {
  /** Look the account up again (session.ts: refreshAccount). */
  check: (owner: string) => Promise<unknown>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  now: () => number;
  /** True while the tab is in the background. */
  hidden: () => boolean;
}

export interface AccountWatch {
  /** The wallet whose account is 'none' right now, or null: nothing to wait for. */
  follow: (owner: string | null) => void;
  /** A deposit may be on its way: look again soon (`now`: at once), and start the waits over. */
  nudge: (now?: boolean) => void;
  /** The window got focus or the tab was shown again. */
  shown: () => void;
  /** Whom the watch is waiting for (tests). */
  readonly owner: string | null;
}

export function createAccountWatch(deps: AccountWatchDeps): AccountWatch {
  let owner: string | null = null;
  let wait = WATCH_FIRST_MS;
  let timer: unknown = null;
  let running = false;
  let lastAt = -Infinity;
  /** A look was due while the tab was hidden: it runs when the tab is shown. */
  let missed = false;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number) => {
    clear();
    if (owner) timer = deps.setTimer(tick, ms);
  };
  async function look(): Promise<void> {
    const o = owner;
    if (!o || running) return;
    running = true;
    lastAt = deps.now();
    try {
      await deps.check(o);
    } catch {
      /* the next look tries again */
    } finally {
      running = false;
    }
  }
  function tick(): void {
    timer = null;
    const o = owner;
    if (!o) return;
    if (deps.hidden()) {
      missed = true;
      return;
    }
    void look().then(() => {
      // Followed someone else, or nudged, meanwhile: their timer stands.
      if (owner !== o || timer !== null) return;
      wait = Math.min(wait * 2, WATCH_MAX_MS);
      arm(wait);
    });
  }

  return {
    follow(next) {
      if (next === owner) return;
      clear();
      owner = next;
      wait = WATCH_FIRST_MS;
      missed = false;
      if (owner) arm(wait);
    },
    nudge(now = false) {
      if (!owner) return;
      wait = WATCH_FIRST_MS;
      if (now) {
        clear();
        tick();
      } else arm(wait);
    },
    shown() {
      if (!owner) return;
      if (!missed && deps.now() - lastAt < WATCH_FIRST_MS) return;
      missed = false;
      wait = WATCH_FIRST_MS;
      clear();
      tick();
    },
    get owner() {
      return owner;
    },
  };
}
