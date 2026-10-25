/**
 * Extra tabs a trader adds to a tabbed panel - the bottom account band and the
 * chart card on the trade page.
 *
 * The + opens the widget sidebar edit mode uses (the same window, cards and
 * sketches, EditMode.tsx), listing the widgets that work as a tab there - and,
 * on the chart, other markets' charts; a card adds its tab. A right-click on a
 * tab offers Close tab, Add widget and Duplicate. Kept per panel on this
 * browser; a duplicate (`news#2`) keeps its own settings.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStored } from '../hooks';
import { Sketch } from './sketches';
import './editMode.css';

/** Widgets a tab can hold; which panel offers which is the caller's list. */
export const TAB_WIDGETS: Record<string, string> = {
  trades: 'Trades',
  news: 'News',
  livefeed: 'Live feed',
  fedlive: 'Fed live',
  fedwatch: 'FOMC odds',
  indicator: 'Indicator',
  etfflows: 'ETF flows',
  funding: 'Funding spreads',
  liqmap: 'Liq. heatmap',
  sizecalc: 'Position size',
  feetier: 'Fee tier',
  venue: 'Venue status',
};
/** The edit palette's sketch for each (widgetCatalog ids). */
const SKETCH: Record<string, string> = { trades: 'tape', news: 'news', livefeed: 'livefeed', fedlive: 'livefeed', fedwatch: 'tape', indicator: 'funding', etfflows: 'funding', funding: 'funding', liqmap: 'liq', sizecalc: 'sizecalc', feetier: 'feetier', venue: 'venue' };

export { assetOf, baseOf, copyOf, extraKey, isExtraKey, nextCopy } from './tabIds';
import { nextCopy } from './tabIds';

export function useExtraTabs(panel: string, max = 8): {
  ids: string[];
  /** Adds the next copy of `id`; returns the id it added (or null when the panel is full). */
  add: (id: string) => string | null;
  remove: (id: string) => void;
} {
  const [stored, setStored] = useStored<string[]>(`vs.tabs.${panel}`, []);
  const ids = Array.isArray(stored) ? stored.filter((x) => typeof x === 'string').slice(0, max) : [];
  return {
    ids,
    add: (id) => {
      if (ids.length >= max) return null;
      const next = nextCopy(ids, id);
      setStored([...ids, next]);
      return next;
    },
    remove: (id) => setStored(ids.filter((x) => x !== id)),
  };
}

/** The + at the end of a tab bar: opens the widget sidebar. */
export function AddTabButton({ onOpen, open, label = 'Add a tab' }: { onOpen: () => void; open: boolean; label?: string }) {
  return (
    <button type="button" className="tab-add dash-nodrag" aria-label={label} title={label} aria-expanded={open} onClick={onOpen}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
  );
}

export interface TabMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Its icon, drawn in the text's colour: one of MENU_ICONS. */
  icon?: ReactNode;
  /** Closes or deletes something: red, and set off from the items above it by a line. */
  danger?: boolean;
}

const menuIcon = (d: ReactNode) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
/**
 * The icons of the app's right-click menus (a tab's here, a drawing's and an
 * indicator's on the chart), so every menu reads the same: 16px outlines in the
 * text's colour.
 */
export const MENU_ICONS = {
  add: menuIcon(<path d="M8 3.5v9M3.5 8h9" />),
  widget: menuIcon(<><rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.2" /><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.2" /><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.2" /><path d="M11.2 9.3v4M9.2 11.3h4" /></>),
  duplicate: menuIcon(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></>),
  close: menuIcon(<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />),
  remove: menuIcon(<path d="M3 4.5h10M6.5 4.5V3.3c0-.5.3-.8.8-.8h1.4c.5 0 .8.3.8.8v1.2M4.5 4.5l.6 8c.1.6.5 1 1.1 1h3.6c.6 0 1-.4 1.1-1l.6-8M6.8 7v4M9.2 7v4" />),
  // The knowledge folders' menus (knowledge/): a folder's and an item's.
  rename: menuIcon(<><path d="M9.8 3.4 12.6 6.2 6 12.8l-3.3.5.5-3.3z" /><path d="M8.6 4.6l2.8 2.8" /></>),
  open: menuIcon(<><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v2.5a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h2.5" /></>),
  download: menuIcon(<><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2" /><path d="M2.8 11v1.2c0 .7.6 1.3 1.3 1.3h7.8c.7 0 1.3-.6 1.3-1.3V11" /></>),
  folder: menuIcon(<path d="M2.5 4.5c0-.6.4-1 1-1h3l1.4 1.5h4.6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z" />),
  moveTo: menuIcon(<><path d="M2.5 4.5c0-.6.4-1 1-1h3l1.4 1.5h4.6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1z" /><path d="M6 9.3h4M8.6 7.8 10 9.3l-1.4 1.5" /></>),
  signOut: menuIcon(<><path d="M6.5 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h2.5" /><path d="M10.5 11 13.5 8l-3-3M13.5 8H6.5" /></>),
  settings: menuIcon(<><path d="M6.9 2.3h2.2l.4 1.6 1.2.7 1.6-.5 1.1 1.9-1.2 1.2v1.6l1.2 1.2-1.1 1.9-1.6-.5-1.2.7-.4 1.6H6.9l-.4-1.6-1.2-.7-1.6.5-1.1-1.9 1.2-1.2V7.2L2.6 6l1.1-1.9 1.6.5 1.2-.7z" /><circle cx="8" cy="8" r="1.9" /></>),
  show: menuIcon(<><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" /><circle cx="8" cy="8" r="1.9" /></>),
  hide: menuIcon(<><path d="M6.3 4a6 6 0 0 1 1.7-.2c4 0 6.2 4.2 6.2 4.2a10 10 0 0 1-1.6 2.1M4.3 5A10 10 0 0 0 1.8 8s2.2 4.2 6.2 4.2a6 6 0 0 0 2.7-.6" /><path d="m2.5 2.5 11 11" /></>),
  lock: menuIcon(<><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.5" /><path d="M5.5 7.2V5.3a2.5 2.5 0 0 1 5 0v1.9" /></>),
  unlock: menuIcon(<><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.5" /><path d="M5.5 7.2V5.3a2.5 2.5 0 0 1 4.8-1" /></>),
  front: menuIcon(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M2.5 9.5v-6a1 1 0 0 1 1-1h6" opacity="0.55" /></>),
  back: menuIcon(<><rect x="2.5" y="2.5" width="8" height="8" rx="1.5" opacity="0.55" /><path d="M13.5 6.5v6a1 1 0 0 1-1 1h-6" /></>),
  // An indicator's menu on the chart: its "more" button and the pane moves.
  more: menuIcon(<><circle cx="3.5" cy="8" r="0.9" /><circle cx="8" cy="8" r="0.9" /><circle cx="12.5" cy="8" r="0.9" /></>),
  up: menuIcon(<path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />),
  down: menuIcon(<path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" />),
  newPane: menuIcon(<><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 9.5h11" /></>),
  mainChart: menuIcon(<path d="M5 2.5v11M11 4v9M3.5 5.5h3v5h-3zM9.5 6.5h3v4h-3z" />),
  intoPane: menuIcon(<><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 8.5h11M8 4.5V11M6 9l2 2 2-2" /></>),
  // The layout menu's and the header's: arrange the panels, back to the default, alerts.
  edit: menuIcon(<><rect x="2.5" y="2.5" width="5" height="5" rx="1.2" /><rect x="2.5" y="9.5" width="5" height="4" rx="1.2" /><path d="M9.5 13.5h1.2l3-3-1.2-1.2-3 3zM12.5 8.3 13.7 9.5" /><rect x="9.5" y="2.5" width="4" height="4" rx="1.2" /></>),
  reset: menuIcon(<><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2.8v2.6h2.6" /></>),
  bell: menuIcon(<><path d="M4.2 11V7.5a3.8 3.8 0 0 1 7.6 0V11l1.2 1.5H3L4.2 11Z" /><path d="M6.6 13.5a1.5 1.5 0 0 0 2.8 0" /></>),
} as const;

/** A right-click menu (a tab's: Add widget, Duplicate, Close tab), with icons; the destructive items last, in red. */
export function TabMenu({ at, items, onClose }: { at: { x: number; y: number }; items: readonly TabMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPlace({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const menu = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('contextmenu', menu, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('contextmenu', menu, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu-popup tabmenu" role="menu" style={{ left: place.x, top: place.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <Fragment key={it.label}>
          {it.danger && i > 0 && !items[i - 1]!.danger && <span className="tabmenu__sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`tabmenu__item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}
          >
            <span className="tabmenu__ic">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

/** Opens a tab's menu at the pointer, and keeps the dashboard's own menu from opening too. */
export const menuAt = (e: ReactMouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  return { x: e.clientX, y: e.clientY };
};

/**
 * The widget sidebar edit mode shows (dash-edit-palette), for a panel's tabs:
 * the widgets that work as a tab here, as the same cards with their sketches,
 * and on the chart a search for another market's chart. A card adds its tab.
 */
export function TabSidebar({ title, widgets, markets, onAdd, onClose }: {
  title: string;
  widgets: readonly string[];
  /** Markets a chart tab can show (the chart card only). */
  markets?: readonly { name: string; label: string }[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.('.tab-add')) return;
      onClose();
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', down, true);
    };
  }, [onClose]);
  const term = q.trim().toUpperCase();
  const found = markets && term ? markets.filter((m) => m.label.toUpperCase().includes(term) || m.name.toUpperCase().includes(term)).slice(0, 10) : [];

  return createPortal(
    <div className="tabside-root">
      {/* The page under it, slightly blurred; a press there closes the sidebar. */}
      <div className="tabside-scrim" aria-hidden="true" />
      <aside ref={ref} className="tabside" aria-label={title}>
        <header className="tabside__head">
          <b>{title}</b>
          <button type="button" className="tabside__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="dash-edit-palette__list tabside__list">
          {markets && (
            <section className="dash-edit-palette__group">
              <p>Charts</p>
              <label className="tabside__find">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Another market: ETH, SOL, HYPE…"
                  aria-label="Find a market for a chart tab"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) onAdd(`asset:${found[0].name}`); }}
                />
              </label>
              {found.length > 0 && (
                <div className="dash-edit-palette__grid" role="list">
                  {found.map((m) => (
                    <button key={m.name} type="button" role="listitem" className="dash-edit-wcard tabside__card" onClick={() => onAdd(`asset:${m.name}`)}>
                      <span className="dash-edit-card__screen" aria-hidden="true"><Sketch id="chart" /></span>
                      <span className="dash-edit-wcard__row"><span className="dash-edit-widget__name">{m.label}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <section className="dash-edit-palette__group">
            <p>Widgets</p>
            <div className="dash-edit-palette__grid" role="list">
              {widgets.map((id) => (
                <button key={id} type="button" role="listitem" className="dash-edit-wcard tabside__card" onClick={() => onAdd(id)}>
                  <span className="dash-edit-card__screen" aria-hidden="true"><Sketch id={SKETCH[id] ?? id} /></span>
                  <span className="dash-edit-wcard__row"><span className="dash-edit-widget__name">{TAB_WIDGETS[id] ?? id}</span></span>
                </button>
              ))}
            </div>
          </section>
        </div>
        <p className="tabside__hint">A card adds it as a tab. Right-click a tab to close or duplicate it.</p>
      </aside>
    </div>,
    document.body,
  );
}
