/**
 * A new build is out, and this tab was not reloaded to it because it runs live algos or
 * copies a reload would stop (lazyPage.ts holdReloadWhile). The line says so on every page;
 * the user reloads once those can stop - or now, knowing it stops them.
 */
import { useEffect, useState } from 'react';
import { UPDATE_HELD_EVENT } from '../lazyPage';

export function UpdateHeldBanner() {
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setHeld(String((e as CustomEvent<unknown>).detail ?? 'a running algo or copy'));
    window.addEventListener(UPDATE_HELD_EVENT, on);
    return () => window.removeEventListener(UPDATE_HELD_EVENT, on);
  }, []);
  if (!held) return null;
  return <UpdateHeldLine held={held} />;
}

/** The line itself (what it says for `held`, e.g. "2 live algos"). */
export function UpdateHeldLine({ held }: { held: string }) {
  return (
    <div className="banner info banner--status" role="status">
      <div className="banner-inner">
        <span className="banner-text">
          A new version of ValueDesk is out. This tab runs {held}, so it was not reloaded; some pages may not open
          until it is. Reload when they can stop.
        </span>
        <button type="button" className="link" onClick={() => window.location.reload()}>
          Reload now (stops them)
        </button>
      </div>
    </div>
  );
}
