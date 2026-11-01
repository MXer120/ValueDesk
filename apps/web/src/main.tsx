import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// IBM Plex Sans, self-hosted (SIL OFL). Only the two weights the UI actually
// uses - 400 for labels, 500 for values. `body` in styles.css has named this
// family all along; until now nothing loaded it and every glyph fell through
// to the system sans, which is why the type never matched the reference.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
// Asap carries the NUMERALS. The reference terminal runs two families - IBM
// Plex Sans for text (48 elements) and a DIN face for numbers (107 elements) -
// and numbers are the majority of a trading screen. Rendering them in Plex made
// every figure ~11% wider, which three separate reviews reported as three
// unrelated symptoms before it resolved to this one cause. DIN Alternate is
// commercially licensed; Asap is SIL OFL and the closest open match by measured
// advance width (digit run 64.20 vs DIN's 63.98, against Plex's 72.00).
import '@fontsource/asap/400.css';
import '@fontsource/asap/500.css';
// Space Grotesk (SIL OFL): the display face of page headlines (--font-display),
// one weight. Only the subset a page's text needs is fetched (unicode-range).
import '@fontsource/space-grotesk/600.css';
import { App } from './App';
import { installGlobalLogging } from './log';
import { installErrorReporting } from './errorReport';
import { installChunkErrorReload } from './lazyPage';
import { captureBoot } from './algo/tabLife';
import { SiteGate } from './legal/LegalGate';
import { AnalyticsPrompt } from './legal/AnalyticsPrompt';
import { loadViewerGeo } from './legal/geo';
import { startAnalytics } from './analytics/usage';
import { startAttention } from './attention';
import './styles.css';
import { useNumStyle } from './numStyle';

// Before the first render, so an error thrown while mounting is logged too.
// See log.ts for levels, ?debug=<ns>, and the __vs console handle.
installGlobalLogging();
// Crashes in this browser reach the owner, scrubbed and counted (errorReport.ts); a production build only.
installErrorReporting();
// A release replaced the file names while this tab was open: load the current build once (lazyPage.ts).
installChunkErrorReload();
// Before anything runs: whether this page is a reload of the tab that ran the browser algos, or that tab was closed (algo/tabLife.ts).
captureBoot();
// Where this visitor is, as the edge sees it (legal/geo.ts): one small request, answered by the /api function.
void loadViewerGeo();
// ValueDesk's own usage analytics (analytics/usage.ts): nothing at all - no storage, no request - until the visitor allows it.
startAnalytics();
startAttention();
// window.__vsTest for the UI specs (testBridge.ts): the dev server only - a production build drops this branch and the module.
if (import.meta.env.DEV) void import('./testBridge').then((m) => m.installTestBridge());

/**
 * The root re-renders when the number format changes (Settings > Appearance):
 * it builds its elements afresh, so the whole tree renders again with the new
 * separators - at once, without a reload, and keeping every page's state.
 */
function Root() {
  useNumStyle();
  return (
    // In a sanctioned place the app is not mounted at all: only the legal pages (legal/LegalGate.tsx).
    <SiteGate>
      <App />
      {/* Analytics, asked once of visitors who accepted the terms before it existed (legal/AnalyticsPrompt.tsx). */}
      <AnalyticsPrompt />
    </SiteGate>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
