/**
 * The portfolio page, as a dashboard.
 *
 * The page has a fixed layout since 2026-11-05 (components/portfolio/PortfolioPage.tsx):
 * the owner asked for Trade and Wealth tabs over a set order of sections, which a
 * draggable grid cannot promise. Everything it reads comes from `usePortfolioContext`.
 * The panels in PORTFOLIO_PANELS stay: the terminal's widgets and Scan still mount them.
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
import {
  usePortfolioContext,
  type PortfolioProps,
} from '../components/Portfolio';
import type { PortfolioPageLinks } from '../components/portfolio/PortfolioPage';
import { PortfolioPage } from '../components/portfolio/Page';
import { useDevWatch } from '../components/portfolio/devWatch';

export function PortfolioDashboard({ provider, onOpenMarket, onOpenTab, ...props }: PortfolioProps & PortfolioPageLinks) {
  // Localhost only: the version switch can show another wallet, read-only (always null in a build).
  const watch = useDevWatch();
  const context = usePortfolioContext(watch ? { ...props, address: watch, unlocked: false } : props);
  const c = watch ? { ...context, readOnly: true } : context;
  return <PortfolioPage c={c} provider={provider} onOpenMarket={onOpenMarket} onOpenTab={onOpenTab} />;
}
