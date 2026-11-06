/**
 * Right-click -> "Send feedback about this" (owner, 2026-10-27: "in the feedback
 * the element that got right clicked is directly added").
 *
 * The trade page's dashboard has its own right-click menu (dashboard/LayoutMenu.tsx);
 * it carries the same entry. Everywhere else this small menu opens instead of
 * the browser's - EXCEPT where the browser's own menu is what a person wants:
 *   - in a text field, a select or editable content (paste, spell check);
 *   - while text is selected (copy);
 *   - on a link (open in a new tab, copy the address);
 *   - with Shift held: Shift + right-click still gives the browser's menu (the
 *     hint saying so was removed, owner 2026-11-06);
 *   - where something else already took the click (a chart's own menu, the
 *     dashboard's: `defaultPrevented`, or inside the dashboard's area).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describeElement, type ElementInfo } from './element';
import { FeedbackIcon, openFeedback, reportTranslation } from './FeedbackButton';
import { useLanguage } from '../i18n/store';

/** Whether a right-click on `target` keeps the browser's own menu (see the header). */
export function keepNativeMenu(e: { defaultPrevented: boolean; shiftKey: boolean; target: unknown }, selection: string): boolean {
  if (e.defaultPrevented || e.shiftKey || selection.trim()) return true;
  const t = e.target as { closest?: (selector: string) => unknown } | null;
  if (!t || typeof t.closest !== 'function') return true;
  if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], a[href]')) return true;
  // The dashboard's area has its own menu (Dashboard.tsx), menus and dialogs their own clicks.
  if (t.closest('.dash-scroll, .menu-popup, .modal-scrim')) return true;
  return false;
}

export function FeedbackMenu() {
  const lang = useLanguage();
  const [at, setAt] = useState<{ x: number; y: number; element: ElementInfo } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    // On the document, bubbling: after every element's own handler, before the window's.
    const onMenu = (e: MouseEvent) => {
      if (keepNativeMenu(e, window.getSelection()?.toString() ?? '')) return;
      e.preventDefault();
      setPlace(null);
      setAt({ x: e.clientX, y: e.clientY, element: describeElement(e.target as Element, window.location.pathname) });
    };
    document.addEventListener('contextmenu', onMenu);
    return () => document.removeEventListener('contextmenu', onMenu);
  }, []);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return;
      setAt(null);
    };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [at]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!at || !el) return;
    const r = el.getBoundingClientRect();
    setPlace({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [at]);

  if (!at) return null;
  return createPortal(
    <div
      ref={ref}
      className="menu-popup dash-layoutmenu fb-menu"
      role="menu"
      aria-label="Feedback"
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? undefined : 'hidden' }}
    >
      <button
        type="button"
        role="menuitem"
        className="menu-row"
        onClick={() => {
          const element = at.element;
          setAt(null);
          openFeedback({ element });
        }}
      >
        <span className="menu-row__ic"><FeedbackIcon /></span>
        <span className="menu-row__label">Send feedback about this</span>
      </button>
      {lang !== 'en' && (
        <button
          type="button"
          role="menuitem"
          className="menu-row"
          onClick={() => {
            const element = at.element;
            setAt(null);
            reportTranslation(element);
          }}
        >
          <span className="menu-row__ic"><FeedbackIcon /></span>
          <span className="menu-row__label">Report a translation issue</span>
        </button>
      )}
    </div>,
    document.body,
  );
}
