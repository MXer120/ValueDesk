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
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useStored } from '../hooks';
import { Sketch } from './sketches';
import './editMode.css';

/** Widgets a tab can hold; which panel offers which is the caller's list. */
export const TAB_WIDGETS: Record<string, string> = {
  trades: 'Trades',
  news: 'News',
  livefeed: 'Live feed',
  funding: 'Funding spreads',
  sizecalc: 'Position size',
  feetier: 'Fee tier',
  venue: 'Venue status',
};
/** The edit palette's sketch for each (widgetCatalog ids). */
const SKETCH: Record<string, string> = { trades: 'tape', news: 'news', livefeed: 'livefeed', funding: 'funding', sizecalc: 'sizecalc', feetier: 'feetier', venue: 'venue' };

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
}

/** A tab's right-click menu: Close tab, Add widget, Duplicate. */
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
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="tabmenu__item"
          disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}
        >
          {it.label}
        </button>
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
    <div className="dash-edit-root tabside-root">
      <aside ref={ref} className="dash-edit-side dash-edit-palette tabside" aria-label={title}>
        <header className="tabside__head">
          <b>{title}</b>
          <button type="button" className="tabside__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="dash-edit-palette__list">
          {markets && (
            <section className="dash-edit-palette__group">
              <p>Charts</p>
              <input
                className="tabside__find"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Another market: ETH, SOL, HYPE…"
                aria-label="Find a market for a chart tab"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) onAdd(`asset:${found[0].name}`); }}
              />
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
