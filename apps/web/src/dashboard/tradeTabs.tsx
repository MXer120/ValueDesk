/**
 * The trade page's two tabbed panels with extra tabs (tabExtras.tsx): the
 * account band under the chart and the chart card itself.
 *
 * The + opens the widget sidebar; a right-click on a tab offers Close tab, Add
 * widget and Duplicate. The band's extras follow its own tabs. The chart card's
 * tabs sit at the end of its coin row: the market on screen first, then other
 * markets' charts and widget tabs; the coin row follows the tab (another
 * market's tab shows that market's figures; a widget tab keeps the market on
 * screen's), and the body fades across a switch.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Chart } from '../components/Chart';
import { TickerBar, Trades } from '../components/Market';
import { AccountTabs } from '../components/AccountTabs';
import { FeeTier } from '../components/FeeTier';
import { Stats } from '../components/Stats';
import { LiveFeed } from '../components/livefeed/LiveFeed';
import { FedLive } from '../components/fedlive/FedLive';
import { FedWatch } from '../components/macro/FedWatch';
import { IndicatorWidget } from '../components/macro/IndicatorView';
import { EtfFlows } from '../components/macro/EtfFlows';
import { NewsFeed } from '../components/news/NewsFeed';
import { FundingScanner } from '../components/explore/FundingScanner';
import { coinLabel } from '../format';
import { useStored } from '../hooks';
import type { PanelTab } from './Panel';
import { SizeCalc } from './sourceWidgets';
import {
  AddTabButton, MENU_ICONS, TAB_WIDGETS, TabMenu, TabSidebar, assetOf, baseOf, copyOf, extraKey, isExtraKey, menuAt, useExtraTabs,
  type TabMenuItem,
} from './tabExtras';
import type { TradeContext } from './registry';
import { newsProps } from './newsProps';

/** One widget as a tab body; a duplicate keeps its own settings (`instance`). */
function widgetTab(id: string, c: TradeContext): { content: ReactNode; scroll: PanelTab['scroll'] } {
  const n = copyOf(id);
  const instance = n ? String(n) : undefined;
  switch (baseOf(id)) {
    case 'trades': return { content: <Trades engine={c.engine} symbol={c.symbol} sym={c.sym} showTitle={false} onOpenScan={c.onOpenScan} />, scroll: 'auto' };
    case 'news': return { content: <NewsFeed {...newsProps(c)} instance={instance} />, scroll: 'hidden' };
    case 'livefeed': return { content: <LiveFeed instance={instance} />, scroll: 'hidden' };
    case 'fedlive': return { content: <FedLive />, scroll: 'hidden' };
    case 'fedwatch': return { content: <FedWatch instance={instance} />, scroll: 'hidden' };
    case 'indicator': return { content: <IndicatorWidget instance={instance} />, scroll: 'hidden' };
    case 'etfflows': return { content: <EtfFlows instance={instance} />, scroll: 'hidden' };
    case 'funding': return { content: <FundingScanner enabled mode="compact" onOpenSymbol={(s) => c.onSelectSymbol?.(s)} />, scroll: 'auto' };
    case 'sizecalc': return { content: <SizeCalc price={c.lastPrice || c.price} />, scroll: 'auto' };
    case 'feetier': return { content: <FeeTier address={c.address} engine={c.engine} />, scroll: 'auto' };
    case 'venue': return { content: <Stats address={c.address} showTitle={false} />, scroll: 'auto' };
    default: return { content: null, scroll: 'auto' };
  }
}

/** A tab's name: the widget's, with its copy number. */
const widgetName = (id: string) => `${TAB_WIDGETS[baseOf(id)] ?? baseOf(id)}${copyOf(id) ? ` ${copyOf(id)}` : ''}`;

const BAND_WIDGETS = ['trades', 'news', 'livefeed', 'fedlive', 'fedwatch', 'indicator', 'etfflows', 'funding', 'sizecalc', 'feetier', 'venue'];
const CHART_WIDGETS = ['livefeed', 'fedlive', 'fedwatch', 'indicator', 'etfflows', 'news', 'trades', 'funding'];

const accountCtx = (c: TradeContext) => ({
  engine: c.engine,
  address: c.address,
  unlocked: c.unlocked,
  byName: c.byName,
  refreshToken: c.refreshToken,
  onChanged: c.onChanged,
});

/** The account band with its extra tabs (the bottom panel). */
export function TradeAccountBand({ c }: { c: TradeContext }) {
  const extra = useExtraTabs('band');
  const [side, setSide] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; key: string } | null>(null);
  const [select, setSelect] = useState<{ key: string; n: number } | null>(null);
  const ids = extra.ids.filter((id) => TAB_WIDGETS[baseOf(id)]);
  const show = (id: string | null) => { if (id) setSelect((s) => ({ key: extraKey(id), n: (s?.n ?? 0) + 1 })); };
  const tabs: PanelTab[] = ids.map((id) => {
    const w = widgetTab(id, c);
    return { key: extraKey(id), label: widgetName(id), content: w.content, scroll: w.scroll };
  });
  const closeMenu = useCallback(() => setMenu(null), []);
  const items = (key: string): TabMenuItem[] => {
    const id = isExtraKey(key) ? key.slice(2) : null;
    return [
      { label: 'Add widget…', icon: MENU_ICONS.widget, onClick: () => setSide(true) },
      { label: 'Duplicate', icon: MENU_ICONS.duplicate, disabled: !id, onClick: () => id && show(extra.add(id)) },
      { label: 'Close tab', icon: MENU_ICONS.close, danger: true, disabled: !id, onClick: () => id && extra.remove(id) },
    ];
  };
  return (
    <>
      <AccountTabs
        {...accountCtx(c)}
        market={c.sym?.displayName ?? c.symbol}
        positionCount={c.positionCount}
        orderCount={c.orderCount}
        onPositionCount={c.onPositionCount}
        onOrderCount={c.onOrderCount}
        extraTabs={tabs}
        tabsAfter={<AddTabButton open={side} onOpen={() => setSide((v) => !v)} label="Add a tab to this panel" />}
        onTabMenu={(key, e) => setMenu({ at: menuAt(e), key })}
        select={select}
      />
      {menu && <TabMenu at={menu.at} items={items(menu.key)} onClose={closeMenu} />}
      {side && (
        <TabSidebar
          title="Add a tab · Account"
          widgets={BAND_WIDGETS}
          onAdd={(id) => { show(extra.add(id)); setSide(false); }}
          onClose={() => setSide(false)}
        />
      )}
    </>
  );
}

/** The chart card: the coin row (with the tabs at its end), then the chart or the tab's widget. */
export function ChartCard({ c }: { c: TradeContext }) {
  const extra = useExtraTabs('chart');
  const [active, setActive] = useStored<string>('vs.tabs.chart.active', 'main');
  const [side, setSide] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const ids = extra.ids.filter((id) => TAB_WIDGETS[baseOf(id)] || (assetOf(id) && c.byName.has(assetOf(id)!)));
  const on = active !== 'main' && ids.includes(active) ? active : 'main';
  const asset = assetOf(on);
  const symbol = asset ?? c.symbol;
  const sym = asset ? c.byName.get(asset) : c.sym;
  const widget = !asset && on !== 'main' ? widgetTab(on, c) : null;
  const add = (id: string) => {
    const next = extra.add(id);
    if (next) setActive(next);
  };
  const remove = (id: string) => {
    extra.remove(id);
    if (on === id) setActive('main');
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const items = (id: string): TabMenuItem[] => [
    { label: 'Add widget…', icon: MENU_ICONS.widget, onClick: () => setSide(true) },
    // The market on screen duplicates as a chart tab of its own.
    { label: 'Duplicate', icon: MENU_ICONS.duplicate, onClick: () => add(id === 'main' ? `asset:${c.symbol}` : id) },
    { label: 'Close tab', icon: MENU_ICONS.close, danger: true, disabled: id === 'main', onClick: () => remove(id) },
  ];
  const label = (id: string) => {
    const a = assetOf(id);
    if (!a) return widgetName(id);
    // A copy of the market on screen counts the main tab as its first.
    const n = a === c.symbol ? (copyOf(id) ?? 1) + 1 : copyOf(id);
    return `${c.byName.get(a)?.displayName ?? a}${n ? ` ${n}` : ''}`;
  };
  const markets = [...c.byName.values()].map((s) => ({ name: s.name, label: s.displayName ?? s.name }));

  const tabs = (
    <div className="chart-tabs dash-nodrag" role="tablist" aria-label="Chart tabs">
      {ids.length > 0 && (
        <>
          <button
            type="button"
            role="tab"
            aria-selected={on === 'main'}
            className={`chart-tab${on === 'main' ? ' is-on' : ''}`}
            onClick={() => setActive('main')}
            onContextMenu={(e) => setMenu({ at: menuAt(e), id: 'main' })}
          >
            {c.sym?.displayName ?? c.symbol}
          </button>
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on === id}
              className={`chart-tab${on === id ? ' is-on' : ''}`}
              onClick={() => setActive(id)}
              onContextMenu={(e) => setMenu({ at: menuAt(e), id })}
            >
              {label(id)}
            </button>
          ))}
        </>
      )}
      <AddTabButton open={side} onOpen={() => setSide((v) => !v)} label="Add a chart or a widget tab" />
    </div>
  );

  return (
    <div className="chart-card">
      {/* Another market's tab is on: the market on screen still reports its last price to the ticket. */}
      {asset && (
        <div hidden>
          <TickerBar engine={c.engine} symbol={c.symbol} sym={c.sym} onLast={c.onLastPrice} />
        </div>
      )}
      <TickerBar
        engine={c.engine}
        symbol={symbol}
        sym={sym}
        // Only the market on screen reports its last price to the order ticket.
        onLast={asset ? undefined : c.onLastPrice}
        onSymbolClick={() => c.onOpenSearch(asset ?? undefined)}
        aside={tabs}
      />
      <div key={on} className={`chart-card__body mo-switch${widget ? ' is-widget' : ''}`}>
        {widget ? widget.content : (
          <Chart
            key={symbol}
            engine={c.engine}
            symbol={symbol}
            sym={sym}
            address={c.address}
            // Another market's chart is for reading: no dragging its order lines, no pricing the ticket.
            unlocked={asset ? false : c.unlocked}
            refreshToken={c.refreshToken}
            onChanged={c.onChanged}
            onPrice={asset ? () => {} : c.onPrice}
            lastPrice={asset ? '' : c.lastPrice}
          />
        )}
      </div>
      {menu && <TabMenu at={menu.at} items={items(menu.id)} onClose={closeMenu} />}
      {side && (
        <TabSidebar
          title="Add a tab · Chart"
          widgets={CHART_WIDGETS}
          markets={markets}
          onAdd={(id) => { add(id); setSide(false); }}
          onClose={() => setSide(false)}
        />
      )}
    </div>
  );
}
