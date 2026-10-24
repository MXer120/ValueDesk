import './cssOrder';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrivacyProvider } from './privacy';
import { NavBar, scanHref } from './components/NavBar';
import { SideBar } from './components/SideBar';
import './components/shell.css';
import { DEFAULT_TAB, TABS, landingTab, legalForPath, tabForPath, useRoute, type LegalPage, type Tab } from './router';
import { api, type Engine } from './api';
import { useAsync, useConnState, useMediaQuery, useSession, useStored, useSymbols } from './hooks';
import { hub } from './ws';
import { Guarded } from './components/ErrorBoundary';
import { StatusFooter } from './components/StatusFooter';
import { CommandPalette, loadPalette, openPalette, paletteReady } from './components/palette/lazyPalette';
import type { TradeContext } from './dashboard';
import { MaintenanceBanner } from './components/MaintenanceBanner';
import type { Eip1193Provider } from './wallet';
import { AccountController } from './components/account/AccountController';
import { AccountSetup } from './setup/AccountSetup';
import { IndexPrompt } from './components/IndexPrompt';
import { DevPanel } from './components/dev/DevPanel';
import { goToWallet } from './components/account/actions';
import { useWalletBridge } from './components/account/useWallet';
import { configureFromHealth } from './trading/config';
import { restoreTrading } from './trading/session';
import { ToastProvider } from './toast';
import { FillToasts } from './components/FillToasts';
import { lazyPage, type LazyPage } from './lazyPage';
import { primeFirstReads } from './serverFetch';
import type { Venue } from './vsApi';
import { OPEN_LEGAL_EVENT, TermsGate } from './legal/LegalGate';
import { FoldersHost } from './folders/FoldersHost';
import { registerChartOpener } from './folders/bridge';

const DEFAULT_SYMBOL: Record<Engine, string> = { perps: 'BTC-USD', spot: 'vBTC_vUSDC' };

/*
 * THE PAGES ARE CODE-SPLIT, AND NOTHING ON SCREEN MAY TELL.
 *
 * Each page is its own chunk, so the first load only parses the page you
 * landed on (plus the shell) instead of all six. lazyPage.ts explains why this
 * is not React.lazy; the rules that keep it invisible live here:
 *   - the landing page's code - and the Cmd+K palette's, which must answer a
 *     key pressed the moment the page appears - is requested the moment this
 *     module runs, in parallel, and <App> renders nothing until both are in:
 *     the whole app still mounts in ONE commit, in the same order as before
 *     (App's effects after its children's, e.g. the dash:lock query below
 *     still finds the Dashboard), with the palette listening from the start;
 *   - the other pages are fetched right after the first paint (idle time, at
 *     most a second later), and again on hover/focus of any link to them;
 *   - `setTab` changes page only once the next page's code is in, so a
 *     navigation never renders a fallback.
 * Their CSS is not split at all: see cssOrder.ts.
 */
const TradeDashboard = lazyPage('trade', () => import('./dashboard/TradeDashboard').then((m) => m.TradeDashboard));
const Explore = lazyPage('explore', () => import('./components/explore/Explore').then((m) => m.Explore));
const CopyPage = lazyPage('copy', () => import('./components/copy/CopyPage').then((m) => m.CopyPage));
/** Live copy trading (copy/CopyRunner.tsx): mounted on every page, loaded after it. */
const CopyRunner = lazy(() => import('./copy/CopyRunner'));
/** Algo orders run in this browser (algo/AlgoRunner.tsx): mounted on every page, loaded after it. */
const AlgoRunner = lazy(() => import('./algo/AlgoRunner'));
const LeaderboardPage = lazyPage('leaderboard', () => import('./components/leaderboard/LeaderboardPage').then((m) => m.LeaderboardPage));
const PortfolioDashboard = lazyPage('portfolio', () => import('./dashboard/PortfolioDashboard').then((m) => m.PortfolioDashboard));
const ScanDashboard = lazyPage('scan', () => import('./dashboard/ScanDashboard').then((m) => m.ScanDashboard));
/* The market strip below is shown on no page today, so this never loads. */
const TickerBar = lazyPage('ticker', () => import('./components/Market').then((m) => m.TickerBar));
/* Impressum, privacy policy, terms (src/legal): one chunk for the three, loaded
   only when a legal link is hovered, focused or followed - or when the app
   starts on a legal URL. Never part of the idle prefetch below. */
const LegalDoc = lazyPage('legal', () => import('./legal/LegalView').then((m) => m.LegalView));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAGES: Record<Tab, LazyPage<any>> = {
  trade: TradeDashboard,
  explore: Explore,
  copy: CopyPage,
  leaderboard: LeaderboardPage,
  portfolio: PortfolioDashboard,
  scan: ScanDashboard,
};

/** The page the first render shows, and the one an old URL is then moved to (router.ts). */
const bootTabs = (): Tab[] => {
  const first = tabForPath(window.location.pathname) ?? DEFAULT_TAB;
  const settled = landingTab(window.location.pathname);
  return first === settled ? [first] : [first, settled];
};
/** The code the first render needs: a legal page's, or the landing tab's (above). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bootPages = (): LazyPage<any>[] =>
  legalForPath(window.location.pathname) ? [LegalDoc] : bootTabs().map((t) => PAGES[t]);
/* The landing page's first index reads leave now, when this browser has started
   on this URL before: the page asks for them in an effect, after its code has
   arrived and rendered, and takes the answers that are already there (serverFetch.ts). */
primeFirstReads(window.location.pathname + window.location.search);
/* Requested now, in parallel with React starting up. */
const booting: Promise<unknown> = Promise.all([...bootPages().map((p) => p.preload()), loadPalette()]);
booting.catch(() => {
  /* logged in lazyPage; the page itself retries and recovers when it renders */
});

/** Holds the app back until the landing page's code is in (see above). */
export function App() {
  const [ready, setReady] = useState(() => bootPages().every((p) => p.ready) && paletteReady());
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
  return ready ? <AppShell /> : null;
}

function AppShell() {
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
  /* The page comes from the URL. `setTab` keeps its name because ~15 call
   * sites below pass it around as a callback; it pushes history now. */
  const [tab, navigate, legal, navigateLegal] = useRoute();
  /* Change page only once its code is in; the latest request wins. After the
     idle prefetch every page is in, and this is a plain synchronous navigate. */
  const navSeq = useRef(0);
  const setTab = useCallback((next: Tab) => {
    const seq = ++navSeq.current;
    const page = PAGES[next];
    if (page.ready) {
      navigate(next);
      return;
    }
    const go = () => {
      if (seq === navSeq.current) navigate(next);
    };
    page.preload().then(go, go);
  }, [navigate]);
  /* A chart saved to a research folder, opened again (folders/bridge.ts): on its
     market, in the Trade page, where the chart shows it as a snapshot view
     (chart/snapshot.ts - loaded on demand, so the chart code stays out of here). */
  useEffect(
    () =>
      registerChartOpener((raw) => {
        void import('./chart/snapshot').then(({ openSnapshot, parseChartSnapshot }) => {
          const s = parseChartSnapshot(raw);
          if (!s) return;
          openSnapshot(s);
          setEngine(s.engine);
          setSymbol(s.symbol);
          setTab('trade');
        });
      }),
    [setEngine, setSymbol, setTab],
  );
  /* The legal pages the same way: their chunk first, then the page. */
  const openLegal = useCallback((next: LegalPage) => {
    const seq = ++navSeq.current;
    if (LegalDoc.ready) {
      navigateLegal(next);
      return;
    }
    const go = () => {
      if (seq === navSeq.current) navigateLegal(next);
    };
    LegalDoc.preload().then(go, go);
  }, [navigateLegal]);
  /* A legal link anywhere in the app (legal/LegalGate.tsx LegalLink) opens its page in place. */
  useEffect(() => {
    const on = (e: Event) => {
      const page = (e as CustomEvent<LegalPage>).detail;
      if (typeof page === 'string' && legalForPath(`/${page}`)) openLegal(page);
    };
    window.addEventListener(OPEN_LEGAL_EVENT, on);
    return () => window.removeEventListener(OPEN_LEGAL_EVENT, on);
  }, [openLegal]);
  /* The tab whose page is on screen - none while a legal page is. */
  const shown: Tab | null = legal ? null : tab;
  usePagePrefetch();
  const openScanAddress = useCallback((addr: string, venue?: Venue) => {
    window.location.href = venue
      ? `/scan?address=${encodeURIComponent(addr)}&venue=${venue}`
      : scanHref(addr);
  }, []);
  /* The Scan overview for an address: every venue it is on, before any one opens. */
  const openScanOverview = useCallback((addr: string) => {
    window.location.href = `/scan?find=${encodeURIComponent(addr)}`;
  }, []);
  /* Copy setup for one trader. The Copy page reads ?address=&venue= on mount. */
  const openCopy = useCallback((addr: string, venue: Venue) => {
    window.location.href = `/copy?address=${encodeURIComponent(addr)}&venue=${venue}`;
  }, []);
  const openSymbol = useCallback((sym: string) => {
    setEngine('perps');
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
      .then((d) => { window.location.href = scanHref(d?.address); })
      .catch(() => { window.location.href = scanHref(); });
  }, []);
  const [price, setPrice] = useState('');
  const [lastPrice, setLastPrice] = useState('');
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

  const [refreshToken, setRefreshToken] = useState(0);
  // Surfaced from the tab content up to the tab label, e.g. "Positions (2)".
  const [posCount, setPosCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  // Lives here, not in the footer, because two separate things open it: the
  // footer's help button and the global `?` shortcut.
  const [helpOpen, setHelpOpen] = useState(false);

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
  const { symbols, byName } = useSymbols(engine);
  const { state: connState, upstream } = useConnState();
  const { data: health } = useAsync(() => api.health(), [], { pollMs: 30_000 });
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

  // Keep the selected symbol valid when the engine changes.
  //
  // Keyed on the first symbol's NAME, not on symbols.length: two engines can
  // return lists of equal length (and spot/perps counts drift as markets are
  // listed), which would leave the previous engine's symbol selected and every
  // panel requesting a market that does not exist on the new engine.
  const symbolsFingerprint = `${engine}:${symbols[0]?.name ?? ''}:${symbols.length}`;
  useEffect(() => {
    if (symbols.length === 0) return;
    if (!byName.has(symbol)) {
      const fallback = byName.has(DEFAULT_SYMBOL[engine]) ? DEFAULT_SYMBOL[engine] : symbols[0]!.name;
      setSymbol(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsFingerprint, symbol]);

  useEffect(() => {
    hub.connect();
  }, []);

  // Seed the price field from the book when switching markets.
  useEffect(() => {
    let cancelled = false;
    api
      .orderbook(engine, symbol, 1)
      .then(({ book }) => {
        if (cancelled) return;
        const mid = book.bids?.[0]?.[0] ?? book.asks?.[0]?.[0];
        if (mid) setPrice(mid);
      })
      .catch(() => {});
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
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useKeyboardShortcuts({
    setTab, engine, symbol, unlocked: session?.unlocked ?? false, onChanged: bump,
    onOpenSearch: openSearch, onHelp: openHelp,
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
      lastPrice,
      favorites,
      positionCount: posCount,
      orderCount: orderCount,
      onPrice: setPrice,
      onLastPrice: setLastPrice,
      onChanged: bump,
      onToggleFavorite: toggleFavorite,
      onOpenSearch: openSearch,
      /* The favourites bar's chips switch the market in place. */
      onSelectSymbol: setSymbol,
      onPositionCount: setPosCount,
      onOrderCount: setOrderCount,
      onOpenScan: openScanAccountId,
    }),
    [
      engine, symbol, sym, health?.network, session?.unlocked, session?.session?.address,
      address, byName, refreshToken, price, lastPrice, favorites, posCount, orderCount,
      bump, toggleFavorite, openSearch, setTab, openScanAccountId, setSymbol,
    ],
  );

  const upstreamState = upstream[engine];
  const connLabel =
    connState === 'open' && upstreamState === 'open' ? 'live'
    : connState === 'open' ? `hub ok · sodex ${upstreamState ?? '…'}`
    : connState;

  return (
    /* Only a page chunk that failed to load can suspend in here (lazyPage.ts
       then retries or reloads); navigation never does - see setTab. */
    <Suspense fallback={null}>
    {/* The provider wraps the WHOLE shell, header included: the navbar's address
       chip reads it, and so does every page below. */}
    <ToastProvider>
    <PrivacyProvider>
    <div className={`shell${rail ? ' shell--rail' : ''}`}>
      {rail && (
        <SideBar address={address} hasLayout={hasLayout} dashLocked={dashLocked} onOpenSearch={() => openSearch()} tab={shown} onNavigate={setTab} />
      )}
      {/* ONE bar of chrome at the top, 56px, and nothing underneath it.
       *
       * Hierarchy here is carried by colour alone: the wordmark and the current
       * page are --text, every other link is --muted, and the active item gets
       * no pill, no box and no underline. The connection state used to live up
       * here as a dot and a word; it belongs to the status bar at the bottom of
       * the screen and is not duplicated.
       *
       * The "MAINNET - real funds" block is gone with it. A filled red badge in
       * the top-right was the loudest pixel on a 1920px trading screen, louder
       * than the live price and the two order buttons, for a fact that does not
       * change between sessions. The network is now a quiet outlined pill. */}
      <NavBar
        tab={shown}
        onNavigate={setTab}
        address={address}
        hasLayout={hasLayout}
        dashLocked={dashLocked}
        onOpenSearch={() => openSearch()}
        rail={rail}
        engine={engine}
        onEngine={switchEngine}
      />

      {/* The venue-status line is the ONLY full-width strip allowed under the
          navbar, and it renders nothing at all unless SoDEX is actually
          degraded. The onboarding bar that used to sit here - "Connect a wallet
          to trade", with a second Connect button 30px below the first one - is
          gone: it appeared on every cold load, cost a row of the chart to say
          something the order ticket already says at the point of use, and put
          the same call to action on screen twice. The order entry panel carries
          that state now ("Read-only - unlock a signing key"). */}
      <Guarded name="Maintenance">
        <MaintenanceBanner />
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
        {tab !== 'trade' && tab !== 'portfolio' && tab !== 'scan' && tab !== 'leaderboard' && tab !== 'explore' && tab !== 'copy' && (
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

        <div className="appcontent">
        {/* The trade page IS the dashboard. Layout is data: see
            src/dashboard/layout.ts for the grid and registry.tsx for the
            panels. Nothing about arrangement lives in this file. */}
        {shown === 'trade' && <TradeDashboard context={tradeCtx} />}

        {/* The portfolio page is its own dashboard: layout is data, in
            components/Portfolio.tsx. It takes exactly the `ctx` bag the account
            panels already use, so this page adds no state to App.tsx. */}
        {shown === 'portfolio' && (
          <Guarded name="Portfolio"><PortfolioDashboard {...ctx} /></Guarded>
        )}

        {shown === 'scan' && (
          <Guarded name="Scan"><ScanDashboard {...ctx} /></Guarded>
        )}

        {shown === 'explore' && (
          <Guarded name="Explore">
            <Explore address={address} onScan={openScanAddress} onOpenCopy={openCopy} onOpenSymbol={openSymbol} />
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

        {legal && (
          <Guarded name="Legal"><LegalDoc page={legal} onOpen={openLegal} /></Guarded>
        )}

        </div>

        {/* Account ACTIONS - enable trading, turn it off, advanced key options -
            run here, whichever button asked for them (address menu, order
            ticket, footer). It also renders OUR Connect dialog, the one thing
            every Connect button opens (AppKit only ever appears behind a row of
            it). All three are portals, closed until asked for. */}
        <FillToasts address={address} />
        <Guarded name="Account">
          <AccountController
            address={address}
            provider={provider}
            session={session}
            onSession={refreshSession}
          />
        </Guarded>
        <Guarded name="Account setup">
          <AccountSetup address={address} />
        </Guarded>
        <Guarded name="Dev panel">
          <DevPanel address={address} engine={engine} />
        </Guarded>
        <Guarded name="Indexing">
          <IndexPrompt address={address} />
        </Guarded>
        {/* The first-visit clickwrap (legal/acceptance.ts): until this browser accepts the
            current terms - with a connected wallet, ticked and signed in one step. Not over
            a legal page, so what it links to can be read first. */}
        <Guarded name="Terms">
          <TermsGate hidden={!!legal} onOpen={openLegal} address={address} provider={provider} />
        </Guarded>
        {/* The knowledge folders (folders/): the rail's folder view, and "Save to folder" from the chart and News. */}
        <Guarded name="Folders">
          <FoldersHost address={address} provider={provider} />
        </Guarded>
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

        {/* The workspace bar: connection + which account we are signing as on
            the left, the two things worth reaching for on the right. What used
            to be here - a REST-weight readout and a printed shortcut list - was
            developer scaffolding; the readout survives inside StatusFooter
            behind import.meta.env.DEV, and the shortcut list became a real
            dialog reachable from both the `?` key and a button. */}
        <Guarded name="Status footer">
          <StatusFooter
            connLabel={connLabel}
            connOk={connState === 'open' && upstreamState === 'open'}
            session={session}
            address={address}
            health={health ?? null}
            onGoToWallet={() => goToWallet({ address, hasProvider: !!provider, unlocked: session?.unlocked ?? false })}
            onSessionChanged={refreshSession}
            helpOpen={helpOpen}
            onHelpOpen={setHelpOpen}
            legal={legal}
            onOpenLegal={openLegal}
          />
        </Guarded>
      </div>

      {/* Search / Cmd+K: Home, Traders, Screener, Assets - components/palette/. */}
      <CommandPalette
        onSelectSymbol={(e, s) => { setEngine(e); setSymbol(s); setTab('trade'); }}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onOpenTrader={(a: string, venue?: Venue) => {
          window.history.pushState(null, '', `/scan?address=${a}${venue && venue !== 'sodex' ? `&venue=${venue}` : ''}`);
          setTab('scan');
        }}
        onOpenCopy={openCopy}
        onNavigate={setTab}
      />
    </div>
    </PrivacyProvider>
    </ToastProvider>
    </Suspense>
  );
}

/**
 * Fetch every other page once the first one has painted - in idle time, at
 * most 1 s later - and fetch a page early when a link to it is hovered,
 * focused or touched. Loading a chunk only fetches and evaluates it; nothing
 * renders until the page is navigated to.
 */
function usePagePrefetch(): void {
  useEffect(() => {
    const all = () => {
      for (const t of TABS) PAGES[t].preload().catch(() => {});
    };
    const idle = typeof window.requestIdleCallback === 'function';
    const handle = idle ? window.requestIdleCallback(all, { timeout: 1000 }) : window.setTimeout(all, 300);
    const onIntent = (e: Event) => {
      const el = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(el instanceof HTMLAnchorElement) || el.origin !== window.location.origin) return;
      const t = tabForPath(el.pathname);
      if (t && !PAGES[t].ready) PAGES[t].preload().catch(() => {});
      if (!t && legalForPath(el.pathname) && !LegalDoc.ready) LegalDoc.preload().catch(() => {});
    };
    document.addEventListener('pointerover', onIntent, { passive: true });
    document.addEventListener('focusin', onIntent);
    document.addEventListener('touchstart', onIntent, { passive: true });
    return () => {
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

      const tabs: readonly Tab[] = TABS;
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
        if (confirm('Cancel every open order?')) {
          api.cancelAll(engine).then(onChanged).catch(() => {});
        }
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
