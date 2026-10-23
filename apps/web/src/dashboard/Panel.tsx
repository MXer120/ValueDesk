/**
 * Panel chrome, and the two pieces of shared furniture that go inside a panel:
 * a tab bar and a "current market only" row filter.
 *
 * THERE IS NO TITLE BAR. This file used to render `⠿ Title` above every panel.
 * The measured reference draws no per-panel title bar, no panel border and no
 * permanent drag affordance - the panel is a filled card and the 4px gutter
 * separates it from its neighbours. What is left here is a body wrapper and a
 * drag strip that only exists while you are pointing at the panel.
 *
 * It renders a FRAGMENT, not a box. The box is the grid item div created by
 * Dashboard.tsx, because react-grid-layout clones its direct children to
 * attach positioning and to append the resize grips - so the outer element has
 * to be a plain DOM node that tolerates having children injected after it.
 * Keeping the chrome as a fragment inside that div is what lets the grips stay
 * direct children of `.react-grid-item`, which is what their positioning CSS
 * requires.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onFontsSettled } from '../fontsSettled';
import type { PanelScroll } from './types';

export interface PanelChromeProps {
  scroll?: PanelScroll;
  pad?: boolean;
  children: ReactNode;
}

export function PanelChrome({ scroll = 'auto', pad = true, children }: PanelChromeProps) {
  return (
    <>
      {/*
        The whole drag affordance: a 6px strip along the panel's top edge that
        is invisible and pointer-transparent until the panel is hovered.

        Why an overlay and not a header: a header costs every panel 24px of
        permanent height for a string the user already knows, and 24px times
        seven panels is a chart row. Why the TOP EDGE and not a corner: a corner
        grip has to land on whichever control happens to sit there, and on this
        page that is the leverage button, the tab bar and the chart's fullscreen
        toggle depending on the panel. The top 6px, in contrast, is padding in
        every panel we ship - and while the strip is live it only shadows the
        top 6px of a 32-40px control, so nothing becomes unclickable.

        `.dash-panel__handle` is what react-grid-layout is told to start drags
        from, so text selection in the order book and crosshair scrubbing on the
        chart never move a panel. The tab bar below carries the same class,
        which gives tabbed panels a second, larger drag region for free.
      */}
      <div
        className="dash-panel__grip dash-panel__handle"
        role="presentation"
        aria-hidden="true"
        title="Drag to move"
      />
      <div
        className={[
          'dash-panel__body',
          scroll === 'auto' ? 'dash-panel__body--scroll' : 'dash-panel__body--fit',
          pad ? '' : 'dash-panel__body--flush',
        ].filter(Boolean).join(' ')}
      >
        {children}
      </div>
    </>
  );
}

/* --- tabs ------------------------------------------------------------------ */

export interface PanelTab {
  key: string;
  label: ReactNode;
  content: ReactNode;
  /**
   * 'hidden' for content that measures its own box and must never be handed a
   * scrollbar - the order book divides the body's clientHeight by a row height
   * to decide how many levels fit, and a scrollbar would let it grow instead of
   * fit. 'auto' (the default) for anything list-shaped; the trade tape walks up
   * to the nearest scrollable ancestor to compensate scrollTop when prints
   * prepend, and that ancestor is this body.
   */
  scroll?: PanelScroll;
}

/**
 * A tabbed panel body: one bar of tabs, one body, optional right-aligned
 * controls in the bar.
 *
 * This is deliberately NOT components/Tabs.tsx. That one is the generic tab
 * group the standalone pages use; this one is dashboard furniture - it draws no
 * fill of its own (the panel around it is the card), marks itself off with a
 * single hairline, doubles as a drag handle, and takes an `actions` slot for the
 * market filter. Keeping them apart means restyling the terminal's tab bars
 * cannot silently restyle the Portfolio page's.
 *
 * Inactive tabs unmount rather than hiding, so a tab that polls or holds a
 * WebSocket subscription stops doing so while it is not selected.
 */
export function PanelTabs({
  tabs, actions: actionsFor, active: activeIn, onChange,
}: {
  tabs: PanelTab[];
  /** Right-aligned controls; a function gets the active tab's key (the account band's filter bar). */
  actions?: ReactNode | ((activeKey: string) => ReactNode);
  /** Controlled: the active tab's key (a parent that switches tabs itself, e.g. "Activity" from a row). */
  active?: string;
  onChange?: (key: string) => void;
}) {
  const [activeOwn, setActiveOwn] = useState(tabs[0]?.key);
  const active = activeIn ?? activeOwn;
  const setActive = (key: string) => {
    setActiveOwn(key);
    onChange?.(key);
  };
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  const actions = typeof actionsFor === 'function' ? actionsFor(current?.key ?? '') : actionsFor;

  /*
   * SMOOTH SWITCHING. The marker under the tabs is ONE element that slides to
   * the chosen tab (instead of one stub fading out and another in), and the
   * outgoing tab stays on screen for a moment, fading out UNDER the incoming
   * one - a cross-fade, not a blink. The data itself is cached (accountFeeds /
   * the history caches), so the incoming tab arrives filled.
   */
  const bar = useRef<HTMLDivElement>(null);
  const btns = useRef(new Map<string, HTMLButtonElement>());
  const [ink, setInk] = useState<{ x: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const b = current ? btns.current.get(current.key) : undefined;
      if (!b) return;
      setInk((p) => ({ x: b.offsetLeft + b.offsetWidth / 2 - 8, ready: p !== null }));
    };
    place();
    const ro = new ResizeObserver(place);
    if (bar.current) ro.observe(bar.current);
    /* The tabs' widths change when the web font swaps in, and the bar's own
       box does not - so the observer above never hears of it and the marker
       stayed where the fallback font put it (about half a pixel off). */
    const offFonts = onFontsSettled(place);
    return () => {
      ro.disconnect();
      offFonts();
    };
  }, [current?.key, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [leaving, setLeaving] = useState<{ key: string; content: ReactNode; fit: boolean } | null>(null);
  const shown = useRef<{ key: string; content: ReactNode; fit: boolean } | null>(null);
  const pick = (key: string) => {
    if (key === current?.key) return;
    if (shown.current) setLeaving(shown.current);
    setActive(key);
  };
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), 220);
    return () => window.clearTimeout(t);
  }, [leaving]);
  if (current) shown.current = { key: current.key, content: current.content, fit: current.scroll === 'hidden' };

  return (
    <div className="dash-tabs">
      <div ref={bar} className="dash-tabs__bar dash-panel__handle has-ink" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            ref={(el) => { if (el) btns.current.set(t.key, el); else btns.current.delete(t.key); }}
            type="button"
            role="tab"
            aria-selected={t.key === current?.key}
            className={`dash-tab${t.key === current?.key ? ' is-active' : ''}`}
            onClick={() => pick(t.key)}
          >
            {t.label}
          </button>
        ))}
        {ink && <span className={`dash-tabs__ink${ink.ready ? ' is-ready' : ''}`} style={{ transform: `translateX(${ink.x}px)` }} aria-hidden="true" />}
        {actions ? <div className="dash-tabs__actions dash-nodrag">{actions}</div> : null}
      </div>
      <div className="dash-tabs__stack">
        {leaving && leaving.key !== current?.key && (
          <div key={leaving.key} className={`dash-tabs__body is-leaving${leaving.fit ? ' dash-tabs__body--fit' : ''}`} aria-hidden="true">
            {leaving.content}
          </div>
        )}
        <div
          key={current?.key}
          className={`dash-tabs__body mo-switch${current?.scroll === 'hidden' ? ' dash-tabs__body--fit' : ''}`}
        >
          {current?.content}
        </div>
      </div>
    </div>
  );
}

/**
 * A panel with ONE view gets a heading where a tabbed panel gets its tab row.
 *
 * WHY IT EXISTS. Measured at 1920x1080, the reference's bottom-right account
 * card carries a left-aligned heading 16px inside the card edge, drawn in the
 * ACTIVE TAB's own style, sitting in the same 40px band as the tab row of the
 * panel beside it and closed by the same 1px rule at y760. Ours had no heading
 * at all, so the summary's first line floated up into that band and the two
 * bottom panels' bodies started ~36px out of step - our left body at row 762
 * against our right body at row 726.
 *
 * WHY IT REUSES `.dash-tabs`'s band and body rather than declaring its own.
 * The entire requirement is that the two panels line up, and two independently
 * stated 40px bands are two numbers that can drift apart. Sharing the selector
 * makes the alignment structural: change the band once and both panels move.
 *
 * The label is an <h2>, not a <button>, and it takes no amber stub. The stub in
 * this terminal means "this one of several"; a panel with a single view has no
 * others, so a marker under it would be a control that does nothing. Hierarchy
 * comes from COLOUR - --text against the --muted of an inactive tab - which is
 * the same rank the reference gives it and the rule this whole page follows.
 */
export function PanelHeading({
  label, end, scroll = 'auto', children,
}: { label: ReactNode; end?: ReactNode; scroll?: PanelScroll; children: ReactNode }) {
  return (
    <div className="dash-tabs">
      {/* Same drag region as a tab bar, for the same reason: it is the one
          piece of permanent chrome the panel has. */}
      <div className={`dash-tabs__bar dash-panel__handle${end ? ' has-end' : ''}`}>
        <h2 className="dash-heading">{label}</h2>
        {end}
      </div>
      <div className={`dash-tabs__body${scroll === 'hidden' ? ' dash-tabs__body--fit' : ''}`}>
        {children}
      </div>
    </div>
  );
}

/* --- current-market filter ------------------------------------------------- */

/**
 * Hides every table row that is not the market you are looking at.
 *
 * WHY IT WORKS ON THE DOM AND NOT ON PROPS. The account tables (positions, open
 * orders, the three histories) are owned by components/Account.tsx and take no
 * symbol argument; this filter is panel chrome, declared in the tab bar that
 * sits above them. Rather than push a filter prop through five components that
 * do not have one, the filter reads the rendered table the same way the user
 * does: it finds the column whose header cell says "Market" and hides the rows
 * whose cell in that column says something else.
 *
 * The contract is therefore explicit and narrow, and every part of it fails
 * SAFE - a table with no "Market" header, or rows whose cell count does not
 * match the header row (a colSpan note like "No open positions."), is left
 * completely alone. The worst case is that the checkbox stops filtering a table
 * that changed shape; it can never hide the wrong row or invent one.
 *
 * `emptied` distinguishes "this market has nothing" from "this account has
 * nothing": the first needs a line saying so, because a table that is empty
 * only because of a filter you set two clicks ago reads as a broken panel.
 */
export function MarketOnly({
  market, active, children,
}: { market: string; active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [emptied, setEmptied] = useState(false);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;

    const apply = () => {
      frame = 0;
      let hidden = 0;
      let shown = 0;

      for (const table of Array.from(root.querySelectorAll('table'))) {
        const heads = Array.from(table.querySelectorAll('thead th'));
        const col = heads.findIndex((th) => (th.textContent ?? '').trim().toLowerCase() === 'market');
        for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))) {
          // A row whose cell count does not match the header row is a note
          // spanning the table, never a market row.
          const cell = col >= 0 && row.cells.length === heads.length ? row.cells[col] : undefined;
          const hide = active && !!cell && (cell.textContent ?? '').trim() !== market;
          const want = hide ? 'none' : '';
          if (row.style.display !== want) row.style.display = want;
          if (!cell) continue;
          if (hide) hidden++;
          else shown++;
        }
      }
      setEmptied(hidden > 0 && shown === 0);
    };

    apply();

    // React re-renders these tables on every account poll, which replaces the
    // rows we just styled. Re-apply when the subtree changes.
    //
    // `attributes: false` is load-bearing: hiding a row IS an attribute
    // mutation, so observing attributes would make this feed itself. childList
    // and characterData are not written by `apply`, so it cannot loop - and the
    // one node `apply` does cause React to add or remove (the note below) settles
    // in a single pass, because re-running against it produces the same state
    // and React bails out of an identical setState.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [market, active]);

  return (
    <div className="dash-filtered" ref={ref}>
      {children}
      {active && emptied ? (
        <p className="dash-filtered__note">Nothing on {market}. Untick “Current market” to see the rest.</p>
      ) : null}
    </div>
  );
}
