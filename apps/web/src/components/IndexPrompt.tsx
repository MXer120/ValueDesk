/**
 * Portfolio prompt for indexing. First visit, then again after 48 hours.
 * Start reveals the pace. Once the pointer leaves, the card stays until the
 * walk finishes and shows how far back it has reached.
 */
import { useEffect, useRef, useState } from 'react';
import { earliestFlowTime } from '../accountData';
import { indexKey, parseIndex, SPEED_ORDER, SPEEDS, type SpeedId } from '../setup/stats';
import {
  IDLE_PROGRESS, indexEnabled, setIndexEnabled, setIndexSpeed, subscribeIndex, type IndexProgress,
} from '../setup/indexer';
import './IndexPrompt.css';

const SEEN = 'vs.index.promptAt';
const GAP = 48 * 60 * 60 * 1000;
/** Same span as an info toast, then the card shrinks and stays. */
const FULL_MS = 6_000;

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

/**
 * Mean of every stream. A stream that has not started is 0. One stream that
 * has already walked back must not make the whole job look finished.
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
    sum += Math.max(0, Math.min(1, walked / span));
  }
  if (!started) return null;
  return (sum / cursors.length) * 100;
}

export function IndexPrompt({ address }: { address: string | null }) {
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(() => indexEnabled());
  const fresh = useRef(false);
  const [speed, setSpeed] = useState<SpeedId>('default');
  const [earliest, setEarliest] = useState<number | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [small, setSmall] = useState(false);
  const [pressed, setPressed] = useState(false);

  useEffect(() => subscribeIndex(setProgress), []);

  useEffect(() => {
    if (!address) { setOpen(false); return; }
    if (progress.done && started) { setOpen(false); return; }
    const running = indexEnabled() && !progress.done;
    if (running) {
      setOpen(true);
      setStarted(true);
      if (!fresh.current) setSmall(true);
      return;
    }
    setOpen(due());
  }, [address, progress.done, started]);

  useEffect(() => {
    if (!started || !address) return;
    let stop = false;
    earliestFlowTime(address).then((t) => { if (!stop) setEarliest(t); }).catch(() => { if (!stop) setEarliest(null); });
    return () => { stop = true; };
  }, [started, address]);

  useEffect(() => {
    if (!started || !address || earliest === null) { setPct(null); return; }
    if (progress.done) { setPct(100); return; }
    setPct(coverage(address, earliest));
  }, [started, address, earliest, progress.pages, progress.done, progress.cursorMs]);

  useEffect(() => {
    if (!started) return;
    const t = window.setTimeout(() => setSmall(true), FULL_MS);
    return () => window.clearTimeout(t);
  }, [started]);

  if (!open || !address) return null;
  const stop = () => {
    setIndexEnabled(false, address);
    markSeen();
    setOpen(false);
    setStarted(false);
  };

  return (
    <aside className={`ix-note${small ? ' is-small' : ''}${pressed ? ' is-pressed' : ''}${started ? ' is-on' : ''}`}>
      <div className="ix-note__row">
        <strong>Indexing statistics</strong>
        {started ? (
          <span className="ix-note__pct">
            {progress.done ? 'Done' : pct === null ? <i className="ix-note__spin" aria-label="Estimating" /> : `${Math.round(pct)}%`}
          </span>
        ) : (
          <button type="button" className="ix-note__x" aria-label="Not now" onClick={() => { markSeen(); setOpen(false); }}>×</button>
        )}
        {started && <button type="button" className="ix-note__x" aria-label="Stop indexing" onClick={stop}>×</button>}
      </div>
      {!small && !started && (
        <p>Fees, funding, volume, and fills, kept on this browser.</p>
      )}
      {!small && !started && (
        <button
          type="button"
          className="ix-note__go"
          onClick={() => {
            setPressed(true);
            fresh.current = true;
            setStarted(true);
            setIndexSpeed(speed);
            setIndexEnabled(true, address);
            window.setTimeout(() => setPressed(false), 180);
          }}
        >
          Start
        </button>
      )}
      {!small && started && (
        <div className="ix-note__speeds" role="group" aria-label="Indexing speed">
          {SPEED_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className={speed === id ? 'is-on' : ''}
              aria-pressed={speed === id}
              onClick={() => { setSpeed(id); setIndexSpeed(id); }}
            >
              {SPEEDS[id].label}
            </button>
          ))}
        </div>
      )}
      {started && (
        <div className={`ix-note__bar${pct === null ? ' is-wait' : ''}`} aria-hidden="true">
          {pct !== null && <span style={{ width: `${Math.min(100, pct)}%` }} />}
        </div>
      )}
    </aside>
  );
}
