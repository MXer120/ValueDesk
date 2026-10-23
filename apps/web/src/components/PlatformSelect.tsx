/**
 * The platform filter, one dropdown wherever a page reads several platforms
 * (Cohorts, the leaderboard, Copy, the search palette, Explore -> Markets),
 * in place of a chip per platform with its full name and logo.
 *
 * Closed it says what is chosen: a globe and "All platforms" by default, one
 * platform's logo and name, or "2 platforms". Open, "All platforms" heads the
 * list; a row picks that platform alone, and its box adds it to (or takes it
 * out of) the choice, so a netted pair is still two ticks away. One platform
 * always stays chosen.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { VenueLogo } from './VenueLogo';
import { VENUE_BRAND } from './venueBrand';
import { VENUE_LABEL, type Venue } from '../vsApi';
import './PlatformSelect.css';

export function GlobeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="psel__globe" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.5 3.9 2.5 6.2S9.7 12.4 8 14.2M8 1.8C6.3 3.6 5.5 5.7 5.5 8s.8 4.4 2.5 6.2" />
    </svg>
  );
}

export function PlatformSelect({ options, value, onChange, label = 'Platforms', tag, align = 'start', className = '' }: {
  /** Every platform offered, in order. */
  options: readonly Venue[];
  value: readonly Venue[];
  onChange: (next: Venue[]) => void;
  /** The accessible name of the control. */
  label?: string;
  /** A note beside a platform in the list ("View only"), or null. */
  tag?: (v: Venue) => { text: string; title?: string } | null;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);

  const chosen = options.filter((v) => value.includes(v));
  const all = chosen.length === options.length;
  const only = (v: Venue) => { onChange([v]); setOpen(false); };
  const toggle = (v: Venue) => {
    const on = chosen.includes(v);
    if (on && chosen.length === 1) return;
    onChange(options.filter((x) => (x === v ? !on : chosen.includes(x))));
  };

  return (
    <div className={`psel${className ? ` ${className}` : ''}`} ref={box}>
      <button
        type="button"
        className={`psel__btn${all ? '' : ' is-on'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${all ? 'all' : chosen.map((v) => VENUE_LABEL[v]).join(', ')}`}
        onClick={() => setOpen((o) => !o)}
      >
        {all ? (
          <GlobeIcon />
        ) : (
          <span className="psel__logos" aria-hidden="true">
            {chosen.slice(0, 3).map((v) => <VenueLogo key={v} venue={v} size={14} />)}
          </span>
        )}
        <span className="psel__v">{all ? 'All platforms' : chosen.length === 1 ? VENUE_LABEL[chosen[0]!] : `${chosen.length} platforms`}</span>
        <svg className="psel__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className={`psel__pop psel__pop--${align}`} role="listbox" aria-label={label} aria-multiselectable="true">
          <button type="button" role="option" aria-selected={all} className={`psel__row psel__row--all${all ? ' is-on' : ''}`} onClick={() => { onChange([...options]); setOpen(false); }}>
            <span className="psel__ic"><GlobeIcon size={15} /></span>
            <span className="psel__name">All platforms</span>
            {all && <Tick />}
          </button>
          <span className="psel__sep" aria-hidden="true" />
          {options.map((v) => {
            const on = chosen.includes(v);
            const last = on && chosen.length === 1;
            const t = tag?.(v) ?? null;
            return (
              <div key={v} className={`psel__item${on && !all ? ' is-on' : ''}`} style={{ '--brand': VENUE_BRAND[v] } as CSSProperties}>
                <button type="button" role="option" aria-selected={on && !all} className="psel__row" onClick={() => only(v)} title={`${VENUE_LABEL[v]} only`}>
                  <span className="psel__ic"><VenueLogo venue={v} size={16} /></span>
                  <span className="psel__name">{VENUE_LABEL[v]}</span>
                  {t && <span className="psel__tag" title={t.title}>{t.text}</span>}
                </button>
                <button
                  type="button"
                  className={`psel__box${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  aria-label={on ? `Take ${VENUE_LABEL[v]} out` : `Add ${VENUE_LABEL[v]}`}
                  title={last ? 'One platform stays chosen' : on ? 'Take it out' : 'Add it'}
                  disabled={last}
                  onClick={() => toggle(v)}
                >
                  {on && <Tick />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const Tick = () => (
  <svg className="psel__tick" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
    <path d="M2.5 6.4 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
