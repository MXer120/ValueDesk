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
 */
import { Dashboard } from './Dashboard';
import { TRADE_DASHBOARD } from './layout';
import { TRADE_PANELS, type TradeContext } from './registry';

export function TradeDashboard({ context }: { context: TradeContext }) {
  return (
    <Dashboard
      config={TRADE_DASHBOARD}
      panels={TRADE_PANELS}
      context={context}
      onNotificationSettings={context.onOpenNotificationSettings}
    />
  );
}
