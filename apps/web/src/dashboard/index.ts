/**
 * Public surface of the dashboard. Import from 'src/dashboard', not from the
 * individual files - the internals (resolve, storage) are free to change.
 */
export { Dashboard, breakpointFor, type DashboardProps } from './Dashboard';
export { PanelChrome, type PanelChromeProps } from './Panel';
export { TradeDashboard } from './TradeDashboard';
export { PortfolioDashboard } from './PortfolioDashboard';
export { PointsDashboard } from './PointsDashboard';
export { ScanDashboard } from './ScanDashboard';
export { TRADE_PANELS, type TradeContext } from './registry';
export { TRADE_DASHBOARD, PORTFOLIO_DASHBOARD, POINTS_DASHBOARD } from './layout';
export {
  BREAKPOINT_ORDER,
  type BreakpointName,
  type DashboardConfig,
  type GridMetrics,
  type PanelDefinition,
  type PanelPlacement,
  type PanelScroll,
  type ResizeMode,
} from './types';
