/**
 * "More" at the end of the navbar's pages (owner, 2026-10-28): what is not a trading page -
 * the status page first, then Help & FAQ and Send feedback. While something is open on
 * the status page (an incident, maintenance in progress, or the data service not
 * answering) the button carries a dot, and the Status row says what.
 *
 * Status is a real link with its href, so a middle click or ctrl-click opens it in a tab;
 * a plain click opens it in place (App.tsx openStatus). The menu is the app's glass
 * dropdown (.menu-popup) with its rows; Escape or a click outside closes it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EXCLUDED_PATH, STATUS_PATH } from '../router';
import { FeedbackIcon, openFeedback } from '../feedback/FeedbackButton';
import { openSettings } from '../settingsBus';

/** What the status page has open right now, for the dot: worst first. */
export type NavAlert = 'down' | 'incident' | 'maintenance' | null;

const ALERT_HINT: Record<Exclude<NavAlert, null>, string> = {
  down: 'Not reachable',
  incident: 'Incident',
  maintenance: 'Maintenance',
};

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export function NavMore({ alert = null, onOpenStatus, onOpenExcluded }: { alert?: NavAlert; onOpenStatus?: () => void; onOpenExcluded?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    root.current?.querySelector<HTMLElement>('.menu-row')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="navmore" ref={root}>
      <button
        type="button"
        className={`navmore__btn${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={alert ? `More - status: ${ALERT_HINT[alert].toLowerCase()}` : 'More'}
        onClick={() => setOpen((v) => !v)}
      >
        More
        {alert && <span className={`navmore__dot is-${alert}`} aria-hidden="true" />}
        <svg className="navmore__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="menu-popup navmore__menu" role="menu" aria-label="More">
          <a
            role="menuitem"
            className="menu-row"
            href={STATUS_PATH}
            onClick={(e) => {
              if (!onOpenStatus || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              setOpen(false);
              onOpenStatus();
            }}
          >
            <span className="menu-row__ic"><Icon><path d="M2.5 10h3l2-5 3 10 2-5h5" /></Icon></span>
            <span className="menu-row__label">Status</span>
            {alert && <span className={`navmore__hint is-${alert}`}>{ALERT_HINT[alert]}</span>}
          </a>
          <a
            role="menuitem"
            className="menu-row"
            href={EXCLUDED_PATH}
            onClick={(e) => {
              if (!onOpenExcluded || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              setOpen(false);
              onOpenExcluded();
            }}
          >
            <span className="menu-row__ic"><Icon><circle cx="10" cy="10" r="7" /><path d="M5 15 15 5" /></Icon></span>
            <span className="menu-row__label">Excluded wallets</span>
          </a>
          <button type="button" role="menuitem" className="menu-row" onClick={() => { setOpen(false); openSettings('help'); }}>
            <span className="menu-row__ic"><Icon><circle cx="10" cy="10" r="7" /><path d="M7.9 7.8a2.2 2.2 0 1 1 3 2.1c-.6.3-.9.7-.9 1.3v.4" /><path d="M10 14.2h.01" /></Icon></span>
            <span className="menu-row__label">Help &amp; FAQ</span>
          </button>
          <button type="button" role="menuitem" className="menu-row" onClick={() => { setOpen(false); openFeedback(); }}>
            <span className="menu-row__ic"><FeedbackIcon /></span>
            <span className="menu-row__label">Send feedback</span>
          </button>
        </div>
      )}
    </div>
  );
}
