/**
 * Zoom and pan for the cohort maps (the cohort treemap and the market map).
 *
 * Scroll or pinch zooms around the pointer, drag pans, double-click zooms in.
 * The maps place their tiles in SCREEN space from `view` (x * z + view.x) rather
 * than scaling a layer, so text keeps its size and appears as tiles grow.
 * `moving` is on while the pointer drives the view, so tiles can drop their
 * easing and follow it directly.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

export interface MapView { z: number; x: number; y: number }

export const MAX_ZOOM = 60;
const WHOLE: MapView = { z: 1, x: 0, y: 0 };

export function useMapZoom(resetKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<MapView>(WHOLE);
  const [moving, setMoving] = useState(false);
  const idle = useRef<number | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setView(WHOLE); }, [resetKey]);

  /** Keep the map covering the box: no panning past its edges. */
  const clamp = useCallback((v: MapView): MapView => {
    const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
    return { z, x: Math.min(0, Math.max(size.w - size.w * z, v.x)), y: Math.min(0, Math.max(size.h - size.h * z, v.y)) };
  }, [size]);

  const settle = useCallback(() => {
    setMoving(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setMoving(false), 180);
  }, []);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(1, v.z * factor));
      const k = z / v.z;
      return clamp({ z, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    });
    settle();
  }, [clamp, settle]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setMoving(true);
      setView((v) => clamp({ ...v, x: d.vx + dx, y: d.vy + dy }));
    },
    onPointerUp: () => {
      window.setTimeout(() => { drag.current = null; }, 0);
      setMoving(false);
    },
    onPointerCancel: () => {
      drag.current = null;
      setMoving(false);
    },
    onDoubleClick: (e: ReactMouseEvent<HTMLDivElement>) => {
      const r = ref.current!.getBoundingClientRect();
      zoomAt(2, e.clientX - r.left, e.clientY - r.top);
    },
  };

  return {
    ref, size, view, moving, handlers, zoomAt,
    zoomed: view.z > 1.001,
    reset: () => setView(WHOLE),
    /** A click that was not the end of a drag. */
    isClick: () => !drag.current?.moved,
    /** A layout rect in screen space. */
    toScreen: (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * view.z + view.x, y: r.y * view.z + view.y, w: r.w * view.z, h: r.h * view.z }),
  };
}
