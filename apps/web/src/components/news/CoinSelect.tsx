/**
 * The News widget's coin filter: one coin, several, or every coin - the
 * platform dropdown's pattern (PlatformSelect.tsx) with the coins' own logos and
 * a search on top.
 *
 * Closed it says what is chosen: a stack of coins and "All coins" by default,
 * one coin's logo and ticker, or a few logos and "3 coins". Open, "All coins"
 * and "This market" (the chart's coin, following it) head the list; a row
 * picks that coin alone, and its box adds it to the choice or takes it out, up
 * to MAX coins (the server's limit). The list is the markets this terminal
 * trades, so a coin picked here is also one whose chart a story can open.
 *
 * The list lives in <body>, placed under (or over) its button, so a short panel
 * does not clip it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CoinIcon } from '../CoinIcon';
import '../PlatformSelect.css';

/** "This market": the chart's coin, whichever it is. */
export const CURRENT = 'current';
/** As many coins as one query may filter by (sosovalue/news.ts MAX_COINS). */
export const MAX = 5;

export interface CoinChoice {
  symbol: string;
  name?: string;
}

export function CoinsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="psel__globe" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="6" cy="6.5" r="4.2" />
      <path d="M8.9 3.4a4.2 4.2 0 1 1-1.6 8.1" />
      <path d="M6 4.6v3.8M4.6 5.6h2.2a.9.9 0 0 1 0 1.8H4.9" />
    </svg>
  );
}

export function CoinSelect({ coins, value, here, onChange, label = 'Coins' }: {
  coins: readonly CoinChoice[];
  /** The chosen tickers (and CURRENT); none is every coin. */
  value: readonly string[];
  /** The chart's coin, for "This market". */
  here: string | null;
  onChange: (next: string[]) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      const below = vh - r.bottom - 14;
      const above = r.top - 14;
      const up = below < 260 && above > below;
      const width = 260;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const maxHeight = Math.max(200, Math.min(420, up ? above : below));
      setPos(up ? { left, bottom: vh - r.top + 6, maxHeight } : { left, top: r.bottom + 6, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  useEffect(() => {
    if (open && pos) search.current?.focus({ preventScroll: true });
  }, [open, pos]);

  const chosen = value.filter((v) => v === CURRENT ? !!here : coins.some((c) => c.symbol === v) || v === here);
  const all = chosen.length === 0;
  const full = chosen.length >= MAX;
  const nameOf = (v: string) => (v === CURRENT ? here ?? '' : v);
  const only = (v: string) => {
    onChange([v]);
    close();
  };
  const toggle = (v: string) => onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : full ? chosen : [...chosen, v]);
  const q = query.trim().toUpperCase();
  const shown = q ? coins.filter((c) => c.symbol.includes(q) || (c.name ?? '').toUpperCase().includes(q)) : coins;

  const summary = all
    ? 'All coins'
    : chosen.length === 1
      ? chosen[0] === CURRENT ? `This market · ${here}` : chosen[0]!
      : `${chosen.length} coins`;

  return (
    <div className="psel">
      <button
        ref={btn}
        type="button"
        className={`psel__btn${all ? '' : ' is-on'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${all ? 'all' : chosen.map(nameOf).join(', ')}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {all ? (
          <CoinsIcon />
        ) : (
          <span className="psel__logos" aria-hidden="true">
            {chosen.slice(0, 3).map((v) => <CoinIcon key={v} coin={nameOf(v)} size={14} />)}
          </span>
        )}
        <span className="psel__v">{summary}</span>
        <svg className="psel__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={pop}
          className="psel__pop csel__pop"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
        >
          <label className="csel__search">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search coins" aria-label="Search coins" spellCheck={false} autoComplete="off" />
          </label>
          {!q && (
            <>
              <button type="button" role="option" aria-selected={all} className={`psel__row psel__row--all${all ? ' is-on' : ''}`} onClick={() => { onChange([]); close(); }}>
                <span className="psel__ic"><CoinsIcon size={15} /></span>
                <span className="psel__name">All coins</span>
                {all && <Tick />}
              </button>
              {here && (
                <Row
                  v={CURRENT}
                  icon={here}
                  name="This market"
                  hint={here}
                  on={chosen.includes(CURRENT)}
                  off={full && !chosen.includes(CURRENT)}
                  onOnly={only}
                  onToggle={toggle}
                />
              )}
              <span className="psel__sep" aria-hidden="true" />
            </>
          )}
          <div className="csel__list">
            {shown.map((c) => (
              <Row
                key={c.symbol}
                v={c.symbol}
                icon={c.symbol}
                name={c.symbol}
                hint={c.name && c.name.toUpperCase() !== c.symbol ? c.name : undefined}
                on={chosen.includes(c.symbol)}
                off={full && !chosen.includes(c.symbol)}
                onOnly={only}
                onToggle={toggle}
              />
            ))}
            {shown.length === 0 && <p className="csel__none">No coin matches “{query.trim()}”</p>}
          </div>
          {full && <p className="csel__none">{MAX} coins at most at once.</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}

function Row({ v, icon, name, hint, on, off, onOnly, onToggle }: {
  v: string;
  icon: string;
  name: string;
  hint?: string;
  on: boolean;
  /** Full: a coin that is not chosen cannot be added. */
  off: boolean;
  onOnly: (v: string) => void;
  onToggle: (v: string) => void;
}) {
  return (
    <div className={`psel__item${on ? ' is-on' : ''}`}>
      <button type="button" role="option" aria-selected={on} className="psel__row" onClick={() => onOnly(v)} title={`${name} only`}>
        <span className="psel__ic"><CoinIcon coin={icon} size={16} /></span>
        <span className="psel__name">{name}</span>
        {hint && <span className="csel__hint">{hint}</span>}
      </button>
      <button
        type="button"
        className={`psel__box${on ? ' is-on' : ''}`}
        aria-pressed={on}
        aria-label={on ? `Take ${name} out` : `Add ${name}`}
        title={off ? `${MAX} coins at most` : on ? 'Take it out' : 'Add it'}
        disabled={off}
        onClick={() => onToggle(v)}
      >
        {on && <Tick />}
      </button>
    </div>
  );
}

const Tick = () => (
  <svg className="psel__tick" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
    <path d="M2.5 6.4 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
