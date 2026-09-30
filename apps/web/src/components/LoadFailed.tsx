/**
 * The ONE way a failed read is shown: "<What> couldn't load." - and a Retry
 * when the caller can try again. Never the technical reason (a path, a
 * timeout, a backend's advice): that goes to the console, where
 * `logLoadFailure` puts it, not in front of a trader.
 */
import { useEffect } from 'react';
import { logger } from '../log';
import { useErrorToast } from '../toast';

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

export function LoadFailed({ what, onRetry, className, crashed = false }: {
  what: string;
  onRetry?: () => void;
  className?: string;
  /** A render crash, not a failed read: "<What> stopped working." */
  crashed?: boolean;
}) {
  return (
    <p className={`load-failed${className ? ` ${className}` : ''}`} role="status">
      {crashed ? stoppedWorking(what) : couldntLoad(what)}
      {onRetry && (
        <button type="button" className="load-failed__retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </p>
  );
}
