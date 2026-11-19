/**
 * The sm/xs replacement for the old book|exec two-column band: Chart, Order
 * Book + Trades, and the order ticket, each a FULL-WIDTH page of one
 * horizontal swipe carousel instead of two panels squeezed to a quarter and
 * a half of a phone's width.
 *
 * "Not put them above/below each other" ruled out a vertical stack - the
 * price ladder and the box you type a size into need to stay one flick apart,
 * not a full scroll apart. Full-width pages you swipe between is the
 * remaining shape: each page gets the phone's whole width (a real chart, a
 * real order book, a ticket whose labelled rows do not wrap). The tab bar
 * and the dots are how a first-time user finds the other pages. A peek of
 * the next page used to cover the chart's price scale, so the pages are
 * full width.
 *
 * Phone pass (2026-11-18): the page last used opens again (this browser
 * remembers it - the trade page unmounts on every page change); the swipe hint
 * plays once per browser, and stops the moment the visitor touches the
 * carousel or a tab, so it can never undo their own move; and a page's content
 * can open another page (useCarouselPage: a price picked in the book opens the
 * ticket with it).
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { carouselStore } from './carouselMemory';
import './carousel.css';

interface Page {
  key: string;
  label: string;
  /**
   * What the page is called to assistive tech (its tabpanel's name), when the tab's short label
   * is not the name the same content has elsewhere: the ticket is "Order entry" on every screen,
   * as its desktop panel is, so a screen reader (and a test) finds it by one name.
   */
  name?: string;
  content: ReactNode;
  /** 'auto' for content that scrolls internally (the order ticket); 'hidden'
   *  for content that measures its own box, same contract as PanelScroll. */
  scroll?: 'auto' | 'hidden';
}

/** The carousel a page's content sits in: open one of its pages by key. Null outside a carousel (a wide screen). */
const CarouselContext = createContext<{ goTo: (key: string) => void } | null>(null);
export const useCarouselPage = () => useContext(CarouselContext);

export function MobileCarousel({ pages }: { pages: Page[] }) {
  const uid = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const keys = useMemo(() => pages.map((p) => p.key), [pages]);
  /* The page last used, opened at once (before the first paint, without the smooth scroll the track carries). */
  const [start] = useState(() => carouselStore.startIndex(keys));
  const [active, setActive] = useState(start);
  /** The observer has read the real scroll position: from then on the page on screen is the one to remember. */
  const settled = useRef(false);
  const nudge = useRef<number[]>([]);
  const stopNudge = useCallback(() => {
    for (const t of nudge.current) window.clearTimeout(t);
    nudge.current = [];
  }, []);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || start === 0) return;
    const place = (): boolean => {
      if (track.clientWidth === 0) return false;
      const prev = track.style.scrollBehavior;
      track.style.scrollBehavior = 'auto';
      track.scrollLeft = start * track.clientWidth;
      track.style.scrollBehavior = prev;
      return true;
    };
    if (place() || typeof ResizeObserver === 'undefined') return;
    // The grid has not given the panel its width yet: place it on the first frame it has one.
    const ro = new ResizeObserver(() => { if (place()) ro.disconnect(); });
    ro.observe(track);
    return () => ro.disconnect();
  }, [start]);

  // Which page is "current" is read off real scroll position via
  // IntersectionObserver, not tracked by whichever control was last pressed -
  // a free swipe (no tap involved) updates the nav bar and dots exactly the
  // same way a tap does, because both end in the same scroll state.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = pageRefs.current.findIndex((el) => el === e.target);
          if (idx !== -1) ratios.set(idx, e.intersectionRatio);
        }
        let bestIdx = 0;
        let bestRatio = -1;
        for (const [idx, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIdx = idx;
          }
        }
        settled.current = true;
        setActive(bestIdx);
      },
      { root: track, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of pageRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pages.length]);

  useEffect(() => {
    if (settled.current) carouselStore.remember(keys[active]);
  }, [active, keys]);

  // A page with no pixel in view is marked `data-off` (the attribute
  // offscreen.ts sets): every page stays mounted, and what loops on one - the
  // order ticket's glare (OrderEntry.css) - pauses while it is swiped away.
  // Its own observer, with the track shrunk by a pixel at either side: the
  // pages are exactly as wide as the track, so the one beside the page on
  // screen touches it, and a touching box counts as intersecting.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.target.toggleAttribute('data-off', !e.isIntersecting);
      },
      { root: track, rootMargin: '0px -1px 0px -1px', threshold: 0 },
    );
    const els = pageRefs.current.filter((el): el is HTMLDivElement => el !== null);
    for (const el of els) io.observe(el);
    return () => {
      io.disconnect();
      for (const el of els) el.removeAttribute('data-off');
    };
  }, [pages.length]);

  const goTo = useCallback((i: number) => {
    stopNudge();
    pageRefs.current[i]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }, [stopNudge]);
  const nav = useMemo(() => ({ goTo: (key: string) => { const i = keys.indexOf(key); if (i !== -1) goTo(i); } }), [keys, goTo]);

  // The swipe hint, so the tabs are not the ONLY discoverability cue: once per
  // browser, ease a few px into page 2 and back. Skipped for anyone who prefers
  // reduced motion and for a browser that opens on another page (it has found
  // them), and it is a real scroll (the same gesture a swipe produces), not an
  // animation layered on top, so it can never desync from the snap points.
  // Both of its moves are cancelled by the visitor's first touch, wheel or tab.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || start !== 0 || !carouselStore.hintDue()) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    nudge.current.push(window.setTimeout(() => {
      carouselStore.hinted();
      track.scrollTo({ left: 28, behavior: 'smooth' });
      nudge.current.push(window.setTimeout(() => track.scrollTo({ left: 0, behavior: 'smooth' }), 380));
    }, 500));
    return stopNudge;
  }, [start, stopNudge]);

  return (
    <CarouselContext.Provider value={nav}>
      <div className="mcarousel" onPointerDownCapture={stopNudge} onWheelCapture={stopNudge} onKeyDownCapture={stopNudge}>
        {/* Reuses PanelTabs' own bar/tab classes (dash-tabs__bar / dash-tab) -
            same 41px bar, same 14px/400 muted->text, same amber stub marker -
            so this reads as the SAME tab language the rest of the app already
            uses, not a second one invented for one screen size. */}
        {/* The WAI-ARIA tabs pattern, whole: each tab controls its page, each page is a named
            tabpanel. Without it the three pages were one unnamed stretch inside the "Order book and
            trades" panel, and the ticket - "Order entry" on a wide screen - had no name on a phone. */}
        <div className="dash-tabs__bar dash-panel__handle" role="tablist">
          {pages.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              id={`${uid}-tab-${p.key}`}
              aria-controls={`${uid}-page-${p.key}`}
              aria-selected={i === active}
              className={`dash-tab${i === active ? ' is-active' : ''}`}
              onClick={() => goTo(i)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mcarousel__track" ref={trackRef}>
          {pages.map((p, i) => (
            <div
              key={p.key}
              ref={(el) => { pageRefs.current[i] = el; }}
              id={`${uid}-page-${p.key}`}
              role="tabpanel"
              aria-label={p.name ?? p.label}
              className={`mcarousel__page${p.scroll === 'hidden' ? ' mcarousel__page--fit' : ''}`}
            >
              {p.content}
            </div>
          ))}
        </div>
        <div className="mcarousel__dots" aria-hidden="true">
          {keys.map((k, i) => (
            <span key={k} className={`mcarousel__dot${i === active ? ' is-active' : ''}`} />
          ))}
        </div>
      </div>
    </CarouselContext.Provider>
  );
}
