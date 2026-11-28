/**
 * "More" at the end of the navbar's pages (owner, 2026-10-28; two columns owner 2026-11-05):
 * what is not a trading page, as Data and Resources, each a list of icon + label rows, with SoDEX's
 * own products under Data once App passes `onOpenSodex`. Opens on hover too (useHoverMenu.ts).
 * While something is open on the status page (an incident, maintenance in progress, or the
 * data service not answering) the button carries a dot, and the Status row says what.
 *
 * A page's row is a real link with its href, so a middle click or ctrl-click opens it in a tab;
 * a plain click opens it in place. Community and News leave the site, in a new tab, and say so
 * with a small arrow. The menu is the app's glass dropdown (.menu-popup) with its rows; Escape
 * or a click outside closes it. On a phone it spans the window under the bar.
 *
 * The Impressum and the other legal documents are reachable from here on every page (owner 2026-11-06:
 * out of the status bar, which is gone). One row; the legal page lists all the documents beside it.
 */
import { useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { markSeen, useUnseen, type NewPage } from './navSeen';
import { EXCLUDED_PATH, LIMITS_PATH, SODEX_LABELS, SODEX_VIEWS, STATUS_PATH, pathForLegal, pathForSodexView, pathForTab, type LegalPage, type SodexView, type Tab } from '../router';
import { applyForBeta } from '../beta/access';
import { FeedbackIcon, FEEDBACK_LABEL, openFeedback } from '../feedback/FeedbackButton';
import { FEEDBACK_URL } from '../feedback/url';
import { openSettings } from '../settingsBus';
import { usePresence } from './motion';
import { useHoverMenu } from './useHoverMenu';
import { LanguageMoreRow } from './LanguageMenu';

/** More's legal row lands here; the legal page lists the other documents beside it. */
const LEGAL_HOME: LegalPage = 'impressum';

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

const SODEX_ICONS: Record<SodexView, ReactNode> = {
  points: <Icon><path d="M10 2.8 12.2 7.300l5 .7-3.600 3.500.9 4.900L10 14.100l-4.500 2.300.9-4.900L2.800 8l5-.7L10 2.800Z" /></Icon>,
  'blind-boxes': <Icon><path d="M3 6.500 10 3l7 3.500v7L10 17l-7-3.500v-7Z" /><path d="M3 6.500 10 10l7-3.500M10 10v7" /></Icon>,
  wealth: <Icon><path d="M2.500 17h15M4 14l4-4 3 2.500L16.500 6" /><path d="M12.500 6h4v4" /></Icon>,
};

/** A page of the app: a link with its href, opened in place by a plain click. */
const NewDot = () => <span className="navmore__new" aria-label="Not visited yet" />;

function PageRow({ href, icon, label, current, onOpen, children }: { href: string; icon: ReactNode; label: ReactNode; current?: boolean; onOpen?: () => void; children?: ReactNode }) {
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

export function NavMore({ alert = null, tab = null, limits = false, status = false, excluded = false, onNavigate, onOpenStatus, onOpenExcluded, onOpenLimits, onOpenSodex, sodexOn = null, onOpenLegal, legalOn = false, settingsRow = false, sodexOpen = true }: {
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
  /** Open one of SoDEX's products; without it there is no SoDEX group. */
  onOpenSodex?: (view: SodexView) => void;
  sodexOn?: SodexView | null;
  onOpenLegal?: (page: LegalPage) => void;
  legalOn?: boolean;
  /** No wallet menu to hold Settings: they sit here instead. */
  settingsRow?: boolean;
  /** SoDEX's products are open for this wallet (beta/access.ts); else their rows ask for access (owner 2026-11-07). */
  sodexOpen?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { open, mode, close: shut, press, hoverProps } = useHoverMenu(root);
  const pres = usePresence(open);
  const close = (then?: () => void) => () => {
    shut();
    then?.();
  };
  const unseen = useUnseen();
  useEffect(() => {
    if (sodexOn) markSeen(sodexOn as NewPage);
    if (tab === 'referrals') markSeen('referrals');
  }, [sodexOn, tab]);
  const here = tab === 'leaderboard' || tab === 'referrals' || limits || status || excluded || legalOn || sodexOn !== null;

  /* The button sits mid-bar, so the menu steps left by what would run off the window. On a phone CSS places it. */
  useLayoutEffect(() => {
    const el = menu.current;
    if (!pres.mounted || !el) return;
    const place = () => {
      el.style.removeProperty('left');
      if (getComputedStyle(el).position === 'fixed') return;
      const over = el.getBoundingClientRect().right - (window.innerWidth - 8);
      if (over > 0) el.style.left = `${-over}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [pres.mounted]);

  /* A press or the keyboard moves into the menu; a mouse passing over does not take the focus. */
  useEffect(() => {
    if (mode === 'pinned') root.current?.querySelector<HTMLElement>('.menu-row')?.focus();
  }, [mode]);

  return (
    <div className="navmore" ref={root} {...hoverProps}>
      <button
        type="button"
        className={`navmore__btn${open ? ' is-open' : ''}${here ? ' is-here' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={alert ? `More - status: ${ALERT_HINT[alert].toLowerCase()}` : 'More'}
        onClick={press}
      >
        More
        {alert ? <span className={`navmore__dot is-${alert}`} aria-hidden="true" /> : [...unseen].some((p) => p !== 'referrals') && <span className="navmore__dot is-new" aria-hidden="true" />}
        <svg className="navmore__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {pres.mounted && (
        <div
          ref={menu}
          className={`menu-popup navmore__menu navpop${pres.closing ? ' is-closing' : ''}`}
          role="menu"
          aria-label="More"
          onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}
        >
          <NavMoreBody alert={alert} tab={tab} limits={limits} status={status} excluded={excluded} onNavigate={onNavigate} onOpenStatus={onOpenStatus} onOpenExcluded={onOpenExcluded} onOpenLimits={onOpenLimits} onOpenSodex={onOpenSodex} sodexOn={sodexOn} onOpenLegal={onOpenLegal} legalOn={legalOn} settingsRow={settingsRow} sodexOpen={sodexOpen} close={close} />
        </div>
      )}
    </div>
  );
}

type NavMoreProps = Parameters<typeof NavMore>[0];

/**
 * More's rows, on their own: the navbar's dropdown above and the phone tab bar's sheet (PhoneTabBar.tsx) show the
 * same pages in the same groups. `close(then)` returns the handler that closes the surface they sit in, then runs `then`.
 */
export function NavMoreBody({ alert = null, tab = null, limits = false, status = false, excluded = false, onNavigate, onOpenStatus, onOpenExcluded, onOpenLimits, onOpenSodex, sodexOn = null, onOpenLegal, legalOn = false, settingsRow = false, sodexOpen = true, languageRow = false, close }: NavMoreProps & {
  close: (then?: () => void) => () => void;
  /** The language picker as a row: the phone's bar has no globe (NavBar.tsx). */
  languageRow?: boolean;
}) {
  const unseen = useUnseen();
  return (
    <>
          <div className="navmore__col">
            <div className="navmore__group" role="group" aria-label="Data">
              <div className="menu-group-label" aria-hidden="true">Data</div>
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
            {onOpenSodex && (
              <div className="navmore__group is-sodex" role="group" aria-label="SoDEX">
                <div className="menu-group-label" aria-hidden="true">SoDEX</div>
                {SODEX_VIEWS.map((v) => sodexOpen ? (
                  <PageRow key={v} href={pathForSodexView(v)} label={SODEX_LABELS[v]} current={sodexOn === v} onOpen={close(() => onOpenSodex(v))} icon={SODEX_ICONS[v]}>{unseen.has(v as NewPage) && <NewDot />}</PageRow>
                ) : (
                  <button key={v} type="button" role="menuitem" className="menu-row navmore__row is-access" title="In beta: apply for access on our Discord" onClick={close(applyForBeta)}>
                    <span className="menu-row__ic">{SODEX_ICONS[v]}</span>
                    <span className="menu-row__label">{SODEX_LABELS[v]}</span>
                    <span className="dv-devtag dv-devtag--beta navmore__access">Get access</span>
                  </button>
                ))}
              </div>
            )}
            </div>
            <div className="navmore__col navmore__group" role="group" aria-label="Resources">
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
              {settingsRow && (
                <button type="button" role="menuitem" className="menu-row navmore__row" onClick={close(() => openSettings('profile'))}>
                  <span className="menu-row__ic"><Icon><path d="M3 6h7M14 6h3M3 14h3M10 14h7" /><circle cx="12" cy="6" r="2" /><circle cx="8" cy="14" r="2" /></Icon></span>
                  <span className="menu-row__label">Settings</span>
                </button>
              )}
              {languageRow && <LanguageMoreRow />}
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
              <PageRow
                href={pathForLegal(LEGAL_HOME)}
                label={<><span lang="de">Impressum</span><span> &amp; legal</span></>}
                current={legalOn}
                onOpen={onOpenLegal && close(() => onOpenLegal(LEGAL_HOME))}
                icon={<Icon><path d="M6 3h6l3 3v11H6Z" /><path d="M12 3v3h3M8.500 10h4M8.500 13h4" /></Icon>}
              />
            </div>
    </>
  );
}
