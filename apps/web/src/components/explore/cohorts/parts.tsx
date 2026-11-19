/**
 * Pieces the cohort pages share: the polled read that never blanks, the bias
 * pills, the long / short bars.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BIAS_LABEL, LEAN_LABEL, biasOf, isBullish, longShare, type Lean,
} from '@sign/valuedesk/cohorts/model.js';
import { VENUE_LABEL, type Venue } from '../../../vsApi';
import type { BooksOverOi } from '@sign/valuedesk/cohorts/model.js';
import { DASH } from '../../../format';
import { VenueLogo } from '../../VenueLogo';
import { fmtUsdShort } from '../model';
import { fmtFixed } from '../../../numStyle';
import { pollEvery } from '../../../exchange/visibility';
import { revalidating } from '../../../serverFetch';
import { useHeld } from '../../../live/useHeld';
import { asOfText } from '../../../asOf';

export const POLL_MS = 60_000;

/* --- data ------------------------------------------------------------------------------ */

export interface Read<T> {
  /** The latest answer - for an OLDER key while the new one loads (see `stale`). */
  data: T | null;
  /** `data` answers a previous request: shown dimmed, never blanked, so nothing flickers. */
  stale: boolean;
  error: string | null;
  loading: boolean;
  retry: () => void;
  /** `data` is the path's kept answer (serverFetch.ts), made at this time: the page says so until the current one is in. */
  heldAt?: number;
}

/** The as-of line under a panel drawn from a kept answer, as the overview says its own (asOf.ts). */
export function HeldNote({ at }: { at: number | undefined }) {
  const text = at === undefined ? null : asOfText(at);
  return text ? <p className="lbp-note coh-asof">{text}</p> : null;
}

/**
 * One polled read; an answer for an older key is never shown under a newer one. `keepPath`: the HTTP path `fetcher`
 * reads, for a page that may show its kept answer (serverFetch.ts KEPT ANSWERS) - as `stale`, until the first read,
 * which then asks the server for the current one, replaces it.
 */
export function usePolled<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, pollMs = POLL_MS, keepPath: string | null = null): Read<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const f = useRef(fetcher);
  f.current = fetcher;
  const mine = state.key === key;
  const held = useHeld<T>(key, keepPath, mine, keepPath !== null);
  const heldNow = useRef(false);
  heldNow.current = !!held;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const ac = new AbortController();
    const run = () => {
      f.current(ac.signal).then(
        (data) => { if (alive) setState({ key, data, error: null }); },
        (e: unknown) => {
          if (!alive || ac.signal.aborted) return;
          setState((s) => ({ key, data: s.key === key ? s.data : null, error: e instanceof Error ? e.message : String(e) }));
        },
      );
    };
    // A kept answer is on screen: the first read asks the server for the current one.
    if (heldNow.current) revalidating(run);
    else run();
    // Paused while the tab is hidden; a tick missed then runs the moment it is shown again.
    // A poll asks the server; the first read may be answered by the HTTP cache (serverFetch.ts).
    const stop = pollMs > 0 ? pollEvery(pollMs, () => revalidating(run)) : null;
    return () => { alive = false; ac.abort(); stop?.(); };
  }, [key, tick, pollMs]);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  if (!mine && held) return { data: held.body, stale: true, error: null, loading: true, retry, heldAt: held.at };
  return {
    data: state.data,
    stale: !mine && state.data !== null,
    error: mine ? state.error : null,
    loading: !!key && (!mine || (state.data === null && state.error === null)),
    retry,
  };
}

/* --- small parts ----------------------------------------------------------------------- */

export const Arrow = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
    <path d={up ? 'M2 8 8 2M3.5 2H8v4.5' : 'M2 2l6 6M8 3.5V8H3.5'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Books that hold more than the venue says is open: size that does not exist until the reads correct it, so the figures
 * under it are not to be taken as current (server read.ts booksOverOi). Nothing when all is well.
 */
export function OverOiNote({ rows }: { rows: ReadonlyArray<BooksOverOi> | undefined }) {
  if (!rows?.length) return null;
  const venues = [...new Set(rows.map((r) => r.venue))];
  const text = venues.map((v) => `${VENUE_LABEL[v]}: ${rows.filter((r) => r.venue === v).map((r) => `${r.coin} ${Math.round(r.ratio * 100)}%`).join(', ')}`).join(' · ');
  return <p className="lbp-note">Books above open interest, being read again and not current. {text}</p>;
}

export function BiasPill({ long, short }: { long: number; short: number }) {
  const bias = biasOf(longShare(long, short));
  if (!bias) return <span className="coh-bias is-none">No positions</span>;
  const bull = isBullish(bias);
  return <span className={`coh-bias ${bull ? 'is-bull' : 'is-bear'}`}>{BIAS_LABEL[bias]}<Arrow up={bull} /></span>;
}

export const leanTone = (l: Lean) => (l.endsWith('bullish') ? 'is-bull' : 'is-bear');

export function LeanPill({ lean }: { lean: Lean | null }) {
  if (!lean) return <span className="coh-dim">{DASH}</span>;
  return (
    <span className={`coh-bias ${leanTone(lean)}`}>
      {LEAN_LABEL[lean]}
      <Arrow up={lean.endsWith('bullish')} />
    </span>
  );
}

export function Split({ long, short }: { long: number; short: number }) {
  const share = longShare(long, short);
  return (
    <div className="coh-split">
      <div className="pf-split" role="img" aria-label={share === null ? 'No open positions' : `${fmtFixed(share * 100, 1)}% of open exposure is long`}>
        <span className="pf-split__fill" style={{ transform: `scaleX(${share ?? 0.5})` }} />
      </div>
      <div className="coh-split__figs">
        <span className="coh-split__long"><b>{share === null ? DASH : fmtUsdShort(long)}</b><i>Long</i></span>
        <span className="coh-split__short"><b>{share === null ? DASH : fmtUsdShort(short)}</b><i>Short</i></span>
      </div>
    </div>
  );
}

export function VenueMarks({ venues }: { venues: readonly Venue[] }) {
  return (
    <span className="coh-vmarks">
      {venues.map((v) => <span key={v} title={VENUE_LABEL[v]}><VenueLogo venue={v} size={14} /></span>)}
    </span>
  );
}

export function Meter({ title, share, left, right }: { title: string; share: number | null; left: ReactNode; right: ReactNode }) {
  return (
    <div className="coh-meter">
      <span className="coh-meter__t">{title}</span>
      <div className="pf-split"><span className="pf-split__fill" style={{ transform: `scaleX(${share ?? 0.5})` }} /></div>
      <div className="coh-meter__l">
        <span className="pos">{left}</span>
        <span className="neg">{right}</span>
      </div>
    </div>
  );
}

export const pctText = (v: number | null) => (v === null ? DASH : `${Math.round(v * 100)}%`);

/* --- pickers ---------------------------------------------------------------------------- */

/** A bar dropdown (sector, asset, whose positions): a glass list under its button. */
export function Picker({
  label, value, children, onClear, empty = 'All', align = 'left',
}: {
  label: string;
  value: ReactNode | null;
  children: (close: () => void) => ReactNode;
  onClear: () => void;
  /** Shown while nothing is chosen. */
  empty?: string;
  /** Which edge of the button the list lines up with. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="coh-pick" ref={ref}>
      <button type="button" className={`coh-pick__btn${value ? ' is-set' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="coh-pick__k">{label}</span>
        <span className="coh-pick__v">{value ?? empty}</span>
        <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {value && (
        <button type="button" className="coh-pick__x" aria-label={`Clear ${label.toLowerCase()}`} onClick={onClear}>×</button>
      )}
      {open && <div className={`coh-pick__pop${align === 'right' ? ' is-right' : ''}`} role="listbox">{children(() => setOpen(false))}</div>}
    </div>
  );
}
