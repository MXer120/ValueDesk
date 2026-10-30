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
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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

export function MobileCarousel({ pages }: { pages: Page[] }) {
  const uid = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [active, setActive] = useState(0);

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
        setActive(bestIdx);
      },
      { root: track, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of pageRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pages.length]);

  const goTo = (i: number) => {
    pageRefs.current[i]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  // A one-time nudge so the peek is not the ONLY discoverability cue: on
  // first mount, ease a few px into page 2 and back. Skipped entirely for
  // anyone who prefers reduced motion, and it is a real scroll (the same
  // gesture a swipe produces), not an animation layered on top, so it can
  // never desync from the snap points.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setTimeout(() => {
      track.scrollTo({ left: 28, behavior: 'smooth' });
      window.setTimeout(() => track.scrollTo({ left: 0, behavior: 'smooth' }), 380);
    }, 500);
    return () => window.clearTimeout(id);
  }, []);

  const dots = useMemo(() => pages.map((p) => p.key), [pages]);

  return (
    <div className="mcarousel">
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
        {dots.map((k, i) => (
          <span key={k} className={`mcarousel__dot${i === active ? ' is-active' : ''}`} />
        ))}
      </div>
    </div>
  );
}
