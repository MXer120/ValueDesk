/**
 * Motion for panels whose content changes: nothing in a sheet or menu should
 * jump from one state to the next.
 *
 *   <Collapse open>      expands and collapses smoothly (grid rows 0fr -> 1fr),
 *                        and is inert while closed;
 *   <AutoHeight>         animates its own height to whatever its content
 *                        becomes, so a sheet grows and shrinks instead of
 *                        snapping when a view, a note or a result appears;
 *   <FadeView viewKey>   re-mounts on a new key and fades the new content in;
 *   usePresence(open)    keeps a pop-up mounted while it animates OUT (add
 *                        `is-closing` to it; the CSS in motion.css plays the
 *                        exit, and `done` - or a timer - unmounts it).
 *
 * All of it is switched off under prefers-reduced-motion (motion.css).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './motion.css';

export function Collapse({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !open;
  }, [open]);
  return (
    <div ref={ref} className={`mo-collapse${open ? ' is-open' : ''}`}>
      <div className={`mo-collapse__in ${className}`}>{children}</div>
    </div>
  );
}

export function AutoHeight({ children, className = '' }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="mo-autoh" style={height === null ? undefined : { height }}>
      <div ref={inner} className={className}>{children}</div>
    </div>
  );
}

export function FadeView({ viewKey, children, className = '' }: { viewKey: string; children: ReactNode; className?: string }) {
  return (
    <div key={viewKey} className={`mo-fade ${className}`}>
      {children}
    </div>
  );
}

/** How long a pop-up's exit may take before it is unmounted regardless. */
export const EXIT_MS = 160;

/**
 * Keeps something mounted while it animates out. `mounted` turns true with
 * `open` in the same render (no empty frame before the enter animation) and
 * false after the exit: `done()` from the element's animationend, or EXIT_MS
 * later - a background tab or a hidden ancestor never fires the event.
 */
export function usePresence(open: boolean, ms = EXIT_MS): { mounted: boolean; closing: boolean; done: () => void } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const closing = mounted && !open;
  const done = useCallback(() => setMounted(false), []);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(done, ms);
    return () => window.clearTimeout(t);
  }, [closing, done, ms]);
  return { mounted: mounted || open, closing, done };
}

/**
 * usePresence for a pop-up driven by a VALUE (which menu is open, where a
 * context menu sits): while it animates out, `value` is still the last one
 * shown, `closing` is true, and `onExit` (the element's onAnimationEnd) ends it.
 *
 *   const m = useLatched(openMenu);
 *   {m.value === 'style' && <div className={`menu-popup${m.closing ? ' is-closing' : ''}`} onAnimationEnd={m.onExit}>}
 */
export function useLatched<T>(value: T | null | undefined | false, ms = EXIT_MS): {
  value: T | null;
  closing: boolean;
  onExit: (e: { animationName: string }) => void;
} {
  const live = value === null || value === undefined || value === false ? null : value;
  const [last, setLast] = useState<T | null>(live);
  if (live !== null && live !== last) setLast(live);
  const closing = live === null && last !== null;
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setLast(null), ms);
    return () => window.clearTimeout(t);
  }, [closing, ms]);
  const onExit = useCallback((e: { animationName: string }) => {
    if (e.animationName === 'mo-pop-out') setLast(null);
  }, []);
  return { value: live ?? last, closing, onExit };
}

/**
 * Cross-fade between two views of the same place (Position History cards <->
 * list, the fee sheet's two engines): the new view sets the height at once,
 * the old one fades out on top of it, and the box eases to the new height.
 */
export function CrossFade({ viewKey, children, className = '' }: { viewKey: string; children: ReactNode; className?: string }) {
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  const last = useRef<{ key: string; node: ReactNode }>({ key: viewKey, node: children });
  if (last.current.key !== viewKey) {
    const prev = last.current;
    last.current = { key: viewKey, node: children };
    if (!leaving || leaving.key !== prev.key) setLeaving(prev);
  } else {
    last.current = { key: viewKey, node: children };
  }
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), 260);
    return () => window.clearTimeout(t);
  }, [leaving]);
  return (
    <AutoHeight className={`mo-xfade ${className}`}>
      <div className="mo-xfade__stack">
        {leaving && leaving.key !== viewKey && (
          <div key={leaving.key} className="mo-xfade__out" aria-hidden="true">{leaving.node}</div>
        )}
        <div key={viewKey} className="mo-xfade__in">{children}</div>
      </div>
    </AutoHeight>
  );
}
