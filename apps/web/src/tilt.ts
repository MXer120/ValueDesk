/**
 * A card leans toward the pointer a little, and back when it leaves. Built for the VIP pass (BotsVip), now every card
 * that should move under the mouse (owner 2026-11-26: "Cards should move when hovered a bit with mouse"). It sets
 * --tx and --ty (degrees) and --sx (where a glare sits, 10% to 90%) on the element; the element's CSS turns them into
 * its transform (kit.css .tf-tilt, botsPages.css .vipx-tilt). Not on touch, not with reduced motion.
 *
 * `reach` is how far from the centre, in the element's own widths and heights, the lean is full: 1.2 for the VIP pass
 * (the whole dialog moves it), 0.5 for a card (its own edge is full).
 */
import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';

export function useTilt<T extends HTMLElement = HTMLDivElement>(maxX = 10, maxY = 8, reach = 1.2): { ref: RefObject<T>; onMove: (e: PointerEvent) => void; onLeave: () => void } {
  const ref = useRef<T>(null);
  const frame = useRef(0);
  const set = (x: number, y: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.style.setProperty('--tx', `${(x * maxX).toFixed(2)}deg`);
      el.style.setProperty('--ty', `${(-y * maxY).toFixed(2)}deg`);
      el.style.setProperty('--sx', `${50 + x * 40}%`);
    });
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    // -1..1 from the centre, held at the reach so a far pointer does not throw it around.
    const x = Math.max(-1, Math.min(1, (e.clientX - (b.left + b.width / 2)) / (b.width * reach)));
    const y = Math.max(-1, Math.min(1, (e.clientY - (b.top + b.height / 2)) / (b.height * reach)));
    set(x, y);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return { ref, onMove, onLeave: () => set(0, 0) };
}
