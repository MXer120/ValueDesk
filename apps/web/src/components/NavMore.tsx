/**
 * "More" at the end of the navbar's pages (owner, 2026-10-28; two columns owner 2026-11-05):
 * what is not a trading page, as Products and Resources, each a list of icon + label rows.
 * While something is open on the status page (an incident, maintenance in progress, or the
 * data service not answering) the button carries a dot, and the Status row says what.
 *
 * A page's row is a real link with its href, so a middle click or ctrl-click opens it in a tab;
 * a plain click opens it in place. Community and News leave the site, in a new tab, and say so
 * with a small arrow. The menu is the app's glass dropdown (.menu-popup) with its rows; Escape
 * or a click outside closes it. On a phone it spans the window under the bar.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { EXCLUDED_PATH, LIMITS_PATH, STATUS_PATH, pathForTab, type Tab } from '../router';
import { FeedbackIcon, FEEDBACK_LABEL, openFeedback } from '../feedback/FeedbackButton';
import { FEEDBACK_URL } from '../feedback/feedback';
import { openSettings } from '../settingsBus';

/** What the status page has open right now, for the dot: worst first. */
export type NavAlert = 'down' | 'incident' | 'maintenance' | null;

const ALERT_HINT: Record<Exclude<NavAlert, null>, string> = {
  down: 'Not reachable',
  incident: 'Incident',
  maintenance: 'Maintenance',
};

/** The owner's Discord (docs/GO-LIVE.md): the build's feedback link, which a build may point elsewhere. */
const COMMUNITY_URL = FEEDBACK_URL ?? 'https://discord.gg/TVJKHY9vhK';
const NEWS_URL = 'https://x.com/ValueDeskdotso';

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/** A page of the app: a link with its href, opened in place by a plain click. */
function PageRow({ href, icon, label, current, onOpen, children }: { href: string; icon: ReactNode; label: string; current?: boolean; onOpen?: () => void; children?: ReactNode }) {
  const go = (e: ReactMouseEvent) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpen();
  };
  return (
    <a role="menuitem" className={`menu-row navmore__row${current ? ' is-current' : ''}`} href={href} aria-current={current ? 'page' : undefined} onClick={go}>
      <span className="menu-row__ic">{icon}</span>
      <span className="menu-row__label">{label}</span>
      {children}
    </a>
  );
}

/** Off the site, in a new tab. */
function OutRow({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a role="menuitem" className="menu-row navmore__row" href={href} target="_blank" rel="noreferrer">
      <span className="menu-row__ic">{icon}</span>
      <span className="menu-row__label">{label}</span>
      <svg className="navmore__out" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </a>
  );
}

export function NavMore({ alert = null, tab = null, limits = false, status = false, excluded = false, onNavigate, onOpenStatus, onOpenExcluded, onOpenLimits }: {
  alert?: NavAlert;
  /** The tab on screen, for the Leaderboard row and the button. */
  tab?: Tab | null;
  /** Which of this menu's own pages is on screen. */
  limits?: boolean;
  status?: boolean;
  excluded?: boolean;
  onNavigate?: (tab: Tab) => void;
  onOpenStatus?: () => void;
  onOpenExcluded?: () => void;
  onOpenLimits?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = (then?: () => void) => () => {
    setOpen(false);
    then?.();
  };
  const here = tab === 'leaderboard' || limits || status || excluded;

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
        className={`navmore__btn${open ? ' is-open' : ''}${here ? ' is-here' : ''}`}
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
          <div className="navmore__col" role="group" aria-label="Products">
            <div className="menu-group-label" aria-hidden="true">Products</div>
            <PageRow
              href={pathForTab('leaderboard')}
              label="Leaderboard"
              current={tab === 'leaderboard'}
              onOpen={onNavigate && close(() => onNavigate('leaderboard'))}
              icon={<Icon><path d="M7.5 17v-6.5h5V17M2.5 17v-4h5M12.5 17v-8h5v8M1.5 17h17" /><path d="M10 3.2 10.8 5l1.9.2-1.4 1.3.4 1.9-1.7-1-1.7 1 .4-1.9-1.4-1.3L9.2 5 10 3.2Z" /></Icon>}
            />
            <PageRow
              href={LIMITS_PATH}
              label="Trading limits"
              current={limits}
              onOpen={onOpenLimits && close(onOpenLimits)}
              icon={<Icon><path d="M2.5 15.5a7.5 7.5 0 0 1 15 0" /><path d="M10 15.5 13.2 9.6" /><path d="M2.5 15.5h1.8M15.7 15.5h1.8M10 8v1.5" /></Icon>}
            />
            <PageRow
              href={EXCLUDED_PATH}
              label="Excluded wallets"
              current={excluded}
              onOpen={onOpenExcluded && close(onOpenExcluded)}
              icon={<Icon><circle cx="10" cy="10" r="7" /><path d="M5 15 15 5" /></Icon>}
            />
          </div>
          <div className="navmore__col" role="group" aria-label="Resources">
            <div className="menu-group-label" aria-hidden="true">Resources</div>
            <PageRow
              href={STATUS_PATH}
              label="Status"
              current={status}
              onOpen={onOpenStatus && close(onOpenStatus)}
              icon={<Icon><path d="M2.5 10h3l2-5 3 10 2-5h5" /></Icon>}
            >
              {alert && <span className={`navmore__hint is-${alert}`}>{ALERT_HINT[alert]}</span>}
            </PageRow>
            <button type="button" role="menuitem" className="menu-row navmore__row" onClick={close(() => openSettings('help'))}>
              <span className="menu-row__ic"><Icon><circle cx="10" cy="10" r="7" /><path d="M7.9 7.8a2.2 2.2 0 1 1 3 2.1c-.6.3-.9.7-.9 1.3v.4" /><path d="M10 14.2h.01" /></Icon></span>
              <span className="menu-row__label">Help &amp; FAQ</span>
            </button>
            <button type="button" role="menuitem" className="menu-row navmore__row" onClick={close(() => openFeedback())}>
              <span className="menu-row__ic"><FeedbackIcon /></span>
              <span className="menu-row__label">{FEEDBACK_LABEL}</span>
            </button>
            <OutRow
              href={COMMUNITY_URL}
              label="Community"
              icon={<Icon><path d="M7.4 4.6c-1.5.2-2.8.7-3.8 1.3C2 8.400 1.300 11.200 1.600 14.300c1.300 1 2.700 1.600 4.100 1.900l1-1.700M12.600 4.600c1.500.2 2.800.7 3.800 1.300 1.600 2.500 2.300 5.300 2 8.400-1.300 1-2.700 1.600-4.100 1.900l-1-1.700" /><path d="M5.500 14c2.900 1.200 6.100 1.200 9 0M6.500 6c2.300-.7 4.700-.7 7 0" /><circle cx="7.400" cy="10.700" r="1.200" /><circle cx="12.600" cy="10.700" r="1.200" /></Icon>}
            />
            <OutRow
              href={NEWS_URL}
              label="News & updates"
              icon={<Icon><path d="M3.500 3.500h3.200l9.800 13h-3.200l-9.800-13ZM16 3.500l-5 5.700M4 16.500l5.200-5.900" /></Icon>}
            />
          </div>
        </div>
      )}
    </div>
  );
}
