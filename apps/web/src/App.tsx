import './cssOrder';
import { ShareHost } from './components/share/host';
import { captureInvite } from './invites/invites';
import { flushSync } from 'react-dom';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { PrivacyProvider } from './privacy';
import { NavBar, scanHref } from './components/NavBar';
import { SideBar } from './components/SideBar';
import './components/shell.css';
import { DEFAULT_TAB, EXCLUDED_PATH, LIMITS_PATH, STATUS_PATH, SOON_TABS, TABS, isExcludedPath, isLimitsPath, isStatusPath, landingTab, legalForPath, litFromKey, pathForLegal, pathForSodexView, pathForTab, pushPath, routeKeyForPath, routeKeyOf, sodexViewForPath, tabForPath, useRoute, type LegalPage, type RouteReady, type SodexView, type Tab } from './router';
import { dropBootShell } from './bootShell';
import { api, type Engine } from './api';
import { askTrade } from './components/TradeConfirm';
import { useAsync, useConnState, useMediaQuery, useSession, useStored, useSymbols } from './hooks';
import { hub } from './ws';
import { Guarded } from './components/ErrorBoundary';
import { ShortcutsDialog, openShortcuts } from './components/ShortcutsDialog';
import { PhoneTabBar } from './components/PhoneTabBar';
import { i18nRouteChanged, i18nWait, i18nWarmPath } from './i18n/store';
import { afterNextPaint, beginNav, cancelNav, isLatestNav, navTicket, plainClick, settleNav, setPathOpener, usePendingNav, type Pending } from './nav';
import { installScrollMemory, scrollMemory } from './scrollMemory';
import { DUR_PAGE_MS, EASE_VIEW_CSS, reducedMotion } from './ease';
import { CommandPalette, loadPalette, openPalette, paletteReady } from './components/palette/lazyPalette';
import type { TradeContext } from './dashboard';
import { SiteNoticeBanner, navAlertOf, useHealthDown } from './status/SiteNoticeBanner';
import { setSodexMaintFrom, useSodexMaint } from './status/sodexMaint';
import { UpdateHeldBanner } from './status/UpdateHeldBanner';
import { MaintNote } from './status/MaintNote';
import { IncidentNote } from './status/IncidentNote';
import { BrakeBanner } from './components/BrakeBanner';
import type { Eip1193Provider } from './wallet';
import { AccountController } from './components/account/AccountController';
import { UnlockDialog } from './components/account/UnlockDialog';
import { AccountSetup } from './setup/AccountSetup';
import { OnboardingHost, useOnboardingGate } from './onboarding/OnboardingHost';
import { useWalletBridge } from './components/account/useWallet';
import { configureFromHealth } from './trading/config';
import { restoreTrading } from './trading/session';
import { ToastProvider, notify } from './toast';
import { DEFAULT_SYMBOL, linkedMarket, notListed } from './trading/listed';
/* The wallet-only hosts load beside the page when a wallet is remembered, after it otherwise. */
import { WalletHostsSlot } from './components/account/walletHostsLazy';
/* Here, in the entry, so the market pickers in the palette and on the trade page share it
   without a chunk of its own on the trade page's first load (chart/press.ts). */
import { pressMarket } from './chart/press';
import { FeedbackHost } from './feedback/FeedbackHost';
import { lazyPage, type LazyPage, lazyChunk } from './lazyPage';
import type { SodexPageProps } from './components/sodex/WealthPage';
import { primeFirstReads } from './serverFetch';
import type { Venue } from './vsApi';
import { OPEN_LEGAL_EVENT, RegionBanner, TermsGate } from './legal/LegalGate';
import { setLastPrice } from './lastPrice';
import { priceSeeder } from './priceSeed';

/*
 * THE PAGES ARE CODE-SPLIT, AND NOTHING ON SCREEN MAY TELL.
 *
 * Each page is its own chunk, so the first load only parses the page you
 * landed on (plus the shell) instead of all six. lazyPage.ts explains why this
 * is not React.lazy; the rules that keep it invisible live here:
 *   - the landing page's code - and the Cmd+K palette's, which must answer a
 *     key pressed the moment the page appears (not on a touch phone: below) -
 *     is requested the moment this module runs, in parallel, and <App> renders
 *     nothing but the terms popup until both are in:
 *     the whole app still mounts in ONE commit, in the same order as before
 *     (App's effects after its children's, e.g. the dash:lock query below
 *     still finds the Dashboard), with the palette listening from the start;
 *   - the other pages are fetched right after the first paint (idle time, at
 *     most a second later), and again on hover/focus of any link to them;
 *   - `setTab` changes page only once the next page's code is in, so a
 *     navigation never renders a fallback.
 * Their CSS is not split at all: see cssOrder.ts.
 */
/* With the code of the widgets the stored layout draws at once (TradeDashboard.tsx tradeWidgetsReady): the page
   still mounts in one commit; widgets no layout places are not in its chunk (dashboard/lazyWidgets.tsx). */
const TradeDashboard = lazyPage('trade', () => import('./dashboard/TradeDashboard').then((m) => m.tradeWidgetsReady().then(() => m.TradeDashboard)));
/* With its Cohorts view's code when the URL opens on it (Explore.tsx exploreReady): Cohorts is a chunk of its own. */
const Explore = lazyPage('explore', () => import('./components/explore/Explore').then((m) => m.exploreReady().then(() => m.Explore)));
const CopyPage = lazyPage('copy', () => import('./components/copy/CopyPage').then((m) => m.CopyPage));
/** Live copy trading (copy/CopyRunner.tsx): mounted on every page, loaded after it. */
const CopyRunner = lazyChunk(() => import('./copy/CopyRunner'));
/** Algo orders run in this browser (algo/AlgoRunner.tsx): mounted on every page, loaded after it. */
const AlgoRunner = lazyChunk(() => import('./algo/AlgoRunner'));
const ReferralsPage = lazyPage('referrals', () => import('./components/referrals/ReferralsPage').then((m) => m.ReferralsPage));
const LeaderboardPage = lazyPage('leaderboard', () => import('./components/leaderboard/LeaderboardPage').then((m) => m.LeaderboardPage));
const PortfolioDashboard = lazyPage('portfolio', () => import('./dashboard/PortfolioDashboard').then((m) => m.PortfolioDashboard));
const ScanDashboard = lazyPage('scan', () => import('./dashboard/ScanDashboard').then((m) => m.ScanDashboard));
/* Bots (components/bots/): automated strategies on the ValueDesk executor. */
// Bots: for wallets on the beta list, on the beta site and the main one alike (owner, 2026-11-06); the page
// shows everyone else how to get access (beta/access.ts). Real bots are the executor's to allow.
const BotsPage = lazyPage('bots', () => import('./components/bots/BotsPage').then((m) => m.BotsPage));
/* The market strip below is shown on no page today, so this never loads. */
const TickerBar = lazyPage('ticker', () => import('./components/Market').then((m) => m.TickerBar));
/* Impressum, privacy policy, terms (src/legal): one chunk for the three, loaded
   only when a legal link is hovered, focused or followed - or when the app
   starts on a legal URL. Never part of the idle prefetch below. */
const LegalDoc = lazyPage('legal', () => import('./legal/LegalView').then((m) => m.LegalView));
/* The status page (status/): its own small chunk, loaded like the legal pages'. */
const StatusDoc = lazyPage('status', () => import('./status/StatusPage').then((m) => m.StatusPage));
/* The excluded wallets (More > Excluded wallets), the same way. */
const ExcludedDoc = lazyPage('excluded', () => import('./components/excluded/ExcludedPage').then((m) => m.ExcludedPage));
/* Trading limits & conditions (More > Trading limits), the same way. */
const LimitsDoc = lazyPage('limits', () => import('./components/limits/LimitsPage').then((m) => m.LimitsPage));
/* SoDEX's own products (More > SoDEX), the same way. */
const SODEX_DOCS: Record<SodexView, LazyPage<SodexPageProps>> = {
  points: lazyPage('sopoints', () => import('./components/sodex/SoPointsPage').then((m) => m.SoPointsPage)),
  'blind-boxes': lazyPage('blindboxes', () => import('./components/sodex/BlindBoxPage').then((m) => m.BlindBoxPage)),
  wealth: lazyPage('wealth', () => import('./components/sodex/WealthPage').then((m) => m.WealthPage)),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAGES: Record<Tab, LazyPage<any>> = {
  trade: TradeDashboard,
  explore: Explore,
  copy: CopyPage,
  leaderboard: LeaderboardPage,
  portfolio: PortfolioDashboard,
  scan: ScanDashboard,
  bots: BotsPage,
  referrals: ReferralsPage,
};

/** The page the first render shows, and the one an old URL is then moved to (router.ts). */
const bootTabs = (): Tab[] => {
  const first = tabForPath(window.location.pathname) ?? DEFAULT_TAB;
  const settled = landingTab(window.location.pathname);
  return first === settled ? [first] : [first, settled];
};
/** The code the first render needs: a legal page's, the status page's, or the landing tab's (above). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bootPages = (): LazyPage<any>[] =>
  legalForPath(window.location.pathname) ? [LegalDoc] : isStatusPath(window.location.pathname) ? [StatusDoc] : isExcludedPath(window.location.pathname) ? [ExcludedDoc] : isLimitsPath(window.location.pathname) ? [LimitsDoc] : sodexViewForPath(window.location.pathname) ? [SODEX_DOCS[sodexViewForPath(window.location.pathname) as SodexView]] : bootTabs().map((t) => PAGES[t]);
/* A touch phone has no Cmd+K to press the moment the page appears, so its first render does not wait for the
   palette's eight chunks (~28 KB brotli, ~83 KB of script to run first): the stand-in (lazyPalette.tsx) asks for
   them as soon as it is mounted, long before a tap on search, and keeps an open asked for before they are in.
   The same query decides whether tools/boot-shell.mjs announces the palette's chunks in the page's head. */
const TOUCH_ONLY = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
/* Requested now, in parallel with React starting up. */
const booting: Promise<unknown> = Promise.all([...bootPages().map((p) => p.preload()), ...(TOUCH_ONLY ? [] : [loadPalette()])]);
/* The landing page's first index reads: started by the route script while the HTML was read (or now, without it); the
   page asks for them in an effect, after its code has arrived and rendered, and takes the answers that are already
   there (serverFetch.ts). What it reads in the seconds after its code is in (`booting`) is remembered for this URL. */
primeFirstReads(window.location.pathname + window.location.search, booting);
booting.catch(() => {
  /* logged in lazyPage; the page itself retries and recovers when it renders */
});

/** The code a URL's page needs: a legal page's, the status page's, a SoDEX product's or a tab's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageForPath(path: string): LazyPage<any> {
  if (legalForPath(path)) return LegalDoc;
  if (isStatusPath(path)) return StatusDoc;
  if (isExcludedPath(path)) return ExcludedDoc;
  if (isLimitsPath(path)) return LimitsDoc;
  const view = sodexViewForPath(path);
  if (view) return SODEX_DOCS[view];
  return PAGES[tabForPath(path) ?? landingTab(path)];
}
/**
 * What opening `path` waits for: its page's code, then - in a language read in parts - the page's text, so it does
 * not open in English for a round trip (i18n/store.ts i18nWait, capped). Null: nothing, it can open now. A chunk
 * that fails still opens the page, which then retries or reloads (lazyPage.ts), as before.
 */
function waitFor(path: string): Promise<unknown> | null {
  const page = pageForPath(path);
  if (page.ready) return i18nWait(path);
  return page.preload().catch(() => undefined).then(() => i18nWait(path));
}

/** How the incoming page fades in on a phone: opacity only (a transform would make the scroller the containing
 *  block of every fixed pop-up inside it, the bug Modal.tsx documents), on the chart's curve, on the compositor. */
const PAGE_FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];


/** What the terms popup takes from the shell: AppShell hands its own values up once it is mounted. */
interface GateProps {
  hidden: boolean;
  onOpen: (p: LegalPage) => void;
  address: string | null;
  provider: Eip1193Provider | null;
}

/** The connected wallet the shell will start with (useStored('ot.address') in AppShell), read before it exists. */
const storedAddress = (): string | null => {
  try {
    const raw = localStorage.getItem('ot.address');
    const v: unknown = raw ? JSON.parse(raw) : null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
};

/**
 * Holds the app back until the landing page's code is in (see above) - all but the terms popup.
 *
 * THE TERMS POPUP DOES NOT WAIT (phone pass, 2026-11-18). Every first visit has to answer it, and its code is in the
 * entry: it used to appear only with the whole landing page (on "Slow 4G" + 4x CPU ~2.6 s after the entry was in).
 * It is mounted here, beside the shell, so it opens over index.html's static shell as soon as the entry has run, and
 * it is the SAME popup once the shell is in (its ticked box and its open animation are not lost): AppShell hands it
 * its values (onGate). Before that it has the stored wallet, no provider (as before the wallet bridge restores it),
 * and a legal link opens that page as soon as the legal chunk is in - that page needs none of the landing page's code.
 */
export function App() {
  const [ready, setReady] = useState(() => bootPages().every((p) => p.ready) && (TOUCH_ONLY || paletteReady()));
  useEffect(() => {
    if (ready) return;
    let live = true;
    const done = () => {
      if (live) setReady(true);
    };
    booting.then(done, done);
    return () => {
      live = false;
    };
  }, [ready]);
  const [gate, setGate] = useState<GateProps | null>(null);
  const [bootLegal, setBootLegal] = useState(false);
  const bootOpen = useCallback((page: LegalPage) => {
    const go = () => {
      if (legalForPath(window.location.pathname) !== page) window.history.pushState(null, '', pathForLegal(page));
      setBootLegal(true);
      setReady(true);
    };
    LegalDoc.preload().then(go, go);
  }, []);
  /* One element for the life of the page: App re-rendering for the popup's values never re-renders the shell. */
  const shell = useMemo(() => <AppShell onGate={setGate} />, []);
  const path = window.location.pathname;
  const terms: GateProps = gate ?? { hidden: bootLegal || !!legalForPath(path) || isStatusPath(path), onOpen: bootOpen, address: storedAddress(), provider: null };
  return (
    <>
      {ready ? shell : null}
      {/* The first-visit clickwrap (legal/acceptance.ts): until this browser accepts the
          current terms - with a connected wallet, ticked and signed in one step. Not over
          a legal page, so what it links to can be read first, nor over the status page,
          which anyone may read without accepting anything. */}
      <Guarded name="Terms">
        <TermsGate hidden={terms.hidden} onOpen={terms.onOpen} address={terms.address} provider={terms.provider} />
      </Guarded>
    </>
  );
}

function AppShell({ onGate }: { onGate: (g: GateProps) => void }) {
  const [engine, setEngine] = useStored<Engine>('ot.engine', 'perps');
  const [symbol, setSymbol] = useStored<string>('ot.symbol', DEFAULT_SYMBOL.perps);
  /* The navbar's Futures / Spot switch: the other book opens on its default market. */
  const switchEngine = useCallback((e: Engine) => {
    if (e === engine) return;
    setEngine(e);
    setSymbol(DEFAULT_SYMBOL[e]);
  }, [engine, setEngine, setSymbol]);
  /* The icon rail (SideBar.tsx) from 761px up; below it the navbar carries its tools. */
  const rail = useMediaQuery('(min-width: 761px)');
  const [address, setAddress] = useStored<string | null>('ot.address', null);
  /* Back/Forward wait for the page's code (and text) like a tap does, its tab lit meanwhile (router.ts). */
  const routeReady = useCallback<RouteReady>((path) => {
    const wait = waitFor(path);
    if (wait) beginNav(routeKeyForPath(path) ?? `tab:${landingTab(path)}`);
    return wait;
  }, []);
  /* The page comes from the URL. `setTab` keeps its name because ~15 call
   * sites below pass it around as a callback; it pushes history now. */
  const [tab, navigate, legal, navigateLegal, status, navigateStatus, excluded, navigateExcluded, limits, navigateLimits, sodex, navigateSodex] = useRoute(routeReady);
  /*
   * EVERY IN-APP NAVIGATION GOES THROUGH `go` (nav.ts says why): the target's item lights in the frame after the
   * tap; the page changes after that frame has been painted, or once its code (and, in a language read in parts,
   * its text) is in - the current page stays up meanwhile, never a fallback; the latest request wins. A page
   * already on screen changes at once (a Scan of another address, the same tab tapped again).
   */
  const committedKey = useRef(routeKeyOf({ tab, legal, status, excluded, limits, sodex }));
  const go = useCallback((path: string, apply: () => void) => {
    const t = navTicket();
    const key = routeKeyForPath(path) ?? `tab:${landingTab(path)}`;
    if (key === committedKey.current) {
      cancelNav();
      apply();
      return;
    }
    beginNav(key);
    /* The page commits synchronously, then the pending item is cleared whatever key landed: a SOON tab or a landing
       fallback can land under another route key than beginNav's, and a same-page query change under the same one,
       and settleNav (layout effect) would then leave the lit item and its spinner up until the next navigation. */
    const land = () => {
      if (!isLatestNav(t)) return;
      flushSync(apply);
      cancelNav();
    };
    // After the lit frame is on screen in either case: a wait that settles at once (code in, text in flight)
    // must not fold the page's commit into the tap's frame.
    const wait = waitFor(path);
    if (wait) wait.then(() => afterNextPaint(land), () => afterNextPaint(land));
    else afterNextPaint(land);
  }, []);
  const setTab = useCallback((next: Tab) => go(pathForTab(next), () => navigate(next)), [go, navigate]);
  /* The legal pages the same way: their chunk first, then the page. */
  const openLegal = useCallback((next: LegalPage) => go(pathForLegal(next), () => navigateLegal(next)), [go, navigateLegal]);
  /* The status page the same way. */
  const openStatus = useCallback(() => go(STATUS_PATH, navigateStatus), [go, navigateStatus]);
  /* The excluded wallets page the same way. */
  const openExcluded = useCallback(() => go(EXCLUDED_PATH, navigateExcluded), [go, navigateExcluded]);
  /* The trading limits page the same way. */
  const openLimits = useCallback(() => go(LIMITS_PATH, navigateLimits), [go, navigateLimits]);
  /* SoDEX's products the same way. */
  const openSodex = useCallback((view: SodexView) => go(pathForSodexView(view), () => navigateSodex(view)), [go, navigateSodex]);
  /*
   * Any URL of this app, with its query (a wallet on Scan, a trader's Copy setup, a market): in place, the way a
   * tab opens - not by assigning window.location, which re-ran the whole boot (5.5-8 s on a phone) and dropped the
   * sockets, the caches and the translations. The pages read their query on popstate (ScanDashboard, CopyPage, the
   * market reader below), which the push dispatches. Another site's URL is the browser's.
   */
  const openUrl = useCallback((url: string) => {
    let u: URL;
    try {
      u = new URL(url, window.location.href);
    } catch {
      return;
    }
    if (u.origin !== window.location.origin || routeKeyForPath(u.pathname) === null) {
      window.location.assign(u.href);
      return;
    }
    const to = `${u.pathname}${u.search}${u.hash}`;
    go(u.pathname, () => {
      const same = routeKeyForPath(u.pathname) === committedKey.current;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== to) pushPath(to);
      window.dispatchEvent(new PopStateEvent('popstate'));
      if (same) {
        // The page stays mounted (another wallet on Scan): it opens at its top all the same.
        scrollMemory().takeKind();
        scrollMemory().top();
      }
    });
  }, [go]);
  useEffect(() => setPathOpener(openUrl), [openUrl]);
  /*
   * A plain click on an <a href> to one of these pages, anywhere (a card's "Open profile", a boosted market, a
   * page's own CTA), opens it in place too; a modified or middle click, a link to elsewhere, target=_blank, a
   * download or a handler that already took the click is left alone.
   */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!plainClick(e)) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(a instanceof HTMLAnchorElement) || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
      if (a.origin !== window.location.origin || routeKeyForPath(a.pathname) === null || a.closest('[data-reload]')) return;
      e.preventDefault();
      openUrl(`${a.pathname}${a.search}${a.hash}`);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [openUrl]);
  /* A legal link anywhere in the app (legal/LegalGate.tsx LegalLink) opens its page in place. */
  useEffect(() => {
    const on = (e: Event) => {
      const page = (e as CustomEvent<LegalPage>).detail;
      if (typeof page === 'string' && legalForPath(`/${page}`)) openLegal(page);
    };
    window.addEventListener(OPEN_LEGAL_EVENT, on);
    return () => window.removeEventListener(OPEN_LEGAL_EVENT, on);
  }, [openLegal]);
  /* The tab whose page is on screen - none while a legal page or the status page is. */
  const shown: Tab | null = legal || status || excluded || limits || sodex ? null : tab;
  /*
   * A page landed (any route change): the navigation to it is over (its lit item is the committed one from this
   * same commit, no flicker), and the scroller follows the ONE rule (scrollMemory.ts) - a pushed page opens at its
   * top; Back/Forward is restored by the router once the page is there. On a phone the incoming page then eases in
   * over --dur-page on --ease-view, opacity only, started before this commit paints: its first frame is the new
   * page at 7% (the chart's own first frame), not a hard cut. Not under reduced motion; not on the first render.
   */
  const contentRef = useRef<HTMLDivElement>(null);
  const routeKey = routeKeyOf({ tab, legal, status, excluded, limits, sodex });
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    committedKey.current = routeKey;
    settleNav(routeKey);
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const mem = scrollMemory();
    if (mem.takeKind() !== 'pop') mem.top();
    const el = contentRef.current;
    if (el && !rail && !reducedMotion() && typeof el.animate === 'function') {
      el.animate(PAGE_FADE, { duration: DUR_PAGE_MS, easing: EASE_VIEW_CSS });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
  useEffect(() => {
    const el = contentRef.current;
    return el ? installScrollMemory(el) : undefined;
  }, []);
  /* A language in parts reads the text of a page when it opens (i18n/store.ts). */
  useEffect(() => { i18nRouteChanged(); }, [tab, legal, status, excluded, limits, sodex]);
  const SodexDoc = sodex ? SODEX_DOCS[sodex] : null;
  /* What the nav bars light for the page on screen (a legal page over the status page over the rest). */
  const committedLit = useMemo<Lit>(() => ({ ...litFromKey(routeKey), pending: null }), [routeKey]);
  usePagePrefetch();
  const openScanAddress = useCallback((addr: string, venue?: Venue) => {
    openUrl(venue
      ? `/scan?address=${encodeURIComponent(addr)}&venue=${venue}`
      : scanHref(addr));
  }, [openUrl]);
  /* The Scan overview for an address: every venue it is on, before any one opens. */
  const openScanOverview = useCallback((addr: string) => {
    openUrl(`/scan?find=${encodeURIComponent(addr)}`);
  }, [openUrl]);
  /* Copy setup for one trader. The Copy page reads ?address=&venue= on mount and on popstate. */
  const openCopy = useCallback((addr: string, venue: Venue) => {
    openUrl(`/copy?address=${encodeURIComponent(addr)}&venue=${venue}`);
  }, [openUrl]);
  const openSymbol = useCallback((sym: string) => {
    setEngine('perps');
    setSymbol(sym);
    setTab('trade');
  }, [setEngine, setSymbol, setTab]);
  /** A market on a given engine: the portfolio's Wealth funds are spot markets. */
  const openMarket = useCallback((sym: string, onEngine: 'spot' | 'perps') => {
    setEngine(onEngine);
    setSymbol(sym);
    setTab('trade');
  }, [setEngine, setSymbol, setTab]);
  /** A trade print carries only the numeric account id, never an address - the
   *  same on-chain resolver the standalone Scan page itself uses
   *  (server/src/sodex/chain.ts's resolveAccountOnChain, exposed here as
   *  GET /api/feed/account) runs first, so the link landed on already carries
   *  a real address when one can be found instead of leaving Scan's own
   *  landing screen to repeat the same lookup a click later. Falls through to
   *  the bare landing page, not a dead link, when it can't be resolved. */
  const openScanAccountId = useCallback((id: number) => {
    fetch(`/api/feed/account?id=${id}`)
      .then((r) => r.json())
      .then((d) => { openUrl(scanHref(d?.address)); })
      .catch(() => { openUrl(scanHref()); });
  }, [openUrl]);
  const [price, setPrice] = useState('');
  /* A price the user sets wins over the book's seed after a market switch (priceSeed.ts). */
  const priceSeed = useMemo(() => priceSeeder(), []);
  const onPrice = useCallback((p: string, how?: 'snap') => {
    if (how !== 'snap') priceSeed.typed();
    setPrice(p);
  }, [priceSeed]);
  /* The last price lives in lastPrice.ts, not here: see there. */
  /* The live wallet's EIP-1193 provider, for everything that signs or sends:
     enable trading, Money, Deposit, Points, Copy. Null = read-only. */
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);

  /*
   * THE WALLET, FOLLOWED FOR THE LIFE OF THE PAGE.
   *
   * Which wallet is connected is decided in our Connect dialog and the AppKit
   * step it hands off to (walletconnect.ts); this is where that state becomes
   * App state. It lives here,
   * next to `address` and `provider`, and NOT inside a sheet: the subscriptions
   * that used to live in the wallet panel were mounted only while that panel was
   * open, so a session the wallet ended, an account switched in the extension,
   * or a Disconnect pressed in the navbar reached nobody - the header kept saying
   * Connected. useWalletBridge covers, at app level:
   *   - the silent restore on reload (no wallet prompt);
   *   - account and chain changes in the wallet;
   *   - the wallet or relay ending the session (both values cleared);
   *   - `wallet:disconnect` from the navbar's address menu.
   */
  useWalletBridge({ address, setAddress, setProvider });
  /* First signup (onboarding/): a new wallet's username, the features, dark or light. */
  const onboarding = useOnboardingGate(address);
  // An invite link (?i=<code>): checked, kept in this browser, taken off the address bar (invites/invites.ts).
  useEffect(() => { void captureInvite(); }, []);

  const [refreshToken, setRefreshToken] = useState(0);
  // Surfaced from the tab content up to the tab label, e.g. "Positions (2)".
  const [posCount, setPosCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  // Lives here, not in the footer, because two separate things open it: the
  // footer's help button and the global `?` shortcut.

  /* Mirrors Dashboard.tsx's `locked` so the navbar icon can show it. Dashboard
   * broadcasts `dash:lock` on every change including its own mount; the
   * `dash:lock:query` dispatch covers the reverse order, where this header is
   * already mounted when Dashboard appears on switching back to the trade tab. */
  const [dashLocked, setDashLocked] = useState(false);
  /*
   * Is a Dashboard mounted on the CURRENT tab?
   *
   * The two layout icons are now permanent - they used to unmount with the trade
   * tab, so a workspace-wide control moved and the whole nav group reflowed every
   * time you looked at the portfolio. Permanent buttons must still tell the truth
   * about whether they do anything, and only a tab that mounts a Dashboard has a
   * layout to lock or configure.
   *
   * Detected rather than hardcoded as a tab list: `dispatchEvent` is SYNCHRONOUS,
   * so a mounted Dashboard's `dash:lock:query` handler has already answered by the
   * time the dispatch returns. No answer means nothing is listening. A second
   * dashboard therefore lights these up on its own, with no edit here.
   */
  const [hasLayout, setHasLayout] = useState(false);
  useEffect(() => {
    let answered = false;
    const onLock = (e: Event) => {
      answered = true;
      setDashLocked(Boolean((e as CustomEvent).detail?.locked));
    };
    window.addEventListener('dash:lock', onLock);
    window.dispatchEvent(new CustomEvent('dash:lock:query'));
    setHasLayout(answered);
    return () => window.removeEventListener('dash:lock', onLock);
  }, [shown]);
  // Lifted so the ticker bar's star and the search modal's watchlist never go
  // stale against each other - both are mounted continuously, and useStored
  // is a plain useState under the hood with no cross-instance sync.
  /* A first visit starts with the four busiest perps starred, so the favourites bar has something to show. */
  const [favorites, setFavorites] = useStored<string[]>('ot.favorites', ['perps:BTC-USD', 'perps:ETH-USD', 'perps:SOL-USD', 'perps:BNB-USD']);
  const toggleFavorite = useCallback(
    (key: string) => setFavorites(favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key]),
    [favorites, setFavorites],
  );

  const { session, refresh: refreshSession } = useSession();
  const { symbols, byName, listEngine } = useSymbols(engine);
  const { state: connState, upstream } = useConnState();
  const { data: health, error: healthError } = useAsync(() => api.health(), [], { pollMs: 30_000 });
  /* The data service not answering for a while: a notification says so on every page (status/IncidentNote.tsx). */
  const healthDown = useHealthDown(healthError);
  // Browser trading follows the backend's network (the one its market data and
  // account ids come from), then the connected wallet: load that wallet's key
  // from this device, or show trading as off.
  useEffect(() => {
    configureFromHealth(health ?? null);
  }, [health]);
  useEffect(() => {
    void restoreTrading(address);
  }, [address, health?.network]);

  const sym = byName.get(symbol);
  const bump = useCallback(() => setRefreshToken((n) => n + 1), []);

  /* A link to a market (/trade?symbol=BTC-USD, a position card's "Trade" link) opens that market,
     not the one stored from before; the address is cleaned at once, so a reload keeps the market
     picked since. One SoDEX does not list is refused by the check below, in words. */
  useEffect(() => {
    const read = () => {
      const linked = linkedMarket(window.location.search);
      if (!linked) return;
      const q = new URLSearchParams(window.location.search);
      q.delete('symbol');
      const rest = q.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
      setEngine(linked.engine);
      setSymbol(linked.symbol);
    };
    read();
    /* An in-app link to a market (openUrl pushes, then dispatches popstate): the same. */
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the selected symbol valid when the engine changes.
  //
  // Keyed on the first symbol's NAME, not on symbols.length: two engines can
  // return lists of equal length (and spot/perps counts drift as markets are
  // listed), which would leave the previous engine's symbol selected and every
  // panel requesting a market that does not exist on the new engine.
  //
  // NEVER SILENTLY ON ANOTHER MARKET (owner, 2026-10-29). A market SoDEX does not
  // list - a stored one since delisted, a link, a saved chart, a market delisted
  // while this tab was open - cannot be traded here: the trade page shows the
  // default market instead and says why (trading/listed.ts). Judged only on this
  // engine's own list: for a moment after a switch the poll still holds the other's.
  const symbolsFingerprint = `${engine}:${listEngine ?? ''}:${symbols[0]?.name ?? ''}:${symbols.length}`;
  useEffect(() => {
    if (symbols.length === 0 || listEngine !== engine) return;
    if (!byName.has(symbol)) {
      const fallback = byName.has(DEFAULT_SYMBOL[engine]) ? DEFAULT_SYMBOL[engine] : symbols[0]!.name;
      if (symbol) notify('warn', `${notListed(symbol)} Showing ${byName.get(fallback)?.displayName ?? fallback} instead.`);
      setSymbol(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsFingerprint, symbol]);

  useEffect(() => {
    hub.connect();
  }, []);

  // Seed the price field from the book when switching markets - unless the user set a
  // price while the book was on its way (priceSeed.ts).
  useEffect(() => {
    let cancelled = false;
    priceSeed.start();
    api
      .orderbook(engine, symbol, 1)
      .then(({ book }) => {
        if (cancelled) return;
        const mid = book.bids?.[0]?.[0] ?? book.asks?.[0]?.[0];
        if (priceSeed.settle() && mid) setPrice(mid);
      })
      .catch(() => {
        if (!cancelled) priceSeed.settle();
      });
    return () => {
      cancelled = true;
    };
  }, [engine, symbol]);

  // The palette holds its own open state (openPalette): opening or closing it
  // must not re-render the whole app.
  const openSearch = useCallback((seed = '') => openPalette(seed), []);

  // useCallback, not an inline arrow: the shortcut hook takes this as an effect
  // dependency, and a fresh identity every render would tear down and re-bind
  // the window keydown listener on every state change in the app.
  useKeyboardShortcuts({
    setTab, engine, symbol, unlocked: session?.unlocked ?? false, onChanged: bump,
    onOpenSearch: openSearch, onHelp: openShortcuts,
  });

  const ctx = useMemo(
    () => ({
      engine,
      address,
      unlocked: session?.unlocked ?? false,
      byName,
      refreshToken,
      onChanged: bump,
    }),
    [engine, address, session?.unlocked, byName, refreshToken, bump],
  );

  /**
   * Everything the trade dashboard's panels read. State still lives here - the
   * dashboard is a renderer, not an owner - so this is a projection of the same
   * values the other tabs use, gathered into the one object the panel registry
   * is typed against.
   */
  const tradeCtx = useMemo<TradeContext>(
    () => ({
      engine,
      symbol,
      sym,
      network: health?.network ?? '',
      unlocked: session?.unlocked ?? false,
      address,
      signingAddress: session?.session?.address ?? null,
      byName,
      refreshToken,
      price,
      favorites,
      positionCount: posCount,
      orderCount: orderCount,
      onPrice,
      onLastPrice: setLastPrice,
      onChanged: bump,
      onToggleFavorite: toggleFavorite,
      onOpenSearch: openSearch,
      /* The favourites bar's chips switch the market in place. */
      onSelectSymbol: setSymbol,
      onPositionCount: setPosCount,
      onOrderCount: setOrderCount,
      onOpenScan: openScanAccountId,
      /* Futures / Spot in the trade page's market row on a phone, where the one-row bar has no room (NavBar.tsx). */
      onEngine: switchEngine,
      marketTypeInPage: !rail,
    }),
    [
      engine, symbol, sym, health?.network, session?.unlocked, session?.session?.address,
      address, byName, refreshToken, price, favorites, posCount, orderCount,
      bump, toggleFavorite, openSearch, setTab, openScanAccountId, setSymbol, onPrice, switchEngine, rail,
    ],
  );

  /* The terms popup lives in App (it opens before this shell is in): its values from here, in this frame. */
  useLayoutEffect(() => {
    onGate({ hidden: !!legal || status, onOpen: openLegal, address, provider });
  }, [onGate, legal, status, openLegal, address, provider]);
  /* This frame is the app's first: index.html's static shell goes (bootShell.ts). */
  useLayoutEffect(() => dropBootShell(), []);

  const upstreamState = upstream[engine];
  // In words (owner 2026-11-11): "hub ok · sodex closed" said nothing to a trader.
  const sodexMaint = useSodexMaint();
  useEffect(() => setSodexMaintFrom(health), [health]);
  const connLabel =
    connState === 'open' && upstreamState === 'open' ? 'live'
    : connState === 'open' ? (sodexMaint ? 'SoDEX maintenance' : 'SoDEX reconnecting…')
    : connState;

  return (
    /* Only a page chunk that failed to load can suspend in here (lazyPage.ts
       then retries or reloads); navigation never does - see setTab. */
    <Suspense fallback={null}>
    {/* The provider wraps the WHOLE shell, header included: the navbar's address
       chip reads it, and so does every page below. */}
    <ToastProvider>
    <PrivacyProvider>
    {/* Close-only (or an unknown country): one slim line above everything, on every page (legal/LegalGate.tsx). */}
    <Guarded name="Region">
      <RegionBanner address={address} />
    </Guarded>
    <div className={`shell${rail ? ' shell--rail' : ''}`}>
      {rail && (
        <LitNav committed={committedLit}>
          {(lit) => <SideBar address={address} hasLayout={hasLayout} dashLocked={dashLocked} onOpenSearch={() => openSearch()} tab={lit.tab} onNavigate={setTab} />}
        </LitNav>
      )}
      {/* ONE bar of chrome at the top, 56px, and nothing underneath it.
       *
       * Hierarchy here is carried by colour alone: the wordmark and the current
       * page are --text, every other link is --muted, and the active item gets
       * no pill, no box and no underline. The connection shows only when it is
       * not live (NavBar.tsx ConnectionPill).
       *
       * The "MAINNET - real funds" block is gone with it. A filled red badge in
       * the top-right was the loudest pixel on a 1920px trading screen, louder
       * than the live price and the two order buttons, for a fact that does not
       * change between sessions. The network is now a quiet outlined pill. */}
      <LitNav committed={committedLit}>
        {(lit) => (
          <NavBar
            tab={lit.tab}
            onNavigate={setTab}
            address={address}
            hasLayout={hasLayout}
            dashLocked={dashLocked}
            onOpenSearch={() => openSearch()}
            rail={rail}
            connLabel={connLabel}
            connOk={connState === 'open' && upstreamState === 'open'}
            legalOn={!!lit.legal}
            onOpenLegal={openLegal}
            engine={engine}
            onEngine={switchEngine}
            alert={navAlertOf(health, healthDown)}
            onOpenStatus={openStatus}
            onOpenExcluded={openExcluded}
            onOpenLimits={openLimits}
            statusOn={lit.status}
            excludedOn={lit.excluded}
            limitsOn={lit.limits}
            onOpenSodex={openSodex}
            sodexOn={lit.sodex}
          />
        )}
      </LitNav>
      {!rail && (
        <LitNav committed={committedLit}>
          {(lit) => (
            <PhoneTabBar
              tab={lit.tab}
              address={address}
              onNavigate={setTab}
              onOpenSodex={openSodex}
              sodexOn={lit.sodex}
              alert={navAlertOf(health, healthDown)}
              onOpenStatus={openStatus}
              onOpenExcluded={openExcluded}
              onOpenLimits={openLimits}
              onOpenLegal={openLegal}
              statusOn={lit.status}
              excludedOn={lit.excluded}
              limitsOn={lit.limits}
              legalOn={!!lit.legal}
              pending={lit.pending}
              onPrefetch={prefetchPaths}
            />
          )}
        </LitNav>
      )}

      {/* The venue-status line is the ONLY full-width strip allowed under the
          navbar, and it renders nothing at all unless SoDEX is actually
          degraded. The onboarding bar that used to sit here - "Connect a wallet
          to trade", with a second Connect button 30px below the first one - is
          gone: it appeared on every cold load, cost a row of the chart to say
          something the order ticket already says at the point of use, and put
          the same call to action on screen twice. The order entry panel carries
          that state now ("Read-only - unlock a signing key"). */}
      <Guarded name="Maintenance">
        {/* Our own scheduled maintenance (status/), from /api/health: no request of its own. */}
        <SiteNoticeBanner health={health} onOpenStatus={openStatus} />
        <UpdateHeldBanner />
        {/* SoDEX's own maintenance is a notification card now, from its flag and announcements read on the
            server (apps/server/src/ops/sodexWatch.ts -> status notices -> MaintNote), not a bar (owner 2026-11-11). */}
      </Guarded>
      <Guarded name="Brake">
        <BrakeBanner health={health} />
      </Guarded>

      <div className="app">
        {/* On the trade page the symbol/price header is a dashboard panel the
            user can move; everywhere else it stays a fixed strip so the market
            being viewed - and the way to change it - is never off screen. */}
        {/* Portfolio is excluded alongside trade, for the opposite reason.
            Trade owns its own ticker inside the dashboard; portfolio is
            ACCOUNT-scoped and has no current market at all, so a BTC-USD price
            strip above it is answering a question the page never asks. It also
            cost the page its top 60px, pushing the card grid below where the
            reference starts it. The other tabs are market-scoped and keep it. */}
        {/* Scan is excluded for the same reason as portfolio, and one more: the
            page is ABOUT an address you typed, so a BTC-USD price strip above it
            is the loudest thing on screen answering a question nobody asked, and
            it pushed the account card - the only thing you can act on before
            scanning - below the fold. */}
        {/* Explore and Copy are about traders, not one market: no strip there either. */}
        {tab !== 'trade' && tab !== 'portfolio' && tab !== 'scan' && tab !== 'leaderboard' && tab !== 'explore' && tab !== 'copy' && tab !== 'bots' && tab !== 'referrals' && (
          <div className="marketbar">
            <Guarded name="Ticker">
              <TickerBar
                engine={engine}
                symbol={symbol}
                sym={sym}
                onLast={setLastPrice}
                onSymbolClick={() => openSearch()}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
              />
            </Guarded>
          </div>
        )}

        <div className="appcontent" ref={contentRef}>
        {/* The trade page IS the dashboard. Layout is data: see
            src/dashboard/layout.ts for the grid and registry.tsx for the
            panels. Nothing about arrangement lives in this file. */}
        {shown === 'trade' && <TradeDashboard context={tradeCtx} />}

        {/* The portfolio page is its own dashboard: layout is data, in
            components/Portfolio.tsx. It takes exactly the `ctx` bag the account
            panels already use, so this page adds no state to App.tsx. */}
        {shown === 'portfolio' && (
          <Guarded name="Portfolio"><PortfolioDashboard {...ctx} provider={provider} onOpenMarket={openMarket} onOpenTab={setTab} /></Guarded>
        )}

        {shown === 'scan' && (
          <Guarded name="Scan"><ScanDashboard {...ctx} /></Guarded>
        )}

        {shown === 'explore' && (
          <Guarded name="Explore">
            <Explore address={address} onScan={openScanAddress} onOpenCopy={openCopy} onOpenSymbol={openSymbol} onOpenCopyPage={() => setTab('copy')} />
          </Guarded>
        )}

        {shown === 'copy' && (
          <Guarded name="Copy"><CopyPage address={address} provider={provider} onScan={openScanAddress} /></Guarded>
        )}

        {shown === 'leaderboard' && (
          <Guarded name="Leaderboard">
            <LeaderboardPage address={address} onScan={openScanOverview} onOpenCopy={openCopy} />
          </Guarded>
        )}

        {shown === 'bots' && (
          <Guarded name="Bots" bare><BotsPage address={address} provider={provider} /></Guarded>
        )}

        {shown === 'referrals' && (
          <Guarded name="Referrals" bare><ReferralsPage address={address} /></Guarded>
        )}


        {legal && (
          <Guarded name="Legal"><LegalDoc page={legal} onOpen={openLegal} /></Guarded>
        )}

        {status && !legal && (
          <Guarded name="Status"><StatusDoc /></Guarded>
        )}

        {excluded && !legal && !status && (
          <Guarded name="Excluded wallets"><ExcludedDoc /></Guarded>
        )}
        {limits && !legal && !status && !excluded && (
          <Guarded name="Trading limits"><LimitsDoc /></Guarded>
        )}
        {SodexDoc && !legal && !status && !excluded && !limits && (
          <Guarded name="SoDEX"><SodexDoc {...ctx} provider={provider} onOpenMarket={openMarket} /></Guarded>
        )}

        </div>

        {/* Account ACTIONS - enable trading, turn it off, advanced key options -
            run here, whichever button asked for them (address menu, order
            ticket, footer). It also renders OUR Connect dialog, the one thing
            every Connect button opens (AppKit only ever appears behind a row of
            it). All three are portals, closed until asked for. */}
        {/* Send feedback: the chat with the team, its right-click entry and the watch for replies (feedback/). */}
        <Guarded name="Feedback">
          <FeedbackHost address={address} provider={provider} />
        </Guarded>
        <Guarded name="Account">
          <AccountController
            address={address}
            provider={provider}
            session={session}
            onSession={refreshSession}
          />
        </Guarded>
        {/* The trading key's user lock (trading/keyLock.ts): one dialog for every unlock and money confirmation. */}
        <Guarded name="Unlock">
          <UnlockDialog />
        </Guarded>
        <Guarded name="Account setup">
          <AccountSetup address={address} hold={onboarding.holdSetup} />
          <OnboardingHost gate={onboarding} address={address} provider={provider} onFinish={() => { setTab('trade'); }} />
        </Guarded>
        <Guarded name="Share">
          <ShareHost address={address} />
        </Guarded>
        {/* What only a wallet uses - fill toasts, the referral offer, the invite, the indexing and history notes -
            in a chunk of its own, each in its own boundary (components/account/WalletHosts.tsx). */}
        <WalletHostsSlot address={address} provider={provider} hold={onboarding.holdSetup || !!onboarding.open} />
        {/* Maintenance as a notification: blue with its countdown while an update runs, green once done (status/MaintNote.tsx). */}
        <Guarded name="Maintenance notice">
          <MaintNote health={health} onOpenStatus={openStatus} />
        </Guarded>
        {/* Incidents, and the data service not answering, as notifications too (status/IncidentNote.tsx). */}
        <Guarded name="Incident notice">
          <IncidentNote health={health} down={healthDown} onOpenStatus={openStatus} />
        </Guarded>
        {/* The terms popup is App's, beside this shell: it opens before the shell is in (App above). */}
        {/* Live copy trading on every page: the browser copier runs whichever page is open. */}
        <Guarded name="Copy trading">
          <Suspense fallback={null}>
            <CopyRunner address={address} provider={provider} />
          </Suspense>
        </Guarded>
        <Guarded name="Algo orders">
          <Suspense fallback={null}>
            <AlgoRunner address={address} provider={provider} />
          </Suspense>
        </Guarded>

        <ShortcutsDialog />
      </div>

      {/* Search / Cmd+K: Home, Traders, Screener, Assets - components/palette/. */}
      <CommandPalette
        onOpenSodex={openSodex}
        onSelectSymbol={(e, s) => { setEngine(e); setSymbol(s); setTab('trade'); }}
        onPressSymbol={pressMarket}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onOpenTrader={(a: string, venue?: Venue) => openUrl(`/scan?address=${a}${venue && venue !== 'sodex' ? `&venue=${venue}` : ''}`)}
        onOpenCopy={openCopy}
        onNavigate={setTab}
      />
    </div>
    </PrivacyProvider>
    </ToastProvider>
    </Suspense>
  );
}

/** What the nav bars light: the page on screen, or the one a navigation is opening (nav.ts). */
interface Lit extends ReturnType<typeof litFromKey> {
  pending: Pending | null;
}

/**
 * The nav bars, with the item of a navigation still on its way already lit: they alone read the pending store,
 * so the frame after a tap commits a few dozen nodes - the bar - and not the app.
 */
function LitNav({ committed, children }: { committed: Lit; children: (lit: Lit) => ReactElement }): ReactElement {
  const pending = usePendingNav();
  return children(pending ? { ...litFromKey(pending.key), pending } : committed);
}

/** The pages the phone's tab bar opens (PhoneTabBar.tsx), in its order: the likeliest next taps from any page. */
const TAB_BAR_PATHS = [pathForTab('trade'), pathForTab('bots'), pathForSodexView('points'), pathForTab('portfolio')];

/**
 * Fetch (and evaluate) the code of these pages, one after another, then - in a language read in parts - their
 * text, which a chunk names only once it has run (i18n/store.ts); nothing renders.
 */
function prefetchPaths(paths: readonly string[]): Promise<void> {
  let chain = Promise.resolve();
  for (const path of paths) {
    const page = pageForPath(path);
    if (page.ready) {
      i18nWarmPath(path);
      continue;
    }
    chain = chain.then(() => page.preload().catch(() => undefined)).then(() => i18nWarmPath(path));
  }
  return chain;
}

/** The connection as the browser rates it (Network Information API; Chromium only). */
type Conn = { saveData?: boolean; effectiveType?: string };
const connection = (): Conn | undefined => (navigator as Navigator & { connection?: Conn }).connection;

/**
 * WHICH PAGES' CODE IS FETCHED BEFORE IT IS ASKED FOR (nav pass, 2026-11-18). A tap must answer in under 100 ms,
 * and a page whose code is not in waits for the network (1.1-2.2 s measured on Slow 4G, the tab lit meanwhile):
 *   - after the load event, on every connection but Save-Data: the tab bar's pages (Trade, Bots, Points,
 *     Portfolio), one after another - ~200 KB brotli, the pages a thumb goes to next. (The More sheet's own code
 *     is in the entry: nothing to fetch for it.) This used to be skipped whenever Chrome rated the link '2g'/'3g',
 *     which is every Slow 4G phone (rated '3g', rtt 600 ms, measured) and made a switch to /trade take 2-5 s;
 *   - then every other page, on every connection but Save-Data too: measured on Slow 4G (2026-11-18), leaving them to
 *     intent made a switch to Cohorts 2.2-5.3 s and to the leaderboard ~1.5 s, against ~0.8 s with them fetched;
 *   - and on intent (a touch, hover or focus on a link, More's sheet opening: PhoneTabBar onPrefetch), whichever
 *     comes first.
 * Fetching only fetches and evaluates the chunk; nothing renders until the page is opened.
 */
function usePagePrefetch(): void {
  useEffect(() => {
    const others = () => {
      for (const t of TABS) if (!SOON_TABS.has(t)) PAGES[t].preload().catch(() => {});
      for (const doc of Object.values(SODEX_DOCS)) doc.preload().catch(() => {});
    };
    const idle = typeof window.requestIdleCallback === 'function';
    let handle = 0;
    const run = () => {
      if (connection()?.saveData === true) return;
      void prefetchPaths(TAB_BAR_PATHS).then(others);
    };
    const later = () => { handle = idle ? window.requestIdleCallback(run, { timeout: 3000 }) : window.setTimeout(run, 1000); };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
    const onIntent = (e: Event) => {
      const el = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(el instanceof HTMLAnchorElement) || el.origin !== window.location.origin) return;
      if (routeKeyForPath(el.pathname) === null) return;
      void prefetchPaths([el.pathname]);
    };
    document.addEventListener('pointerover', onIntent, { passive: true });
    document.addEventListener('focusin', onIntent);
    document.addEventListener('touchstart', onIntent, { passive: true });
    return () => {
      window.removeEventListener('load', later);
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      document.removeEventListener('pointerover', onIntent);
      document.removeEventListener('focusin', onIntent);
      document.removeEventListener('touchstart', onIntent);
    };
  }, []);
}

/**
 * Keyboard shortcuts. Deliberately inert while a text field has focus, so
 * typing a quantity never fires a trading action. The exception is ⌘K/Ctrl+K,
 * which — like every command-palette convention — opens search regardless of
 * focus.
 */
const RESERVED_KEYS = new Set(['1', '2', '3', '4', 'c', '?', '/']);

function useKeyboardShortcuts({
  setTab, engine, unlocked, onChanged, onOpenSearch, onHelp,
}: {
  setTab: (t: Tab) => void;
  engine: Engine;
  symbol: string;
  unlocked: boolean;
  onChanged: () => void;
  onOpenSearch: (seed?: string) => void;
  onHelp: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenSearch();
        return;
      }

      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const tabs: readonly Tab[] = TABS.filter((t) => !SOON_TABS.has(t));
      const idx = Number.parseInt(e.key, 10);
      if (idx >= 1 && idx <= tabs.length) {
        setTab(tabs[idx - 1]!);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        onOpenSearch();
        return;
      }
      if (e.key === 'c' && unlocked) {
        // One stray letter: this asks even when Cancel all's window was turned off.
        void askTrade({
          kind: 'cancelAll',
          force: true,
          title: `Cancel all ${engine} orders`,
          tone: 'danger',
          confirmLabel: 'Cancel every open order',
          cancelLabel: 'Keep them',
          note: `The C key cancels every order open on ${engine === 'perps' ? 'Futures' : 'Spot'}. Open positions are not closed by this.`,
        }).then((ok) => {
          if (ok) api.cancelAll(engine).then(onChanged).catch(() => {});
        });
        return;
      }
      if (e.key === '?') {
        // Opens the same dialog as the footer's help button - one list, one
        // renderer. It used to be an alert(), which blocked the tab and could
        // not be dismissed by clicking away.
        onHelp();
        return;
      }
      // Anything else printable, and not already a shortcut: start a market search with it.
      if (e.key.length === 1 && !RESERVED_KEYS.has(e.key)) {
        onOpenSearch(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab, engine, unlocked, onChanged, onOpenSearch, onHelp]);
}
