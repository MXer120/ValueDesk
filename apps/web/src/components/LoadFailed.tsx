/**
 * The ONE way a failed read is shown: "<What> couldn't load." - and a Retry
 * when the caller can try again. Never the technical reason (a path, a
 * timeout, a backend's advice): that goes to the console, where
 * `logLoadFailure` puts it, not in front of a trader.
 */
import { useEffect, useRef, useState } from 'react';
import { logger } from '../log';
import { useErrorToast } from '../toast';
import { EmptyState } from './EmptyState';
import { FEEDBACK_LABEL, FeedbackIcon, openFeedback } from '../feedback/FeedbackButton';
import { describeElement } from '../feedback/element';
import { MENU_ICONS, TabMenu, menuAt } from '../dashboard/tabExtras';
import { updatingLine } from './readState';

const log = logger('load');

/** "Positions couldn't load." - a READ that failed. */
export const couldntLoad = (what: string): string => `${what} couldn't load.`;
/** "Chart stopped working." - a part of the page that CRASHED (not a failed read). */
export const stoppedWorking = (what: string): string => `${what} stopped working.`;

/** Keep the detail for debugging (?debug=load, __vs.dump()), show only the generic line. */
export function logLoadFailure(what: string, e: unknown): void {
  log.warn(`${what} couldn't load`, { error: e instanceof Error ? e.message : String(e) });
}

/**
 * For a read with no inline place to say it failed (the chart's order lines, a
 * background poll): the same generic line, as a toast. The technical detail
 * goes to the console via `logLoadFailure`, never into the toast - the toast
 * only ever receives "<What> couldn't load.", so it cannot show a path, a
 * timeout or backend advice however the request failed.
 */
export function useLoadFailedToast(error: unknown, what: string, retry?: () => void): void {
  useEffect(() => {
    if (error) logLoadFailure(what, error);
  }, [error, what]);
  useErrorToast(error ? couldntLoad(what) : null, what, retry);
}

/**
 * Under data kept through a failed refresh (readState.ts): not the failure
 * card, only a quiet "Updating…" - with the copy's age once it is a minute
 * old. The reason goes to the console, as for LoadFailed. `at`: when the data
 * on screen was read.
 */
export function Updating({ what, error, at, className }: { what: string; error: unknown; at?: number | null; className?: string }) {
  const detail = error instanceof Error ? error.message : String(error);
  useEffect(() => { logLoadFailure(what, error); }, [what, detail]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <p
      className={`load-updating${className ? ` ${className}` : ''}`}
      role="status"
      title={`The last refresh of ${what.toLowerCase()} did not come through; this is the copy from before. It refreshes on its own.`}
    >
      {updatingLine(now, at)}
    </p>
  );
}

/**
 * Drawn as the app's empty state (EmptyState.tsx, as "No wallet connected"): a warning icon,
 * "<What> couldn't load.", one line, then Retry and Send feedback - the feedback chat opens with
 * this spot on the page attached, so a report says where it broke. A right-click on it offers
 * the same two.
 */
export function LoadFailed({ what, onRetry, className, crashed = false }: {
  what: string;
  onRetry?: () => void;
  className?: string;
  /** A render crash, not a failed read: "<What> stopped working." */
  crashed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const report = () => openFeedback(ref.current ? { element: describeElement(ref.current, window.location.pathname) } : {});
  return (
    <div ref={ref} className={`load-failed${className ? ` ${className}` : ''}`} onContextMenu={(e) => setMenu(menuAt(e))}>
      <EmptyState
        icon="alert"
        compact
        title={crashed ? stoppedWorking(what) : couldntLoad(what)}
        line={crashed
          ? 'This part of the page ran into a problem. Retry starts it again; the rest of the page is fine.'
          : 'This is usually gone on a retry. If it keeps happening, tell us: where it happened comes with your message.'}
        action={(
          <span className="load-failed__acts">
            {onRetry && <button type="button" className="empty-state__cta" onClick={onRetry}>Retry</button>}
            <button type="button" className="load-failed__fb" onClick={report}><FeedbackIcon />{FEEDBACK_LABEL}</button>
          </span>
        )}
      />
      {menu && (
        <TabMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            ...(onRetry ? [{ label: 'Retry', icon: MENU_ICONS.reset, onClick: onRetry }] : []),
            { label: 'Send feedback about this', icon: <FeedbackIcon />, onClick: report },
          ]}
        />
      )}
    </div>
  );
}
