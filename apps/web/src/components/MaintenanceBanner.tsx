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
import { useSharedPoll } from '../hooks';
import type { MaintenanceStatus } from './Maintenance';
import { bannerMessage } from './maintenanceVerdict';

const STATUS_PATH = '/api/external/maintenance/status';

async function getStatus(): Promise<MaintenanceStatus> {
  const res = await fetch(STATUS_PATH);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Malformed response from ${STATUS_PATH}`);
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as MaintenanceStatus;
}

/**
 * The exchange's maintenance status, every 45 s: ONE poll shared by the shell's
 * banner and the full panel (Maintenance.tsx) when both are mounted - each
 * used to run its own timer for the same answer (every request is an /api
 * function call). Paused while the tab is hidden (sharedPoll.ts).
 */
export function useMaintenanceStatus() {
  return useSharedPoll<MaintenanceStatus>('ext:maintenance:status', getStatus, { pollMs: 45_000 });
}

export function MaintenanceBanner({ onOpenStatus }: { onOpenStatus?: () => void }) {
  // The backend caches for 15s, so N open tabs cost far fewer than N upstream requests.
  const { data } = useMaintenanceStatus();

  // Never assert health. If the poll itself failed we know nothing, and
  // claiming "operating normally" on no evidence would be worse than silence.
  if (!data) return null;

  // The server's verdict, as given (maintenanceVerdict.ts): a status it could
  // not read is not an outage. A value we have never seen is still covered -
  // the server marks any status other than NORMAL as maintenance.
  const message = bannerMessage(data);
  if (!message) return null;

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
