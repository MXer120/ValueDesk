/**
 * The dashboard's own right-click menu - summoned by right-clicking any
 * panel (see the window-level `contextmenu` listener in Dashboard.tsx, which
 * decides whether a click lands on this menu's territory the same way
 * Market.tsx's header stat menu decides for its own header: by geometry, not
 * DOM ancestry, so the resize grip and the drag strip sitting on top of a
 * panel do not swallow the click).
 *
 * The app's menu rows (styles.css `.menu-row`), each with its icon (owner,
 * 2026-10-26: "edit, unlock and reset + that element's settings"): Edit layout,
 * Lock / Unlock panels (ONE lock for the whole dashboard, `Dashboard.tsx`'s own
 * `locked`, so every panel's menu drives the same toggle), Reset layout, and -
 * under a line - the settings of the panel that was right-clicked, when it has
 * any (SettingsMenu.tsx opens at its section). Panels are added and taken out
 * in Edit layout, not here.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MENU_ICONS } from './tabExtras';
import { FeedbackIcon } from '../feedback/FeedbackButton';

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

interface Action {
  key: string;
  label: string;
  icon: React.ReactNode;
  run: () => void;
  disabled?: boolean;
  hint?: string;
  title?: string;
  pressed?: boolean;
  /** A line above it: the panel's own settings, apart from the layout's. */
  sep?: boolean;
}

export function LayoutMenu({
  at, locked, onToggleLock, onReset, hasSaved, onEditLayout, panelSettings, onFeedback, onClose, closing = false, onExit,
}: {
  /** Fading out (motion.css); `onExit` is its onAnimationEnd. */
  closing?: boolean;
  onExit?: (e: { animationName: string }) => void;
  at: { x: number; y: number };
  locked: boolean;
  onToggleLock: () => void;
  onReset: () => void;
  hasSaved: boolean;
  /** Opens the scaled edit canvas. Absent only if a caller has no canvas. */
  onEditLayout?: () => void;
  /** The right-clicked panel's settings ("News settings"); absent when it has none. */
  panelSettings?: { label: string; run: () => void };
  /** "Send feedback about this": the feedback chat with the right-clicked element attached (feedback/). */
  onFeedback?: () => void;
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

  const actions: Action[] = [
    ...(onEditLayout ? [{ key: 'edit', label: 'Edit layout', icon: MENU_ICONS.edit, hint: '\\', title: 'Arrange, add and take out panels (Backslash)', run: () => { onEditLayout(); onClose(); } }] : []),
    {
      key: 'lock',
      label: locked ? 'Unlock panels' : 'Lock panels',
      icon: locked ? MENU_ICONS.unlock : MENU_ICONS.lock,
      title: locked ? 'Panels are locked in place' : 'Stop panels being dragged or resized',
      pressed: locked,
      run: onToggleLock,
    },
    { key: 'reset', label: 'Reset layout…', icon: MENU_ICONS.reset, disabled: !hasSaved && !locked, run: onReset },
    ...(panelSettings ? [{ key: 'panel', label: panelSettings.label, icon: MENU_ICONS.settings, sep: true, run: () => { panelSettings.run(); onClose(); } }] : []),
    ...(onFeedback ? [{ key: 'feedback', label: 'Send feedback about this', icon: <FeedbackIcon />, sep: !panelSettings, run: () => { onClose(); onFeedback(); } }] : []),
  ];
  const count = actions.length;
  const at0 = Math.min(idx, count - 1);

  useEffect(() => {
    if (place) items.current[at0]?.focus();
  }, [at0, place]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((at0 + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((at0 - 1 + count) % count); }
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
      {actions.map((a, i) => (
        <div key={a.key} className="dash-layoutmenu-item">
          {a.sep && <span className="menu-sep" role="separator" />}
          <button
            ref={(el) => { items.current[i] = el; }}
            type="button"
            role="menuitem"
            tabIndex={i === at0 ? 0 : -1}
            className="menu-row"
            disabled={a.disabled}
            aria-pressed={a.pressed}
            title={a.title}
            onFocus={() => setIdx(i)}
            onClick={a.run}
          >
            <span className={`menu-row__ic${a.pressed ? ' is-warn' : ''}`}>{a.icon}</span>
            <span className="menu-row__label">{a.label}</span>
            {a.hint && <kbd className="menu-row__hint">{a.hint}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
