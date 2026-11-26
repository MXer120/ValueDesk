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
 *
 * On localhost it also draws the page in the version the switch chose (versions/store.ts): the same panels, the
 * same saved layouts and the same ticket, in another design. A build always draws the original.
 */
import { Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import { prefetchAfterLoad } from '../afterLoad';
import { Dashboard } from './Dashboard';
import { bandTabIds, firstRenderWidgetIds } from './firstWidgets';
import { TRADE_DASHBOARD } from './layout';
import { preloadAllWidgets, preloadWidgets } from './lazyWidgets';
import { TRADE_PANELS, type TradeContext } from './registry';
import { DevVersionSwitch, useDevReady } from './versions/dev';
import { tradeConfigFor } from './versions/pageConfig';
import { usePageVersion } from './versions/store';

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
  const chosen = usePageVersion();
  // A version is drawn once its styles are in (DEV only); until then, and always in a build, the original.
  const version = useDevReady(chosen !== 'original') ? chosen : 'original';
  const config = useMemo(() => tradeConfigFor(version, TRADE_DASHBOARD), [version]);
  const ctx = useMemo<TradeContext>(() => (version === 'original' ? context : { ...context, pageVersion: version }), [context, version]);
  // The page's own surroundings (the body behind the panels, the coin row's menus) read the version off <html>.
  useLayoutEffect(() => {
    if (version === 'original') return;
    const root = document.documentElement;
    root.dataset.tv = version;
    return () => { delete root.dataset.tv; };
  }, [version]);
  return (
    <>
      <Dashboard
        config={config}
        panels={TRADE_PANELS}
        context={ctx}
        className={version === 'original' ? undefined : `tv tv-${version}`}
        onNotificationSettings={context.onOpenNotificationSettings}
        onEditing={preloadAllWidgets}
      />
      {DevVersionSwitch && <Suspense fallback={null}><DevVersionSwitch /></Suspense>}
    </>
  );
}
