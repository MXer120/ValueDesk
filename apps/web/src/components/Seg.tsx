/**
 * One of N with a sliding ink (`.cp-seg`, DESIGN.md section 5) and the ink itself, in a module of their own.
 *
 * They used to live in palette/ui.tsx with the rest of the Cmd+K palette's parts, and the account setup dialog
 * (setup/AccountSetup.tsx, in the entry) imports Seg: that pulled palette/ui.tsx and what it imports into the entry
 * chunk, ~12 KB brotli every page waited for before its first render (phone pass, 2026-11-18). palette/ui.tsx
 * re-exports all four, so every other import stays as it was. The styles are CommandPalette.css's, in the one
 * stylesheet (cssOrder.ts).
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * The cohort pages' sliding ink: where the chosen `.is-on` child of `ref` sits,
 * re-measured on resize. `ready` turns true after the first placement, so the
 * ink appears in place and only slides on later changes.
 */
export function useInk(ref: RefObject<HTMLElement>, key: string): { left: number; width: number; ready: boolean } | null {
  const [ink, setInk] = useState<{ left: number; width: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>(':scope > .is-on');
      if (!el) return setInk(null);
      setInk((cur) => {
        const next = { left: el.offsetLeft, width: el.offsetWidth, ready: cur !== null };
        return cur && cur.left === next.left && cur.width === next.width && cur.ready === next.ready ? cur : next;
      });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [ref, key]);
  return ink;
}

export function Ink({ ink }: { ink: { left: number; width: number; ready: boolean } | null }) {
  if (!ink) return null;
  return (
    <span
      className={`cp-ink${ink.ready ? ' is-ready' : ''}`}
      style={{ transform: `translateX(${ink.left}px)`, width: ink.width }}
      aria-hidden="true"
    />
  );
}

export interface SegOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A count after the label ("Watchlist 3"); null hides it. */
  count?: number | null;
  title?: string;
}

/** One of N (DESIGN.md section 5, `.lbp-seg`): a bordered well, the chosen one under a sliding ink. */
export function Seg<T extends string>({
  options, value, onChange, label, size = 'md',
}: {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const ink = useInk(ref, `${value}|${options.map((o) => `${o.id}:${o.label}:${o.count ?? ''}`).join(',')}`);
  return (
    <span ref={ref} className={`cp-seg cp-seg--${size}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" className={on ? 'is-on' : ''} aria-pressed={on} title={o.title} onClick={() => onChange(o.id)}>
            {o.icon}
            <span>{o.label}</span>
            {typeof o.count === 'number' && o.count > 0 && <span className="cp-seg__n cp-num">{o.count}</span>}
          </button>
        );
      })}
      <Ink ink={ink} />
    </span>
  );
}
