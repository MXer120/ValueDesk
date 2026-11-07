/**
 * Indexing, as a toast in the top-right stack.
 *
 * It asks once, then again after 48 hours. Once the walk is running it stays
 * until that walk is finished, including while paused. Hover (or a tap on the
 * card) opens pause, speed, and clear.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { earliestFlowTime } from '../accountData';
import { indexKey, parseIndex, readSpeed, SPEED_ORDER, SPEEDS, type SpeedId } from '../setup/stats';
import {
  IDLE_PROGRESS, indexEnabled, resetIndex, setIndexEnabled, setIndexSpeed, subscribeIndex, type IndexProgress,
} from '../setup/indexer';
import './IndexPrompt.css';

const SEEN = 'vs.index.promptAt';
const GAP = 48 * 60 * 60 * 1000;

function due(): boolean {
  try {
    const t = Number(localStorage.getItem(SEEN) || 0);
    return !t || Date.now() - t > GAP;
  } catch {
    return false;
  }
}

function markSeen(): void {
  try { localStorage.setItem(SEEN, String(Date.now())); } catch { /* next visit asks again */ }
}

function storedSpeed(): SpeedId {
  try { return readSpeed((k) => localStorage.getItem(k)); }
  catch { return 'default'; }
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Mean of every stream. A stream that has not started is 0. One that is still
 * paging stops short of 1: the first deposit is not the end of trade history,
 * so a cursor past that date must not read as finished.
 */
function coverage(address: string, earliest: number): number | null {
  let idx;
  try { idx = parseIndex(localStorage.getItem(indexKey(address)), address); }
  catch { return null; }
  const cursors = Object.values(idx.c);
  if (!cursors.length) return null;
  const span = Date.now() - earliest;
  if (span <= 0) return null;
  let sum = 0;
  let started = 0;
  for (const c of cursors) {
    if (c.x) { sum += 1; started += 1; continue; }
    if (typeof c.b !== 'number' || c.b <= 0) continue;
    started += 1;
    const walked = Math.max(0, Date.now() - c.b);
    sum += Math.max(0, Math.min(0.99, walked / span));
  }
  if (!started) return null;
  return (sum / cursors.length) * 100;
}

export function IndexPrompt({ address }: { address: string | null }) {
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [open, setOpen] = useState(false);
  const [engaged, setEngaged] = useState(() => indexEnabled());
  const [on, setOn] = useState(() => indexEnabled());
  const [speed, setSpeed] = useState<SpeedId>(storedSpeed);
  const [earliest, setEarliest] = useState<number | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [historyUp, setHistoryUp] = useState(false);
  useEffect(() => {
    const sync = () => setHistoryUp(document.body.dataset.vsHistory === 'on');
    sync();
    window.addEventListener('vs-history', sync);
    return () => window.removeEventListener('vs-history', sync);
  }, []);

  useEffect(() => {
    setSlot(document.getElementById('vs-toast-pin'));
  }, []);

  useEffect(() => subscribeIndex(setProgress), []);

  useEffect(() => {
    const sync = () => {
      const enabled = indexEnabled();
      setOn(enabled);
      if (enabled) setEngaged(true);
    };
    window.addEventListener('vs-index', sync);
    return () => window.removeEventListener('vs-index', sync);
  }, []);

  useEffect(() => {
    if (!address) { setOpen(false); return; }
    if (progress.done && (engaged || on)) { setOpen(false); return; }
    if (on || engaged) { setOpen(true); return; }
    // Not over the portfolio's own history walk (HistoryNote): one indexing notification at a time.
    setOpen(due() && document.body.dataset.vsHistory !== 'on');
  }, [address, progress.done, engaged, on]);

  useEffect(() => {
    if (!engaged || !address) return;
    let stop = false;
    earliestFlowTime(address).then((t) => { if (!stop) setEarliest(t); }).catch(() => { if (!stop) setEarliest(null); });
    return () => { stop = true; };
  }, [engaged, address]);

  useEffect(() => {
    if (!engaged || !address || earliest === null) { setPct(null); return; }
    if (progress.done) { setPct(100); return; }
    const raw = coverage(address, earliest);
    // 100 is only the caught-up flag. Rounding a 99.6 mean used to say 100%
    // while a stream was still paging.
    setPct(raw === null ? null : Math.min(99, raw));
  }, [engaged, address, earliest, progress.pages, progress.done, progress.cursorMs]);

  // One indexing notification at a time: while the portfolio history's is up (HistoryNote.tsx), it speaks for both.
  if (!open || !address || !slot || historyUp) return null;

  const detail = progress.notice
    ? progress.notice
    : [
      progress.pages === 0 && on ? 'Starting…' : (progress.pages > 0 ? `${progress.pages} ${progress.pages === 1 ? 'page' : 'pages'}` : ''),
      progress.stream,
      progress.cursorMs ? `${progress.done ? 'through' : 'back to'} ${when(progress.cursorMs)}` : '',
    ].filter(Boolean).join(' · ');

  const card = (
    <aside
      className={`toast toast--info ix-note${held ? ' is-open' : ''}${on ? ' is-on' : ''}`}
      role="status"
      onPointerEnter={() => setSpeed(storedSpeed())}
    >
      <div
        className="ix-note__top"
        onClick={(e) => {
          if (!engaged) return;
          if ((e.target as HTMLElement).closest('button')) return;
          setHeld((v) => !v);
        }}
      >
        <span className="toast__ic" aria-hidden="true">
          <span className="toast__glyph">
            {engaged ? (on ? <i className="ix-note__spin" /> : <PauseMark />) : <InfoMark />}
          </span>
        </span>
        <div className="toast__body">
          <span className="toast__title">{engaged ? (on ? 'Indexing' : 'Indexing paused') : 'Indexing'}</span>
          <span className="toast__detail">
            {engaged ? (detail || 'Counting history on this browser.') : 'Fees, funding, volume, and fills, kept on this browser.'}
          </span>
        </div>
        {engaged ? (
          <span className="ix-note__pct">
            {pct === null ? '…' : `${progress.done ? 100 : Math.min(99, Math.floor(pct))}%`}
          </span>
        ) : (
          <>
            <button type="button" className="toast__retry" onClick={() => {
              setEngaged(true);
              setOn(true);
              setIndexSpeed(speed);
              setIndexEnabled(true, address);
            }}>Start</button>
            <button type="button" className="toast__x" aria-label="Not now" onClick={() => { markSeen(); setOpen(false); }}>
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </>
        )}
      </div>

      {engaged && (
        <div className="ix-note__more">
          <div className="ix-note__panel">
            <button
              type="button"
              className="ix-note__pause"
              onClick={() => {
                const next = !indexEnabled();
                setIndexEnabled(next, address);
                setOn(next);
              }}
            >
              {on ? 'Pause' : 'Resume'}
            </button>
            <div className="ix-note__speeds" role="group" aria-label="Indexing speed">
              {SPEED_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={speed === id ? 'is-on' : ''}
                  aria-pressed={speed === id}
                  onClick={() => { setSpeed(id); setIndexSpeed(id); }}
                >
                  {id === 'giga' ? 'Giga' : SPEEDS[id].label}
                </button>
              ))}
            </div>
            <button type="button" className="ix-note__clear" onClick={() => resetIndex(address)}>
              Clear index
            </button>
          </div>
        </div>
      )}

      {engaged && (
        <div className={`ix-note__bar${pct === null && on ? ' is-wait' : ''}`} aria-hidden="true">
          {pct !== null && <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />}
        </div>
      )}
    </aside>
  );

  return createPortal(card, slot);
}

function InfoMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7.3v3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="5.2" r="0.8" fill="currentColor" />
    </svg>
  );
}

function PauseMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 4.5v7M10 4.5v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
