/**
 * The React half of lineMorph.ts: hand it the line it should show (in pixels), a `key` that names WHICH line it is
 * (range, view, wallet - whatever a switch changes) and the decor drawn with it (axis labels), and it gives back:
 *
 *   frame  the line to draw this frame while a switch morphs (null when settled: draw the line itself);
 *   e      how far the morph is (eased, 0..1);
 *   prev   the decor of the chart switched away from, to fade out at 1 - e while the new decor fades in at e.
 *
 * Only a change of `key` morphs. A new point arriving, or the plot resizing, redraws at once, as the trade chart does
 * for a live tick. A switch during a morph starts from the frame on screen. Under reduced motion it switches at once.
 */
import { useEffect, useReducer, useRef } from 'react';
import { LINE_MORPH_MS, blendShapes, easeLineMorph, type LineShape } from './lineMorph';

const motionOk = (): boolean => {
  try {
    return typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
};
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface State<D> {
  key: string;
  /** The line on screen after the last render. */
  shown: LineShape | null;
  decor: D | null;
  /** While morphing: where it started, the decor it fades out, and when. */
  from: LineShape | null;
  prev: D | null;
  t0: number;
}

export function useLineMorph<D>(target: LineShape | null, key: string, decor: D): { frame: LineShape | null; e: number; prev: D | null } {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<State<D> | null>(null);
  if (!ref.current) ref.current = { key, shown: null, decor: null, from: null, prev: null, t0: 0 };
  const s = ref.current;

  if (key !== s.key) {
    // Another line: from the one on screen, whatever it is doing.
    if (s.shown && target && target.pts.length > 1 && motionOk()) {
      s.from = s.shown;
      s.prev = s.decor;
      s.t0 = now();
    } else {
      s.from = null;
      s.prev = null;
    }
    s.key = key;
  }

  let frame: LineShape | null = null;
  let e = 1;
  if (s.from && target) {
    const p = Math.min(1, (now() - s.t0) / LINE_MORPH_MS);
    e = easeLineMorph(p);
    if (p < 1) frame = blendShapes(s.from, target, e);
    else {
      s.from = null;
      s.prev = null;
    }
  } else if (!target) {
    s.from = null;
    s.prev = null;
  }
  s.shown = frame ?? target;
  s.decor = decor;

  const morphing = frame !== null;
  // One frame at a time while morphing: each render asks for the next.
  useEffect(() => {
    if (!morphing) return;
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  });

  return { frame, e: morphing ? e : 1, prev: morphing ? s.prev : null };
}
