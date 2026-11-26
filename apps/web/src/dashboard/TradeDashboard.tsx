/**
 * The trade page, as a dashboard.
 *
 * This is the seam that names which registry and which layout config make up
 * the trade terminal. It holds no state and no layout of its own: App.tsx still
 * owns every value in TradeContext, exactly as it did when this page was a
 * hand-written CSS grid.
 *
 * A second dashboard (say, a portfolio page) is another two-line component like
 * this one, pointing at its own panel list and its own DashboardConfig.
 *
 * It also says which widgets' code (lazyWidgets.tsx) the page waits for before its first render, and which it
 * fetches after the load event.
 */
import { useEffect } from 'react';
import { prefetchAfterLoad } from '../afterLoad';
import { Dashboard } from './Dashboard';
import { bandTabIds, firstRenderWidgetIds } from './firstWidgets';
import { TRADE_DASHBOARD } from './layout';
import { preloadAllWidgets, preloadWidgets } from './lazyWidgets';
import { TRADE_PANELS, type TradeContext } from './registry';

/** App.tsx's loader for /trade waits for this: the code of every widget the first render draws is in. */
export const tradeWidgetsReady = (): Promise<void> => preloadWidgets(firstRenderWidgetIds(TRADE_DASHBOARD, TRADE_PANELS));

/**
 * Fetched after the load event (afterLoad.ts): on a screen wide enough for the chart card's tabs and the rail's
 * terminals, every widget's code - each is a tap away there; on a phone only the widgets added as account tabs.
 */
function prefetchWidgets(): Promise<void> {
  const wide = typeof window.matchMedia === 'function' && window.matchMedia(`(min-width: ${TRADE_DASHBOARD.breakpoints.md}px)`).matches;
  return wide ? preloadAllWidgets() : preloadWidgets(bandTabIds());
}

export function TradeDashboard({ context }: { context: TradeContext }) {
  useEffect(() => prefetchAfterLoad(prefetchWidgets), []);
  return (
    <Dashboard
      config={TRADE_DASHBOARD}
      panels={TRADE_PANELS}
      context={context}
      onNotificationSettings={context.onOpenNotificationSettings}
      onEditing={preloadAllWidgets}
    />
  );
}
