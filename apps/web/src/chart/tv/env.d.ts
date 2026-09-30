/**
 * The chart switch. `VITE_CHART=tradingview` (in apps/web/.env.local, then
 * restart Vite) selects TradingView Advanced Charts when the library files are
 * present in public/charting_library/. Anything else - including unset - keeps
 * the klinecharts chart. See docs/TRADINGVIEW.md.
 */
interface ImportMetaEnv {
  readonly VITE_CHART?: string;
}
