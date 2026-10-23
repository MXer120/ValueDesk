/**
 * The trade page's two tabbed panels with a + (tabExtras.tsx): the account band
 * under the chart and the chart card itself.
 *
 * The band's + adds a widget tab after its own tabs. The chart card's tabs sit
 * at the end of its coin row: the market on screen first, then other markets'
 * charts and widget tabs; the coin row follows the tab (another market's tab
 * shows that market's figures; a widget tab keeps the market on screen's).
 */
import type { ReactNode } from 'react';
import { Chart } from '../components/Chart';
import { TickerBar, Trades } from '../components/Market';
import { AccountTabs } from '../components/AccountTabs';
import { FeeTier } from '../components/FeeTier';
import { Stats } from '../components/Stats';
import { LiveFeed } from '../components/livefeed/LiveFeed';
import { NewsFeed } from '../components/news/NewsFeed';
import { FundingScanner } from '../components/explore/FundingScanner';
import { coinLabel } from '../format';
import { useStored } from '../hooks';
import type { PanelTab } from './Panel';
import { SizeCalc } from './sourceWidgets';
import { AddTabButton, ExtraLabel, TAB_WIDGETS, assetOf, extraKey, isExtraKey, useExtraTabs } from './tabExtras';
import type { TradeContext } from './registry';

/** One widget as a tab body. */
function widgetTab(id: string, c: TradeContext): { content: ReactNode; scroll: PanelTab['scroll'] } {
  switch (id) {
    case 'trades': return { content: <Trades engine={c.engine} symbol={c.symbol} sym={c.sym} showTitle={false} onOpenScan={c.onOpenScan} />, scroll: 'auto' };
    case 'news': return { content: <NewsFeed coin={coinLabel(c.sym?.baseCoin) || null} />, scroll: 'hidden' };
    case 'livefeed': return { content: <LiveFeed />, scroll: 'hidden' };
    case 'funding': return { content: <FundingScanner enabled mode="compact" onOpenSymbol={(s) => c.onSelectSymbol?.(s)} />, scroll: 'auto' };
    case 'sizecalc': return { content: <SizeCalc price={c.lastPrice || c.price} />, scroll: 'auto' };
    case 'feetier': return { content: <FeeTier address={c.address} engine={c.engine} />, scroll: 'auto' };
    case 'venue': return { content: <Stats address={c.address} showTitle={false} />, scroll: 'auto' };
    default: return { content: null, scroll: 'auto' };
  }
}

const BAND_WIDGETS = ['trades', 'news', 'livefeed', 'funding', 'sizecalc', 'feetier', 'venue'];
const CHART_WIDGETS = ['livefeed', 'news', 'trades', 'funding'];

const accountCtx = (c: TradeContext) => ({
  engine: c.engine,
  address: c.address,
  unlocked: c.unlocked,
  byName: c.byName,
  refreshToken: c.refreshToken,
  onChanged: c.onChanged,
});

/** The account band with its + (the bottom panel). */
export function TradeAccountBand({ c }: { c: TradeContext }) {
  const extra = useExtraTabs('band');
  const tabs: PanelTab[] = extra.ids.filter((id) => TAB_WIDGETS[id]).map((id) => {
    const w = widgetTab(id, c);
    return { key: extraKey(id), label: <ExtraLabel name={TAB_WIDGETS[id]} onRemove={() => extra.remove(id)} />, content: w.content, scroll: w.scroll };
  });
  const options = BAND_WIDGETS.filter((id) => !extra.ids.includes(id)).map((id) => ({ id, name: TAB_WIDGETS[id]! }));
  return (
    <AccountTabs
      {...accountCtx(c)}
      market={c.sym?.displayName ?? c.symbol}
      positionCount={c.positionCount}
      orderCount={c.orderCount}
      onPositionCount={c.onPositionCount}
      onOrderCount={c.onOrderCount}
      extraTabs={tabs}
      tabsAfter={<AddTabButton options={options} onAdd={extra.add} label="Add a tab to this panel" />}
    />
  );
}

/** The chart card: the coin row (with the tabs at its end), then the chart or the tab's widget. */
export function ChartCard({ c }: { c: TradeContext }) {
  const extra = useExtraTabs('chart');
  const [active, setActive] = useStored<string>('vs.tabs.chart.active', 'main');
  const ids = extra.ids.filter((id) => TAB_WIDGETS[id] || (assetOf(id) && c.byName.has(assetOf(id)!)));
  const on = active !== 'main' && ids.includes(active) ? active : 'main';
  const asset = assetOf(on);
  const symbol = asset ?? c.symbol;
  const sym = asset ? c.byName.get(asset) : c.sym;
  const widget = !asset && on !== 'main' ? widgetTab(on, c) : null;
  const remove = (id: string) => {
    extra.remove(id);
    if (on === id) setActive('main');
  };
  const options = CHART_WIDGETS.filter((id) => !ids.includes(id)).map((id) => ({ id, name: TAB_WIDGETS[id]! }));
  const markets = [...c.byName.keys()].filter((m) => m !== c.symbol && !ids.includes(`asset:${m}`));
  const label = (id: string) => (assetOf(id) ? c.byName.get(assetOf(id)!)?.displayName ?? assetOf(id)! : TAB_WIDGETS[id] ?? id);

  const tabs = (
    <div className="chart-tabs dash-nodrag" role="tablist" aria-label="Chart tabs">
      {ids.length > 0 && (
        <>
          <button type="button" role="tab" aria-selected={on === 'main'} className={`chart-tab${on === 'main' ? ' is-on' : ''}`} onClick={() => setActive('main')}>
            {c.sym?.displayName ?? c.symbol}
          </button>
          {ids.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={on === id} className={`chart-tab${on === id ? ' is-on' : ''}`} onClick={() => setActive(id)}>
              <ExtraLabel name={label(id)} onRemove={() => remove(id)} />
            </button>
          ))}
        </>
      )}
      <AddTabButton
        options={options}
        markets={markets}
        label="Add a chart or a widget tab"
        onAdd={(id) => {
          extra.add(id);
          setActive(id);
        }}
      />
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
      <div className={`chart-card__body${widget ? ' is-widget' : ''}`}>
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
    </div>
  );
}
