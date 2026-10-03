/**
 * The search / Cmd+K palette: Home, Traders, Screener, Assets.
 *
 * SURFACE (docs/DESIGN.md sections 4 and 10). A glass sheet over a --scrim,
 * a fixed-height flex column that NEVER scrolls as a whole: the header, the
 * section heads and the key hints stay put, and only the lists inside scroll,
 * each in its own box (`.cp-scroll`). Sections inside are hairline-separated,
 * like the wallet pop-up's, with 42px head strips. Phones get a full-screen
 * sheet with the same structure.
 *
 * VENUES. Traders cover every venue Scan reads (SoDEX, Hyperliquid, trade.xyz,
 * Lighter, Arcus), chosen with the leaderboard bar's chips (one always stays
 * on). SoDEX and Hyperliquid come from the server's screener pool; the others
 * from their leaderboards (vsApi.leaderboard, as the leaderboard page reads
 * them). A venue with no data, or without the figure a filter needs, says so
 * on one line - rows are never invented. MARKETS are SoDEX's only: it is the
 * one venue this app trades on, so the venue chips do not apply to them.
 *
 * SPEED. The shell paints on the first frame; the lists mount one frame later
 * (from the session cache, so the last answer shows at once) and are frozen
 * while the sheet animates out, so closing never re-renders them.
 *
 * KEYBOARD. Cmd/Ctrl+K toggles, Esc closes, Up/Down/PageUp/PageDown move,
 * Enter opens, Tab / Shift+Tab in the search field or Alt/Ctrl+1..4 switch
 * sections, typing anywhere filters. Focus is trapped and handed back.
 *
 * MOTION. The sheet pops in (--dur-fast, --ease-spring) and fades out; the
 * section ink slides; a new section or list fades in (FadeView). All of it
 * honours prefers-reduced-motion.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import type { Engine } from '../../api';
import type { Tab } from '../../router';
import { VENUE_LABEL, type BoardWindow, type Venue } from '../../vsApi';
import { usePrivacy } from '../../privacy';
import { resolveTarget } from '../../dashboard/scanAliases';
import { FadeView } from '../motion';
import { CohortIcon } from '../explore/cohorts/CohortIcon';
import {
  IconActivity,
  IconAssets,
  IconBadgeCheck,
  IconCandles,
  IconClock,
  IconClose,
  IconCompass,
  IconCopyTrade,
  IconEye,
  IconFlame,
  IconGrid,
  IconHome,
  IconMap,
  IconPie,
  IconPodium,
  IconScan,
  IconScreener,
  IconSearch,
  IconShield,
  IconStar,
  IconTarget,
  IconTraders,
  IconTrendUp,
  IconWhale,
} from './icons';
import {
  AmountField,
  AssetMark,
  EmptyState,
  FieldLabel,
  FilterPop,
  HostContext,
  Ink,
  Kbd,
  LongShortBar,
  NavRow,
  Panel,
  QuickOptions,
  RangeField,
  ScreenerTableRow,
  Seg,
  SkeletonRows,
  TraderListRow,
  VenueChip,
  VenueNote,
  useInk,
  usePresence,
  useVisualViewportBox,
  winTintColor,
  type AnyTrader,
  type NavProps,
  type QuickOption,
  type SegOption,
} from './ui';
import {
  COHORTS_PATH,
  DEFAULT_LIST_FILTERS,
  DEFAULT_SCREENER_FILTERS,
  LS_RECENT_SEARCHES,
  LS_RECENT_TRADERS,
  LS_WATCHLIST,
  MARKET_MAP_PATH,
  PALETTE_TABS,
  PALETTE_VENUES,
  TAB_LABEL,
  boardListRows,
  boardScreenerRows,
  boardVenues,
  cohortAssetPath,
  cycleTab,
  effectiveSort,
  extractAddress,
  filterAssets,
  fmtAgo,
  fmtChangePct,
  fmtPriceAuto,
  fmtUsdCompact,
  interleaveVenues,
  isMissing,
  listQuery,
  mergeByPnl,
  normaliseVenues,
  poolToggles,
  pushFront,
  readList,
  readTraderRefs,
  screenerQuery,
  signOf,
  sortAssets,
  toggleVenueIn,
  traderKey,
  venueList,
  writeList,
  type ActiveSpan,
  type AssetCategory,
  type AssetRow,
  type AssetSort,
  type HiddenBy,
  type ListFilters,
  type PaletteTab,
  type PresetId,
  type ScreenerFilters,
  type ScreenerSort,
  type Strategy,
  type TraderRef,
} from './model';
import { useLeaderboardSearch, useMarkets, useNow, useScreener, useVenueBoards, type BoardState, type ScreenerState } from './usePaletteData';
import { MarketHeatmap } from './Heatmap';
import { PaletteBoundary } from './PaletteBoundary';
import { TypeAhead, applyTyped } from './typeAhead';
import { LoadFailed } from '../LoadFailed';
import {
  overviewCards, overviewLead, useAddressVenues, VENUE_CHECK,
} from '../scan/addressVenues';
import { VenueChooser } from '../scan/VenueChooser';
import './CommandPalette.css';

export interface CommandPaletteProps {
  /** Controlled opening (optional): App opens it through `openPalette` instead, see below. */
  open?: boolean;
  /** Seeds the search box, e.g. when the user opened this by typing outside a field. */
  initialQuery?: string;
  onClose?: () => void;
  /** Pick a market to trade (Assets tab). */
  onSelectSymbol: (engine: Engine, symbolName: string) => void;
  favorites: string[];
  onToggleFavorite: (key: string) => void;
  /** Open a trader's Scan page. venue omitted = let Scan decide. */
  onOpenTrader: (address: string, venue?: Venue) => void;
  /** Open the Copy setup for a trader. */
  onOpenCopy: (address: string, venue: Venue) => void;
  /** Go to an app page. */
  onNavigate: (tab: Tab) => void;
}

/* ===========================================================================
 *  Static choices
 * ======================================================================== */

const TAB_ICON: Record<PaletteTab, () => JSX.Element> = {
  home: IconHome,
  traders: IconTraders,
  screener: IconScreener,
  assets: IconAssets,
};

const WIN_QUICK: QuickOption<number | null>[] = [
  { value: 40, label: '≥ 40%', winRate: 40 },
  { value: 50, label: '≥ 50%', winRate: 50 },
  { value: 60, label: '≥ 60%', winRate: 60 },
  { value: 70, label: '≥ 70%', winRate: 70 },
];

const VOL_QUICK: QuickOption<number | null>[] = [
  { value: 100_000, label: '$100k' },
  { value: 1_000_000, label: '$1M' },
  { value: 10_000_000, label: '$10M' },
  { value: 100_000_000, label: '$100M' },
];

const AV_QUICK: QuickOption<number | null>[] = [
  { value: 10_000, label: '$10k' },
  { value: 100_000, label: '$100k' },
  { value: 1_000_000, label: '$1M' },
  { value: 10_000_000, label: '$10M' },
];

const ROI_QUICK: QuickOption<number | null>[] = [
  { value: 0, label: '> 0%' },
  { value: 10, label: '≥ 10%' },
  { value: 25, label: '≥ 25%' },
  { value: 50, label: '≥ 50%' },
  { value: 100, label: '≥ 100%' },
];

const STRATEGY_QUICK: QuickOption<Strategy | null>[] = [
  { value: null, label: 'Any' },
  { value: 'scalper', label: 'Scalper' },
  { value: 'intraday', label: 'Intraday' },
  { value: 'swing', label: 'Swing' },
  { value: 'position', label: 'Position' },
  { value: 'high-leverage', label: 'High leverage' },
  { value: 'whale', label: 'Whale' },
  { value: 'vault', label: 'Vault' },
];

const ACTIVE_QUICK: QuickOption<ActiveSpan | null>[] = [
  { value: null, label: 'Any time' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];
const ACTIVE_WORD: Record<ActiveSpan, string> = { '1h': '1h', '24h': '24h', '7d': '7 days', '30d': '30 days' };

const VOL_WINDOWS: SegOption<ListFilters['volWindow'] & ('1d' | '7d' | '30d')>[] = [
  { id: '1d', label: '24h' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
];

const PRESET_CHIPS: { id: PresetId; label: string; icon: () => JSX.Element; hint: string }[] = [
  { id: 'all', label: 'All', icon: IconGrid, hint: 'Every active trader in the pool' },
  { id: 'consistent', label: 'Consistent winners', icon: IconBadgeCheck, hint: 'Profitable over 7D, 30D and all time' },
  { id: 'high-winrate', label: 'High win rate', icon: IconTarget, hint: 'Win rate of 60% or more over at least 10 closed trades' },
  { id: 'whales', label: 'Whales', icon: IconWhale, hint: 'Account value of $1M or more' },
  { id: 'low-drawdown', label: 'Low drawdown', icon: IconShield, hint: 'Profitable over 30D with a max drawdown of 15% or less' },
  { id: 'rising', label: 'Rising stars', icon: IconTrendUp, hint: '7D PnL is at least half of a positive all-time PnL' },
  { id: 'most-active', label: 'Most active', icon: IconActivity, hint: 'Traded in the last 7 days, ranked by volume' },
];

const SORT_CHIPS: { id: ScreenerSort; label: string }[] = [
  { id: 'pnl', label: 'PnL' },
  { id: 'roi', label: 'ROI' },
  { id: 'volume', label: 'Volume' },
  { id: 'winRate', label: 'Win rate' },
  { id: 'accountValue', label: 'Account value' },
  { id: 'lastActive', label: 'Last active' },
];

const ASSET_CATS: SegOption<AssetCategory>[] = [
  { id: 'all', label: 'All' },
  { id: 'favorites', label: 'Favorites', icon: <IconStar size={14} /> },
  { id: 'perps', label: 'Perps' },
  { id: 'spot', label: 'Spot' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'commodities', label: 'Commodities' },
];

const ASSET_SORTS: { id: AssetSort; label: string }[] = [
  { id: 'volume', label: 'Volume' },
  { id: 'change', label: '24h change' },
  { id: 'price', label: 'Price' },
  { id: 'positioning', label: 'Top traders' },
];

/** Every page, with its own glyph. `path` opens a view inside Explore. `words` also match a search. */
const PAGES: { id: string; tab: Tab; path?: string; label: string; hint: string; icon: ReactNode; words: string }[] = [
  { id: 'trade', tab: 'trade', label: 'Trade', hint: 'The SoDEX trading terminal', icon: <IconCandles size={18} />, words: 'trade terminal chart order' },
  { id: 'explore', tab: 'explore', label: 'Explore', hint: 'Discover traders across venues', icon: <IconCompass size={18} />, words: 'explore discover overview' },
  { id: 'cohorts', tab: 'explore', path: COHORTS_PATH, label: 'Cohorts', hint: 'Wallets grouped by PnL and account size', icon: <CohortIcon id="apex" size={18} />, words: 'cohorts whales groups' },
  { id: 'map', tab: 'explore', path: MARKET_MAP_PATH, label: 'Market map', hint: 'Every asset the tracked wallets hold', icon: <IconMap size={18} />, words: 'market map heatmap treemap' },
  { id: 'leaderboard', tab: 'leaderboard', label: 'Leaderboard', hint: 'Top traders by PnL, ROI and volume', icon: <IconPodium size={18} />, words: 'leaderboard ranking top' },
  { id: 'copy', tab: 'copy', label: 'Copy', hint: 'Set up and manage copy trading', icon: <IconCopyTrade size={18} />, words: 'copy trading follow' },
  { id: 'portfolio', tab: 'portfolio', label: 'Portfolio', hint: 'Your positions and history', icon: <IconPie size={18} />, words: 'portfolio positions history account' },
  { id: 'scan', tab: 'scan', label: 'Scan', hint: 'Look up any wallet', icon: <IconScan size={18} />, words: 'scan wallet address lookup' },
];

type HomeList = 'trending' | 'watchlist' | 'recent';

const WINDOW_LABEL: Record<string, string> = { '1d': '24h', '7d': '7D', '30d': '30D', all: 'all-time' };
const LS_VENUES = 'vs.palette.venues';

/** The markets' second line: "Perp · 40x" / "Spot". */
const marketKind = (a: AssetRow): string => (a.kind === 'perp' ? `Perp${a.maxLeverage ? ` · ${a.maxLeverage}x` : ''}` : 'Spot');

/* ===========================================================================
 *  Outer shell: state that survives closing and reopening
 * ======================================================================== */

interface Persisted {
  tab: PaletteTab;
  venues: Venue[];
  list: ListFilters;
  scr: ScreenerFilters;
  assetCat: AssetCategory;
  assetSort: { sort: AssetSort; dir: 'asc' | 'desc' };
  trend: '1d' | '7d';
  homeList: HomeList;
}

const initial = (): Persisted => ({
  tab: 'home',
  venues: normaliseVenues(readList<Venue>(LS_VENUES)),
  list: DEFAULT_LIST_FILTERS,
  scr: DEFAULT_SCREENER_FILTERS,
  assetCat: 'all',
  assetSort: { sort: 'volume', dir: 'desc' },
  trend: '1d',
  homeList: 'trending',
});

/** Longest the close animation may take before the dialog is removed anyway. */
const EXIT_FALLBACK_MS = 220;

/* Opening from outside (the search button, "/", typing outside a field) goes
   straight to the mounted palette: holding the open flag in App re-rendered
   the whole app on every open and close, which is what made those paths lag. */
let requestOpen: ((seed: string) => void) | null = null;
/** Open the palette, optionally with text already in the search box. */
export function openPalette(seed = ''): void {
  requestOpen?.(seed);
}

/* Keys typed after an open was asked for and before the search box has the
   focus (typeAhead.ts): taken here, handed to the box when it gets the focus. */
const typeAhead = new TypeAhead();
/** The mounted dialog's search box, and how it takes what was typed ahead. */
let searchBox: HTMLInputElement | null = null;
let flushTyped: (() => void) | null = null;

export function CommandPalette(p: CommandPaletteProps) {
  const [state, setState] = useState<Persisted>(initial);
  const patch = useCallback((u: Partial<Persisted>) => setState((s) => ({ ...s, ...u })), []);
  /* Cmd/Ctrl+K opens the palette HERE, before App's own shortcut sees it: App
     opening it re-renders the whole app first, which measured 80-120 ms from
     the key to the sheet. App's `open` still works (the search button, "/",
     typing outside a field). */
  const [selfOpen, setSelfOpen] = useState(false);
  const [seed, setSeed] = useState<string | undefined>(undefined);
  useEffect(() => {
    requestOpen = (s) => {
      if (!openRef.current) typeAhead.begin();
      setSeed(s || undefined);
      setSelfOpen(true);
    };
    return () => { requestOpen = null; };
  }, []);
  const open = !!p.open || selfOpen;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (openRef.current || e.repeat || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      typeAhead.begin();
      setSeed(undefined);
      setSelfOpen(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  /* Until the search box has the focus, what is typed is the search: taken
     before anything behind the palette sees it (capture phase, first). */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!typeAhead.active || !typeAhead.key(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // A click put the focus in the box before its own focus step ran: hand over now.
      if (searchBox && document.activeElement === searchBox) flushTyped?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const appClose = p.onClose;
  /* The exit starts on the next frame: the classes that play it go on the DOM
     now, before React (and App, when App opened it) re-render - that pass
     alone measured ~30 ms before the sheet began to leave. */
  const shellRef = useRef<HTMLDivElement | null>(null);
  const onClose = useCallback(() => {
    typeAhead.cancel();
    const layer = shellRef.current;
    layer?.classList.add('is-closing');
    layer?.querySelector(':scope > .cp')?.classList.add('is-closing');
    setSelfOpen(false);
    appClose?.();
  }, [appClose]);
  // Reduced motion plays no exit animation (motion.css), so nothing waits for one.
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const presence = usePresence(open, reduced ? 0 : EXIT_FALLBACK_MS);
  if (!presence.mounted) return null;
  // Its own boundary: a throw in here must never unmount the app around it.
  return (
    <PaletteBoundary onClose={onClose} closing={presence.closing}>
      <PaletteDialog
        {...p}
        initialQuery={p.open ? p.initialQuery : seed}
        onClose={onClose}
        state={state}
        patch={patch}
        closing={presence.closing}
        onExited={presence.done}
        shellRef={shellRef}
      />
    </PaletteBoundary>
  );
}

/** Children rendered once more only while not `frozen`: the lists do not re-render as the sheet closes. */
const Freeze = memo(function Freeze({ children }: { frozen: boolean; children: ReactNode }) {
  return <>{children}</>;
}, (_prev, next) => next.frozen);

/* ===========================================================================
 *  The dialog
 * ======================================================================== */

interface Item {
  id: string;
  run: () => void;
}

function PaletteDialog(
  p: CommandPaletteProps & {
    /** Always given by the outer component (its instant-exit close). */
    onClose: () => void;
    state: Persisted;
    patch: (u: Partial<Persisted>) => void;
    closing?: boolean;
    onExited?: () => void;
    /** The layer element, for the outer component's instant exit. */
    shellRef?: { current: HTMLDivElement | null };
  },
) {
  const { state, patch } = p;
  const closing = !!p.closing;
  const { tab, venues } = state;
  const [query, setQuery] = useState(p.initialQuery ?? '');
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const setDialog = useCallback((el: HTMLDivElement | null) => {
    dialogRef.current = el;
    setHost(el);
  }, []);
  /* Pop-overs are portalled into the LAYER, beside the dialog: the dialog's
     own backdrop-filter makes it a backdrop root, and a glass pop-over inside
     it would not frost what lies under it. */
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const shellRef = p.shellRef;
  const setLayerEl = useCallback((el: HTMLDivElement | null) => {
    layerRef.current = el;
    if (shellRef) shellRef.current = el;
    setLayer(el);
  }, [shellRef]);
  const inputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const vvBox = useVisualViewportBox(true);
  const hideFavs = usePrivacy().isHidden('favorites');
  const now = useNow(true);

  /* The shell paints on the first frame; the lists one frame later. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Local lists (try/catch-guarded inside read/writeList).
  // Read back as venue, address and time only: a name stored by an older build is dropped.
  const [watchlist, setWatchlist] = useState<TraderRef[]>(() => readTraderRefs(readList<unknown>(LS_WATCHLIST)));
  const [recentTraders, setRecentTraders] = useState<TraderRef[]>(() => readTraderRefs(readList<unknown>(LS_RECENT_TRADERS)));
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    readList<string>(LS_RECENT_SEARCHES).filter((s) => typeof s === 'string' && !!s.trim()),
  );
  const watched = useMemo(() => new Set(watchlist.map(traderKey)), [watchlist]);
  // Written back once, sanitised: a name an older build stored must not stay in this browser.
  useEffect(() => {
    writeList(LS_WATCHLIST, watchlist);
    writeList(LS_RECENT_TRADERS, recentTraders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (p.initialQuery) patch({ tab: 'home' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- focus: in on open, back as soon as it starts closing ------------- */
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (closing) {
      const prev = prevFocus.current;
      prevFocus.current = null;
      const a = document.activeElement as HTMLElement | null;
      if (!a || a === document.body || layerRef.current?.contains(a)) {
        if (prev && prev !== document.body && document.contains(prev)) prev.focus({ preventScroll: true });
        const still = document.activeElement as HTMLElement | null;
        if (still && layerRef.current?.contains(still)) still.blur();
      }
      return;
    }
    const a = document.activeElement as HTMLElement | null;
    if (!layerRef.current?.contains(a)) prevFocus.current = a;
    const focusInput = () => {
      const el = inputRef.current;
      const cur = document.activeElement;
      if (el && cur !== el && !(cur && cur !== document.body && layerRef.current?.contains(cur))) {
        el.focus({ preventScroll: true });
        const n = el.value.length;
        el.setSelectionRange(n, n);
      }
      // What was typed before the box had the focus goes in now, after the seed.
      flushTyped?.();
    };
    const raf = requestAnimationFrame(focusInput);
    const t = window.setTimeout(focusInput, 100);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [closing]);
  useEffect(() => () => {
    const prev = prevFocus.current;
    if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
  }, []);
  /* Where the keys typed ahead (typeAhead.ts) go: this dialog's box. Layout
     effect, so it is in place before the focus step above can run. */
  useLayoutEffect(() => {
    const box = inputRef.current;
    searchBox = box;
    flushTyped = () => {
      if (!typeAhead.active) return;
      const t = typeAhead.take();
      if (t.back || t.text) setQuery((q) => applyTyped(q, t));
    };
    return () => {
      if (searchBox === box) searchBox = null;
      flushTyped = null;
      typeAhead.cancel();
    };
  }, []);

  /* --- Cmd/Ctrl+K closes (App's own handler only opens) ---------------- */
  const onClose = p.onClose;
  useEffect(() => {
    if (closing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Escape' && !layerRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, closing]);

  /* --- what was typed --------------------------------------------------- */
  const text = query.trim();
  const addr = useMemo(() => {
    const direct = extractAddress(text);
    if (direct) return direct;
    const viaAlias = text ? resolveTarget(text) : null;
    return viaAlias ? viaAlias.toLowerCase() : null;
  }, [text]);
  const looked = useAddressVenues(addr);
  const poolQ = addr ?? text;

  /* --- venues: the pool part and the leaderboard part ------------------ */
  const pool = useMemo(() => poolToggles(venues), [venues]);
  const boardVs = useMemo(() => boardVenues(venues), [venues]);
  const inVenues = useCallback((v: Venue) => venues.includes(v), [venues]);

  /* --- data --------------------------------------------------------------- */
  const onHome = tab === 'home' && !text;
  const homeList = state.homeList;
  const listParams = useMemo(() => (pool ? listQuery(state.list, pool, { q: poolQ }) : null), [state.list, pool, poolQ]);
  const traders = useScreener(tab === 'traders' ? listParams : null, 50, { debounceMs: 180 });
  const tradersBoards = useVenueBoards(boardVs, '30d', 50, ready && tab === 'traders' && !text);
  // Home ignores the list filters (they live on Traders and Screener).
  const homeParams = useMemo(() => (pool ? listQuery(DEFAULT_LIST_FILTERS, pool, { q: poolQ }) : null), [pool, poolQ]);
  const homeSearch = useScreener(tab === 'home' && text ? homeParams : null, 12, { debounceMs: 180 });
  // Trending: each venue's own top, alternated (one mixed "top by PnL" is all Hyperliquid).
  const trendOn = onHome && homeList === 'trending';
  const trendQ = (v: 'sodex' | 'hyperliquid') =>
    listQuery(DEFAULT_LIST_FILTERS, { sodex: v === 'sodex', hyperliquid: v === 'hyperliquid' }, { sort: 'pnl', window: state.trend });
  const trendingSodex = useScreener(trendOn && inVenues('sodex') ? trendQ('sodex') : null, 12);
  const trendingHl = useScreener(trendOn && inVenues('hyperliquid') ? trendQ('hyperliquid') : null, 12);
  const trendBoards = useVenueBoards(boardVs, state.trend, 12, ready && trendOn);
  const scrWindow = effectiveSort(state.scr).window as BoardWindow;
  const screener = useScreener(
    tab === 'screener' && pool ? screenerQuery(state.scr, pool, { q: poolQ }) : null,
    100,
    { debounceMs: 180 },
  );
  const scrBoards = useVenueBoards(boardVs, scrWindow, 50, ready && tab === 'screener' && !text);
  const markets = useMarkets(ready && (tab === 'assets' || tab === 'home'));
  // Names and addresses on every venue's board (index boards cover all five).
  const lbExtras = useLeaderboardSearch(text, 'all', ready && (tab === 'traders' || tab === 'home') && !addr && !/^\d+$/.test(text));

  const trendingRows = useMemo(
    () => interleaveVenues([
      ...(inVenues('sodex') ? trendingSodex.rows : []),
      ...(inVenues('hyperliquid') ? trendingHl.rows : []),
      ...trendBoards.flatMap((b) => b.rows),
    ], 24),
    [trendingSodex.rows, trendingHl.rows, trendBoards, inVenues],
  );
  const trending: ScreenerState = useMemo(() => {
    const on = [inVenues('sodex') ? trendingSodex : null, inVenues('hyperliquid') ? trendingHl : null].filter((s): s is ScreenerState => !!s);
    const boardsLoading = trendBoards.some((b) => b.loading);
    return {
      rows: trendingRows as ScreenerState["rows"],
      meta: on.find((s) => s.meta)?.meta ?? (trendBoards.length && !boardsLoading ? ({} as ScreenerState['meta']) : null),
      loading: on.some((s) => s.loading) || boardsLoading,
      error: on.length && on.every((s) => s.error) && trendBoards.every((b) => b.error) ? on[0]!.error : null,
      hasMore: false,
      loadMore: () => {},
      retry: () => on.forEach((s) => s.retry()),
    };
  }, [trendingRows, trendingSodex, trendingHl, trendBoards, inVenues]);

  /* --- actions ------------------------------------------------------------ */
  const rememberSearch = useCallback(() => {
    if (!text || addr) return;
    setRecentSearches((l) => {
      const next = pushFront(l, text, (s) => s.toLowerCase(), 8);
      writeList(LS_RECENT_SEARCHES, next);
      return next;
    });
  }, [text, addr]);

  // Stored as venue, address and time only: the palette shows no names.
  const rememberTrader = useCallback((t: { venue: Venue; address: string }) => {
    setRecentTraders((l) => {
      const next = pushFront(l, { venue: t.venue, address: t.address.toLowerCase(), at: Date.now() }, traderKey, 8);
      writeList(LS_RECENT_TRADERS, next);
      return next;
    });
  }, []);

  const openTrader = useCallback(
    (t: { venue: Venue; address: string }) => {
      rememberSearch();
      rememberTrader(t);
      p.onOpenTrader(t.address, t.venue);
      p.onClose();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rememberSearch, rememberTrader, p.onOpenTrader, p.onClose],
  );

  const toggleWatch = (t: { venue: Venue; address: string }) => {
    setWatchlist((l) => {
      const k = traderKey(t);
      const next = l.some((x) => traderKey(x) === k)
        ? l.filter((x) => traderKey(x) !== k)
        : [{ venue: t.venue, address: t.address.toLowerCase(), at: Date.now() }, ...l].slice(0, 50);
      writeList(LS_WATCHLIST, next);
      return next;
    });
  };

  const selectAsset = (a: AssetRow) => {
    rememberSearch();
    if (a.engine) p.onSelectSymbol(a.engine, a.symbol);
    p.onClose();
  };

  const navigate = (t: Tab) => {
    p.onNavigate(t);
    p.onClose();
  };

  /** A view inside Explore: the URL first, then the page (a mounted Explore re-reads it on popstate). */
  const openExplorePath = (path: string) => {
    const wasExplore = window.location.pathname.replace(/\/+$/, '').toLowerCase() === '/explore';
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path);
    p.onNavigate('explore');
    if (wasExplore) window.dispatchEvent(new PopStateEvent('popstate'));
    p.onClose();
  };
  const openPage = (pg: (typeof PAGES)[number]) => (pg.path ? openExplorePath(pg.path) : navigate(pg.tab));

  const setVenues = (next: Venue[]) => {
    writeList(LS_VENUES, next);
    patch({ venues: next });
  };

  /* --- which rows each tab shows ----------------------------------------- */

  const addrActions = useMemo(() => {
    if (!addr) return [];
    if (looked.loading || !looked.cards) return [{ id: 'x:hold', run: () => {} }];
    return overviewCards(looked.cards).map((c) => ({ id: `x:open:${c.venue}`, run: () => openTrader({ venue: c.venue, address: addr }) }));
  }, [addr, looked.loading, looked.cards, openTrader]);

  const withExtras = (rows: AnyTrader[], max: number): AnyTrader[] => {
    const seen = new Set(rows.map((r) => traderKey(r)));
    const extra = lbExtras.filter((r) => !seen.has(traderKey(r)) && inVenues(r.venue)).slice(0, max);
    return [...rows, ...extra];
  };

  const tradersBoardsFiltered = useMemo(() => {
    const all = tradersBoards.map((b) => ({ b, ...boardListRows(b.rows, state.list) }));
    return { rows: all.flatMap((x) => x.rows), hiddenBy: all[0]?.hiddenBy ?? null };
  }, [tradersBoards, state.list]);
  const traderRows0: AnyTrader[] = useMemo(
    () => (text
      ? withExtras(traders.rows, 12)
      : mergeByPnl<AnyTrader>(traders.rows, tradersBoardsFiltered.rows, '30d', !pool || (!!traders.meta && !traders.hasMore))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [traders.rows, traders.meta, traders.hasMore, tradersBoardsFiltered, lbExtras, text, venues],
  );
  const homeTraderRows0: AnyTrader[] = useMemo(
    () => withExtras(homeSearch.rows, Math.max(0, 16 - homeSearch.rows.length)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [homeSearch.rows, lbExtras, venues],
  );
  const scrBoardsFiltered = useMemo(() => {
    const all = scrBoards.map((b) => boardScreenerRows(b.rows, state.scr));
    return { rows: all.flatMap((x) => x.rows), hiddenBy: all[0]?.hiddenBy ?? null };
  }, [scrBoards, state.scr]);

  // SoDEX markets only: the one venue this app trades on.
  const sodexOnly = useMemo(() => markets.rows.filter((r) => r.venue === 'sodex'), [markets.rows]);
  const SODEX = { sodex: true, hyperliquid: false };
  const assetRows = useMemo(
    () => sortAssets(filterAssets(sodexOnly, { category: state.assetCat, venues: SODEX, q: text, favorites: p.favorites }), state.assetSort.sort, state.assetSort.dir),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sodexOnly, state.assetCat, state.assetSort, text, p.favorites],
  );
  const homeAssets = useMemo(
    () => sortAssets(filterAssets(sodexOnly, { category: 'all', venues: SODEX, q: text, favorites: p.favorites }), 'volume', 'desc').slice(0, text ? 12 : 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sodexOnly, text, p.favorites],
  );
  const pageHits = useMemo(() => {
    const t = text.toLowerCase();
    if (t.length < 2 || addr) return [];
    return PAGES.filter((pg) => pg.label.toLowerCase().includes(t) || pg.words.split(' ').some((w) => w.startsWith(t)));
  }, [text, addr]);

  // Rows already loaded anywhere, so a watchlist entry can show live numbers.
  const known = useMemo(() => {
    const m = new Map<string, AnyTrader>();
    for (const r of [...trending.rows, ...traders.rows, ...screener.rows, ...homeSearch.rows, ...tradersBoards.flatMap((b) => b.rows)]) m.set(traderKey(r), r);
    return m;
  }, [trending.rows, traders.rows, screener.rows, homeSearch.rows, tradersBoards]);

  const stub = (t: TraderRef): AnyTrader =>
    known.get(traderKey(t)) ?? { venue: t.venue, address: t.address, label: null, accountValue: null, pnl: {}, roi: {}, volume: {} };

  // Traders are found by address only: the palette shows and searches no names.
  const traderRows = traderRows0;
  const homeTraderRows = homeTraderRows0;

  const homeWatch = !text ? watchlist.filter((t) => inVenues(t.venue)).slice(0, 50) : [];
  const homeRecent = !text ? recentTraders.filter((t) => inVenues(t.venue)).slice(0, 8) : [];
  const homeSearches = !text ? recentSearches.slice(0, 6) : [];
  const homeListRows: { prefix: string; row: AnyTrader }[] =
    homeList === 'watchlist' ? homeWatch.map((t) => ({ prefix: 'w', row: stub(t) }))
      : homeList === 'recent' ? homeRecent.map((t) => ({ prefix: 'r', row: stub(t) }))
        : trendingRows.map((r) => ({ prefix: 't', row: r }));
  const scrRows: AnyTrader[] = screener.rows;
  const scrBoardRows: AnyTrader[] = text ? [] : scrBoardsFiltered.rows;

  /* --- the navigable items, in render order ------------------------------ */
  const items: Item[] = useMemo(() => {
    const out: Item[] = addrActions.map((a) => ({ id: a.id, run: a.run }));
    const trader = (prefix: string, r: AnyTrader) => ({ id: `${prefix}:${traderKey(r)}`, run: () => openTrader(r) });
    const asset = (a: AssetRow) => ({ id: `a:${a.key}`, run: () => selectAsset(a) });
    const page = (pg: (typeof PAGES)[number]) => ({ id: `l:${pg.id}`, run: () => openPage(pg) });
    if (tab === 'home') {
      if (text) {
        out.push(...homeTraderRows.map((r) => trader('t', r)), ...pageHits.map(page), ...homeAssets.map(asset));
      } else {
        out.push(
          ...homeListRows.map((x) => trader(x.prefix, x.row)),
          ...homeSearches.map((s, i) => ({ id: `s:${i}`, run: () => setQuery(s) })),
          ...homeAssets.map(asset),
          ...PAGES.map(page),
        );
      }
    } else if (tab === 'traders') {
      out.push(...traderRows.map((r) => trader('t', r)));
    } else if (tab === 'screener') {
      out.push(...scrRows.map((r) => trader('g', r)), ...scrBoardRows.map((r) => trader('g', r)));
    } else {
      out.push(...assetRows.map(asset));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, text, homeList, addrActions, homeTraderRows, pageHits, homeAssets, watchlist, recentTraders, recentSearches, trendingRows, traderRows, scrRows, scrBoardRows, assetRows, known, venues]);

  /* --- active item ---------------------------------------------------------- */
  const [activeId, setActiveId] = useState<string | null>(null);
  const kbdMove = useRef(false);
  const picked = useRef(false);
  useEffect(() => {
    if (!items.length) {
      if (activeId !== null) setActiveId(null);
    } else if (!picked.current || !activeId || !items.some((i) => i.id === activeId)) {
      if (activeId !== items[0]!.id) setActiveId(items[0]!.id);
    }
  }, [items, activeId]);
  const pick = (id: string) => {
    picked.current = true;
    setActiveId((cur) => (cur === id ? cur : id));
  };

  const firstAddrAction = addrActions[0]?.id ?? null;
  useEffect(() => {
    if (firstAddrAction) setActiveId(firstAddrAction);
  }, [firstAddrAction]);

  useEffect(() => {
    if (!kbdMove.current || !activeId || !host) return;
    kbdMove.current = false;
    host.querySelector(`[data-nav-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, host]);

  const nav = (id: string, run: () => void): NavProps => ({ navId: id, active: id === activeId, onHover: pick, onRun: run });

  const current = tab === 'traders' ? traders : tab === 'screener' ? screener : null;

  const move = (delta: number) => {
    if (!items.length) return;
    const i = items.findIndex((x) => x.id === activeId);
    const next = Math.max(0, Math.min(items.length - 1, (i < 0 ? -1 : i) + delta));
    kbdMove.current = true;
    pointerAt.current = null;
    pick(items[next]!.id);
    if (next >= items.length - 3) current?.loadMore();
  };

  const scrollListsToTop = () => {
    mainRef.current?.querySelectorAll<HTMLElement>('.cp-scroll').forEach((el) => { el.scrollTop = 0; });
  };

  const switchTab = (t: PaletteTab) => {
    if (t === tab) return;
    patch({ tab: t });
    picked.current = false;
    setActiveId(null);
  };

  useEffect(() => {
    picked.current = false;
    scrollListsToTop();
  }, [tab, text, state.list, state.scr, venues, state.assetCat, state.assetSort, state.trend, state.homeList]);

  const tabInk = useInk(tabsRef, tab);

  /* --- keyboard --------------------------------------------------------------- */
  const trapFocus = (e: KeyboardEvent) => {
    if (!host) return;
    const els = Array.from(
      host.querySelectorAll<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0]!;
    const last = els[els.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (closing) return;
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const inInput = target === inputRef.current;
    if (e.key === 'Escape') {
      e.preventDefault();
      p.onClose();
      return;
    }
    if ((e.altKey || e.ctrlKey) && !e.metaKey && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      switchTab(PALETTE_TABS[Number(e.key) - 1]!);
      return;
    }
    if (e.key === 'Tab') {
      if (inInput) {
        e.preventDefault();
        switchTab(cycleTab(tab, e.shiftKey ? -1 : 1));
      } else {
        trapFocus(e);
      }
      return;
    }
    const onControl = !inInput && (target.tagName === 'BUTTON' || target.tagName === 'SELECT');
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        move(e.key === 'PageDown' ? 8 : -8);
        return;
      case 'Enter':
        if (onControl) return;
        e.preventDefault();
        items.find((x) => x.id === activeId)?.run();
        return;
      default:
    }
    if (!inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'Backspace') {
        e.preventDefault();
        setQuery((q) => q.slice(0, -1));
        inputRef.current?.focus();
      } else if (e.key.length === 1 && !(onControl && e.key === ' ')) {
        e.preventDefault();
        setQuery((q) => q + e.key);
        inputRef.current?.focus();
      }
    }
  };

  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const scrollRaf = useRef(0);
  const rowUnderPointer = () => {
    const at = pointerAt.current;
    if (!at) return;
    const hit = document.elementFromPoint(at.x, at.y);
    const id = (hit?.closest('[data-nav-id]') as HTMLElement | null)?.dataset.navId;
    if (id && mainRef.current?.contains(hit)) pick(id);
  };
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(rowUnderPointer);
    const el = e.target as HTMLElement;
    if (!current || !el.hasAttribute('data-paged')) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) current.loadMore();
  };

  /* --- filters ------------------------------------------------------------ */
  const setList = (u: Partial<ListFilters>) => patch({ list: { ...state.list, ...u } });
  const setScr = (u: Partial<ScreenerFilters>) => patch({ scr: { ...state.scr, ...u } });
  const scrEff = effectiveSort(state.scr);
  const activeSort = screener.meta?.sort ?? scrEff.sort;

  const winPop = (id: string, value: number | null, set: (v: number | null) => void) => (
    <FilterPop
      id={id}
      label="Win rate"
      value={value === null ? 'Any' : `≥ ${value}%`}
      active={value !== null}
      title="Minimum win rate"
      onReset={() => set(null)}
    >
      <FieldLabel aside={<span className="cp-num">{value === null ? 'Any' : `${value}%`}</span>}>Win rate at least</FieldLabel>
      <RangeField value={value} onChange={set} label="Minimum win rate" tint={value === null ? undefined : winTintColor(value, 100) ?? 'var(--muted)'} />
      <QuickOptions label="Quick win rates" options={WIN_QUICK} value={value} onChange={set} columns={4} />
      <p className="cp-fpop__note">Share of closed trades that made money. Estimates (≈) count as values; a trader with fewer than 10 closes held has none yet.</p>
    </FilterPop>
  );

  const listFilters = (
    <div className="cp-row-ctl cp-filters">
      {winPop('f-win', state.list.minWinRate, (v) => setList({ minWinRate: v }))}
      <FilterPop
        id="f-vol"
        label="Volume"
        value={state.list.minVolume === null ? 'Any' : `≥ ${fmtUsdCompact(state.list.minVolume)} · ${WINDOW_LABEL[state.list.volWindow] ?? state.list.volWindow}`}
        active={state.list.minVolume !== null}
        title="Minimum volume"
        onReset={() => setList({ minVolume: null, volWindow: '1d' })}
      >
        <FieldLabel aside={<Seg size="sm" label="Volume window" value={(state.list.volWindow as '1d' | '7d' | '30d')} onChange={(w) => setList({ volWindow: w })} options={VOL_WINDOWS} />}>Traded at least</FieldLabel>
        <AmountField value={state.list.minVolume} onChange={(v) => setList({ minVolume: v })} label="Minimum volume" />
        <QuickOptions label="Quick volumes" options={VOL_QUICK} value={state.list.minVolume} onChange={(v) => setList({ minVolume: v })} columns={4} />
      </FilterPop>
      <FilterPop
        id="f-strat"
        label="Strategy"
        value={STRATEGY_QUICK.find((o) => o.value === state.list.strategy)?.label ?? 'Any'}
        active={state.list.strategy !== null}
        title="How they trade"
        onReset={() => setList({ strategy: null })}
        width={300}
      >
        <QuickOptions label="Strategy" options={STRATEGY_QUICK} value={state.list.strategy} onChange={(v) => setList({ strategy: v })} columns={2} />
      </FilterPop>
      <FilterPop
        id="f-active"
        label="Last active"
        value={state.list.active === null ? 'Any' : ACTIVE_WORD[state.list.active]}
        active={state.list.active !== null}
        title="Traded within"
        onReset={() => setList({ active: null })}
        width={260}
      >
        <QuickOptions label="Last active" options={ACTIVE_QUICK} value={state.list.active} onChange={(v) => setList({ active: v })} columns={1} />
      </FilterPop>
      {isListFiltered(state.list) && (
        <button type="button" className="cp-linkbtn" onClick={() => patch({ list: DEFAULT_LIST_FILTERS })}>Reset all</button>
      )}
    </div>
  );

  const screenerFilters = (
    <div className="cp-row-ctl cp-filters">
      {winPop('s-win', state.scr.minWinRate, (v) => setScr({ minWinRate: v }))}
      <FilterPop
        id="s-vol"
        label="Volume 24h"
        value={state.scr.minVolume === null ? 'Any' : `≥ ${fmtUsdCompact(state.scr.minVolume)}`}
        active={state.scr.minVolume !== null}
        title="Minimum 24h volume"
        onReset={() => setScr({ minVolume: null })}
      >
        <AmountField value={state.scr.minVolume} onChange={(v) => setScr({ minVolume: v, volWindow: '1d' })} label="Minimum 24h volume" />
        <QuickOptions label="Quick volumes" options={VOL_QUICK} value={state.scr.minVolume} onChange={(v) => setScr({ minVolume: v, volWindow: '1d' })} columns={4} />
      </FilterPop>
      <FilterPop
        id="s-av"
        label="Account value"
        value={state.scr.minAccountValue === null ? 'Any' : `≥ ${fmtUsdCompact(state.scr.minAccountValue)}`}
        active={state.scr.minAccountValue !== null}
        title="Minimum account value"
        onReset={() => setScr({ minAccountValue: null })}
      >
        <AmountField value={state.scr.minAccountValue} onChange={(v) => setScr({ minAccountValue: v })} label="Minimum account value" />
        <QuickOptions label="Quick account values" options={AV_QUICK} value={state.scr.minAccountValue} onChange={(v) => setScr({ minAccountValue: v })} columns={4} />
      </FilterPop>
      <FilterPop
        id="s-roi"
        label={`ROI ${WINDOW_LABEL[scrEff.window] ?? scrEff.window}`}
        value={state.scr.minRoi === null ? 'Any' : `≥ ${state.scr.minRoi}%`}
        active={state.scr.minRoi !== null}
        title={`Minimum ROI (${WINDOW_LABEL[scrEff.window] ?? scrEff.window})`}
        onReset={() => setScr({ minRoi: null })}
        width={300}
      >
        <AmountField value={state.scr.minRoi} onChange={(v) => setScr({ minRoi: v })} label="Minimum ROI" prefix="" suffix="%" />
        <QuickOptions label="Quick ROI" options={ROI_QUICK} value={state.scr.minRoi} onChange={(v) => setScr({ minRoi: v })} columns={5} />
      </FilterPop>
      <span className="cp-row-ctl__end">
        <span className="cp-count">
          <span className="cp-count__n cp-num">{countLabel(screener, scrBoardRows.length)}</span>
          {screener.meta && <span className="cp-count__meta">updated {fmtAgo(screener.meta.updatedAt, now)}</span>}
        </span>
        <Seg
          size="sm"
          label="Sort by"
          value={activeSort}
          onChange={sortBy}
          options={SORT_CHIPS.map((s) => ({ id: s.id, label: `${s.label}${activeSort === s.id && state.scr.dir === 'asc' ? ' ↑' : ''}` }))}
        />
      </span>
    </div>
  );

  /* --- render ------------------------------------------------------------------ */
  const listRow = (prefix: string, r: AnyTrader, o: { window?: '1d' | '7d' | '30d'; subtitle?: ReactNode } = {}) => {
    const id = `${prefix}:${traderKey(r)}`;
    return (
      <TraderListRow
        key={id}
        row={r}
        nav={nav(id, () => openTrader(r))}
        watched={watched.has(traderKey(r))}
        onToggleWatch={() => toggleWatch(r)}
        window={o.window}
        subtitle={o.subtitle}
      />
    );
  };

  const addressChoices = looked.cards ? overviewCards(looked.cards) : [];
  const addressLead = looked.cards ? overviewLead(looked.cards) : null;
  const addressBlock = !!addr && (
    <div className="cp-addr cp-scroll" role="group" aria-label="Address">
      {(looked.loading || !looked.cards) && (
        <p className="cp-addr__status" data-nav-id="x:hold"><span className="cp-addr__dot cp-shimmer" aria-hidden="true" />{VENUE_CHECK}</p>
      )}
      {addressLead && looked.cards && (
        <VenueChooser
          cards={addressChoices}
          lead={addressLead}
          activeVenue={activeId?.startsWith('x:open:') ? (activeId.slice('x:open:'.length) as Venue) : null}
          onHover={(v) => pick(`x:open:${v}`)}
          onPick={(v) => openTrader({ venue: v, address: addr })}
        />
      )}
    </div>
  );

  const compactAsset = (a: AssetRow) => (
    <NavRow key={a.key} {...nav(`a:${a.key}`, () => selectAsset(a))} className="cp-row cp-row--asset">
      <AssetMark a={a} size={28} />
      <div className="cp-row__main">
        <div className="cp-row__title"><span className="cp-row__name">{a.display}</span></div>
        <div className="cp-row__sub"><span>{marketKind(a)}</span></div>
      </div>
      <span className="cp-fig cp-fig--price">
        <span className={`cp-fig__v cp-num ${isMissing(fmtPriceAuto(a.price)) ? 'cp-na' : ''}`}>{fmtPriceAuto(a.price)}</span>
        <span className={`cp-fig__k cp-num cp-fig__k--chg ${isMissing(fmtChangePct(a.changePct)) ? 'cp-na' : signOf(a.changePct)}`}>{fmtChangePct(a.changePct)}</span>
      </span>
    </NavRow>
  );

  const pageRow = (pg: (typeof PAGES)[number]) => (
    <NavRow key={pg.id} {...nav(`l:${pg.id}`, () => openPage(pg))} className="cp-row cp-row--asset">
      <span className="cp-page__icon">{pg.icon}</span>
      <div className="cp-row__main">
        <div className="cp-row__title"><span className="cp-row__name">{pg.label}</span></div>
        <div className="cp-row__sub"><span>{pg.hint}</span></div>
      </div>
    </NavRow>
  );

  const clearSearches = () => { setRecentSearches([]); writeList(LS_RECENT_SEARCHES, []); };

  /** Honest lines for the leaderboard venues: no ranking, failed, or hidden by a filter. */
  const boardNotes = (states: readonly BoardState[], hiddenBy: HiddenBy, win: string) => {
    if (!states.length) return null;
    if (hiddenBy) {
      const vs = states.map((s) => s.venue);
      const names = venueList(vs.map((v) => VENUE_LABEL[v]));
      return (
        <VenueNote venues={vs}>
          {hiddenBy === 'preset'
            ? `${names} are left out of presets, which rank the screener's SoDEX and Hyperliquid pool. Choose All to see them.`
            : `${names} are left out: their leaderboard rows carry no ${hiddenBy}.`}
        </VenueNote>
      );
    }
    return states.map((s) => {
      if (s.error) return <VenueNote key={s.venue} venues={[s.venue]}>{VENUE_LABEL[s.venue]} couldn't load.</VenueNote>;
      if (!s.loading && !s.rows.length) return <VenueNote key={s.venue} venues={[s.venue]}>{VENUE_LABEL[s.venue]} has no {win} ranking yet.</VenueNote>;
      return null;
    });
  };

  let main: ReactNode = null;
  let thead: ReactNode = null;
  if (!ready) {
    main = null;
  } else if (tab === 'home') {
    main = text ? (
      <div className="cp-results">
        {addressBlock}
        <div className={`cp-split${addr ? ' is-single' : ''}`}>
          <Panel title="Traders" icon={<IconTraders />} meta={homeTraderRows.length ? <span className="cp-num">{homeTraderRows.length}</span> : null} scroll className="cp-panel--list" bodyClass="cp-cq">
            {homeTraderRows.map((r) => listRow('t', r))}
            {!homeTraderRows.length && (homeSearch.error
              ? <LoadFailed what="Traders" onRetry={homeSearch.retry} className="cp-failed" />
              : homeSearch.loading ? <SkeletonRows n={4} />
                : <EmptyState title="No traders found">Nothing on {venues.length === PALETTE_VENUES.length ? 'any venue' : venueList(venues.map((v) => VENUE_LABEL[v]))} matches “{text}”.</EmptyState>)}
          </Panel>
          {!addr && (
            <div className="cp-col">
              {pageHits.length > 0 && (
                <Panel title="Pages" icon={<IconCompass />} className="cp-panel--pagehits">
                  {pageHits.map(pageRow)}
                </Panel>
              )}
              <Panel title="Markets" icon={<IconAssets />} meta="SoDEX" scroll className="cp-panel--list">
                {homeAssets.map(compactAsset)}
                {!homeAssets.length && <MarketsState m={markets} title="No markets found" empty={`No SoDEX market matches “${text}”.`} rows={3} />}
              </Panel>
            </div>
          )}
        </div>
      </div>
    ) : (
      <div className="cp-home">
        <div className="cp-home__col cp-home__col--left">
          <Panel
            title={homeList === 'watchlist' ? 'Watchlist' : homeList === 'recent' ? 'Recently viewed' : 'Trending'}
            icon={homeList === 'watchlist' ? <IconEye /> : homeList === 'recent' ? <IconClock /> : <IconFlame />}
            scroll
            className="cp-panel--list cp-panel--traders"
            bodyClass="cp-cq"
            meta={homeList === 'trending' ? (
              <span className="cp-wtoggle" role="group" aria-label="Trending window">
                {(['1d', '7d'] as const).map((w) => (
                  <button key={w} type="button" className={state.trend === w ? 'is-on' : ''} aria-pressed={state.trend === w} onClick={() => patch({ trend: w })}>
                    {w === '1d' ? '24h' : '7D'}
                  </button>
                ))}
              </span>
            ) : null}
            right={
              <Seg
                size="sm"
                label="Trader list"
                value={homeList}
                onChange={(v) => { patch({ homeList: v }); setActiveId(null); }}
                options={[
                  { id: 'trending', label: 'Trending' },
                  { id: 'watchlist', label: 'Watchlist', count: homeWatch.length },
                  { id: 'recent', label: 'Recent', count: homeRecent.length },
                ]}
              />
            }
          >
            <FadeView viewKey={`${homeList}:${state.trend}`} className="cp-fade">
              {homeList === 'trending' && trendingRows.map((r) => listRow('t', r, { window: state.trend }))}
              {homeList === 'trending' && !trendingRows.length && (
                <StateLine s={trending} empty="No trader on the chosen venues has a ranking for this window." />
              )}
              {homeList === 'trending' && boardNotes(trendBoards, null, WINDOW_LABEL[state.trend]!)}
              {homeList === 'watchlist' && homeWatch.map((t) => listRow('w', stub(t)))}
              {homeList === 'watchlist' && !homeWatch.length && (
                <EmptyState title="No traders watched yet">Press + on any trader to keep them here.</EmptyState>
              )}
              {homeList === 'recent' && homeRecent.map((t) => listRow('r', stub(t), {
                subtitle: <><span>{VENUE_LABEL[t.venue]}</span><span className="cp-dot">·</span><span>viewed {fmtAgo(t.at, now)}</span></>,
              }))}
              {homeList === 'recent' && !homeRecent.length && (
                <EmptyState title="Nothing viewed yet">Traders you open from search show up here.</EmptyState>
              )}
            </FadeView>
          </Panel>
          {homeSearches.length > 0 && (
            <div className="cp-recent" role="group" aria-label="Recent searches">
              <span className="cp-recent__k"><IconClock size={14} />Recent</span>
              <span className="cp-recent__list">
                {homeSearches.map((s, i) => (
                  <NavRow key={`s:${i}`} {...nav(`s:${i}`, () => setQuery(s))} className="cp-rchip">
                    <IconSearch size={12} />
                    <span className="cp-rchip__t">{s}</span>
                  </NavRow>
                ))}
              </span>
              <button type="button" className="cp-linkbtn" onClick={clearSearches}>Clear</button>
            </div>
          )}
        </div>
        <div className="cp-home__col cp-home__col--right">
          <MarketHeatmap
            enabled={onHome}
            onAsset={(coin) => openExplorePath(cohortAssetPath(coin))}
            onOpenMap={() => openExplorePath(MARKET_MAP_PATH)}
          />
          <Panel
            title="Top markets"
            icon={<IconAssets />}
            meta="SoDEX · 24h volume"
            scroll
            className="cp-panel--list cp-panel--assets"
            right={<button type="button" className="cp-linkbtn" onClick={() => switchTab('assets')}>All</button>}
          >
            {homeAssets.map(compactAsset)}
            {!homeAssets.length && <MarketsState m={markets} title="No markets" empty="No SoDEX market is trading right now." rows={4} />}
          </Panel>
          <nav className="cp-pages" aria-label="Pages">
            {PAGES.map((pg) => (
              <NavRow key={pg.id} {...nav(`l:${pg.id}`, () => openPage(pg))} className="cp-page" title={pg.hint}>
                <span className="cp-page__icon">{pg.icon}</span>
                <span className="cp-page__t">{pg.label}</span>
              </NavRow>
            ))}
          </nav>
        </div>
      </div>
    );
  } else if (tab === 'traders') {
    const total = (traders.meta?.total ?? 0) + (text ? 0 : tradersBoardsFiltered.rows.length);
    main = (
      <div className="cp-results">
        {addressBlock}
        <div className="cp-scroll cp-list cp-cq" data-paged="">
          {traderRows.length > 0 && (
            <div className="cp-listhead">
              <span className="cp-listhead__n cp-num">{total > traderRows.length ? `${traderRows.length.toLocaleString('en-US')}+` : traderRows.length.toLocaleString('en-US')} traders</span>
              <span className="cp-listhead__d">
                sorted by 30D PnL
                {traders.meta ? ` · ${traders.meta.enrichedCount.toLocaleString('en-US')} of ${traders.meta.poolSize.toLocaleString('en-US')} read in detail` : ''}
              </span>
            </div>
          )}
          {traderRows.map((r) => listRow('t', r))}
          {!traderRows.length && (pool || tradersBoards.some((b) => b.loading)) && (
            <StateLine s={pool ? traders : { ...traders, loading: true, meta: null }} empty={emptyTraders(text, state.list)} onClear={() => patch({ list: DEFAULT_LIST_FILTERS })} />
          )}
          {traders.loading && traderRows.length > 0 && <SkeletonRows n={2} />}
          {!text && boardNotes(tradersBoards, tradersBoardsFiltered.hiddenBy, '30D')}
        </div>
      </div>
    );
  } else if (tab === 'screener') {
    const eff = { ...effectiveSort(state.scr), ...(screener.meta ? { sort: screener.meta.sort, window: screener.meta.window } : {}) };
    const win = WINDOW_LABEL[eff.window] ?? eff.window;
    const head = (id: ScreenerSort, label: string, cls: string) => (
      <div
        role="columnheader"
        className={`cp-gcell ${cls}${eff.sort === id ? ' is-sorted' : ''}`}
        aria-sort={eff.sort === id ? (state.scr.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className="cp-headbtn" onClick={() => sortBy(id)}>{label}{eff.sort === id ? (state.scr.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
      </div>
    );
    thead = (
      <div role="row" className="cp-ghead">
        <div role="columnheader" className="cp-gcell cp-gcell--lead">Trader</div>
        {head('winRate', 'Win rate', 'cp-gcell--win')}
        {head('volume', '24h volume', 'cp-gcell--vol')}
        {head('accountValue', 'Account value', 'cp-gcell--av')}
        {head('roi', `ROI ${win}`, 'cp-gcell--pnl')}
        {head('lastActive', 'Last active', 'cp-gcell--active')}
      </div>
    );
    const boardNames = venueList(boardVs.map((v) => VENUE_LABEL[v]));
    main = (
      <div className="cp-results cp-results--table cp-results--screener">
        {addressBlock}
        <div role="rowgroup" className="cp-thead">{thead}</div>
        <div className="cp-scroll cp-table" role="rowgroup" data-paged="">
          {scrRows.map((r) => (
            <ScreenerTableRow key={`g:${traderKey(r)}`} row={r} nav={nav(`g:${traderKey(r)}`, () => openTrader(r))} now={now} window={eff.window} volWindow={screener.meta?.volWindow ?? '1d'} />
          ))}
          {pool && !scrRows.length && <StateLine s={screener} empty={emptyScreener(state.scr)} onClear={() => patch({ scr: DEFAULT_SCREENER_FILTERS })} />}
          {screener.loading && scrRows.length > 0 && <SkeletonRows n={2} />}
          {!text && boardVs.length > 0 && (
            <>
              {scrBoardRows.length > 0 && (
                <div role="row" className="cp-gsep">
                  <div role="gridcell">{boardNames} <span className="cp-gsep__d">· from their leaderboards, no win rate or activity</span></div>
                </div>
              )}
              {scrBoardRows.map((r) => (
                <ScreenerTableRow key={`g:${traderKey(r)}`} row={r} nav={nav(`g:${traderKey(r)}`, () => openTrader(r))} now={now} window={eff.window} volWindow={state.scr.volWindow} />
              ))}
              {boardNotes(scrBoards, scrBoardsFiltered.hiddenBy, win)}
            </>
          )}
        </div>
      </div>
    );
  } else {
    thead = (
      <div role="row" className="cp-ghead">
        <div role="columnheader" className="cp-gcell cp-gcell--lead">Market</div>
        {assetHead('price', 'Price', 'cp-gcell--price')}
        {assetHead('change', '24h change', 'cp-gcell--chg')}
        {assetHead('volume', '24h volume', 'cp-gcell--vol')}
        {assetHead('positioning', 'Top traders', 'cp-gcell--pos')}
      </div>
    );
    main = (
      <div className="cp-results cp-results--table cp-results--assets">
        <div role="rowgroup" className="cp-thead">{thead}</div>
        <div className="cp-scroll cp-table" role="rowgroup">
          {assetRows.map((a) => {
            const fav = p.favorites.includes(a.key);
            const price = fmtPriceAuto(a.price);
            const chg = fmtChangePct(a.changePct);
            const vol = fmtUsdCompact(a.volume24h);
            return (
              <NavRow key={a.key} {...nav(`a:${a.key}`, () => selectAsset(a))} className="cp-grow" role="row">
                <div role="gridcell" className="cp-gcell cp-gcell--lead">
                  <button
                    type="button"
                    className={`cp-star${!hideFavs && fav ? ' is-on' : ''}`}
                    aria-label={fav ? `Remove ${a.display} from favorites` : `Add ${a.display} to favorites`}
                    aria-pressed={fav}
                    onClick={(e) => { e.stopPropagation(); p.onToggleFavorite(a.key); }}
                  >
                    <IconStar filled={!hideFavs && fav} size={14} />
                  </button>
                  <AssetMark a={a} size={30} />
                  <div className="cp-gcell__text">
                    <div className="cp-row__title"><span className="cp-row__name">{a.display}</span></div>
                    <div className="cp-row__sub">{marketKind(a)}</div>
                  </div>
                </div>
                <div role="gridcell" className={`cp-gcell cp-num cp-gcell--price ${isMissing(price) ? 'cp-na' : ''}`}>{price}</div>
                <div role="gridcell" className={`cp-gcell cp-num cp-gcell--chg ${isMissing(chg) ? 'cp-na' : signOf(a.changePct)}`}>{chg}</div>
                <div role="gridcell" className={`cp-gcell cp-num cp-gcell--vol ${isMissing(vol) ? 'cp-na' : ''}`}>{vol}</div>
                <div role="gridcell" className="cp-gcell cp-gcell--pos"><LongShortBar share={a.longShare} traders={a.traders} /></div>
              </NavRow>
            );
          })}
          {!assetRows.length && (
            <MarketsState
              m={markets}
              title={state.assetCat === 'favorites' ? 'No favorites yet' : 'No markets found'}
              empty={state.assetCat === 'favorites' ? 'Star a market to keep it here.' : 'No SoDEX market matches this search and filter.'}
              rows={8}
            />
          )}
        </div>
      </div>
    );
  }

  function sortBy(id: ScreenerSort) {
    const eff = effectiveSort(state.scr);
    if (eff.sort === id) setScr({ sort: id, window: eff.window, dir: state.scr.dir === 'desc' ? 'asc' : 'desc' });
    else setScr({ sort: id, window: eff.window, dir: 'desc' });
  }

  function assetHead(id: AssetSort, label: string, cls: string) {
    const on = state.assetSort.sort === id;
    return (
      <div role="columnheader" className={`cp-gcell ${cls}${on ? ' is-sorted' : ''}`} aria-sort={on ? (state.assetSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="cp-headbtn" onClick={() => sortAsset(id)}>{label}{on ? (state.assetSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
      </div>
    );
  }

  function sortAsset(id: AssetSort) {
    const on = state.assetSort.sort === id;
    patch({ assetSort: { sort: id, dir: on && state.assetSort.dir === 'desc' ? 'asc' : 'desc' } });
  }

  const onDialogAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (closing && e.target === e.currentTarget) p.onExited?.();
  };
  const isTable = tab === 'screener' || tab === 'assets';
  const viewKey = tab === 'home' ? (text ? 'home:search' : 'home') : tab;

  return (
    <div
      ref={setLayerEl}
      className={`cp-layer${closing ? ' is-closing' : ''}`}
      style={vvBox ? { top: vvBox.top, left: vvBox.left, width: vvBox.width, height: vvBox.height, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div className="cp-scrim" aria-hidden="true" onMouseDown={() => { if (!closing) p.onClose(); }} />
      <div
        ref={setDialog}
        className={`cp${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Search traders and markets"
        onKeyDown={onKeyDown}
        onAnimationEnd={onDialogAnimationEnd}
      >
        <HostContext.Provider value={layer}>
          <div className="cp-head">
            <div className="cp-search">
              <span className="cp-search__icon"><IconSearch size={18} /></span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search traders, markets, pages or addresses"
                aria-label="Search traders, markets, pages or addresses"
                role="combobox"
                aria-expanded="true"
                aria-controls="cp-main"
                aria-activedescendant={activeId ? `cp-opt-${activeId}` : undefined}
                aria-autocomplete="list"
                spellCheck={false}
                autoComplete="off"
              />
              {query && (
                <button type="button" className="cp-clear" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>Clear</button>
              )}
              <span className="cp-search__esc"><Kbd>Esc</Kbd></span>
              <button type="button" className="cp-close" aria-label="Close search" onClick={p.onClose}><IconClose /></button>
            </div>

            <div className="cp-nav">
              <div className="cp-tabs" role="tablist" aria-label="Search sections" ref={tabsRef}>
                {PALETTE_TABS.map((t, i) => {
                  const Icon = TAB_ICON[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      id={`cp-tab-${t}`}
                      aria-selected={tab === t}
                      aria-controls="cp-main"
                      tabIndex={tab === t ? 0 : -1}
                      className={tab === t ? 'is-on' : ''}
                      onClick={() => switchTab(t)}
                      title={`${TAB_LABEL[t]} (Alt+${i + 1})`}
                    >
                      <Icon />
                      <span>{TAB_LABEL[t]}</span>
                    </button>
                  );
                })}
                <Ink ink={tabInk} />
              </div>
              {tab !== 'assets' && (
                <span className="cp-venues" role="group" aria-label="Venues">
                  {PALETTE_VENUES.map((v) => (
                    <VenueChip key={v} venue={v} on={venues.includes(v)} last={venues.length === 1} onToggle={() => setVenues(toggleVenueIn(venues, v))} />
                  ))}
                </span>
              )}
              {tab === 'assets' && <span className="cp-nav__note">Markets on SoDEX, where Valuescan trades</span>}
            </div>

            {tab === 'screener' && (
              <div className="cp-row-ctl cp-presets" role="group" aria-label="Presets">
                {PRESET_CHIPS.map((c) => {
                  const Icon = c.icon;
                  const on = state.scr.preset === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`cp-chip${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      title={c.hint}
                      onClick={() => setScr({ preset: c.id, sort: null, window: '30d', dir: 'desc' })}
                    >
                      <Icon />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
            {tab === 'traders' && listFilters}
            {tab === 'screener' && screenerFilters}
            {tab === 'assets' && (
              <div className="cp-row-ctl cp-filters">
                <Seg size="sm" label="Market type" value={state.assetCat} onChange={(c) => patch({ assetCat: c })} options={ASSET_CATS} />
                <span className="cp-row-ctl__end">
                  <span className="cp-count"><span className="cp-count__n cp-num">{assetRows.length.toLocaleString('en-US')} markets</span></span>
                  <Seg
                    size="sm"
                    label="Sort by"
                    value={state.assetSort.sort}
                    onChange={sortAsset}
                    options={ASSET_SORTS.map((s) => ({ id: s.id, label: `${s.label}${state.assetSort.sort === s.id && state.assetSort.dir === 'asc' ? ' ↑' : ''}` }))}
                  />
                </span>
              </div>
            )}
          </div>

          <div
            id="cp-main"
            ref={mainRef}
            className={`cp-main cp-main--${tab}${tab === 'home' && text ? ' is-search' : ''}`}
            role={isTable ? 'grid' : 'listbox'}
            aria-labelledby={`cp-tab-${tab}`}
            onScrollCapture={onListScroll}
            onMouseMove={(e) => { pointerAt.current = { x: e.clientX, y: e.clientY }; }}
            onWheel={(e) => { pointerAt.current = { x: e.clientX, y: e.clientY }; }}
            onMouseLeave={() => { pointerAt.current = null; }}
          >
            <Freeze frozen={closing}>
              {ready && <FadeView viewKey={viewKey} className="cp-view">{main}</FadeView>}
            </Freeze>
          </div>

          <div className="cp-foot" aria-hidden="true">
            <span className="cp-foot__k"><Kbd>↑</Kbd><Kbd>↓</Kbd>Move</span>
            <span className="cp-foot__k"><Kbd>↵</Kbd>Open</span>
            <span className="cp-foot__k"><Kbd>Tab</Kbd>Next section</span>
            <span className="cp-foot__k"><Kbd>Esc</Kbd>Close</span>
            <span className="cp-foot__end">Traders on five venues · markets on SoDEX</span>
          </div>
        </HostContext.Provider>
      </div>
    </div>
  );
}

/* ===========================================================================
 *  Small helpers
 * ======================================================================== */

function isListFiltered(f: ListFilters): boolean {
  return f.minWinRate !== DEFAULT_LIST_FILTERS.minWinRate
    || f.minVolume !== DEFAULT_LIST_FILTERS.minVolume
    || f.strategy !== DEFAULT_LIST_FILTERS.strategy
    || f.active !== DEFAULT_LIST_FILTERS.active;
}

function countLabel(s: ScreenerState, extra = 0): string {
  if (!s.meta) return extra ? `${extra} traders` : s.loading ? 'Loading traders…' : '—';
  const n = s.meta.total + extra;
  const shown = s.rows.length + extra;
  return `${n > shown ? `${shown.toLocaleString('en-US')}+` : n.toLocaleString('en-US')} trader${n === 1 ? '' : 's'}`;
}

function emptyTraders(text: string, f: ListFilters): string {
  if (text) return `Nothing on the chosen venues matches “${text}”.`;
  if (f.minWinRate !== null || f.active !== null) {
    return 'Win rate and last-active filters only match traders whose profile has been read; more are read every minute.';
  }
  return 'Loosen a filter or switch another venue on.';
}

function emptyScreener(f: ScreenerFilters): string {
  if (f.preset === 'high-winrate' || f.preset === 'low-drawdown' || f.minWinRate !== null) {
    return 'Win rate and drawdown are read in the background, a few traders a minute; this list fills in as they are.';
  }
  return 'Loosen a filter or switch another venue on.';
}

function MarketsState({ m, title, empty, rows }: { m: { loading: boolean; error: string | null }; title: string; empty: string; rows: number }) {
  if (m.error) return <LoadFailed what="Markets" className="cp-failed" />;
  if (m.loading) return <SkeletonRows n={rows} />;
  return <EmptyState title={title}>{empty}</EmptyState>;
}

function StateLine({ s, empty, onClear }: { s: ScreenerState; empty: string; onClear?: () => void }) {
  if (s.error) return <LoadFailed what="Traders" onRetry={s.retry} className="cp-failed" />;
  if (s.loading || !s.meta) return <SkeletonRows n={5} />;
  return (
    <EmptyState
      title="No traders match"
      action={onClear && <button type="button" className="cp-linkbtn" onClick={onClear}>Clear filters</button>}
    >
      {empty}
    </EmptyState>
  );
}

