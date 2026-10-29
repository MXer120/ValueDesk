/**
 * The status page's scheduled maintenance, in one line at the top of every page, in the
 * maintenance banner's place and look (components/MaintenanceBanner.tsx). The whole line
 * is the link to the status page (owner, 2026-10-28: "when there is downtime a
 * notification should appear on any page that brings them to the status page").
 *
 * No request of its own: the notices ride on /api/health, which the shell already
 * reads every 30 s (App.tsx; the server reads them at most every 30 s,
 * apps/server/src/ops/statusNotices.ts). Silent otherwise. Plain text only; the full
 * story is on /status.
 *
 * Not this line's: maintenance IN PROGRESS is the blue notification with its countdown
 * (MaintNote.tsx), which turns green when it is done; incidents, and the data service not
 * answering for HEALTH_DOWN_MS (useHealthDown), are notification cards too
 * (IncidentNote.tsx; owner, 2026-10-29: "this shouldnt be a bar but a normal
 * notification").
 */
import { useEffect, useState } from 'react';
import { STATUS_PATH } from '../router';
import { healthNoticeText, healthNoticesOf } from './statusData';
import type { NavAlert } from '../components/NavMore';

/** How long /api/health must keep failing before the app says the data service is down (one poll can fail). */
export const HEALTH_DOWN_MS = 45_000;

/**
 * Whether the data service has not answered for HEALTH_DOWN_MS: `error` is the health
 * poll's (useAsync), null once it answers again. Not while the browser itself is offline -
 * that is this device's connection, which the status bar shows.
 */
export function useHealthDown(error: string | null): boolean {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setSince(error ? (s) => s ?? Date.now() : null);
  }, [error]);
  useEffect(() => {
    if (since === null) return;
    const left = since + HEALTH_DOWN_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [since]);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return since !== null && !offline && Date.now() - since >= HEALTH_DOWN_MS;
}

/** The navbar's More dot (NavMore.tsx): the worst of what the banner shows. */
export function navAlertOf(health: unknown, down: boolean): NavAlert {
  if (down) return 'down';
  const list = healthNoticesOf(health);
  if (list.some((n) => n.kind === 'incident')) return 'incident';
  if (list.some((n) => n.phase === 'in_progress')) return 'maintenance';
  return null;
}

/** What the line shows: upcoming maintenance (in progress is MaintNote's, incidents IncidentNote's). */
export const bannerNoticesOf = (health: unknown) => healthNoticesOf(health).filter((n) => n.kind === 'maintenance' && n.phase === 'upcoming');

export function SiteNoticeBanner({ health, onOpenStatus }: { health: unknown; onOpenStatus?: () => void }) {
  const list = bannerNoticesOf(health);
  if (!list.length) return null;
  const href = `${STATUS_PATH}#notice-${list[0]!.id}`;
  return (
    <div className="banner info banner--status" role="status">
      <a
        className="banner-inner banner-hit"
        href={href}
        onClick={(e) => {
          if (!onOpenStatus || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onOpenStatus();
          // The notice's anchor on the status page's address: the page scrolls to it once drawn.
          window.history.replaceState(null, '', href);
        }}
      >
        <span className="banner-text">
          {healthNoticeText(list[0]!)}
          {list.length > 1 && <span className="muted"> (and {list.length - 1} more)</span>}
        </span>
        <span className="link">Status page →</span>
      </a>
    </div>
  );
}
