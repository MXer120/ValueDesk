/**
 * Whether anyone is using the page: `data-still` on <html> once the window loses focus or no input
 * came for STILL_MS, gone at the next input (a pointer over an unfocused window counts).
 * Decorative motion rests on it in the look reduced motion already gives it (owner 2026-11-01:
 * "optimize everything & every page/element. Loading times + device hardware usage"):
 *   - the order ticket's glare (OrderEntry.css) and the copy cards' (CopyHome.css),
 *   - the draft order's pulsing line on the chart (chart.css),
 *   - the copy hero's whale (DotWhale.tsx: the dip, the twinkle),
 *   - the pulsing "live" marks: the heatmap's stream, the live feed, running algos, a copy running
 *     (lit, not pulsing: one running animation keeps every frame drawn).
 * Measured on www, /trade with nothing changing: the glare and the pulse alone kept the GPU process
 * at ~120 ms of CPU a second and the renderer at ~45 (each frame repainted or recomposited, 60
 * times a second, for as long as the tab was open). Data never rests on this: prices, books and
 * polls go on as before.
 */

/** No input for this long: still. */
export const STILL_MS = 20_000;

export interface Attention {
  /** An input: moving again (if still). */
  activity(now: number): void;
  focus(has: boolean, now: number): void;
  /** The clock: still once STILL_MS passed without input. */
  check(now: number): void;
  readonly still: boolean;
}

/** The rule, without the DOM: `set` is told every change. */
export function createAttention(set: (still: boolean) => void, now: number, focused = true, stillMs = STILL_MS): Attention {
  // The last input; a window losing focus counts as long ago.
  let last = focused ? now : -Infinity;
  let still = false;
  const apply = (t: number) => {
    const s = t - last >= stillMs;
    if (s !== still) { still = s; set(s); }
  };
  apply(now);
  return {
    activity(t) { last = t; apply(t); },
    focus(has, t) { last = has ? t : -Infinity; apply(t); },
    check(t) { apply(t); },
    get still() { return still; },
  };
}

const listeners = new Set<(still: boolean) => void>();
let state: Attention | null = null;

/** Once, at boot (main.tsx). */
export function startAttention(): void {
  if (state || typeof document === 'undefined') return;
  const root = document.documentElement;
  state = createAttention((s) => {
    root.toggleAttribute('data-still', s);
    for (const f of [...listeners]) f(s);
  }, Date.now(), document.hasFocus());
  const act = () => state!.activity(Date.now());
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(t, act, { capture: true, passive: true });
  }
  window.addEventListener('focus', () => state!.focus(true, Date.now()));
  window.addEventListener('blur', () => state!.focus(false, Date.now()));
  // Four looks a minute; a hidden tab's timer is slowed by the browser, and nothing animates there anyway.
  setInterval(() => state!.check(Date.now()), 5_000);
}

/** Whether the page rests now (false before startAttention). */
export const isStill = (): boolean => state?.still ?? false;

/** Called on every change. Returns the unsubscribe. */
export function onStill(f: (still: boolean) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
