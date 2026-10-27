/**
 * The status page's open incidents and maintenance, in one line at the top of the
 * app, in the maintenance banner's place and look (components/MaintenanceBanner.tsx).
 *
 * No request of its own: the notices ride on /api/health, which the shell already
 * reads every 30 s (App.tsx; the server reads them at most every 30 s,
 * apps/server/src/ops/statusNotices.ts). Silent unless there is one: an open
 * incident, maintenance in progress, or maintenance starting within a day. Plain
 * text only; the full story is on /status.
 */
import { healthNoticeText, healthNoticesOf } from './statusData';

export function SiteNoticeBanner({ health }: { health: unknown }) {
  const list = healthNoticesOf(health);
  if (!list.length) return null;
  const urgent = list.some((n) => n.kind === 'incident' || n.phase === 'in_progress');
  return (
    <div className={`banner ${urgent ? 'warn' : 'info'}`} role="status">
      <div className="banner-inner">
        <span className="banner-text">
          {healthNoticeText(list[0]!)}
          {list.length > 1 && <span className="muted"> (and {list.length - 1} more)</span>}
        </span>
        <a className="link" href={`/status#notice-${list[0]!.id}`}>Status page</a>
      </div>
    </div>
  );
}
