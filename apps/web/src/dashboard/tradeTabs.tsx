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
import { Suspense, useCallback, useState } from 'react';
import { DevRangeBar } from './versions/dev';
import { LiveChart } from './livePrice';
import { TickerBar } from '../components/Market';
import { AccountTabs } from '../components/AccountTabs';
import { FOMC_ODDS_ON } from '../components/macro/fomcFlag';
import { useStored } from '../hooks';
import type { PanelTab } from './Panel';
import {
  AddTabButton, MENU_ICONS, TabMenu, TabSidebar, assetOf, baseOf, copyOf, extraKey, isExtraKey, menuAt, useExtraTabs,
  type TabMenuItem,
} from './tabExtras';
import type { TradeContext } from './registry';
import { tabWidgetIds, faceFor } from './widgetCatalog';
import { widgetBody, widgetIdOf } from './widgetBodies';
/* The widget list opening is the intent to add one: every widget's code starts loading then (lazyWidgets.tsx). */
import { preloadAllWidgets, preloadWidgets } from './lazyWidgets';

/** One widget as a tab body (widgetBodies.tsx, as on a panel); a duplicate keeps its own settings (`instance`). */
function widgetTab(id: string, c: TradeContext): { content: PanelTab['content']; scroll: PanelTab['scroll'] } {
  const n = copyOf(id);
  const w = widgetBody(baseOf(id), c, { instance: n ? String(n) : undefined });
  return { content: w?.content ?? null, scroll: w?.scroll ?? 'auto' };
}

/** A widget id a tab can show: any of the catalog's (and the tape's older tab id). */
const isWidget = (id: string) => !!faceFor(widgetIdOf(baseOf(id)));
/** A tab's name: the widget's, with its copy number. */
const widgetName = (id: string) => {
  const f = faceFor(widgetIdOf(baseOf(id)));
  return `${f?.tab ?? f?.name ?? baseOf(id)}${copyOf(id) ? ` ${copyOf(id)}` : ''}`;
};

// Every widget, on both panels, bar the panel itself (widgetCatalog.ts tabWidgetIds).
const BAND_WIDGETS = tabWidgetIds('positions', FOMC_ODDS_ON);
const CHART_SEED = ['liqmap'];
const CHART_WIDGETS = tabWidgetIds('chart', FOMC_ODDS_ON);
const TAB_MAX = 8;

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
  const extra = useExtraTabs('band', TAB_MAX);
  const [side, setSide] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; key: string } | null>(null);
  const [select, setSelect] = useState<{ key: string; n: number } | null>(null);
  const ids = extra.ids.filter(isWidget);
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
        tabsAfter={<AddTabButton open={side} onOpen={() => { void preloadAllWidgets(); setSide((v) => !v); }} label="Add a tab to this panel" />}
        onTabMenu={(key, e) => setMenu({ at: menuAt(e), key })}
        select={select}
      />
      {menu && <TabMenu at={menu.at} items={items(menu.key)} onClose={closeMenu} />}
      {side && (
        <TabSidebar
          title="Add a tab · Account"
          widgets={BAND_WIDGETS}
          full={extra.ids.length >= TAB_MAX}
          onAdd={(id) => { show(extra.add(id)); setSide(false); }}
          onClose={() => setSide(false)}
        />
      )}
    </>
  );
}

/** The chart card: the coin row (with the tabs at its end), then the chart or the tab's widget. */
export function ChartCard({ c }: { c: TradeContext }) {
  // The liquidation heatmap is the chart's second tab unless closed (2026-10-27).
  const extra = useExtraTabs('chart', TAB_MAX, CHART_SEED);
  const [active, setActive] = useStored<string>('vs.tabs.chart.active', 'main');
  const [side, setSide] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const ids = extra.ids.filter((id) => isWidget(id) || (assetOf(id) && c.byName.has(assetOf(id)!)));
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
  // Every market, the starred ones first.
  const starred = new Set(c.favorites.filter((k) => k.startsWith(`${c.engine}:`)).map((k) => k.slice(c.engine.length + 1)));
  const markets = [...c.byName.values()]
    .map((s) => ({ name: s.name, label: s.displayName ?? s.name, starred: starred.has(s.name) }))
    .sort((a, b) => Number(b.starred) - Number(a.starred));

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
              onPointerDown={() => { void preloadWidgets([id]); }}
              onClick={() => setActive(id)}
              onContextMenu={(e) => setMenu({ at: menuAt(e), id })}
            >
              {label(id)}
            </button>
          ))}
        </>
      )}
      <AddTabButton open={side} onOpen={() => { void preloadAllWidgets(); setSide((v) => !v); }} label="Add a chart or a widget tab" />
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
      {/* Pulse (localhost only): where the price sits in its 24 hours, under the coin row. */}
      {c.pageVersion === 'pulse' && DevRangeBar && (
        <Suspense fallback={null}><DevRangeBar engine={c.engine} symbol={symbol} sym={sym} /></Suspense>
      )}
      <div key={on} className={`chart-card__body mo-switch${widget ? ' is-widget' : ''}`}>
        {widget ? widget.content : (
          <LiveChart
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
            noPrice={!!asset}
          />
        )}
      </div>
      {menu && <TabMenu at={menu.at} items={items(menu.id)} onClose={closeMenu} />}
      {side && (
        <TabSidebar
          title="Add a tab · Chart"
          widgets={CHART_WIDGETS}
          markets={markets}
          full={extra.ids.length >= TAB_MAX}
          onAdd={(id) => { add(id); setSide(false); }}
          onClose={() => setSide(false)}
        />
      )}
    </div>
  );
}
