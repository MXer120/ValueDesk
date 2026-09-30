/**
 * The dashboard's own right-click menu - summoned by right-clicking any
 * panel (see the window-level `contextmenu` listener in Dashboard.tsx, which
 * decides whether a click lands on this menu's territory the same way
 * Market.tsx's header stat menu decides for its own header: by geometry, not
 * DOM ancestry, so the resize grip and the drag strip sitting on top of a
 * panel do not swallow the click).
 *
 * ONE lock control, not one per panel - the lock is a single fact about the
 * whole dashboard (`Dashboard.tsx`'s own `locked`), so every panel's menu
 * shows and drives the exact same toggle rather than each pretending to own
 * a private one. "View" is the panel checklist: which of the panels this
 * screen size can show are actually in the grid right now, with the same
 * add/remove-by-ticking interaction Market.tsx's header stat menu already
 * uses for exactly the same kind of question.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LayoutMenuPanel {
  id: string;
  name: string;
}

function useDismiss(ref: React.RefObject<HTMLElement>, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref]);
}

/** Closed shackle when locked, swung open (one leg lifted clear of the body)
 *  when not - the same shape change a real padlock icon makes, so the icon
 *  carries the state and not just the tooltip text next to it. */
const LockIcon = ({ locked }: { locked: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path
      d={locked ? 'M4.5 6.3V4.5a2.5 2.5 0 0 1 5 0v1.8' : 'M4.5 6.3V4.5a2.5 2.5 0 0 1 4.5-1.5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <rect x="3" y="6.3" width="8" height="6" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const Tick = () => (
  <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true" focusable="false">
    <path d="M1 4.3 3.7 7 9 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function LayoutMenu({
  at, locked, onToggleLock, panels, hidden, onTogglePanel, onReset, hasSaved, onEditLayout, onNotificationSettings, onClose, closing = false, onExit,
}: {
  /** Fading out (motion.css); `onExit` is its onAnimationEnd. */
  closing?: boolean;
  onExit?: (e: { animationName: string }) => void;
  at: { x: number; y: number };
  locked: boolean;
  onToggleLock: () => void;
  panels: LayoutMenuPanel[];
  hidden: ReadonlySet<string>;
  onTogglePanel: (id: string) => void;
  onReset: () => void;
  hasSaved: boolean;
  /** Opens the scaled edit canvas. Absent only if a caller has no canvas. */
  onEditLayout?: () => void;
  /** Absent when the caller has nowhere to send this yet - see the prop of
   *  the same name on Dashboard.tsx. No item is rendered rather than a dead
   *  one. */
  onNotificationSettings?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [idx, setIdx] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useDismiss(ref, onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlace({
      left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at]);

  useEffect(() => {
    if (place) items.current[idx]?.focus();
  }, [idx, place]);

  // Reset is always there. Edit layout and notification settings are optional.
  const editIndex = onEditLayout ? panels.length : -1;
  const resetIndex = panels.length + (onEditLayout ? 1 : 0);
  const noteIndex = onNotificationSettings ? resetIndex + 1 : -1;
  const count = panels.length + 1 + (onEditLayout ? 1 : 0) + (onNotificationSettings ? 1 : 0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + count) % count); }
    else if (e.key === 'Home') { e.preventDefault(); setIdx(0); }
    else if (e.key === 'End') { e.preventDefault(); setIdx(count - 1); }
  };

  return createPortal(
    <div
      ref={ref}
      className={`menu-popup dash-layoutmenu${closing ? ' is-closing' : ''}`}
      onAnimationEnd={onExit}
      role="menu"
      aria-label="Dashboard layout"
      onKeyDown={onKeyDown}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? undefined : 'hidden',
      }}
    >
      <div className="dash-layoutmenu-head">
        <span className="menu-group-label">View</span>
        <button
          type="button"
          className="dash-layoutmenu-lock"
          aria-pressed={locked}
          onClick={onToggleLock}
          title={locked ? 'Panels are locked in place' : 'Prevent panels being dragged or resized'}
        >
          <LockIcon locked={locked} />
        </button>
      </div>
      {panels.map((p, i) => {
        const shown = !hidden.has(p.id);
        return (
          <button
            key={p.id}
            ref={(el) => { items.current[i] = el; }}
            type="button"
            role="menuitemcheckbox"
            aria-checked={shown}
            tabIndex={i === idx ? 0 : -1}
            className={`dash-layoutmenu-item ${shown ? 'is-on' : ''}`}
            onFocus={() => setIdx(i)}
            onClick={() => onTogglePanel(p.id)}
          >
            <span className="dash-layoutmenu-mark" aria-hidden="true">{shown && <Tick />}</span>
            <span>{p.name}</span>
          </button>
        );
      })}
      <div className="dash-layoutmenu-foot">
        {onEditLayout && (
          <button
            ref={(el) => { items.current[editIndex] = el; }}
            type="button"
            role="menuitem"
            tabIndex={idx === editIndex ? 0 : -1}
            className="dash-layoutmenu-item"
            title="Backslash"
            onFocus={() => setIdx(editIndex)}
            onClick={() => { onEditLayout(); onClose(); }}
          >
            <span className="dash-layoutmenu-mark" aria-hidden="true" />
            <span>Edit layout</span>
          </button>
        )}
        <button
          ref={(el) => { items.current[resetIndex] = el; }}
          type="button"
          role="menuitem"
          tabIndex={idx === resetIndex ? 0 : -1}
          className="dash-layoutmenu-item"
          disabled={!hasSaved && !locked}
          onFocus={() => setIdx(resetIndex)}
          onClick={onReset}
        >
          <span className="dash-layoutmenu-mark" aria-hidden="true" />
          <span>Reset layout</span>
        </button>
        {onNotificationSettings && (
          <button
            ref={(el) => { items.current[noteIndex] = el; }}
            type="button"
            role="menuitem"
            tabIndex={idx === noteIndex ? 0 : -1}
            className="dash-layoutmenu-item"
            onFocus={() => setIdx(noteIndex)}
            onClick={() => { onNotificationSettings(); onClose(); }}
          >
            <span className="dash-layoutmenu-mark" aria-hidden="true" />
            <span>Notification settings</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
