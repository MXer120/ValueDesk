/**
 * The points page, as a dashboard.
 *
 * Third seam of the shape TradeDashboard describes. `className="pf"` is not a
 * copy-paste accident: the panels are built from the portfolio's own Card/Row/
 * Stat, and those rules are scoped under `.pf`, so the points page has to sit in
 * that scope to inherit them. That is the design system being shared rather than
 * duplicated.
 */
import { Dashboard } from './Dashboard';
import { POINTS_DASHBOARD } from './layout';
import { POINTS_PANELS, usePointsContext } from '../components/Points';
import type { Eip1193Provider } from '../wallet';

export function PointsDashboard(
  { address, provider }: { address: string | null; provider: Eip1193Provider | null },
) {
  const context = usePointsContext(address, provider);

  /*
   * LOCKED: no wallet, or a wallet that has not signed in yet.
   *
   * Every panel except the sign-in card is then a grid of dashes, and at full
   * contrast that reads as "this wallet has nothing" rather than "sign in to
   * see it". Same treatment as /scan with no address: dim and soften everything
   * else so the one card you can act on is the one that is sharp.
   */
  const locked = !address || (context.needsToken && !context.mine);

  return (
    <Dashboard
      config={POINTS_DASHBOARD}
      panels={POINTS_PANELS}
      context={context}
      className={`pf scan ${locked ? 'scan--idle' : ''}`}
    />
  );
}
