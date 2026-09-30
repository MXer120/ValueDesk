/**
 * The portfolio page, as a dashboard.
 *
 * The second seam of the shape TradeDashboard.tsx describes: a registry, a
 * config, and no state or layout of its own. Everything the panels read comes
 * from `usePortfolioContext`, which is the page's former component body.
 *
 * It lives in dashboard/ rather than components/ so the dependency runs one way -
 * this file imports from components/Portfolio, and nothing in components imports
 * the dashboard. Putting the seam next to the page instead would make Portfolio
 * import Dashboard while the trade registry imports Portfolio's siblings, which
 * is the beginning of a cycle.
 *
 * SoDEX ONLY. The page used to append a Hyperliquid section (the connected
 * address read as a Hyperliquid account, components/scan/HlPanels.tsx) below
 * the SoDEX panels. That section is gone from this page - the Scan page still
 * carries the Hyperliquid view - and so is the extra default-placement logic it
 * needed. A saved layout that still names `hl-*` panels is harmless: resolve.ts
 * only places panels that are registered, and the grid closes the gap.
 *
 * "My copies" stays. It came in with that section but is not Hyperliquid's: it
 * is this app's own copy-trading summary (components/scan/MyCopies.tsx), and it
 * belongs on the portfolio of whoever does the copying.
 */
import { Dashboard } from './Dashboard';
import { PORTFOLIO_DASHBOARD } from './layout';
import type { PanelDefinition } from './types';
import {
  PORTFOLIO_PANELS,
  usePortfolioContext,
  type PortfolioContext,
  type PortfolioProps,
} from '../components/Portfolio';
import { IndexPrompt } from '../components/IndexPrompt';
import { MyCopiesCard } from '../components/scan/MyCopies';

const PANELS: Array<PanelDefinition<PortfolioContext>> = [
  ...PORTFOLIO_PANELS,
  {
    // Same id it had in the Hyperliquid section, so a placement someone already
    // dragged it to is kept.
    id: 'copies',
    title: 'My copies',
    pad: false,
    minW: 8,
    minH: 6,
    render: () => <MyCopiesCard />,
  },
];

export function PortfolioDashboard(props: PortfolioProps) {
  const context = usePortfolioContext(props);
  return (
    <>
      <Dashboard
        config={PORTFOLIO_DASHBOARD}
        panels={PANELS}
        context={context}
        /* The CSS scope every `.pf .pf-*` rule matches against - see Portfolio.css. */
        className="pf"
      />
      <IndexPrompt address={props.address} />
    </>
  );
}
