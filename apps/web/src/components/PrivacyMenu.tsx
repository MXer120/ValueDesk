/**
 * The incognito control: one button that hides everything, one menu that says
 * exactly what "everything" covers and lets you pick less.
 *
 * The button is the panic path - streaming starts, someone walks up - so it is a
 * single click to hide all of it and a single click to bring it back. The menu
 * behind the caret is for the case where you only ever wanted to hide one thing,
 * which in practice is usually the balance or the address.
 *
 * The eye is FILLED when anything is hidden, not only when everything is. A
 * half-on privacy mode that looks off is how you screenshot your balance
 * believing it was covered.
 */
import { useEffect, useRef, useState } from 'react';
import {
  MODE_HINTS, MODE_LABELS, PRIVACY_HINTS, PRIVACY_KEYS, PRIVACY_LABELS,
  PRIVACY_MODES, usePrivacy,
} from '../privacy';

export function PrivacyMenu() {
  const { hidden, mode, setMode, allHidden, anyHidden, set, setAll } = usePrivacy();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  /* Dismiss on any press outside, and on Escape. Copied rather than shared: the
     other popovers on this page each carry their own for the same reason. */
  useDismiss(open, wrap, () => setOpen(false));

  return (
    <div className="privacy" ref={wrap}>
      <button
        type="button"
        className="navicon"
        aria-pressed={anyHidden}
        aria-label={anyHidden ? 'Show my data' : 'Hide my data'}
        title={
          allHidden ? 'Incognito: everything hidden — click to show'
            : anyHidden ? 'Incognito: some data hidden — click to hide everything'
              : 'Incognito: hide my balances, positions and address'
        }
        onClick={() => setAll(!allHidden)}
      >
        <EyeIcon off={anyHidden} />
      </button>

      <button
        type="button"
        className="navicon privacy__more"
        aria-label="Choose what to hide"
        aria-expanded={open}
        title="Choose what to hide"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretIcon />
      </button>

      {open && (
        <div className="privacy__menu" role="menu">
          <div className="privacy__head">
            <span>Hide</span>
            <button type="button" className="privacy__all" onClick={() => setAll(!allHidden)}>
              {allHidden ? 'Show all' : 'Hide all'}
            </button>
          </div>
          {PRIVACY_KEYS.map((k) => (
            /* Label first, control last: the eye scans the names to find the one
               it wants, and a column of checkboxes on the left makes every row
               start with the same glyph instead of with the word that
               distinguishes it. */
            <label key={k} className="privacy__item" title={PRIVACY_HINTS[k]}>
              <span className="privacy__label">{PRIVACY_LABELS[k]}</span>
              <input
                type="checkbox"
                checked={hidden[k]}
                onChange={(e) => set(k, e.target.checked)}
              />
            </label>
          ))}

          <div className="privacy__head privacy__head--mode">
            <span>How</span>
          </div>
          {/* Radios, not a segmented control: four options with a sentence of
              explanation each do not fit in a strip, and this is a setting you
              choose once rather than a filter you sweep through. */}
          {PRIVACY_MODES.map((m) => (
            <label key={m} className="privacy__item" title={MODE_HINTS[m]}>
              <span className="privacy__label">{MODE_LABELS[m]}</span>
              <input
                type="radio"
                name="privacy-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
            </label>
          ))}

          <p className="privacy__note">
            Blurred and pixelated hide a <b>generic</b> figure, not yours — a blur over a real
            number can be read back from a screenshot. Performance charts are not drawn at all,
            because the shape is the information.
          </p>
          <p className="privacy__note">
            This replaces what is drawn on screen. Market data stays visible, and it is not
            encryption — in the dense tables the value is still in the page.
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


/**
 * An eye, struck through when anything is hidden.
 *
 * 20px viewBox and 1.5 stroke, matching the other navbar glyphs - a different
 * weight here would read as a different class of control.
 */
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path
      d="M1.5 10S4.6 4.8 10 4.8 18.5 10 18.5 10 15.4 15.2 10 15.2 1.5 10 1.5 10z"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
    />
    <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    {off && (
      <path d="M3.2 16.8 16.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    )}
  </svg>
);

const CaretIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M6.5 8.5 10 12l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
