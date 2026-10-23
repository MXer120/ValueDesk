/**
 * Extra tabs a trader adds to a tabbed panel with its + button - the bottom
 * account band and the chart card on the trade page. Only widgets that work as
 * a tab there are offered (TAB_WIDGETS), and the chart also takes another
 * market's chart. The choice is kept per panel on this browser; a tab's x
 * takes it out again.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStored } from '../hooks';

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

/** A tab key for an extra: `x:<widget>` or `x:asset:<SYMBOL>`. */
export const extraKey = (id: string) => `x:${id}`;
export const isExtraKey = (key: string) => key.startsWith('x:');
export const assetOf = (id: string): string | null => (id.startsWith('asset:') ? id.slice(6) : null);

export function useExtraTabs(panel: string, max = 6): { ids: string[]; add: (id: string) => void; remove: (id: string) => void } {
  const [stored, setStored] = useStored<string[]>(`vs.tabs.${panel}`, []);
  const ids = Array.isArray(stored) ? stored.filter((x) => typeof x === 'string').slice(0, max) : [];
  return {
    ids,
    add: (id) => { if (!ids.includes(id) && ids.length < max) setStored([...ids, id]); },
    remove: (id) => setStored(ids.filter((x) => x !== id)),
  };
}

/** A tab's label with an x that removes it (a span: a tab is already a button). */
export function ExtraLabel({ name, onRemove }: { name: ReactNode; onRemove: () => void }) {
  return (
    <span className="tabx">
      {name}
      <span
        className="tabx__x"
        role="button"
        tabIndex={0}
        aria-label="Remove this tab"
        title="Remove this tab"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(); } }}
      >
        <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </span>
    </span>
  );
}

export interface AddOption {
  id: string;
  name: string;
}

/**
 * The + in a rounded square at the end of a tab bar, and its list: the widgets
 * not added yet, and - with \`markets\` - a search over the markets for a chart tab.
 */
export function AddTabButton({ options, markets, onAdd, label = 'Add a tab' }: {
  options: readonly AddOption[];
  /** Market names a chart tab can show (the chart card only). */
  markets?: readonly string[];
  onAdd: (id: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), top: r.bottom + 6 });
    const down = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const pick = (id: string) => {
    onAdd(id);
    setOpen(false);
    setQ('');
  };
  const term = q.trim().toUpperCase();
  const found = markets && term ? markets.filter((m) => m.toUpperCase().includes(term)).slice(0, 8) : [];

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="tab-add dash-nodrag"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && at && createPortal(
        <div ref={pop} className="tab-add__pop" role="menu" style={{ left: at.left, top: at.top }}>
          {markets && (
            <div className="tab-add__sec">
              <span className="tab-add__h">Chart of another market</span>
              <input
                className="tab-add__find"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ETH, SOL, HYPE…"
                aria-label="Find a market"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) pick(`asset:${found[0]}`); }}
              />
              {found.map((m) => (
                <button key={m} type="button" role="menuitem" className="tab-add__opt" onClick={() => pick(`asset:${m}`)}>{m}</button>
              ))}
            </div>
          )}
          <div className="tab-add__sec">
            <span className="tab-add__h">Widgets</span>
            {options.length === 0 && <span className="tab-add__none">Every widget is added.</span>}
            {options.map((o) => (
              <button key={o.id} type="button" role="menuitem" className="tab-add__opt" onClick={() => pick(o.id)}>{o.name}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
