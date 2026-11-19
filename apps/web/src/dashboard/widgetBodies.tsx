/**
 * What every widget of the catalog (widgetCatalog.ts) draws, on the terminal:
 * as a panel added from edit mode's palette (registry.tsx) and as a tab of the
 * chart card or the account band (tradeTabs.tsx). One switch, so a widget is
 * the same component with the same props wherever it is added - the ones the
 * pages that already show it pass (the market, engine and wallet the terminal
 * has, from TradeContext).
 *
 * `instance` is a duplicate tab's own settings key (`news#2`); `bp` is the
 * breakpoint, for the widgets that draw differently on a phone.
 */
import { Suspense, type ReactNode } from 'react';
import { LiveChart, LiveOrderEntry, LiveSizeCalc } from './livePrice';
import { Book, MarketStrip, TickerBar, Trades } from '../components/Market';
import { AccountPanel, History, OpenOrders, Positions } from '../components/Account';
import { AccountLedger, AllBalances } from '../components/AccountHistory';
import { Private } from '../privacy';
import { MarketHeatmap } from '../components/palette/Heatmap';
import { MARKET_MAP_PATH, cohortAssetPath } from '../components/palette/model';
/* The widgets no default layout places: each in a chunk of its own (lazyWidgets.tsx says when each loads). */
import {
  Cohorts, EtfFlows, FedLive, FedWatch, FeeTier, FundingScanner, IndicatorWidget, LazyWidget, Leaderboard, LeaderboardPage,
  LiqHeatmap, LiveFeed, MyCopiesCard, NewsFeed, Stats,
} from './lazyWidgets';
import { MarketHeat, Watchlist, WhaleTrades } from './terminalWidgets';
import { newsProps } from './newsProps';
import type { TradeContext } from './registry';
import type { BreakpointName } from './types';
import { lazyChunk } from '../lazyPage';
import { openPath as goTo } from '../nav';

const AlgoTable = lazyChunk(() => import('../components/algo/AlgoTable'));
/* The Liq. heatmap widget (~51 KB raw of liqmap code) mounts only when its tab or a layout cell shows it, so it is
   split out of the trade dashboard's first render. Once the page's load event has passed, it is fetched in idle time
   (not with Save-Data), so a tap on its tab renders it at once: lazyPage renders synchronously once the code is in.
   Its chunk is lazyWidgets.tsx's; on a phone that file preloads only widgets already added as tabs, the chart's
   liquidation tab is always one tap away, so it is fetched here on every screen. */
if (typeof window !== 'undefined') {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData !== true) {
    const fetchIt = () => {
      const go = () => { LiqHeatmap.preload().catch(() => {}); };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 3000 });
      else window.setTimeout(go, 1000);
    };
    if (document.readyState === 'complete') fetchIt();
    else window.addEventListener('load', fetchIt, { once: true });
  }
}

export interface WidgetBody {
  content: ReactNode;
  /** 'hidden': the widget scrolls inside itself (or measures its box). */
  scroll: 'auto' | 'hidden';
  /** False: it brings its own insets. */
  pad: boolean;
}

/** Tab ids from before the catalog's ids were used for tabs too. */
const LEGACY: Record<string, string> = { trades: 'tape' };
export const widgetIdOf = (id: string): string => LEGACY[id] ?? id;

// A wallet or a page elsewhere in the app: what App.tsx's own links do - in place (nav.ts), not a reload.
const scanWallet = (address: string) => { goTo(`/scan?find=${encodeURIComponent(address)}`); };
const copyTrader = (address: string, venue: string) => { goTo(`/copy?address=${encodeURIComponent(address)}&venue=${venue}`); };
const openPath = (path: string) => { goTo(path); };

const accountCtx = (c: TradeContext) => ({
  engine: c.engine,
  address: c.address,
  unlocked: c.unlocked,
  byName: c.byName,
  refreshToken: c.refreshToken,
  onChanged: c.onChanged,
});

/** How each sits in its panel: its own scrolling (or a measured box), and whether it brings its own insets. */
const SHAPE: Record<string, Omit<WidgetBody, 'content'>> = {};
const shape = (scroll: WidgetBody['scroll'], pad: boolean, ids: string[]) => { for (const id of ids) SHAPE[id] = { scroll, pad }; };
shape('hidden', false, [
  'chart', 'book', 'markets', 'ticker', 'positions', 'orders', 'fills', 'history', 'account', 'transfers',
  'liqmap', 'heatmap', 'cohort', 'news', 'livefeed', 'fedlive', 'fedwatch', 'indicator', 'etfflows',
]);
shape('auto', false, ['tape', 'exec', 'quick', 'watch', 'assets', 'twap', 'twaplive', 'copy', 'poschg', 'cohorts', 'toptraders']);
shape('auto', true, ['sizecalc', 'feetier', 'venue', 'funding', 'leaderboard']);

/** A widget's scroll and insets, without drawing it (the registry's panel definition). */
export const widgetBodyShape = (id: string): Omit<WidgetBody, 'content'> => SHAPE[widgetIdOf(id)] ?? { scroll: 'auto', pad: true };

export function widgetBody(id: string, c: TradeContext, o: { instance?: string; bp?: BreakpointName } = {}): WidgetBody | null {
  const { instance } = o;
  const body = (content: ReactNode): WidgetBody => ({ content, ...widgetBodyShape(id) });
  /** A widget drawn with code of its own (lazyWidgets.tsx): waits in its panel, never the page, until that is in. */
  const lazy = (content: ReactNode): WidgetBody => body(<LazyWidget>{content}</LazyWidget>);
  const select = (s: string) => (c.onSelectSymbol ? c.onSelectSymbol(s) : c.onOpenSearch(s));
  const ticket = (
    <LiveOrderEntry
      engine={c.engine}
      symbol={c.symbol}
      sym={c.sym}
      network={c.network}
      unlocked={c.unlocked}
      showTitle={false}
      connectedAddress={c.address}
      signingAddress={c.signingAddress}
      price={c.price}
      onPrice={c.onPrice}
      onPlaced={c.onChanged}
    />
  );
  switch (widgetIdOf(id)) {
    case 'chart':
      return body(
        <LiveChart engine={c.engine} symbol={c.symbol} sym={c.sym} address={c.address} unlocked={c.unlocked} refreshToken={c.refreshToken} onChanged={c.onChanged} onPrice={c.onPrice} />);
    case 'book': return body(<Book engine={c.engine} symbol={c.symbol} sym={c.sym} onPick={c.onPrice} showTitle={false} address={c.address} />);
    case 'tape': return body(<Trades engine={c.engine} symbol={c.symbol} sym={c.sym} showTitle={false} onOpenScan={c.onOpenScan} />);
    case 'exec':
    case 'quick':
      return body(ticket);
    case 'markets':
      return body(
        <MarketStrip engine={c.engine} symbol={c.symbol} favorites={c.favorites} byName={c.byName} onSelect={select} onToggleFavorite={c.onToggleFavorite} onAdd={() => c.onOpenSearch()} />);
    case 'ticker':
      return body(
        <TickerBar engine={c.engine} symbol={c.symbol} sym={c.sym} onSymbolClick={() => c.onOpenSearch()} favorites={c.favorites} onToggleFavorite={c.onToggleFavorite} />);
    case 'watch': return body(<Watchlist engine={c.engine} symbol={c.symbol} favorites={c.favorites} onSelect={select} />);

    // The account: the same tables as the band under the chart.
    case 'positions': return body(<Positions {...accountCtx(c)} showTitle={false} />);
    case 'orders': return body(<OpenOrders {...accountCtx(c)} showTitle={false} />);
    case 'fills': return body(<History {...accountCtx(c)} showTitle={false} forceTab="trades" />);
    // No `forceTab`: its own trades / orders / funding / positions switch.
    case 'history': return body(<History {...accountCtx(c)} showTitle={false} />);
    case 'account': return body(<AccountPanel {...accountCtx(c)} />);
    case 'assets': return body(<Private k="funds"><AllBalances address={c.address} refreshToken={c.refreshToken} /></Private>);
    case 'transfers': return body(<Private k="history"><AccountLedger address={c.address} refreshToken={c.refreshToken} /></Private>);
    case 'twap':
    case 'twaplive':
      return body(
        <Suspense fallback={null}><AlgoTable address={c.address} initialShow={widgetIdOf(id) === 'twaplive' ? 'running' : 'all'} /></Suspense>);
    // Its cards are the portfolio's (pf-card): the `.pf` scope carries their tokens.
    case 'copy': return body(<div className="pf tw-scope"><LazyWidget><MyCopiesCard /></LazyWidget></div>);
    case 'sizecalc': return body(<LiveSizeCalc price={c.price} />);
    case 'feetier': return lazy(<FeeTier address={c.address} engine={c.engine} />);
    case 'venue': return lazy(<Stats address={c.address} showTitle={false} />);

    // Market-wide.
    case 'liqmap': return lazy(<LiqHeatmap symbol={c.symbol} engine={c.engine} instance={instance} address={c.address} />);
    case 'funding': return lazy(<FundingScanner enabled mode="compact" onOpenSymbol={select} />);
    case 'poschg': return body(<WhaleTrades id={instance ? `poschg#${instance}` : 'poschg'} onScan={scanWallet} />);
    case 'heatmap': return body(<MarketHeat onOpenSymbol={select} />);
    case 'cohort':
      return body(
        <MarketHeatmap enabled onAsset={(coin) => openPath(cohortAssetPath(coin))} onOpenMap={() => openPath(MARKET_MAP_PATH)} />);
    case 'cohorts': return body(<div className="pf ex-cohorts tw-scope"><LazyWidget><Cohorts embedded onScan={scanWallet} onOpenSymbol={select} /></LazyWidget></div>);
    case 'leaderboard': return lazy(<Leaderboard address={c.address} />);
    case 'toptraders': return lazy(<LeaderboardPage embedded address={c.address} onScan={scanWallet} onOpenCopy={copyTrader} />);

    case 'news': return lazy(<NewsFeed {...newsProps(c)} instance={instance} />);
    case 'livefeed': return lazy(<LiveFeed instance={instance} />);
    case 'fedlive': return lazy(<FedLive />);
    case 'fedwatch': return lazy(<FedWatch instance={instance} />);
    case 'indicator': return lazy(<IndicatorWidget instance={instance} />);
    case 'etfflows': return lazy(<EtfFlows instance={instance} />);
    default: return null;
  }
}
