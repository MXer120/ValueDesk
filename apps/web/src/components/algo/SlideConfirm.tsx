/**
 * Slide to confirm: the knob has to be dragged all the way right and let go there. Let go
 * anywhere short of the end and it slides back, nothing sent. The keyboard moves it with the
 * arrow keys (End jumps to the end), and reaching the end by key confirms as a release does.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const KNOB = 48;
const PAD = 4;

export function SlideConfirm({ label, tone, disabled = false, busy = false, onConfirm }: {
  label: string;
  tone: 'buy' | 'sell' | 'paper';
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const [drag, setDragState] = useState<{ x0: number; p0: number } | null>(null);
  // The drag and position as of the last event (a quick drag moves before React re-renders).
  const dragRef = useRef<{ x0: number; p0: number } | null>(null);
  const pRef = useRef(0);
  const setDrag = (v: { x0: number; p0: number } | null) => {
    dragRef.current = v;
    setDragState(v);
  };
  const setAt = (v: number) => {
    pRef.current = v;
    setP(v);
  };
  const span = () => Math.max(1, (track.current?.clientWidth ?? 300) - KNOB - PAD * 2);
  const off = disabled || busy;
  const release = (at: number) => {
    setDrag(null);
    if (at >= 0.97) {
      setAt(1);
      onConfirm();
      window.setTimeout(() => setAt(0), 900);
    } else setAt(0);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (off) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer: the moves still come to the knob */
    }
    setDrag({ x0: e.clientX, p0: pRef.current });
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = dragRef.current;
    if (!g) return;
    setAt(Math.min(1, Math.max(0, g.p0 + (e.clientX - g.x0) / span())));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (off) return;
    const step = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : e.key === 'End' ? 1 : e.key === 'Home' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(1, Math.max(0, p + step));
    if (next >= 1) release(1);
    else setAt(next);
  };
  return (
    <div
      ref={track}
      className={`algo-slide is-${tone}${drag ? ' is-drag' : ''}${off ? ' is-off' : ''}${p >= 0.97 ? ' is-end' : ''}`}
      style={{ ['--p' as string]: p, ['--knob' as string]: `${KNOB}px` }}
    >
      <span className="algo-slide__fill" aria-hidden="true" />
      <span className="algo-slide__label">{busy ? 'Placing…' : label}</span>
      <div
        className="algo-slide__knob"
        role="slider"
        tabIndex={off ? -1 : 0}
        aria-label={`${label}: drag to the end and let go`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p * 100)}
        aria-disabled={off}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => dragRef.current && release(pRef.current)}
        onPointerCancel={() => release(0)}
        onKeyDown={key}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M5 3.5 9.5 8 5 12.5M9 3.5l4.5 4.5L9 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
}
