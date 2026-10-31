/**
 * The admin suite's entry (admin.html, served only on dev.valuedesk.so). The site's
 * fonts and tokens (styles.css), its own sheet on top; nothing else of the site runs
 * here - no analytics, no error reporter, no terms gate.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/asap/400.css';
import '@fontsource/asap/500.css';
import '../styles.css';
// The main app's own pieces, not the suite's: the leaderboard's switch and search (lbp-seg,
// lbp-search), the Status page's card (st-*), the Excluded page's figures (ex-stat).
import '../components/leaderboard/LeaderboardPage.css';
import '../status/status.css';
import '../components/excluded/excluded.css';
import './admin.css';
import { AdminApp } from './AdminApp';
import { AdminBoundary, reportPageError } from './Crash';

// Anything thrown outside a render (a handler, a promise) is logged too; a render error shows the card (Crash.tsx).
addEventListener('error', (e) => reportPageError(e.error ?? e.message, `window ${e.filename ?? ''}:${e.lineno ?? ''}`));
addEventListener('unhandledrejection', (e) => reportPageError(e.reason, 'promise'));

createRoot(document.getElementById('admin-root')!).render(
  <StrictMode>
    <AdminBoundary>
      <AdminApp />
    </AdminBoundary>
  </StrictMode>,
);
