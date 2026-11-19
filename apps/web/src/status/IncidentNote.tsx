/**
 * The incident notification: an open incident of the status page as a card in the
 * notifications' corner, as the maintenance notice is (MaintNote.tsx) - not a bar across
 * the top (owner, 2026-10-29). Amber for a minor incident or a partial outage, red for an outage and
 * for the data service not answering at all. Hover, keyboard focus or a tap opens what
 * each service goes through, the latest words, since when, and the status page link. It
 * goes when the incident is resolved, or by the X (until it gets worse). The logic and
 * what this browser remembers: incidentState.ts.
 *
 * No request of its own: the incidents ride on /api/health, which the shell reads every
 * 30 s (App.tsx); the probes open and resolve them by themselves (ops/statusAuto.ts).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { STATUS_PATH } from '../router';
import { useConnState } from '../hooks';
import { INCIDENT_KEY, QUIET_KEY, QUIET_MS, connectionView, dismissIncident, incidentKey, incidentView, incidentsShown, indexerMinor, parseDismissed, pruneDismissed, quietUntil, type IncidentView } from './incidentState';
import { WarnMark, usePin } from './MaintNote';
import './maintNote.css';

/** The browser's own word on its network, kept current by its online / offline events. */
const subscribeOnline = (f: () => void) => {
  window.addEventListener('online', f);
  window.addEventListener('offline', f);
  return () => {
    window.removeEventListener('online', f);
    window.removeEventListener('offline', f);
  };
};
const onlineNow = () => typeof navigator === 'undefined' || navigator.onLine !== false;
export const useOnline = (): boolean => useSyncExternalStore(subscribeOnline, onlineNow, () => true);

function readDismissed(): string[] {
  try {
    return parseDismissed(localStorage.getItem(INCIDENT_KEY));
  } catch {
    return [];
  }
}

function writeDismissed(d: readonly string[]): void {
  try {
    localStorage.setItem(INCIDENT_KEY, JSON.stringify(d));
  } catch {
    /* private mode: this tab still remembers it */
  }
}

export function IncidentNote({ health, down = false, onOpenStatus }: { health: unknown; down?: boolean; onOpenStatus?: () => void }) {
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissed);
  const ref = useRef(dismissed);
  const apply = useCallback((next: readonly string[]) => {
    if (next === ref.current) return;
    ref.current = next;
    setDismissed(next);
    writeDismissed(next);
  }, []);
  // A resolved incident's X is forgotten: the next one starts shown.
  useEffect(() => {
    apply(pruneDismissed(ref.current, health));
  }, [health, apply]);
  // Clicked away in another tab: away here too.
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key !== INCIDENT_KEY) return;
      ref.current = parseDismissed(e.newValue);
      setDismissed(ref.current);
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  /* This device offline, or the data service down - worded for this device's link when SoDEX's own socket has
     failed too (a market connection retrying), else for the service (incidentState.ts connectionView). */
  const online = useOnline();
  const { upstream } = useConnState();
  const sodexDown = Object.values(upstream).some((s) => s === 'reconnecting');
  const conn = connectionView({ online, down, sodexDown });
  // One card until it clears; its X holds for this outage only.
  const [connAway, setConnAway] = useState<IncidentView | null>(null);
  useEffect(() => {
    if (!conn) setConnAway(null);
  }, [conn]);
  // Minor indexer-only incidents quieted for a day by one X (incidentState.ts QUIET_MS).
  const [quiet, setQuiet] = useState(() => { try { return quietUntil(localStorage.getItem(QUIET_KEY)); } catch { return 0; } });
  const quietOn = quiet > Date.now();
  const pin = usePin();
  const connShown = conn && conn !== connAway ? conn : null;
  const shown = conn ? [] : incidentsShown(health, dismissed).filter((n) => !(quietOn && indexerMinor(n)));
  if (!pin || (!shown.length && !connShown)) return null;
  return createPortal(
    <>
      {connShown && <IncidentCard key={connShown.title} v={connShown} href={STATUS_PATH} onOpenStatus={onOpenStatus} onDismiss={() => setConnAway(connShown)} />}
      {shown.map((n) => (
        <IncidentCard
          key={n.id}
          v={incidentView(n)}
          href={`${STATUS_PATH}#notice-${n.id}`}
          onOpenStatus={onOpenStatus}
          onDismiss={() => {
            apply(dismissIncident(ref.current, incidentKey(n)));
            if (indexerMinor(n)) {
              const until = Date.now() + QUIET_MS;
              setQuiet(until);
              try { localStorage.setItem(QUIET_KEY, String(until)); } catch { /* this tab still remembers it */ }
            }
          }}
        />
      ))}
    </>,
    pin,
  );
}

/** One card (exported for the tests). */
export function IncidentCard({ v, href, onDismiss, onOpenStatus }: {
  v: IncidentView;
  href: string;
  onDismiss: () => void;
  onOpenStatus?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    setLeaving(true);
    window.setTimeout(onDismiss, 170);
  };
  return (
    <aside
      className={`toast mn-note mn-note--${v.tone}${open ? ' is-open' : ''}${leaving ? ' is-leaving' : ''}`}
      role="status"
      aria-label={`${v.title}: ${v.line}`}
    >
      <div
        className="mn-note__top"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          setOpen((o) => !o);
        }}
      >
        <span className="toast__ic" aria-hidden="true">
          <span className="toast__glyph"><WarnMark /></span>
        </span>
        <div className="toast__body">
          <span className="toast__title">{v.title}</span>
          <span className="toast__detail">{v.line}</span>
        </div>
        <button type="button" className="toast__x" aria-label="Dismiss" onClick={close}>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="mn-note__more">
        <div className="mn-note__panel">
          {v.rows.length > 0 && (
            <ul className="mn-note__parts">
              {v.rows.map((r) => (
                <li key={r.id} className={`mn-note__part is-${r.impact}`}>
                  <i className="mn-note__dot" aria-hidden="true" />
                  <span className="mn-note__svc">{r.name}</span>
                  <span className="mn-note__state">{r.state}</span>
                </li>
              ))}
            </ul>
          )}
          {v.note && <p className="mn-note__note">{v.note}</p>}
          {v.since && <p className="mn-note__eta">{v.since}</p>}
          {!v.local && <a
            className="mn-note__link"
            href={href}
            onClick={(e) => {
              if (!onOpenStatus || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              onOpenStatus();
              // The notice's anchor on the status page's address: the page scrolls to it once drawn.
              if (href !== STATUS_PATH) window.history.replaceState(null, '', href);
            }}
          >
            Status page →
          </a>}
        </div>
      </div>
    </aside>
  );
}
