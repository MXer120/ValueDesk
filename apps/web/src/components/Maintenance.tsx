/**
 * Exchange maintenance status + the announcements feed.
 *
 * THE RULE THIS COMPONENT EXISTS TO OBEY: no maintenance WINDOW is ever
 * displayed or inferred. Every historical maintenance article carries
 * startTime = endTime = 0; the actual window exists only as English prose inside
 * the article body. Parsing a date out of that prose and drawing it as a window
 * - especially as a band over a chart - would tell a trader that a real price
 * move happened during an exchange outage. That is a lie a trader can act on, so
 * the only timestamp shown for an article is `createdAt`, which is when the
 * notice was PUBLISHED, and it is labelled as such.
 *
 * The live status flag is the one trustworthy "is it down right now" signal, and
 * it is a separate service from the announcements feed.
 */
import { useEffect, useState } from 'react';
import { useAsync } from '../hooks';
import { useMaintenanceStatus } from './MaintenanceBanner';
import { fmtDateTime, fmtTime } from '../format';
import './Maintenance.css';
import { LoadFailed, logLoadFailure, useLoadFailedToast } from './LoadFailed';

/**
 * What the proxy reports. `status` is upstream's enum verbatim -
 * NORMAL | ALL_MAINTENANCE | CHAIN_MAINTENANCE - or null when the service could
 * not be reached. `maintenance` is already computed server-side as
 * "status is present and is not NORMAL, or the host answered HTTP 503"; the
 * comparison is never an equality test against a 'MAINTENANCE' string, because
 * no such value exists and testing for it would report "up" during an outage.
 */
export interface MaintenanceStatus {
  reachable: boolean;
  maintenance: boolean;
  /**
   * What `maintenance` rests on: 'status' means SoDEX declared it, 'http-503'
   * means a SoDEX host returned 503 within the last 90s. Kept apart so the
   * screen can say which, instead of implying a declared outage from a 503.
   */
  reason: 'status' | 'http-503' | null;
  status: string | null;
  /** The 503 that is still inside the observation window, if any. */
  recent503: { host: string; agoMs: number } | null;
  /** Unit is not documented by the API. Rendered raw, never as minutes/hours. */
  maintenanceDuration: number | null;
  /** Seconds epoch (x1000 for a JS Date), or null. */
  createTime: number | null;
  updateTime: number | null;
  /** Millisecond epoch, our clock: when this reading was taken. */
  checkedAt: number;
  error: string | null;
}

interface Announcement {
  id: number;
  title: string;
  style: string;
  labels: string[];
  /** Seconds epoch - publication time. NOT a maintenance window boundary. */
  createdAt: number;
}

interface AnnouncementDetail extends Announcement {
  /** Already flattened to plain text by the backend; no HTML reaches the DOM. */
  text: string;
}

/** See the identical note in Leaderboard.tsx - the orchestrator folds this into api.ts. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Malformed response from ${path}`);
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const LABELS = ['Updates', 'Listings', 'Delistings', 'Campaigns', 'FAQ'] as const;

export function Maintenance({
  onStatusChange,
}: {
  /** Optional lift-out, so the app shell can raise its own banner on the same reading. */
  onStatusChange?: (s: MaintenanceStatus) => void;
}) {
  const [label, setLabel] = useState<string>('');
  const [openId, setOpenId] = useState<number | null>(null);

  // 45s sits inside the requested 30-60s band, one poll shared with the shell's
  // banner (MaintenanceBanner.tsx). The backend additionally caches for 15s, so
  // N open tabs cost far fewer than N upstream requests.
  const { data: status, error: statusError, refresh: refreshStatus } = useMaintenanceStatus();

  // Either our backend or SoDEX's status service failed to answer: the page
  // says only "Exchange status couldn't load.", the reason goes to the console.
  const statusFailure = statusError ?? (status?.status ? null : status?.error ?? null);
  useEffect(() => {
    if (statusFailure) logLoadFailure('Exchange status', statusFailure);
  }, [statusFailure]);

  useEffect(() => {
    if (status) onStatusChange?.(status);
    // onStatusChange is intentionally not a dependency: a parent that passes an
    // inline arrow would otherwise re-fire this on every one of its renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const { data: feed, error: feedError, loading: feedLoading } = useAsync<{
    count: number;
    items: Announcement[];
  }>(
    () =>
      getJson(`/api/external/announcements?page=1&size=20&lang=en${label ? `&label=${label}` : ''}`),
    [label],
    { pollMs: 5 * 60_000 },
  );

  const { data: detail, error: detailError, loading: detailLoading } = useAsync<AnnouncementDetail>(

    () => getJson<AnnouncementDetail>(`/api/external/announcements/${openId}?lang=en`),
    [openId],
    { enabled: openId !== null },
  );
  useLoadFailedToast(feedError, 'Announcements');
  useLoadFailedToast(detailError, 'Announcement');

  // Three states, not two: up, down, and "we do not know". A failure to reach
  // the status service is NOT evidence of maintenance - saying so would tell a
  // trader their orders are frozen when their network is the thing that broke.
  const dot = !status ? '' : status.maintenance ? 'warn' : status.reachable ? 'ok' : '';
  const headline = !status
    ? // A failing call to our OWN backend is still "we do not know", not "up" -
      // otherwise a dead local server reads as a healthy exchange.
      statusError
      ? 'Exchange status unknown'
      : 'Checking exchange status…'
    : status.maintenance
      ? status.reason === 'status'
        ? 'Exchange maintenance in progress'
        : // A 503 is evidence that a SoDEX host is down, not a declaration of a
          // maintenance window. The wording says exactly that much and no more.
          'A SoDEX service is returning HTTP 503'
      : status.reachable
        ? 'Exchange operating normally'
        : 'Exchange status unknown';

  return (
    <section className="panel maintenance">
      <div className="panelhead">
        <h2>Status &amp; announcements</h2>
        {status && (
          <span className="muted small">Checked {fmtTime(status.checkedAt)}</span>
        )}
      </div>

      <div className={`mt-status ${status?.maintenance ? 'down' : ''}`}>
        <span className={`statusdot ${dot}`} />
        <div className="mt-status-text">
          <div className={status?.maintenance ? 'warn' : ''}>{headline}</div>
          <div className="muted small">
            {status?.status ? (
              <>
                Reported status <code>{status.status}</code>
                {status.updateTime ? ` · updated ${fmtDateTime(status.updateTime * 1000)}` : ''}
              </>
            ) : statusFailure ? (
              <LoadFailed what="Exchange status" onRetry={refreshStatus} />
            ) : (
              ''
            )}
          </div>
          {/* The API documents no unit for this field and it reads 0 in normal
              operation. Showing it as "minutes" would be an invention, so the
              raw number is shown with the ambiguity stated. */}
          {status?.recent503 && (
            <div className="muted small">
              HTTP 503 seen {Math.round(status.recent503.agoMs / 1000)}s ago from{' '}
              <code>{status.recent503.host}</code>.
            </div>
          )}
          {!!status?.maintenanceDuration && (
            <div className="muted small">
              maintenanceDuration reports {status.maintenanceDuration} (the API documents no unit
              for this field)
            </div>
          )}
        </div>
      </div>

      <div className="mt-feedhead">
        <h3>Announcements</h3>
        <div className="segmented mt-labels">
          <button className={label === '' ? 'active' : ''} onClick={() => setLabel('')}>All</button>
          {LABELS.map((l) => (
            <button key={l} className={label === l ? 'active' : ''} onClick={() => setLabel(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Stated in the UI, not just in a code comment: the reader needs to know
          that the dates below are publication times and that no window is
          implied by them. */}
      <p className="muted small mt-note">
        Dates are publication times. SoDEX publishes no machine-readable maintenance window
        (an article's start/end fields are always zero), so none is shown or inferred here — open an
        article to read the window it describes in its own words.
      </p>


      <ul className="mt-list">
        {feedLoading && !feed && <li className="muted small">Loading…</li>}
        {feed?.items.length === 0 && <li className="muted small">No announcements.</li>}
        {feed?.items.map((a) => {
          const open = openId === a.id;
          return (
            <li key={a.id} className={a.style === 'alert' ? 'alert' : ''}>
              <button
                className="mt-row"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : a.id)}
              >
                <span className="mt-when muted small">
                  {a.createdAt ? fmtDateTime(a.createdAt * 1000) : '-'}
                </span>
                <span className="mt-title">{a.title}</span>
                {a.labels.map((l) => (
                  <span key={l} className="badge mt-label">{l}</span>
                ))}
                <span className="muted mt-chev">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="mt-body small">
                  {detailLoading && !detail && <span className="muted">Loading…</span>}
                  {/* Plain text, rendered as text. The backend stripped the
                      markup, and nothing here re-introduces it - no
                      dangerouslySetInnerHTML anywhere in this component. */}
                  {detail && detail.id === a.id && <p className="mt-text">{detail.text}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
