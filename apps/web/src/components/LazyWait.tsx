/**
 * In the place of a part whose code is still coming (a terminal widget, an Explore view): nothing for the first
 * WAIT_MS - most loads are in by then, after the load-event prefetch - then the app's spinner (.pf-spin,
 * Portfolio.css) in the middle of the part's box (.dash-wait, dashboard.css; `page` gives a page view its height).
 */
import { useEffect, useState } from 'react';

/** How long a part may wait for its code before the spinner shows. */
export const WAIT_MS = 250;

export function LazyWait({ page = false }: { page?: boolean }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLate(true), WAIT_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={`dash-wait${page ? ' dash-wait--page' : ''}`} role="status" aria-busy="true" aria-label="Loading">
      {late && <span className="pf-spin" aria-hidden="true" />}
    </div>
  );
}
