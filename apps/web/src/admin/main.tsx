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
// The app's own segmented switch (lbp-seg), not one of the suite's.
import '../components/leaderboard/LeaderboardPage.css';
import './admin.css';
import { AdminApp } from './AdminApp';

createRoot(document.getElementById('admin-root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
