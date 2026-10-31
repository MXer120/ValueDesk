/**
 * The one question about analytics, for visitors who accepted the terms before the
 * site had analytics to ask about (it shipped 2026-10-31): they never saw it in the
 * terms popup's "Accept all", and the popup does not come back once accepted.
 *
 * Asked once, a few seconds after the page settles, only while the visitor has
 * accepted the current terms here and never answered (analyticsConsent.ts
 * analyticsDecided). "No thanks" and "Allow" are the same size side by side, as in
 * the terms popup (gate.css lg-pair: refusing exactly as easy as allowing). Either
 * answer is kept; closing it with the cross only hides it for this page load.
 * Nothing is measured before "Allow" (analytics/tracker.ts).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { allowAnalytics, analyticsDecided, declineAnalytics, subscribeAnalyticsConsent } from './analyticsConsent';
import { browseAccepted, useAcceptanceRevision } from './acceptance';
import { LegalLink } from './LegalGate';

/** How long after load the question waits: never over the first paint or the first click. */
export const ASK_AFTER_MS = 6_000;

export function AnalyticsPrompt() {
  useAcceptanceRevision();
  const decided = useSyncExternalStore(subscribeAnalyticsConsent, analyticsDecided, analyticsDecided);
  const [due, setDue] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDue(true), ASK_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  if (!due || closed || decided || !browseAccepted()) return null;
  return (
    <aside className="lg-ask" role="dialog" aria-labelledby="lg-ask-title" aria-describedby="lg-ask-line">
      <div className="lg-ask__head">
        <h2 id="lg-ask-title" className="lg-ask__title">Help us improve ValueDesk</h2>
        <button type="button" className="lg-ask__x" aria-label="Not now" title="Not now" onClick={() => setClosed(true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <p id="lg-ask-line" className="lg-small">
        May ValueDesk measure which pages and features you use? On its own server only - no IP address, no third party, never used for ads. You can change this any time. <LegalLink page="cookies">Details</LegalLink>
      </p>
      <div className="lg-pair">
        <button type="button" className="lg-cta lg-cta--secondary" onClick={() => declineAnalytics()}>No thanks</button>
        <button type="button" className="lg-cta" onClick={() => allowAnalytics()}>Allow</button>
      </div>
    </aside>
  );
}
