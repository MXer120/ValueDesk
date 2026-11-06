/**
 * The page's two switches, in the app's own controls and nothing else (owner 2026-11-06).
 *
 * RangePicker: a timeframe, as the same dropdown as "All platforms" (PlatformSelect.css `.psel`). The chosen
 * value is the whole label; PlatformSelect itself is multi-select over venues, so only its look is shared.
 * ViewSeg: one of a few views, as the leaderboard and the cohorts switch theirs (`.lbp-seg`, DESIGN.md section 5).
 */
import { useEffect, useRef, useState } from 'react';

export function RangePicker<T extends string>({ value, options, onChange, label = 'Timeframe' }: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  label?: string;
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
  const shown = options.find(([k]) => k === value)?.[1] ?? value;
  return (
    <div className="psel pfx-range" ref={box}>
      <button
        type="button"
        className="psel__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="psel__v">{shown}</span>
        <svg className="psel__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="psel__pop psel__pop--end pfx-range__pop" role="listbox" aria-label={label}>
          {options.map(([k, text]) => (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={k === value}
              className={`psel__row${k === value ? ' is-on' : ''}`}
              onClick={() => { onChange(k); setOpen(false); }}
            >
              <span className="psel__name">{text}</span>
              {k === value && (
                <svg className="psel__tick" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 6.4 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ViewSeg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="lbp-seg" role="radiogroup" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" role="radio" aria-checked={k === value} className={k === value ? 'is-on' : ''} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}
