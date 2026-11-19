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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { EASE_VIEW_CSS, reducedMotion } from '../ease';
import './motion.css';

/** The width up to which the app's sheets are phone sheets (from the bottom edge, draggable): the tab bar's. */
export const SHEET_QUERY = '(max-width: 760px)';

/* --- a phone sheet, dragged by its grip or head -------------------------------------------------------- */

/** Release faster than this (px/ms, downwards) and the sheet goes, however far it was pulled. */
export const SHEET_FLING = 0.5;
/** Pulled further than this share of its height and the sheet goes. */
export const SHEET_DISTANCE = 0.25;

/** Where a drag of `raw` px (down positive) puts the sheet: it follows the finger down, and gives a little upwards. */
export const sheetOffset = (raw: number): number => (raw >= 0 ? raw : Math.max(raw * 0.2, -12));

/** Whether a release at `dy` px with `v` px/ms (down positive) dismisses a sheet `h` px tall. */
export const sheetDismisses = (dy: number, v: number, h: number): boolean => dy > h * SHEET_DISTANCE || v > SHEET_FLING;

/**
 * The exit after a fling: as long as the rest of the way takes at the release speed (at least the sheet's own exit
 * pace, h px in 280 ms), within 120-280 ms, on a curve whose first slope IS the release speed - the finger lets go and
 * the sheet carries on at the same speed, then lands softly (the --ease-view shape, its y1 raised to match).
 */
export function sheetExit(dy: number, v: number, h: number): { ms: number; easing: string } {
  const rest = Math.max(1, h - dy);
  const ms = Math.min(280, Math.max(120, rest / Math.max(v, h / 280)));
  const y1 = Math.min(1, Math.max(0, (0.25 * Math.max(0, v) * ms) / rest));
  return { ms: Math.round(ms), easing: `cubic-bezier(0.25, ${y1.toFixed(3)}, 0.25, 1)` };
}

/**
 * Drag a phone sheet down to dismiss it: from its grip or head only (`.sheet-grip`, `[data-sheet-handle]`, not a
 * button inside it), by touch or pen, while SHEET_QUERY matches. The sheet follows the finger one write per frame
 * (transform only), the scrim lightens with it; on release it goes (pulled past a quarter, or flung) with the
 * release speed carried into its exit, or settles back on --ease-view. Under reduced motion it still follows the
 * finger, and the release resolves at once.
 */
export function useSheetDrag(ref: RefObject<HTMLElement | null>, { enabled, onDismiss }: { enabled: boolean; onDismiss: () => void }): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let id = -1;
    let y0 = 0;
    let dy = 0;
    let h = 1;
    let frame = 0;
    let samples: Array<[number, number]> = [];
    let scrim: HTMLElement | null = null;
    const paint = () => {
      frame = 0;
      el.style.transform = `translate3d(0, ${dy}px, 0)`;
      if (scrim) scrim.style.opacity = String(Math.max(0.4, 1 - (0.6 * Math.max(0, dy)) / h));
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || id !== -1 || !e.isPrimary) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !t.closest('.sheet-grip, [data-sheet-handle]') || t.closest('button, a, input, select, textarea')) return;
      if (typeof matchMedia === 'function' && !matchMedia(SHEET_QUERY).matches) return;
      id = e.pointerId;
      y0 = e.clientY;
      dy = 0;
      h = Math.max(1, el.getBoundingClientRect().height);
      samples = [[e.timeStamp, e.clientY]];
      scrim = el.closest<HTMLElement>('.modal-scrim, .cdlg-scrim');
      // The finger owns it now: the entrance (a CSS animation would win over the inline transform) stops here.
      for (const a of el.getAnimations()) a.cancel();
      el.style.transition = 'none';
      try { el.setPointerCapture(id); } catch { /* a pointer already gone */ }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      dy = sheetOffset(e.clientY - y0);
      samples.push([e.timeStamp, e.clientY]);
      const cut = e.timeStamp - 80;
      while (samples.length > 2 && samples[0]![0] < cut) samples.shift();
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const [t0, ya] = samples[0] ?? [e.timeStamp, e.clientY];
      const dt = e.timeStamp - t0;
      const v = dt > 0 ? (e.clientY - ya) / dt : 0;
      const from = `translate3d(0, ${dy}px, 0)`;
      const still = reducedMotion();
      const fromScrim = scrim?.style.opacity || '1';
      el.style.transform = '';
      el.style.transition = '';
      if (scrim) scrim.style.opacity = '';
      if (e.type !== 'pointercancel' && sheetDismisses(dy, v, h)) {
        const { ms, easing } = sheetExit(dy, v, h);
        const d = still ? 0 : ms;
        // Held at the bottom (fill) through the CSS exit that the close starts: script animations win over it.
        el.animate([{ transform: from }, { transform: 'translate3d(0, 100%, 0)' }], { duration: d, easing, fill: 'forwards' });
        scrim?.animate([{ opacity: fromScrim }, { opacity: 0 }], { duration: d, easing, fill: 'forwards' });
        window.setTimeout(() => dismiss.current(), d);
        return;
      }
      if (still || dy === 0) return;
      el.animate([{ transform: from }, { transform: 'none' }], { duration: 200, easing: EASE_VIEW_CSS });
      scrim?.animate([{ opacity: fromScrim }, { opacity: 1 }], { duration: 200, easing: EASE_VIEW_CSS });
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, enabled]);
}

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
