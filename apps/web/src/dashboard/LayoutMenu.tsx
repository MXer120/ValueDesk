/**
 * The dashboard's own right-click menu - summoned by right-clicking any
 * panel (see the window-level `contextmenu` listener in Dashboard.tsx, which
 * decides whether a click lands on this menu's territory the same way
 * Market.tsx's header stat menu decides for its own header: by geometry, not
 * DOM ancestry, so the resize grip and the drag strip sitting on top of a
 * panel do not swallow the click).
 *
 * The app's menu rows (styles.css `.menu-row`): the actions first, each with
 * its icon - Edit layout, Lock / Unlock panels (ONE lock for the whole
 * dashboard, `Dashboard.tsx`'s own `locked`, so every panel's menu drives the
 * same toggle), Reset layout, Notification settings - then the panels this
 * screen size can show, the ones on screen first, each with a box that adds it
 * to the grid or takes it off. The panel list scrolls in its own area, and a
 * search narrows it once there are more than a handful.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MENU_ICONS } from './tabExtras';

export interface LayoutMenuPanel {
  id: string;
  name: string;
}

/** A search is offered past this many panels. */
const SEARCH_FROM = 8;

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

const Tick = () => (
  <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true" focusable="false">
    <path d="M1 4.3 3.7 7 9 1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface Action {
  key: string;
  label: string;
  icon: React.ReactNode;
  run: () => void;
  disabled?: boolean;
  hint?: string;
  title?: string;
  pressed?: boolean;
}

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
  const [q, setQ] = useState('');
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
    ...(onEditLayout ? [{ key: 'edit', label: 'Edit layout', icon: MENU_ICONS.edit, hint: '\\', title: 'Arrange the panels (Backslash)', run: () => { onEditLayout(); onClose(); } }] : []),
    {
      key: 'lock',
      label: locked ? 'Unlock panels' : 'Lock panels',
      icon: locked ? MENU_ICONS.unlock : MENU_ICONS.lock,
      title: locked ? 'Panels are locked in place' : 'Stop panels being dragged or resized',
      pressed: locked,
      run: onToggleLock,
    },
    { key: 'reset', label: 'Reset layout…', icon: MENU_ICONS.reset, disabled: !hasSaved && !locked, run: onReset },
    ...(onNotificationSettings ? [{ key: 'notes', label: 'Notification settings', icon: MENU_ICONS.bell, run: () => { onNotificationSettings(); onClose(); } }] : []),
  ];

  // The panels on screen first, then the rest, each in the grid's own order; a search narrows both.
  const term = q.trim().toLowerCase();
  const { onScreen, offScreen } = useMemo(() => {
    const match = panels.filter((p) => !term || p.name.toLowerCase().includes(term));
    return { onScreen: match.filter((p) => !hidden.has(p.id)), offScreen: match.filter((p) => hidden.has(p.id)) };
  }, [panels, hidden, term]);
  const listed = [...onScreen, ...offScreen];
  const count = actions.length + listed.length;
  // Focus starts on the first action, and stays inside what is listed as a search narrows it.
  const at0 = Math.min(idx, Math.max(0, count - 1));

  useEffect(() => {
    if (place && document.activeElement?.tagName !== 'INPUT') items.current[at0]?.focus();
  }, [at0, place]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inSearch = (e.target as HTMLElement).tagName === 'INPUT';
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(inSearch ? actions.length : (at0 + 1) % count); if (inSearch) items.current[actions.length]?.focus(); }
    else if (e.key === 'ArrowUp' && !inSearch) { e.preventDefault(); setIdx((at0 - 1 + count) % count); }
    else if (e.key === 'Home' && !inSearch) { e.preventDefault(); setIdx(0); }
    else if (e.key === 'End' && !inSearch) { e.preventDefault(); setIdx(count - 1); }
  };

  const shownCount = panels.filter((p) => !hidden.has(p.id)).length;
  const row = (p: LayoutMenuPanel, i: number) => {
    const shown = !hidden.has(p.id);
    const n = actions.length + i;
    return (
      <button
        key={p.id}
        ref={(el) => { items.current[n] = el; }}
        type="button"
        role="menuitemcheckbox"
        aria-checked={shown}
        tabIndex={n === at0 ? 0 : -1}
        className={`menu-row${shown ? '' : ' is-off'}`}
        onFocus={() => setIdx(n)}
        onClick={() => onTogglePanel(p.id)}
      >
        <span className="menu-row__label">{p.name}</span>
        <span className="menu-box" aria-hidden="true">{shown && <Tick />}</span>
      </button>
    );
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
        <button
          key={a.key}
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
      ))}
      <span className="menu-sep" role="separator" />
      <div className="dash-layoutmenu-head">
        <span className="menu-group-label">Panels</span>
        <span className="dash-layoutmenu-count">{shownCount} of {panels.length} on screen</span>
      </div>
      {panels.length > SEARCH_FROM && (
        <label className="dash-layoutmenu-find">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a panel" aria-label="Find a panel" spellCheck={false} autoComplete="off" />
        </label>
      )}
      <div className="dash-layoutmenu-list">
        {onScreen.length > 0 && <p className="dash-layoutmenu-sub">On screen</p>}
        {onScreen.map((p, i) => row(p, i))}
        {offScreen.length > 0 && <p className="dash-layoutmenu-sub">Add to the screen</p>}
        {offScreen.map((p, i) => row(p, onScreen.length + i))}
        {listed.length === 0 && <p className="dash-layoutmenu-none">No panel matches “{q.trim()}”</p>}
      </div>
    </div>,
    document.body,
  );
}
