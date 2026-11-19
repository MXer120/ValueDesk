/**
 * NAVIGATION THAT ANSWERS THE TAP (nav pass, 2026-11-18).
 *
 * A tap on a tab used to show nothing until the next page had rendered - and on a link Chrome rates '3g' (every
 * Slow 4G phone) not until its code had downloaded: 1.1-2.2 s of an unchanged screen, measured. Now:
 *
 *   1. the tapped tab lights in the frame after the tap: `beginNav` puts the target in a small store only the nav
 *      bars read (PhoneTabBar, NavBar, SideBar through App.tsx's LitNav), so that commit is a few dozen nodes, not
 *      the app;
 *   2. the page itself commits after that frame has been painted (`afterNextPaint`), or once its code is in;
 *   3. a wait past SLOW_MS shows the app's spinner (funds.css .fx-spin) in the lit tab;
 *   4. the store clears in the same commit the page lands in (`settleNav`, App.tsx's layout effect), so the bar
 *      never flickers back to the old tab.
 *
 * Not startTransition: on /trade the book and price ticks (~10 default-lane updates a second) restart a transition
 * render, and React 18 forces an expired one only after ~5 s.
 *
 * `openPath` is how any part of the app opens one of its own URLs in place (it used to assign window.location and
 * reload the whole app: 5.5-8 s on a phone). App.tsx registers the opener; without one (tests, a page outside the
 * shell) it falls back to a document navigation.
 */
import { useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';

/** A wait for the next page longer than this shows the spinner in the lit tab. */
export const SLOW_MS = 250;

/**
 * Run `fn` once the frame that follows now has been painted: a rAF runs before that frame's paint, and a message
 * posted from it is handled after the paint. A hidden tab paints no frames: then a timer stands in.
 */
export function afterNextPaint(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
    setTimeout(run, 0);
    return;
  }
  requestAnimationFrame(() => {
    if (typeof MessageChannel === 'function') {
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        c.port1.close();
        run();
      };
      c.port2.postMessage(0);
    } else setTimeout(run, 0);
  });
  // A frame that never comes (the tab hidden after the check): the page still changes.
  setTimeout(run, 500);
}

/* --- which page a navigation is going to --------------------------------------------------------------- */

export interface Pending {
  /** The route being opened (routeKey in router.ts: 'tab:trade', 'sodex:points', 'legal:terms', 'status' ...). */
  key: string;
  /** Waiting past SLOW_MS: show the spinner. */
  slow: boolean;
}

let pending: Pending | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const say = () => listeners.forEach((f) => f());

/** Light `key` now; the spinner joins after SLOW_MS if the page has not landed by then. */
export function beginNav(key: string): void {
  if (slowTimer) clearTimeout(slowTimer);
  pending = { key, slow: false };
  slowTimer = setTimeout(() => {
    slowTimer = null;
    if (pending && pending.key === key && !pending.slow) {
      pending = { key, slow: true };
      say();
    }
  }, SLOW_MS);
  say();
}

/** The page on screen is now `committed`: a navigation to it is over (a later one to elsewhere stays). */
export function settleNav(committed: string | null): void {
  if (!pending || (committed !== null && pending.key !== committed)) return;
  cancelNav();
}

/** Forget the pending navigation (it landed, or was replaced by one with nothing to wait for). */
export function cancelNav(): void {
  if (slowTimer) clearTimeout(slowTimer);
  slowTimer = null;
  if (!pending) return;
  pending = null;
  say();
}

export const pendingNav = (): Pending | null => pending;

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** The navigation under way, or null. Only the nav bars read it. */
export function usePendingNav(): Pending | null {
  return useSyncExternalStore(subscribe, pendingNav, () => null);
}

/* --- the latest request wins --------------------------------------------------------------------------- */

let ticket = 0;
/** A new navigation: every earlier one that is still waiting gives way. */
export const navTicket = (): number => ++ticket;
export const isLatestNav = (t: number): boolean => t === ticket;

/* --- opening one of the app's own URLs in place -------------------------------------------------------- */

type Opener = (url: string) => void;
let opener: Opener | null = null;

/** App.tsx: how a URL of this app opens without a reload. Returns the unregister. */
export function setPathOpener(fn: Opener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Open `url` (a path of this app, with its query) in place: the page waits for its code, Back returns. */
export function openPath(url: string): void {
  if (opener) opener(url);
  else if (typeof window !== 'undefined') window.location.assign(url);
}

/**
 * A plain left click on a link to one of the app's URLs opens it in place; a modified or middle click, or a link
 * that opens elsewhere, is left to the browser (a new tab, a copied link). True when it was handled here.
 */
export function plainClick(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button' | 'defaultPrevented'>): boolean {
  return !(e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

/** onClick for an `<a href>` to a page of this app: opens it in place. */
export const openInPlace = (url?: string) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
  if (!plainClick(e)) return;
  const a = e.currentTarget;
  if (a.target && a.target !== '_self') return;
  e.preventDefault();
  openPath(url ?? `${a.pathname}${a.search}${a.hash}`);
};

/** The page scroller (.appcontent, styles.css): the window itself never scrolls. */
export const pageScroller = (): HTMLElement | null =>
  typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.appcontent');

/** Back to the top of the page (a view switch inside a page; the window.scrollTo this replaces did nothing). */
export function scrollPageTop(smooth = false): void {
  const el = pageScroller();
  if (!el) return;
  if (smooth) el.scrollTo({ top: 0, behavior: 'smooth' });
  else el.scrollTop = 0;
}
