/**
 * The page's two controls (owner 2026-11-06: the chart's view is the dropdown, the timeframe is the switch).
 *
 * RangePicker: the same dropdown as "All platforms" (PlatformSelect.css `.psel`). The chosen value is the whole
 * label; PlatformSelect itself is multi-select over venues, so only its look is shared.
 * ViewSeg: the leaderboard's well (`.lbp-seg`) with a translucent blob that sits on the chosen segment and slides.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function RangePicker<T extends string>({ value, options, onChange, label, align = 'end' }: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  label: string;
  align?: 'start' | 'end';
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
        <div className={`psel__pop psel__pop--${align} pfx-range__pop`} role="listbox" aria-label={label}>
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
  const box = useRef<HTMLDivElement>(null);
  const blob = useRef<HTMLSpanElement>(null);
  /* Measured, not computed: the segments are as wide as their words. Written straight to the element, and it only
     starts to animate after the first placement, so the page does not open on a blob sliding in from the left. */
  useLayoutEffect(() => {
    const el = box.current;
    const b = blob.current;
    if (!el || !b) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('button[aria-checked="true"]');
      if (!on) return;
      b.style.width = `${on.offsetWidth}px`;
      b.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    place();
    const frame = requestAnimationFrame(() => b.classList.add('is-ready'));
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [value]);
  return (
    <div className="lbp-seg pfx-slide" role="radiogroup" aria-label={label} ref={box}>
      {options.map(([k, text]) => (
        <button key={k} type="button" role="radio" aria-checked={k === value} className={k === value ? 'is-on' : ''} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
      <span className="pfx-slide__blob" ref={blob} aria-hidden="true" />
    </div>
  );
}
