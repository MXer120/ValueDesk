/**
 * The maintenance notification: a card in the notifications' corner (toast.tsx's pin,
 * docked in the navbar's lane where the bar has one), blue while an update runs, with
 * its estimated end ("expected by 14:32 · about 4 min left"; past it, "taking longer than
 * expected", still blue); green with a checkmark only once the server says it was
 * completed ok; amber when it was rolled back or ended unconfirmed. Hover, keyboard focus
 * or a tap opens what each part goes through - down, partly down, not affected - the
 * server's latest words and the estimate. Blue and amber go only by the X; green goes by
 * itself after MAINT_DONE_MS like any good-news notification (owner, 2026-10-29). The
 * logic and what this browser remembers: maintState.ts.
 *
 * No request of its own: the maintenance rides on /api/health, which the shell reads
 * every 30 s (App.tsx).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { STATUS_PATH } from '../router';
import { TTL } from '../toast';
import {
  MAINT_KEY, PART_TEXT, maintDismiss, maintParts, maintShown, maintStep, maintView, parseMaint, withDismissals,
  type MaintSeen, type MaintState,
} from './maintState';
import './maintNote.css';

/** How long the green "Maintenance complete" stays: as long as any good news (toast.tsx TTL.ok). */
export const MAINT_DONE_MS = TTL.ok;

function readMaint(): MaintState {
  try {
    return parseMaint(localStorage.getItem(MAINT_KEY));
  } catch {
    return [];
  }
}

function writeMaint(s: MaintState): void {
  try {
    localStorage.setItem(MAINT_KEY, JSON.stringify(s));
  } catch {
    /* private mode: this tab still shows it */
  }
}

/** The toasts' pin (toast.tsx), found again when the rail moves between the corner and the navbar's lane. Also the incident cards' (IncidentNote.tsx). */
export function usePin(): HTMLElement | null {
  const [pin, setPin] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setPin(document.getElementById('vs-toast-pin'));
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return pin;
}

export function MaintNote({ health, onOpenStatus }: { health: unknown; onOpenStatus?: () => void }) {
  const [state, setState] = useState<MaintState>(readMaint);
  const ref = useRef(state);
  const apply = useCallback((next: MaintState) => {
    if (next === ref.current) return;
    ref.current = next;
    setState(next);
    writeMaint(next);
  }, []);
  useEffect(() => {
    apply(maintStep(ref.current, health, Date.now()));
  }, [health, apply]);
  // Clicked away in another tab: away here too.
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key !== MAINT_KEY) return;
      const next = withDismissals(ref.current, parseMaint(e.newValue));
      if (next === ref.current) return;
      ref.current = next;
      setState(next);
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const shown = maintShown(state);
  const live = shown.some((s) => s.end === null && s.endsAt !== null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    // The estimate is said in minutes: a few seconds of lag is nothing.
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [live]);
  const pin = usePin();
  if (!shown.length || !pin) return null;
  return createPortal(
    <>
      {shown.map((s) => (
        <MaintCard key={s.id} s={s} now={now} onOpenStatus={onOpenStatus} onDismiss={() => apply(maintDismiss(ref.current, s.id))} />
      ))}
    </>,
    pin,
  );
}

/** One card (exported for the tests). */
export function MaintCard({ s, now, onDismiss, onOpenStatus, timeZone }: {
  s: MaintSeen;
  now: number;
  onDismiss: () => void;
  onOpenStatus?: () => void;
  timeZone?: string;
}) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const v = maintView(s, now, timeZone);
  const done = v.tone === 'done';
  const rows = maintParts(s);
  const href = `${STATUS_PATH}#notice-${s.id}`;
  const close = () => {
    setLeaving(true);
    window.setTimeout(onDismiss, 170);
  };
  /* Done, it goes by itself as good news does (toast.tsx), held while the pointer is on it: the time
     left is kept and runs on when it leaves, as the timer bar does. In progress, only the X takes it. */
  const [held, setHeld] = useState(false);
  const left = useRef(MAINT_DONE_MS);
  useEffect(() => {
    if (!done || held || leaving) return;
    const from = Date.now();
    const t = window.setTimeout(close, left.current);
    return () => {
      window.clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - from));
    };
  }, [done, held, leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <aside
      className={`toast mn-note mn-note--${v.tone}${open ? ' is-open' : ''}${leaving ? ' is-leaving' : ''}`}
      role="status"
      aria-label={`${v.title}: ${v.line}`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div
        className="mn-note__top"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          setOpen((o) => !o);
        }}
      >
        <span className="toast__ic" aria-hidden="true">
          <span className="toast__glyph">{v.tone === 'done' ? <CheckMark /> : v.tone === 'warn' ? <WarnMark /> : <WrenchMark />}</span>
        </span>
        <div className="toast__body">
          <span className="toast__title">{v.title}</span>
          <span className="toast__detail">
            {v.line}
            {v.left && <span className="mn-note__left"> · {v.left} left</span>}
          </span>
        </div>
        {/* The only way it goes: one click, no confirmation. */}
        <button type="button" className="toast__x" aria-label="Dismiss" onClick={close}>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="mn-note__more">
        <div className="mn-note__panel">
          <span className="mn-note__name">{s.title}</span>
          {rows.length > 0 && (
            <ul className="mn-note__parts">
              {rows.map((r) => (
                <li key={r.id} className={`mn-note__part is-${r.impact}`}>
                  <i className="mn-note__dot" aria-hidden="true" />
                  <span className="mn-note__svc">{r.name}</span>
                  <span className="mn-note__state">
                    {r.impact === 'none' ? PART_TEXT.none : s.end === 'ok' ? 'Back to normal' : s.end === 'rolled_back' ? 'As before' : PART_TEXT[r.impact]}
                  </span>
                  {r.text && (s.end === null || s.end === 'unconfirmed') && <span className="mn-note__why">{r.text}</span>}
                </li>
              ))}
            </ul>
          )}
          {s.note && v.tone !== 'done' && <p className="mn-note__note">{s.note}</p>}
          {v.eta && <p className="mn-note__eta">{v.eta}</p>}
          <a
            className="mn-note__link"
            href={href}
            onClick={(e) => {
              if (!onOpenStatus || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              onOpenStatus();
              window.history.replaceState(null, '', href);
            }}
          >
            Status page →
          </a>
        </div>
      </div>
      {done && !leaving && <span className="toast__timer" style={{ animationDuration: `${MAINT_DONE_MS}ms` }} />}
    </aside>
  );
}

function WrenchMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M10.6 2.4a3.3 3.3 0 0 0-3.9 4.3L2.6 10.8a1.3 1.3 0 0 0 1.8 1.8l4.1-4.1a3.3 3.3 0 0 0 4.3-3.9l-2 2-1.9-.4-.4-1.9Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function WarnMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2.4 14.2 13.2H1.8Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.4v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8.4 6.6 11.4 12.6 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
