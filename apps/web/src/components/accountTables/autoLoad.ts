/**
 * When the end of a paged table may load the next page on its own.
 *
 * History tables load more as the reader scrolls: the marker at the end of the
 * table asks for the next page when it comes into view (cells.tsx LoadMore).
 * One case must not run away: when a page lands and the end is STILL on screen
 * - a filter hides most rows, the panel is very tall - every page would pull
 * the next, and each is a read against SoDEX's history limit (2 a minute,
 * exchange/historyQueue.ts). So at most AUTO_CHAIN pages load back to back
 * while the end never left the screen; then the table waits for a press.
 * Scrolling the end out of view, or pressing, starts the count again.
 */
export interface AutoLoadState {
  /** Pages loaded in a row while the end stayed on screen. */
  chain: number;
  /** The end waits for a press (the button is shown). */
  stalled: boolean;
}

export const AUTO_CHAIN = 2;
export const AUTO_LOAD_START: AutoLoadState = { chain: 0, stalled: false };

/** The end of the table was observed: what it holds now, and whether to load. */
export function onEndSeen(s: AutoLoadState, visible: boolean): { state: AutoLoadState; load: boolean } {
  if (!visible) return { state: AUTO_LOAD_START, load: false };
  if (s.stalled) return { state: s, load: false };
  if (s.chain >= AUTO_CHAIN) return { state: { chain: s.chain, stalled: true }, load: false };
  return { state: { chain: s.chain + 1, stalled: false }, load: true };
}
