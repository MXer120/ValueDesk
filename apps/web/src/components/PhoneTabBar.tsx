/**
 * THE PHONE'S TAB BAR (phone pass, 2026-11-18): Trade, Bots, Points, Portfolio and More along the bottom edge, where
 * a thumb reaches, on phone widths (the same 760px the navbar's own phone layout starts at). It takes the place of
 * the navbar's link strip there (shell.css hides the strip and More from the top bar on those widths).
 *
 * Each item is a real link with its href (a plain click routes in place, anything else is the browser's), 56px
 * tall over the home indicator's safe area, with a 24px icon and its word. The page on screen is marked by colour
 * and a filled icon, never by an edge.
 *
 * A TAP ANSWERS IN THE NEXT FRAME (nav pass): App.tsx lights the tapped item from the navigation's pending state
 * (nav.ts) before the page itself renders - `tab`/`sodexOn` here are already the target's - and a wait past ~250 ms
 * (its code still on the way) shows the app's spinner (funds.css .fx-spin) in the item's corner, where More's dot
 * sits. The item lit again (the page on screen) takes its page back to the top.
 *
 * More opens the navbar's More rows (NavMoreBody, the same groups and pages) in a sheet from the bottom, with the
 * pages the bar has no item for (Explore, Copy, Scan) on top. Opening it fetches those pages' code (onPrefetch), so
 * the tap that follows does not wait for the network.
 */
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { applyForBeta, useBotsAccess } from '../beta/access';
import { BOTS_ON } from '../bots/routes';
import { reducedMotion } from '../ease';
import { scrollPageTop, type Pending } from '../nav';
import { NAV_TABS, TAB_LABELS, pathForSodexView, pathForTab, type LegalPage, type SodexView, type Tab } from '../router';
import { primeRoute } from '../serverFetch';
import { Modal } from './Modal';
import { NavMoreBody, type NavAlert } from './NavMore';
import './PhoneTabBar.css';

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const ICONS = {
  trade: <Glyph><path d="M5 3v14M10 2v16M15 4v12" /><rect x="3.5" y="6" width="3" height="6" rx="0.8" className="ptab__fill" /><rect x="8.5" y="5" width="3" height="8" rx="0.8" className="ptab__fill" /><rect x="13.5" y="7" width="3" height="5" rx="0.8" className="ptab__fill" /></Glyph>,
  bots: <Glyph><rect x="4" y="6" width="12" height="9" rx="2.4" className="ptab__fill" /><path d="M10 3.2V6M7.5 10.2h.01M12.5 10.2h.01M7.8 12.8h4.4" /></Glyph>,
  points: <Glyph><path d="M10 2.8 12.2 7.3l5 .7-3.6 3.5.9 4.9L10 14.1l-4.5 2.3.9-4.9L2.8 8l5-.7L10 2.8Z" className="ptab__fill" /></Glyph>,
  portfolio: <Glyph><path d="M10 2.5a7.5 7.5 0 1 0 7.5 7.5H10Z" className="ptab__fill" /><path d="M12.5 2.9A7.5 7.5 0 0 1 17.1 7.5h-4.6Z" /></Glyph>,
  more: <Glyph><circle cx="4.5" cy="10" r="1.4" className="ptab__fill" /><circle cx="10" cy="10" r="1.4" className="ptab__fill" /><circle cx="15.5" cy="10" r="1.4" className="ptab__fill" /></Glyph>,
  explore: <Glyph><circle cx="10" cy="10" r="6.5" /><path d="m12.6 7.4-1.7 3.5-3.5 1.7 1.7-3.5z" /></Glyph>,
  copy: <Glyph><rect x="6.5" y="6.5" width="10" height="10" rx="2" /><path d="M13.5 6.5v-1a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1" /></Glyph>,
  scan: <Glyph><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" /></Glyph>,
};

/** The pages More's sheet lists above its groups: those the bar itself has no item for. */
const SHEET_TABS = NAV_TABS.filter((t): t is Extract<Tab, 'explore' | 'copy' | 'scan'> => t === 'explore' || t === 'copy' || t === 'scan');
/** What More's sheet opens most: its three pages and the leaderboard, fetched when it opens. */
const SHEET_PATHS = [...SHEET_TABS.map(pathForTab), pathForTab('leaderboard')];

/** Which item of the bar a route key belongs to (nav.ts): its own, or More for everything the sheet opens. */
type ItemKey = 'trade' | 'bots' | 'points' | 'portfolio' | 'more';
export function itemForRoute(key: string): ItemKey {
  if (key === 'tab:trade' || key === 'tab:bots' || key === 'tab:portfolio') return key.slice(4) as ItemKey;
  if (key === 'sodex:points') return 'points';
  return 'more';
}

export interface PhoneTabBarProps {
  tab: Tab | null;
  address: string | null;
  onNavigate: (tab: Tab) => void;
  onOpenSodex: (view: SodexView) => void;
  sodexOn: SodexView | null;
  alert?: NavAlert;
  onOpenStatus?: () => void;
  onOpenExcluded?: () => void;
  onOpenLimits?: () => void;
  onOpenLegal?: (page: LegalPage) => void;
  statusOn?: boolean;
  excludedOn?: boolean;
  limitsOn?: boolean;
  legalOn?: boolean;
  /** A navigation on its way (nav.ts): its item is the one lit above; past ~250 ms it shows the spinner. */
  pending?: Pending | null;
  /** Fetch these pages' code now (More's sheet opening). */
  onPrefetch?: (paths: readonly string[]) => void;
}

/** A plain click routes in place; a modified or middle click is the browser's (a new tab, a copied link). */
const inPlace = (go: () => void) => (e: ReactMouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  go();
};

/**
 * The page's data on its way at the touch (serverFetch.ts primeRoute): the finger is down ~100 ms before the tap
 * lands, and the page's first read takes the answer instead of starting its own after the page has rendered.
 */
const primeOnTouch = (path: string) => () => primeRoute(path);

/** The app's spinner (funds.css .fx-spin), in the item's corner. */
const Spin = () => <span className="ptab__spin fx-spin" aria-hidden="true" />;

export function PhoneTabBar({ tab, address, onNavigate, onOpenSodex, sodexOn, alert = null, onOpenStatus, onOpenExcluded, onOpenLimits, onOpenLegal, statusOn = false, excludedOn = false, limitsOn = false, legalOn = false, pending = null, onPrefetch }: PhoneTabBarProps) {
  const [more, setMore] = useState(false);
  const listedForBots = useBotsAccess(address);
  const botsOpen = BOTS_ON || listedForBots;
  /* Another surface is on screen (a SoDEX product, status, limits, a legal page): no tab is lit but Points or More. */
  const elsewhere = statusOn || excludedOn || limitsOn || legalOn || sodexOn !== null;
  const on = (t: Tab) => !elsewhere && tab === t;
  const moreOn = more || (!elsewhere && (tab === 'explore' || tab === 'copy' || tab === 'scan' || tab === 'leaderboard' || tab === 'referrals')) || statusOn || excludedOn || limitsOn || legalOn || (sodexOn !== null && sodexOn !== 'points');
  const close = useCallback((then?: () => void) => () => { setMore(false); then?.(); }, []);
  const busy = pending?.slow ? itemForRoute(pending.key) : null;
  useEffect(() => {
    if (more) onPrefetch?.(SHEET_PATHS);
  }, [more, onPrefetch]);

  /* The lit item again: its page back to the top (a navigation still on its way is left to land). */
  const open = (lit: boolean, go: () => void) => () => {
    if (pending) {
      if (!lit) go();
      return;
    }
    if (lit) scrollPageTop(!reducedMotion());
    else go();
  };

  /* The sheet's first page is the likely next tap once it is open: its data starts with the sheet, not after the tap
     (~45 KB on the wire for Explore). The others start when touched: More is opened for its settings and legal pages
     too, and on a metered phone every open would otherwise cost Copy's ~50 KB of boards as well. */
  const openMore = () => {
    setMore(true);
    primeRoute(pathForTab(SHEET_TABS[0] ?? 'explore'));
  };

  const item = (key: 'trade' | 'bots' | 'portfolio', t: Tab) => (
    <a key={key} href={pathForTab(t)} className={`ptab${on(t) ? ' is-on' : ''}${busy === key ? ' is-pending' : ''}`} aria-current={on(t) ? 'page' : undefined} aria-busy={busy === key || undefined} onPointerDown={primeOnTouch(pathForTab(t))} onClick={inPlace(open(on(t), () => onNavigate(t)))}>
      {ICONS[key]}
      <span className="ptab__label">{TAB_LABELS[t]}</span>
      {busy === key && <Spin />}
    </a>
  );
  const pointsOn = sodexOn === 'points' && !statusOn && !legalOn;

  return (
    <>
      <nav className="ptabs" aria-label="Main">
        {item('trade', 'trade')}
        {botsOpen ? item('bots', 'bots') : (
          /* Bots in beta for this wallet: the navbar's "Get access" (Discord), in the bar's form. */
          <button type="button" className="ptab" title="Bots are in beta: apply for access on our Discord" onClick={applyForBeta}>
            {ICONS.bots}
            <span className="ptab__label">Bots</span>
          </button>
        )}
        <a href={pathForSodexView('points')} className={`ptab${pointsOn ? ' is-on' : ''}${busy === 'points' ? ' is-pending' : ''}`} aria-current={sodexOn === 'points' ? 'page' : undefined} aria-busy={busy === 'points' || undefined} onPointerDown={primeOnTouch(pathForSodexView('points'))} onClick={inPlace(open(pointsOn, () => onOpenSodex('points')))}>
          {ICONS.points}
          <span className="ptab__label">Points</span>
          {busy === 'points' && <Spin />}
        </a>
        {item('portfolio', 'portfolio')}
        <button type="button" className={`ptab${moreOn ? ' is-on' : ''}${busy === 'more' ? ' is-pending' : ''}`} aria-haspopup="dialog" aria-expanded={more} aria-busy={busy === 'more' || undefined} onClick={openMore}>
          {ICONS.more}
          <span className="ptab__label">More</span>
          {busy === 'more' ? <Spin /> : alert && <span className={`ptab__dot navmore__dot is-${alert}`} aria-hidden="true" />}
        </button>
      </nav>
      <Modal open={more} onClose={() => setMore(false)} title="More" size="sm" className="ptabs-sheet" sheet focusDialog>
        <div className="ptabs-sheet__pages" role="group" aria-label="Pages">
          {SHEET_TABS.map((t) => (
            <a key={t} href={pathForTab(t)} className={`ptabs-sheet__page${on(t) ? ' is-on' : ''}`} aria-current={on(t) ? 'page' : undefined} onPointerDown={primeOnTouch(pathForTab(t))} onClick={inPlace(close(() => onNavigate(t)))}>
              {ICONS[t]}
              <span>{TAB_LABELS[t]}</span>
            </a>
          ))}
        </div>
        <div className="navmore__menu ptabs-sheet__rows" role="menu" aria-label="More">
          <NavMoreBody
            alert={alert}
            tab={elsewhere ? null : tab}
            limits={limitsOn}
            status={statusOn}
            excluded={excludedOn}
            onNavigate={onNavigate}
            onOpenStatus={onOpenStatus}
            onOpenExcluded={onOpenExcluded}
            onOpenLimits={onOpenLimits}
            onOpenSodex={onOpenSodex}
            sodexOn={sodexOn}
            onOpenLegal={onOpenLegal}
            legalOn={legalOn}
            settingsRow={!address}
            sodexOpen={botsOpen}
            languageRow
            close={close}
          />
        </div>
      </Modal>
    </>
  );
}
