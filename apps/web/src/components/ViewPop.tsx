/**
 * The "View" pop-up as a reusable surface: the account tables' glass panel
 * (Account.css `.acctf-pop`), anchored under its button, clamped to the
 * viewport, closed by an outside press or Escape, fading out on close
 * (usePresence). The sections inside use FilterBar's `Section` / `Seg`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './motion';
import './Account.css';

interface Pos { left: number; top?: number; bottom?: number; maxHeight: number }
const W = 316;
const GAP = 6;

export function ViewPop({
  open, anchor, onClose, title = 'View', onReset, resetDisabled, children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  title?: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  children: ReactNode;
}) {
  const pres = usePresence(open);
  if (!pres.mounted) return null;
  return (
    <Panel anchor={anchor} onClose={onClose} closing={pres.closing} onExited={pres.done} title={title} onReset={onReset} resetDisabled={resetDisabled}>
      {children}
    </Panel>
  );
}

function Panel({
  anchor, onClose, closing, onExited, title, onReset, resetDisabled, children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  closing: boolean;
  onExited: () => void;
  title: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const place = useCallback(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(vw - W - 8, r.right - W));
    const below = vh - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const want = panel.current?.scrollHeight ?? 420;
    if (below >= Math.min(want, 360) || below >= above) setPos({ left, top: r.bottom + GAP, maxHeight: below });
    else setPos({ left, bottom: vh - r.top + GAP, maxHeight: above });
  }, [anchor]);
  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    const on = () => place();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [place]);
  useEffect(() => {
    if (closing) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [anchor, onClose, closing]);

  return createPortal(
    <div
      ref={panel}
      className={`acctf-pop${closing ? ' is-closing' : ''}`}
      onAnimationEnd={(e) => { if (closing && e.animationName === 'mo-pop-out') onExited(); }}
      role="dialog"
      aria-label={title}
      style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight, width: W, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="acctf-head">
        <span>{title}</span>
        {onReset && (
          <button type="button" className="acctf-reset" disabled={resetDisabled} onClick={onReset}>Reset</button>
        )}
      </div>
      {children}
    </div>,
    document.body,
  );
}
