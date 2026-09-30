/**
 * One-line venue-status banner for the app shell.
 *
 * Deliberately NOT the full `<Maintenance />` panel. That component is a
 * page-level browser - status, category tabs and twenty expandable articles,
 * several thousand pixels tall - and mounting it in the shell pushed the entire
 * trading interface below the fold on every tab. The full browser lives on the
 * Stats page; this renders nothing at all while the exchange is healthy, and a
 * single compact line when it is not.
 *
 * Silence is the correct default: a permanent "everything is fine" strip on a
 * trading screen is pure noise, and noise is what stops people reading the
 * banner on the day it finally says something.
 */
import { useAsync } from '../hooks';
import type { MaintenanceStatus } from './Maintenance';

async function getStatus(): Promise<MaintenanceStatus> {
  const res = await fetch('/api/external/maintenance/status');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as MaintenanceStatus;
}

export function MaintenanceBanner({ onOpenStatus }: { onOpenStatus?: () => void }) {
  // Same 45s cadence as the full panel, and the backend caches for 15s, so
  // having both mounted does not double the upstream load.
  const { data } = useAsync<MaintenanceStatus>(getStatus, [], { pollMs: 45_000 });

  // Never assert health. If the poll itself failed we know nothing, and
  // claiming "operating normally" on no evidence would be worse than silence.
  if (!data) return null;

  // Compare against NORMAL rather than for a specific outage value: the enum is
  // NORMAL | ALL_MAINTENANCE | CHAIN_MAINTENANCE, and matching on the negative
  // means a value we have never seen is still treated as "not healthy".
  const degraded = data.status !== 'NORMAL';
  const via503 = Boolean((data as { via503?: boolean }).via503);
  if (!degraded && !via503) return null;

  const message = degraded
    ? data.status === 'CHAIN_MAINTENANCE'
      ? 'SoDEX reports chain maintenance. Deposits and withdrawals may be unavailable.'
      : 'SoDEX reports maintenance. Trading may be unavailable.'
    : 'A SoDEX service is returning HTTP 503, which usually means maintenance.';

  return (
    <div className="banner warn" role="status">
      <div className="banner-inner">
        <span className="banner-text">
          {message}
          {data.maintenanceDuration ? (
            // Rendered raw and unqualified on purpose - the API documents no
            // unit for this field, so presenting it as "minutes" or "seconds"
            // would be a guess about how long the user is locked out.
            <span className="muted"> Reported duration value: {data.maintenanceDuration}.</span>
          ) : null}
        </span>
        {onOpenStatus && (
          <button className="link" onClick={onOpenStatus}>
            Read announcements
          </button>
        )}
      </div>
    </div>
  );
}
