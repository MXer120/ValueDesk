/**
 * Copy trading, as a dashboard.
 *
 * The same seam as the portfolio, points and scan pages: a panel registry
 * (panels.tsx), a layout (layout.ts), and one context hook (useCopy.ts) that
 * owns every fetch and every piece of state. `className="pf copy"` puts the
 * panels in the portfolio's design-system scope, which is what the Card, Row
 * and Group they are built from are styled against.
 *
 * NOTHING HERE CAN START A COPY. The on-chain copy contract is not deployed,
 * so "Start copying" ends in a "not live yet" message. `provider` is accepted
 * because the page will need it once the contract exists, and is deliberately
 * never read: no code path on this page can open a wallet prompt.
 *
 * Reads `?address=&venue=` on mount (Explore, Leaderboard and Scan link here
 * with them) and keeps the URL in step with the selected trader.
 */
import { Dashboard } from '../../dashboard/Dashboard';
import { COPY_DASHBOARD } from './layout';
import { COPY_PANELS } from './panels';
import { useCopyContext, type CopyPageProps } from './useCopy';
import './Copy.css';

export type { CopyPageProps } from './useCopy';

export function CopyPage(props: CopyPageProps) {
  const context = useCopyContext(props);
  return <Dashboard config={COPY_DASHBOARD} panels={COPY_PANELS} context={context} className="pf copy" />;
}
