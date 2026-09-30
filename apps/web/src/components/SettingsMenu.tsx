/**
 * The navbar's ONE settings control: hide mode and the page layout (lock it,
 * edit it) behind a single gear, instead of an eye, a caret, a lock and a gear
 * side by side.
 *
 * The gear carries a dot while anything is hidden: a half-on privacy mode that
 * looks off is how you screenshot your balance believing it was covered.
 *
 * The layout rows talk to the mounted Dashboard by window event, as the old
 * icons did - it owns `locked` and its layout menu, and is not a descendant of
 * the header. On a page without a movable layout they are shown disabled.
 */
import { useEffect, useRef, useState } from 'react';
import { PrefsIcon } from './PrefsIcon';
import {
  MODE_HINTS, MODE_LABELS, PRIVACY_HINTS, PRIVACY_KEYS, PRIVACY_LABELS,
  PRIVACY_MODES, usePrivacy,
} from '../privacy';
import { usePresence } from './motion';

export function SettingsMenu({ hasLayout, dashLocked }: { hasLayout: boolean; dashLocked: boolean }) {
  const { hidden, mode, setMode, allHidden, anyHidden, set, setAll, toggle } = usePrivacy();
  const [open, setOpen] = useState(false);
  const pres = usePresence(open);
  const wrap = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  useDismiss(open, wrap, () => setOpen(false));

  return (
    <div className="privacy settings" ref={wrap}>
      <button
        ref={gear}
        type="button"
        className="navicon settings__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title={anyHidden ? 'Settings - some of your data is hidden' : 'Settings'}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
        {anyHidden && <span className="settings__dot" aria-hidden="true" />}
      </button>

      {pres.mounted && (
        <div className={`privacy__menu${pres.closing ? ' is-closing' : ''}`} role="menu" onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}>
          <label className="privacy__item settings__main" title="Hide your balances, positions and address - one press to show them again">
            <span className="privacy__label">Hide my data</span>
            <input type="checkbox" checked={anyHidden} onChange={toggle} />
          </label>

          <div className="privacy__head">
            <span>Hide</span>
            <button type="button" className="privacy__all" onClick={() => setAll(!allHidden)}>
              {allHidden ? 'Show all' : 'Hide all'}
            </button>
          </div>
          {PRIVACY_KEYS.map((k) => (
            <label key={k} className="privacy__item" title={PRIVACY_HINTS[k]}>
              <span className="privacy__label">{PRIVACY_LABELS[k]}</span>
              <input type="checkbox" checked={hidden[k]} onChange={(e) => set(k, e.target.checked)} />
            </label>
          ))}

          <div className="privacy__head privacy__head--mode">
            <span>How</span>
          </div>
          {PRIVACY_MODES.map((m) => (
            <label key={m} className="privacy__item" title={MODE_HINTS[m]}>
              <span className="privacy__label">{MODE_LABELS[m]}</span>
              <input type="radio" name="privacy-mode" checked={mode === m} onChange={() => setMode(m)} />
            </label>
          ))}

          <div className="privacy__head privacy__head--mode">
            <span>Layout</span>
          </div>
          <label
            className={`privacy__item${hasLayout ? '' : ' is-off'}`}
            title={hasLayout ? 'Stop panels from being moved or resized' : 'This page has no movable layout'}
          >
            <span className="privacy__label">Lock layout</span>
            <input
              type="checkbox"
              disabled={!hasLayout}
              checked={hasLayout && dashLocked}
              onChange={() => window.dispatchEvent(new CustomEvent('dash:lock:toggle'))}
            />
          </label>
          <button
            type="button"
            className="privacy__item settings__action"
            disabled={!hasLayout}
            title={hasLayout ? 'Show, hide and reset panels' : 'This page has no movable layout'}
            onClick={() => {
              // Anchor the layout menu under the gear; Dashboard clamps it to the viewport.
              const r = gear.current?.getBoundingClientRect();
              setOpen(false);
              window.dispatchEvent(new CustomEvent('dash:menu', { detail: { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 } }));
            }}
          >
            <span className="privacy__label">Edit layout…</span>
          </button>

          <p className="privacy__note">
            Blurred and pixelated hide a <b>generic</b> figure, not yours. Performance charts are not drawn at all,
            because the shape is the information. Market data stays visible.
          </p>
        </div>
      )}
    </div>
  );
}

/** Close on an outside press or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}

const GearIcon = () => <PrefsIcon size={20} />;
