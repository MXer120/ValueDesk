/**
 * The one navbar. Every page gets this exact element.
 *
 * It used to be written inline in App.tsx's render, which meant "the navbar"
 * was a shape that existed only as part of a 647-line component and could not
 * be reasoned about, tested, or changed without reading the whole page around
 * it. Per-page differences are PROPS, not branches in a page's own copy: there
 * is one bar, and pages vary its state.
 *
 * WHAT IT DOES NOT OWN. It does not own `dashLocked` or `hasLayout`, and that is
 * not a style preference - it is an effect-ordering requirement. Detecting a
 * dashboard means dispatching `dash:lock:query` and seeing whether anything
 * answers, and React runs a child's effects BEFORE its parent's. This bar renders
 * above the page content, so its own effect would fire before the Dashboard below
 * it had registered a listener, and it would conclude "no layout" every time. The
 * query has to run in the common parent, after both have mounted. See App.tsx.
 *
 * Hierarchy is carried by colour alone: the wordmark and the current page are
 * --text, every other link is --muted, and the active item gets no pill, no box
 * and no underline.
 *
 * WITH THE RAIL (`rail`, from 761px up) the mark and the tool icons live in the
 * icon rail beside it (SideBar.tsx), and the bar is the owner's reference: on
 * Trade a Futures / Spot switch, a divider, then the pages; the wallet at the
 * end. Below 761px there is no rail and the bar carries them again.
 */
import { BOTS_ON } from '../bots/routes';
import { BotsNavSeg } from './bots/BotsNavSeg';
import type { Engine } from '../api';
import { BrandMark } from './BrandMark';
import { slotRef } from '../slots';
import { MarketTypeSwitch } from './MarketTypeSwitch';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Guarded } from './ErrorBoundary';
import { applyForBeta, useBotsAccess } from '../beta/access';
import { NAV_TABS, SOON_TABS, TAB_LABELS, pathForTab, type LegalPage, type SodexView, type Tab } from '../router';
import { preloadWalletModal, warmWalletModal } from '../walletconnect';
import { Notices } from './Notices';
import { NavMore, type NavAlert } from './NavMore';
import { NavTrade } from './NavTrade';
import { LanguageGlobe } from './LanguageMenu';
import { useHoverMenu } from './useHoverMenu';
import { SettingsMenu, useSettingsBadge } from './SettingsMenu';
import { useAddressMask } from '../privacy';
import { WALLET_EVENTS, useAccountPending } from './account/actions';
import { ConnectedWalletLogo } from './funds/ui';
import { usePresence } from './motion';
import { openConnectDialog } from './account/connect';
/* The address menu and its figures load once there is an address (account/addressMenuLazy.ts). */
import { AddressMenu, warmAddressMenu, warmAddressMenuAfterLoad } from './account/addressMenuLazy';
import { RegionPill } from '../legal/LegalGate';
import './account/account.css';

/** `/scan/index.html?address=0x...` - scan.js reads `address` (or `wallet`) off
 *  the URL on load and scans it immediately; with neither, it shows its own
 *  landing screen, which is also the right landing for a bare "Scan" click.
 *
 *  The explicit `index.html` is required, not cosmetic: Vite's dev server (and
 *  most static hosts) resolve a bare `/scan/` to the SPA's root page, not to the
 *  standalone page's index. */
export const scanHref = (address?: string): string =>
  address ? `/scan/index.html?address=${encodeURIComponent(address)}` : '/scan/index.html';

export interface NavBarProps {
  /** The page currently rendered, for the active-link state; null on a page outside the nav (the legal pages). */
  tab: Tab | null;
  /** Push a new page. The bar renders real hrefs, so this only handles the click. */
  onNavigate: (tab: Tab) => void;
  address: string | null;
  /**
   * Does the CURRENT page mount a Dashboard? Drives whether the two layout icons
   * are live or inert. Detected in App.tsx - see the note above.
   */
  hasLayout: boolean;
  /** Mirrors the mounted Dashboard's own `locked`, when there is one. */
  dashLocked: boolean;
  onOpenSearch: () => void;
  /** The icon rail is showing (SideBar.tsx): the mark and the tool icons are there, not here. */
  rail?: boolean;
  /** The connection in a word, and whether all of it is up (App.tsx). */
  connLabel?: string;
  connOk?: boolean;
  /** The legal pages: open one in place, and is one on screen (More > Impressum & legal). */
  onOpenLegal?: (page: LegalPage) => void;
  legalOn?: boolean;
  /** Futures or spot, for the switch on Trade. */
  engine?: Engine;
  onEngine?: (e: Engine) => void;
  /** What the status page has open, for More's dot (status/SiteNoticeBanner.tsx navAlertOf). */
  alert?: NavAlert;
  /** Open the status page in place (App.tsx). */
  onOpenStatus?: () => void;
  /** The excluded wallets page (More > Excluded wallets). */
  onOpenExcluded?: () => void;
  /** The trading limits page (More > Trading limits). */
  onOpenLimits?: () => void;
  /** Which of More's own pages is on screen. */
  statusOn?: boolean;
  excludedOn?: boolean;
  limitsOn?: boolean;
  /** Open one of SoDEX's products. Without it More has no SoDEX group (router.ts SODEX_VIEWS). */
  onOpenSodex?: (view: SodexView) => void;
  /** Which of them is on screen. */
  sodexOn?: SodexView | null;
}

export function NavBar({
  tab, onNavigate, address, hasLayout, dashLocked, onOpenSearch, rail = false, connLabel = '', connOk = true, onOpenLegal, legalOn = false, engine, onEngine, alert = null, onOpenStatus, onOpenExcluded, onOpenLimits, statusOn = false, excludedOn = false, limitsOn = false, onOpenSodex, sodexOn = null,
}: NavBarProps) {
  /*
   * Have the wallet modal's chunk in memory BEFORE the click.
   *
   * AppKit is a large chunk, and a modal that appears a second after the press
   * reads as a button that did not work. It is fetched once the page's own first
   * data is in (walletconnect.ts preloadWalletModal), and at once when the
   * pointer or the focus reaches Connect below - so by the time anyone has
   * chosen a wallet the code is already there.
   */
  useEffect(() => { preloadWalletModal(); }, []);

  /* One shared address masker. This bar had its own copy of `shortAddr`, which
     is exactly how a masked address would have leaked in one place while being
     hidden in another. */
  const maskAddr = useAddressMask();
  // Local builds of the Bots section (BOTS_ON) open it for any wallet, as BotsPage does.
  const listedForBots = useBotsAccess(address);
  const botsOpen = BOTS_ON || listedForBots;
  const addrRoot = useRef<HTMLDivElement>(null);
  const addrHover = useHoverMenu(addrRoot);
  const addrMenu = addrHover.open;
  const addrPres = usePresence(addrMenu);
  const pending = useAccountPending();
  const badge = useSettingsBadge(address);
  /* The address book's logo for whichever wallet is connected, left of the address. */
  /* The menu's code and wallet figures come once the page has loaded with an address (and again on hover once
     stale), so opening it rarely waits. */
  useEffect(() => (address ? warmAddressMenuAfterLoad(address) : undefined), [address]);

  /*
   * `wallet:menu` opens this menu from elsewhere (actions.ts:goToWallet).
   * With no address there is no menu to open, so it connects instead.
   */
  const hasAddress = !!address;
  const openAddrMenu = addrHover.openPinned;
  useEffect(() => {
    if (rail) return;
    const onMenu = () => {
      if (hasAddress) openAddrMenu();
      else openConnectDialog();
    };
    window.addEventListener(WALLET_EVENTS.menu, onMenu);
    return () => window.removeEventListener(WALLET_EVENTS.menu, onMenu);
  }, [hasAddress, rail, openAddrMenu]);

  /*
   * The bar's real height as `--navbar-live` on the root. The page scrolls behind
   * the bar (shell.css) and starts that far down, and --navbar-h is the desktop
   * row's 56px only: from 761px to 840px the row is 46px, and it wraps when it
   * runs out of room.
   */
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const put = () => root.style.setProperty('--navbar-live', `${Math.round(el.getBoundingClientRect().height)}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--navbar-live'); };
  }, []);

  /* Futures or Spot, on the trade page: the rail's bar shows it before the links (a phone's trade page has it instead). */
  const onTrade = tab === 'trade';
  /* Always there: it opens and closes in place when the page changes, instead of popping in and shoving the links along (owner 2026-11-06). */
  const marketType = engine && onEngine ? <MarketTypeSwitch engine={engine} onEngine={onEngine} /> : null;

  /* Bots: the section's pages in the same switch and slot (BotsNavSeg) wherever the section is open to this wallet - a
     local build, or a wallet on the beta list in production (owner 2026-11-10: production had no Overview / New bot /
     Explore / Savings). BOTS_ON stays the local switch (any wallet, demo data). */
  const onBots = botsOpen && tab === 'bots';
  const botsSeg = botsOpen ? <BotsNavSeg active={onBots} /> : null;

  return (
    <header ref={bar} className={`navbar${rail ? ' navbar--rail' : ''}`}>
      {/* The bar's ground over the page that scrolls behind it: blur bands under a tint (shell.css). */}
      <div className="navbar__glass" aria-hidden="true" />
      <div className="navbar-inner">
        {!rail && (
          <span className="brand">
            <BrandMark />
            {/* A phone shows the mark and the Beta tag; the name stays for screen readers (styles.css .brand__name). */}
            <span className="brand__name">ValueDesk</span>
            <span className="dv-devtag dv-devtag--beta brand__beta">Beta</span>
          </span>
        )}
        {rail && marketType && (
          <div className={`nav-seg-slot${onTrade ? ' is-on' : ''}`} aria-hidden={!onTrade}>
            <div className="nav-seg-slot__in">
              {marketType}
              <span className="nav-div" aria-hidden="true" />
            </div>
          </div>
        )}
        {rail && botsSeg && (
          <div className={`nav-seg-slot${onBots ? ' is-on' : ''}`} aria-hidden={!onBots}>
            <div className="nav-seg-slot__in">
              {botsSeg}
              <span className="nav-div" aria-hidden="true" />
            </div>
          </div>
        )}
        <nav className="navlinks">
          {NAV_TABS.map((t) => t === 'trade' ? (
            <NavTrade key={t} tab={tab} botsOpen={botsOpen} engine={engine} onEngine={onEngine} onNavigate={onNavigate} onOpenSodex={onOpenSodex} sodexOn={sodexOn} label={TAB_LABELS[t]} />
          ) : t === 'bots' && !botsOpen ? (
            /* Bots are in beta (owner, 2026-11-06): the page is a wallet on the beta list's; everyone else applies on Discord. */
            <button key={t} type="button" className="navlink navlink--soon navlink--access" title="Bots are in beta: apply for access on our Discord" onClick={applyForBeta}>
              {TAB_LABELS[t]}
              <span className="dv-devtag dv-devtag--beta">Get access</span>
            </button>
          ) : SOON_TABS.has(t) ? (
            /* Coming soon (router.ts SOON_TABS): the name and a pill, no link - there is no page to open. */
            <span key={t} className="navlink navlink--soon" aria-disabled="true" title={`${TAB_LABELS[t]}: coming soon`}>
              {TAB_LABELS[t]}
              <span className="dv-devtag dv-devtag--soon">Coming soon</span>
            </span>
          ) : (
            /*
             * A REAL ANCHOR with a real href, not a button.
             *
             * These are addressable pages now, so middle-click, ctrl-click and
             * "copy link address" have to work - a <button> silently drops all
             * three. The click handler routes in-place and preventDefault()s;
             * anything the browser should own (a modified click, or a middle
             * click, which never fires a plain click event) falls through to
             * the href and loads the page for real.
             */
            <a
              key={t}
              href={pathForTab(t)}
              className={`navlink${tab === t ? ' active' : ''}`}
              aria-current={tab === t ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onNavigate(t);
              }}
            >
              {TAB_LABELS[t]}
            </a>
          ))}
        </nav>
        {/* More: Leaderboard, Trading limits, Status, Help & FAQ, Send feedback, Community, News (owner, 2026-11-05). Outside the nav: its menu's rows are not nav links. */}
        <NavMore alert={alert} tab={tab} limits={limitsOn} status={statusOn} excluded={excludedOn} onNavigate={onNavigate} onOpenStatus={onOpenStatus} onOpenExcluded={onOpenExcluded} onOpenLimits={onOpenLimits} onOpenSodex={onOpenSodex} sodexOn={sodexOn} onOpenLegal={onOpenLegal} legalOn={legalOn} settingsRow={rail && !address} sodexOpen={botsOpen} />
        {/* Without the rail (a phone) the bar is ONE row (phone pass, 2026-11-18): the mark, then search, the bell
            and the wallet. Futures / Spot sits in the trade page's own market row there (MarketTypeSwitch at the
            ticker's end, registry.tsx) and Bots' pages at the top of the Bots page (BotsPage.tsx), each the same switch; the
            language and Settings are in More's sheet (PhoneTabBar.tsx) and the wallet menu. Two and three rows of
            bar took 112-165px of a 812px phone above the page. */}

        <div className={`navstatus${rail ? ' navstatus--rail' : ''}`}>
          {/*
           * THE NOTIFICATIONS' LANE (owner, 2026-10-25): the toasts and the indexing card dock
           * here, in the bar's empty right side, newest at the right (toast.tsx ToastRail portals
           * into this slot); the bell with its list beside them. Deposits, withdrawals and
           * transfers announce themselves on the wallet button instead (SideBar.tsx).
           */}
          {rail && <div id="vs-notify-slot" className="navnotify" ref={slotRef('vs-notify-slot')} />}
          {/* A restricted (close-only) place: the red pill beside the rail (legal/LegalGate.tsx); a phone's one-row bar
              leaves it to the red strip across the top of the app, which says the same (styles.css). */}
          <RegionPill address={address} />
          <ConnectionPill ok={connOk} label={connLabel} />
          {rail && <LanguageGlobe />}
          {rail && <Notices address={address} />}
          {/* Settings: under Copy Address in the wallet menu, and in More's sheet without a wallet; on a phone the bar
              holds only its window, opened from those rows (openSettings). */}
          {!rail && (
            <>
              <SettingsMenu hasLayout={hasLayout} dashLocked={dashLocked} address={address} trigger={false} />
              <Notices address={address} />
              <button
                type="button" className="navicon" title="Search markets (⌘K)"
                aria-label="Search markets" onClick={onOpenSearch}
              >
                <SearchIcon />
              </button>
            </>
          )}
          {/*
            CONNECTED AND DISCONNECTED ARE DIFFERENT CONTROLS.

            With no wallet this is a call to action, and it opens OUR Connect
            dialog (account/ConnectDialog.tsx) - never AppKit directly; AppKit
            appears only after a wallet row in that dialog is pressed.
            With a wallet, the address is an IDENTITY, and pressing it offers
            what you can do with it: copy it, arm trading, the advanced key
            options, drop it.
          */}
          {rail ? null : address ? (
            <div className="navaddr" ref={addrRoot} {...addrHover.hoverProps}>
              <button
                className="navbtn navaddr__btn"
                aria-haspopup="menu"
                aria-expanded={addrMenu}
                onClick={addrHover.press}
                onPointerEnter={() => warmAddressMenu(address)}
                onPointerDown={() => warmAddressMenu(address)}
              >
                <ConnectedWalletLogo size={18} className="navaddr__wicon" />
                {maskAddr(address)}
                {/* Settings live in this menu on a phone (no gear in the bar), so the wallet carries their "your
                    profile is waiting", as the rail's wallet does (SideBar.tsx). */}
                {badge.profile && <span className="settings__dot settings__dot--go" aria-hidden="true" />}
              </button>
              {addrPres.mounted && (
                <Guarded name="Address menu" bare>
                <Suspense fallback={null}>
                  <AddressMenu address={address} onClose={addrHover.close} closing={addrPres.closing} onExited={addrPres.done} onPortfolio={() => onNavigate('portfolio')} />
                </Suspense>
                </Guarded>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="navbtn"
              onClick={() => openConnectDialog()}
              onPointerEnter={warmWalletModal}
              onFocus={warmWalletModal}
              disabled={pending === 'connect'}
              aria-busy={pending === 'connect' || undefined}
            >
              {pending === 'connect' ? 'Opening…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/* Navbar glyphs. Inline, stroked in `currentColor` so they inherit the
 * muted -> text transition the button already carries.
 *
 * 20px viewBoxes in a 24px hit box, and every path is drawn to REACH the edges
 * of that viewBox. The size being matched is the ink, not the box: a 16px box
 * holding a conservatively-inset drawing renders ~13px. The circle radii, the
 * bell's flare and the search handle's end point are all chosen so the stroke's
 * OUTER edge lands within a pixel of the viewBox, which is the whole difference
 * between a 20px icon and a 20px icon that looks 20px.
 *
 * Each one drives a control that actually does something; there is no
 * decorative icon in this bar. */
/**
 * The connection, only while it is not live: prices and the book above are not current then, which
 * must not need a look elsewhere. Waits 3 s, so a page load or a short reconnect does not flash it.
 */
function ConnectionPill({ ok, label }: { ok: boolean; label: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (ok) { setShow(false); return; }
    const t = window.setTimeout(() => setShow(true), 3000);
    return () => window.clearTimeout(t);
  }, [ok]);
  if (ok || !show) return null;
  return (
    <span className="navconn" role="status" title={`Connection: ${label}`}>
      <span className="navconn__dot" aria-hidden="true" />
      Connecting
    </span>
  );
}

const SearchIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <circle cx="8.6" cy="8.6" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M13.3 13.3L18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
