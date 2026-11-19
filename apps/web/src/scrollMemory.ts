/**
 * ONE SCROLL MANAGER (nav pass, 2026-11-18).
 *
 * Every page scrolls inside one element, `.appcontent` (styles.css: the shell is the viewport and the window never
 * scrolls), so the browser's own scroll restoration does nothing for it, and the scroller's offset used to survive a
 * page switch: a page opened wherever the previous one had been read to, and Back landed wherever the scroller
 * happened to be. The rule now:
 *
 *   - a page opened by a link or a tab (a push) opens at its top (App.tsx's layout effect calls `top()`);
 *   - Back and Forward put the scroller where that history entry was, once its page is there: content that
 *     arrives late (a list still loading) is waited for, frame by frame, for up to RESTORE_MS, and any input of
 *     the user's ends the wait - their scroll is theirs;
 *   - the offsets are kept per history entry (the Navigation API's entry key where there is one, else a key in
 *     history.state), and in sessionStorage over a reload, so Back from another site lands on the same row.
 *
 * The dashboard's own scrollers (.dash-scroll, the carousel's pages) are not touched: only the page scroller.
 */

/** How long Back waits for a page's content to be tall enough for its old offset. */
export const RESTORE_MS = 2500;
/** Entries kept over a reload. */
const KEEP = 50;

export interface ScrollEnv {
  /** The current history entry's key. */
  key(): string;
  /** The page scroller. */
  el(): { scrollTop: number; scrollHeight: number; clientHeight: number } | null;
  raf(fn: () => void): number;
  caf(id: number): void;
  /** Scroll anchoring on the scroller on or off (CSS overflow-anchor). */
  anchor(on: boolean): void;
  now(): number;
  load(): Record<string, number>;
  save(saved: Record<string, number>): void;
}

export type NavKind = 'push' | 'pop';

export interface ScrollMemory {
  /** The scroller moved (its scroll event): remembered for this entry, unless a restore owns it. */
  scrolled(): void;
  /** The user touched, scrolled or typed: a restore still waiting gives way. */
  input(): void;
  /** A page was pushed (a link, a tab): it opens at its top. */
  pushed(): void;
  /** Back or Forward: the entry's own offset comes back once its page is there (`restore`). */
  popped(): void;
  /** How the route that just committed was reached, once (App.tsx reads it in its layout effect). */
  takeKind(): NavKind | null;
  /** The scroller to its top (a pushed page). */
  top(): void;
  /** The scroller to this entry's saved offset, from the next frame on, waiting for short content. */
  restore(): void;
  /** The offset kept for an entry (tests). */
  saved(key: string): number | undefined;
  /** Into storage, for a reload (pagehide). */
  persist(): void;
}

export function createScrollMemory(env: ScrollEnv): ScrollMemory {
  const saved = new Map<string, number>();
  try {
    for (const [k, v] of Object.entries(env.load())) if (typeof v === 'number' && Number.isFinite(v)) saved.set(k, v);
  } catch {
    /* unreadable storage: nothing kept */
  }
  /** A restore owns the scroller: its own writes (and the clamping while the page swaps) are not the user's. */
  let held = false;
  let frame = 0;
  let kind: NavKind | null = null;
  /* While Back restores, the browser's scroll anchoring is off: a page re-mounts with its upper sections still
     loading, and anchoring would follow whatever row sat at the old offset in the half-built page down as those
     sections grow (measured: 900 restored, 2070 shown) - with it off, the offset stays where that row ends up. */
  let anchorOff = false;
  let anchorTimer: ReturnType<typeof setTimeout> | null = null;
  const anchorBack = () => {
    if (anchorTimer) clearTimeout(anchorTimer);
    anchorTimer = null;
    if (anchorOff) env.anchor(true);
    anchorOff = false;
  };

  const remember = (key: string, y: number) => {
    saved.delete(key);
    saved.set(key, Math.max(0, Math.round(y)));
    if (saved.size > KEEP * 2) for (const k of [...saved.keys()].slice(0, saved.size - KEEP)) saved.delete(k);
  };
  const stop = () => {
    if (frame) env.caf(frame);
    frame = 0;
    anchorBack();
  };

  return {
    scrolled() {
      if (held) return;
      const el = env.el();
      if (el) remember(env.key(), el.scrollTop);
    },
    input() {
      stop();
      held = false;
    },
    pushed() {
      stop();
      held = false;
      kind = 'push';
    },
    popped() {
      stop();
      held = true;
      kind = 'pop';
    },
    takeKind() {
      const k = kind;
      kind = null;
      return k;
    },
    top() {
      const el = env.el();
      if (el && el.scrollTop !== 0) el.scrollTop = 0;
    },
    restore() {
      stop();
      const key = env.key();
      const y = saved.get(key) ?? 0;
      held = true;
      const until = env.now() + RESTORE_MS;
      if (y > 0) {
        env.anchor(false);
        anchorOff = true;
        anchorTimer = setTimeout(anchorBack, RESTORE_MS);
      }
      const step = () => {
        frame = 0;
        const el = env.el();
        if (!el) {
          held = false;
          return;
        }
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const to = Math.min(y, max);
        if (el.scrollTop !== to) el.scrollTop = to;
        if (max >= y) {
          // There: from now on the scroller's moves are the user's again.
          held = false;
          return;
        }
        // Still short after the wait: keep the old offset for this entry (the user's next scroll replaces it).
        if (env.now() >= until) return;
        frame = env.raf(step);
      };
      frame = env.raf(step);
    },
    saved: (key) => saved.get(key),
    persist() {
      try {
        env.save(Object.fromEntries([...saved].slice(-KEEP)));
      } catch {
        /* storage full or blocked: a reload starts at the top */
      }
    },
  };
}

/* --- in the browser ----------------------------------------------------------------------------------- */

const STORE = 'vs.scroll';

function entryKey(): string {
  const nav = (globalThis as { navigation?: { currentEntry?: { key?: string } | null } }).navigation;
  const k = nav?.currentEntry?.key;
  if (typeof k === 'string' && k) return k;
  // No Navigation API (Firefox, older Safari): a key of ours in the entry's state.
  const st = window.history.state as Record<string, unknown> | null;
  if (st && typeof st === 'object' && typeof st.vsk === 'string') return st.vsk;
  const made = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    window.history.replaceState({ ...(st && typeof st === 'object' ? st : {}), vsk: made }, '');
  } catch {
    /* a sandboxed frame: the key lives as long as this call */
  }
  return made;
}

let memory: ScrollMemory | null = null;
let scroller: HTMLElement | null = null;

/** The page's scroll memory (one per page). */
export function scrollMemory(): ScrollMemory {
  memory ??= createScrollMemory({
    key: entryKey,
    el: () => scroller,
    raf: (fn) => requestAnimationFrame(fn),
    caf: (id) => cancelAnimationFrame(id),
    anchor: (on) => {
      if (scroller) scroller.style.overflowAnchor = on ? '' : 'none';
    },
    now: () => performance.now(),
    load: () => {
      try {
        const raw = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as unknown;
        return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
      } catch {
        return {};
      }
    },
    save: (s) => {
      try {
        sessionStorage.setItem(STORE, JSON.stringify(s));
      } catch {
        /* private mode: kept in memory only */
      }
    },
  });
  return memory;
}

/** AppShell: follow this scroller for the life of the page. Returns the cleanup. */
export function installScrollMemory(el: HTMLElement): () => void {
  scroller = el;
  const m = scrollMemory();
  try {
    window.history.scrollRestoration = 'manual';
  } catch {
    /* read-only in some embedded views */
  }
  const onScroll = () => m.scrolled();
  const onInput = () => m.input();
  const onHide = () => m.persist();
  el.addEventListener('scroll', onScroll, { passive: true });
  for (const t of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) window.addEventListener(t, onInput, { capture: true, passive: true });
  window.addEventListener('pagehide', onHide);
  // Arriving on an entry with an offset kept over a reload (Back from another site, no back/forward cache).
  m.restore();
  return () => {
    el.removeEventListener('scroll', onScroll);
    for (const t of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) window.removeEventListener(t, onInput, { capture: true });
    window.removeEventListener('pagehide', onHide);
    if (scroller === el) scroller = null;
  };
}
