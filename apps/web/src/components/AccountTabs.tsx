/**
 * ============================================================================
 *  THE ACCOUNT BAND - every account view the terminal has, behind one tab bar.
 * ============================================================================
 *
 * Both the trade page and the portfolio mount THIS, so "your open orders" is
 * one element on both. It is page-agnostic: it takes the account props the
 * tables need plus the handful of things a page may or may not know.
 *
 * WHAT IS OPTIONAL, AND WHY EACH ONE IS
 * -------------------------------------
 *   positionCount / orderCount   The trade page lifts these counts to App.tsx so
 *                                the tab LABEL can carry them; the portfolio
 *                                does not, and its labels carry no count.
 *   onPositionCount/onOrderCount The other half of that loop.
 *   accountScope                 The PORTFOLIO's shape: tables that exist on
 *                                both engines carry a Spot / Perps switch, the
 *                                perps-only views are always perps, Balances
 *                                lists Spot, Perps and the EVM wallet together.
 *   market                       The market the page is looking at (display
 *                                name) - what the "Current market" checkbox
 *                                narrows to. The portfolio has no current market
 *                                of its own; it uses the last market viewed on
 *                                the trade page (App.tsx keeps it in `ot.symbol`
 *                                / `ot.engine`), and only on tabs of that engine.
 *
 * THE FILTER BAR (accountTables/FilterBar.tsx) sits at the right of the tab
 * bar and shows only what can narrow the active tab. Its filters are applied
 * to the rows each table already holds (accountTables/filters.ts), persist per
 * tab (`vs.acct.filter.<tab>`), and the counts in the tab labels follow them.
 * Its View pop-up also holds the IDs switch (accountTables/IdCell.tsx): an IDs
 * column on every table with SoDEX records, the Algos tab's included.
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useLiveAlgos } from '../algo/algoBus';
import { api, type Engine, type Symbol as MarketSymbol } from '../api';
import { useAccountResource } from '../accountFeeds';
import { num, pick } from '../format';
import { useSharedStored, useStored } from '../hooks';
import { AccountKeepAlive, History, OpenOrders, Positions } from './Account';
import { AccountLedger, AllBalances, EngineSwitch } from './AccountHistory';
import { PanelTabs, type PanelTab } from '../dashboard/Panel';
import { Private, usePrivacy } from '../privacy';
import {
  DEFAULT_FILTER, NO_CAPS, TAB_CAPS, applyFilter, directionOfPosition, directionOfSide, marginOf, readFilter, sourceOf,
  type BandTab, type TableFilter,
} from './accountTables/filters';
import { FilterBar, NO_META, type BandMeta, type CardView } from './accountTables/FilterBar';
import { lazyChunk } from '../lazyPage';

export interface AccountTabsProps {
  engine: Engine;
  /** Drives every account READ. null renders each table's own empty state. */
  address: string | null;
  unlocked: boolean;
  /** Someone else's account (Scan): every table shows, nothing acts - no close, modify, cancel or transfer. */
  readOnly?: boolean;
  byName: Map<string, MarketSymbol>;
  refreshToken: number;
  onChanged: () => void;
  /** How the page's current market is spelled (display name). Omitted on a page without one. */
  market?: string;
  /** Shown in the tab label when the host page tracks it. */
  positionCount?: number;
  orderCount?: number;
  onPositionCount?: (n: number) => void;
  onOrderCount?: (n: number) => void;
  /** The portfolio's account-wide shape - see the header. */
  accountScope?: boolean;
  /** Each engine's markets, so a table switched to the other engine can name them. */
  symbolsFor?: (engine: Engine) => Map<string, MarketSymbol>;
}

/** Algo orders (TWAP, VWAP, ...): the runner signs orders, so its table loads when the tab is opened. */
const AlgoTable = lazyChunk(() => import('./algo/AlgoTable'));

const TABS: BandTab[] = [
  'positions', 'orders', 'balances', 'order-history', 'trade-history', 'funding-history', 'position-history', 'account-history',
];

/**
 * ONE view setting for every tab (and both pages): a Short filter chosen on
 * Positions is still on in Order History. Each tab applies only the parts it
 * has (TAB_CAPS) - Balances ignores Side, and so on. Live across every mounted
 * band (useSharedStored), remembered across reloads.
 */
const SHARED_FILTER_KEY = 'vs.acct.filter';
function useBandFilters(): [Record<BandTab, TableFilter>, (tab: BandTab, f: TableFilter) => void] {
  const [raw, setRaw] = useSharedStored<unknown>(SHARED_FILTER_KEY, null);
  const all = useMemo(() => {
    const f = readFilter(raw);
    return Object.fromEntries(TABS.map((t) => [t, f])) as Record<BandTab, TableFilter>;
  }, [raw]);
  const set = useCallback((_tab: BandTab, f: TableFilter) => setRaw(f), [setRaw]);
  return [all, set];
}

export function AccountTabs({
  engine, address, unlocked, readOnly = false, byName, refreshToken, onChanged,
  market, positionCount, orderCount, onPositionCount, onOrderCount, accountScope = false, symbolsFor,
  extraTabs, tabsAfter, onTabMenu, select, spotAccount = false,
}: AccountTabsProps & {
  /**
   * The Portfolio's Spot account (owner 2026-11-28: "Spot tab is bugged, it shows same for perps e.g. positions"):
   * Balances first, then its orders and history; no Positions (Spot holds coins, not positions).
   */
  spotAccount?: boolean;
  /** Tabs a trader added with the + (dashboard/tradeTabs.tsx), after the band's own. */
  extraTabs?: PanelTab[];
  /** The + itself. */
  tabsAfter?: ReactNode;
  /** A right-click on any tab (the tab menu). */
  onTabMenu?: (key: string, e: ReactMouseEvent) => void;
  /** Switch to a tab just added. */
  select?: { key: string; n: number } | null;
}) {
  const [currentOnly, setCurrentOnly] = useSharedStored<boolean>('vs.acct.currentMarket', false);
  const [filters, setFilter] = useBandFilters();
  const [view, setView] = useSharedStored<CardView>('vs.acct.poshist.view', 'card');
  const [meta, setMeta] = useState<Partial<Record<BandTab, BandMeta>>>({});
  const onMeta = useMemo(() => {
    const out = {} as Record<BandTab, (m: BandMeta) => void>;
    for (const t of TABS) {
      out[t] = (m: BandMeta) => setMeta((p) => {
        const o = p[t];
        return o && o.oldest === m.oldest && o.staleAt === m.staleAt && o.more === m.more ? p : { ...p, [t]: m };
      });
    }
    return out;
  }, []);

  /*
   * The engine the switchable tables read. On the trade page it IS the page's
   * engine; on the portfolio it is the reader's pick, remembered.
   */
  const [picked, setPicked] = useStored<Engine>('ot.pf.band.engine', engine);
  const [hideDust, setHideDust] = useSharedStored('vs.balances.hideDust', false);
  const eng: Engine = accountScope ? picked : engine;
  const names = (e: Engine) => symbolsFor?.(e) ?? byName;
  const perpsTabs = accountScope || engine === 'perps';
  /* The portfolio's Spot / Perps choice lives in the View pop-up (FilterBar), not on the table. */
  const switcher = undefined;

  /*
   * The market the checkbox narrows to, as a SYMBOL (rows carry symbols; the
   * page hands us a display name), and the engine it lives on.
   */
  const current = useMemo((): { symbol: string; label: string; engine: Engine } | null => {
    if (market) {
      for (const [symbol, s] of byName) if (s.displayName === market || symbol === market) return { symbol, label: s.displayName, engine };
      return { symbol: market, label: market, engine };
    }
    // The portfolio has no market of its own: no "Current market" there.
    return null;
  }, [market, byName, accountScope, engine, symbolsFor]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The engine a tab's rows are on. */
  const tabEngine = (t: BandTab): Engine | null =>
    t === 'positions' || t === 'funding-history' || t === 'position-history' ? 'perps'
      : t === 'orders' || t === 'order-history' || t === 'trade-history' ? eng
      : null;
  const marketFor = (t: BandTab): string | null =>
    current && currentOnly && TAB_CAPS[t].market && tabEngine(t) === current.engine ? current.symbol : null;

  const resetView = useMemo(() => {
    const out = {} as Record<BandTab, () => void>;
    // Everything that narrows a table, the trade page's "current market" included.
    for (const t of TABS) out[t] = () => { setFilter(t, { ...DEFAULT_FILTER }); setCurrentOnly(false); };
    return out;
  }, [setFilter, setCurrentOnly]);

  /** The prop bag Account.tsx's tables take, per tab. */
  const acct = { engine: eng, address, unlocked, readOnly, byName: names(eng), refreshToken, onChanged };
  const perps = { ...acct, engine: 'perps' as const, byName: names('perps') };
  const band = (t: BandTab) => ({ filter: filters[t], symbolFilter: marketFor(t), onResetView: resetView[t], onMeta: onMeta[t] });

  /*
   * " (2)" when the host page counted, nothing when it did not. Hidden counts
   * DROP the parenthetical: a bare "Positions" is what the tab says when nobody
   * counted, which is what someone hiding this wants it to look like.
   */
  const hideCounts = usePrivacy().isHidden('counts');
  const tally = (n: number | undefined) => (n === undefined || hideCounts ? '' : ` (${n})`);
  const liveAlgos = useLiveAlgos();

  /*
   * The counts come from the SAME shared feeds the tables read (accountFeeds.ts,
   * same keys and intervals - no extra request), filtered the way the tables
   * filter, so a label never promises rows its table is hiding.
   */
  const ordersKey = address ? `orders:${eng}:${address}` : null;
  const posKey = address && perpsTabs ? `pos:${address}` : null;
  const ordersFeed = useAccountResource(ordersKey, () => api.openOrders(eng, address!), 10_000);
  const posFeed = useAccountResource(posKey, () => api.positions(address!), 10_000);
  const now = Date.now();
  const liveOrders = ordersFeed.data
    ? applyFilter(
        ordersFeed.data.orders ?? [],
        (o: any) => ({ symbol: pick<string>(o, 'symbol', 's') ?? '', side: directionOfSide(pick(o, 'side', 'S')), source: sourceOf(pick(o, 'clOrdID', 'c')) }),
        filters.orders, TAB_CAPS.orders, { market: marketFor('orders'), now },
      ).length
    : undefined;
  const livePositions = !perpsTabs
    ? (address ? 0 : undefined)
    : posFeed.data
      ? applyFilter(
          (posFeed.data.positions ?? []).filter((p: any) => num(pick(p, 'size', 'positionAmt', 'pa', 'q')) !== 0),
          (p: any) => ({
            symbol: pick<string>(p, 'symbol', 's') ?? '',
            margin: marginOf(pick(p, 'marginMode')),
            side: directionOfPosition(pick(p, 'positionSide', 'ps'), pick(p, 'size', 'positionAmt', 'pa', 'q')),
          }),
          filters.positions, TAB_CAPS.positions, { market: marketFor('positions'), now },
        ).length
      : undefined;
  useEffect(() => { if (liveOrders !== undefined) onOrderCount?.(liveOrders); }, [liveOrders, onOrderCount]);
  useEffect(() => { if (livePositions !== undefined) onPositionCount?.(livePositions); }, [livePositions, onPositionCount]);
  const labelCount = (hostTracks: number | undefined, live: number | undefined) => (hostTracks === undefined ? undefined : live);

  const built: PanelTab[] = [
    {
      key: 'positions',
      label: `Positions${tally(labelCount(positionCount, livePositions))}`,
      content: <Positions {...(accountScope ? perps : acct)} {...band('positions')} showTitle={false} />,
    },
    {
      key: 'orders',
      label: `Open Orders${tally(labelCount(orderCount, liveOrders))}`,
      content: <OpenOrders {...acct} {...band('orders')} showTitle={false} headAction={switcher} />,
    },
    // Algo orders run in perps; someone else's account (Scan) has none of ours to show.
    ...(perpsTabs && !readOnly
      ? [
          {
            key: 'algos',
            label: `Algos${liveAlgos ? tally(liveAlgos) : ''}`,
            content: (
              <Suspense fallback={null}>
                <AlgoTable address={address} />
              </Suspense>
            ),
          },
        ]
      : []),
    {
      key: 'balances',
      label: 'Balances',
      // Per COIN, not per market: no filter bites on it. The portfolio lists
      // every place the account holds funds; the trade page, its engine.
      content: <Private k="funds"><AllBalances address={address} refreshToken={refreshToken} readOnly={readOnly} /></Private>,
    },
    {
      key: 'order-history',
      label: 'Order History',
      content: <History {...acct} {...band('order-history')} showTitle={false} forceTab="orders" headAction={switcher} />,
    },
    {
      key: 'trade-history',
      label: 'Trade History',
      content: <History {...acct} {...band('trade-history')} showTitle={false} forceTab="trades" headAction={switcher} />,
    },
    // Funding and closed positions only exist on perps.
    ...(perpsTabs
      ? [
          {
            key: 'funding-history',
            label: 'Funding History',
            content: <History {...perps} {...band('funding-history')} showTitle={false} forceTab="funding" />,
          },
          {
            key: 'position-history',
            label: 'Position History',
            // The venue's own closed-position log, as cards or as a slim table.
            content: <History {...perps} {...band('position-history')} showTitle={false} forceTab="positions" cardView={view !== 'list'} />,
          },
        ]
      : []),
    {
      key: 'account-history',
      label: 'Account History',
      // Deposits, withdrawals and ValueChain transfers. No market on a row.
      content: (
        <Private k="history">
          <AccountLedger address={address} refreshToken={refreshToken} {...band('account-history')} />
        </Private>
      ),
    },
  ];

  const actions = (active: string): ReactNode => {
    if (active.startsWith('x:')) return null;
    // The Algos tab has no filters; its View pop-up holds the IDs switch alone.
    if (active === 'algos') {
      return (
        <FilterBar
          caps={NO_CAPS} filter={DEFAULT_FILTER} onFilter={() => {}} marketLabel={null}
          currentOnly={false} onCurrentOnly={() => {}} meta={NO_META} ids
        />
      );
    }
    const t = (TABS as string[]).includes(active) ? (active as BandTab) : 'positions';
    if (t === 'balances') {
      return (
        <label className="bal-dust">
          <input type="checkbox" checked={hideDust} onChange={(e) => setHideDust(e.target.checked)} />
          Hide dust
        </label>
      );
    }
    const caps = TAB_CAPS[t];
    const te = tabEngine(t);
    const showMarket = !!current && caps.market && te === current.engine;
    const ids = t !== 'account-history';
    if (!ids && !caps.market && !caps.margin && !caps.side && !caps.source && !caps.time && !meta[t]?.staleAt) return null;
    return (
      <FilterBar
        caps={caps}
        filter={filters[t]}
        onFilter={(f) => setFilter(t, f)}
        marketLabel={showMarket ? current!.label : null}
        currentOnly={currentOnly}
        onCurrentOnly={setCurrentOnly}
        meta={meta[t] ?? NO_META}
        spot={te === 'spot'}
        engineChoice={accountScope && (t === 'orders' || t === 'order-history' || t === 'trade-history') ? { value: picked, onChange: setPicked } : undefined}
        view={t === 'position-history' ? (view === 'list' ? 'list' : 'card') : undefined}
        onView={t === 'position-history' ? setView : undefined}
        ids={ids}
      />
    );
  };

  // `?tab=account-history` (the transfer drawer's "View full history") selects that tab once, on mount.
  const bandRef = useRef<HTMLDivElement>(null);
  const tabs: PanelTab[] = spotAccount && engine === 'spot'
    ? [...built.filter((t) => t.key === 'balances'), ...built.filter((t) => t.key !== 'balances' && t.key !== 'positions')]
    : built;
  const tabKeys = useRef(tabs.map((t) => t.key));
  useLayoutEffect(() => {
    const want = new URLSearchParams(window.location.search).get('tab')?.toLowerCase() ?? '';
    const keys = tabKeys.current;
    if (!want || !keys.includes(want)) return;
    const buttons = bandRef.current?.querySelectorAll<HTMLButtonElement>('.dash-tabs__bar [role="tab"]');
    const btn = buttons?.[keys.indexOf(want)];
    if (btn && btn.getAttribute('aria-selected') !== 'true') btn.click();
  }, []);

  return (
    <div ref={bandRef} style={{ display: 'contents' }}>
      <AccountKeepAlive engine={eng} address={address} />
      <PanelTabs tabs={extraTabs?.length ? [...tabs, ...extraTabs] : tabs} actions={actions} after={tabsAfter} onTabContextMenu={onTabMenu} select={select} />
    </div>
  );
}

export default AccountTabs;
