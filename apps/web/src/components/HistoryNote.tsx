/**
 * The connected wallet's history, read on this device, as a notification while it runs (owner 2026-11-07).
 *
 * It is the walk the portfolio summary adds up (exchange/allTime.ts): every perps fill, spot fill and funding payment
 * back to the wallet's first, stored after each page, so a closed tab carries on from there next time. It starts when
 * a wallet connects. It stays up until every part reached the start of the history (or SoDEX's oldest row), and while
 * paused. The short reads that later fetch the newest rows are not "reading your history": with every part complete
 * the card goes, though one of them runs (owner 2026-11-07: it sat at 99% for good, as one always came round again).
 * Hover (or a tap on the card) opens pause, speed and remove, as the indexing toast does. In the navbar's lane it is
 * pinned at the right end; new notifications come in on its left (shell.css).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSlot } from '../slots';
import { setIndexEnabled } from '../setup/indexer';
import { WALK_SPEEDS, walks, type WalkSpeed, type WalkState } from '../exchange/allTime';
import { day, noteView, share } from './historyNoteView';
import type { ScopeKind } from '@sign/historySync.js';
import './IndexPrompt.css';

const LABEL: Record<ScopeKind, string> = { 'trades-perps': 'Perps trades', 'trades-spot': 'Spot trades', funding: 'Funding' };

export function HistoryNote({ address }: { address: string | null }) {
  const [state, setState] = useState<WalkState | null>(null);
  /* The notification lane moves into the navbar once that is up (toast.tsx): follow it (slots.ts). */
  const slot = useSlot('vs-toast-pin');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setState(null);
    if (!address) return;
    let off = false;
    let timer = 0;
    void walks.start(address).catch(() => {});
    const tick = async () => {
      let next = 10_000;
      try {
        const s = await walks.state(address);
        if (off) return;
        setState(s);
        if (s.scopes.some((x) => x.running)) next = 2_000;
      } catch {
        /* the next look tries again */
      }
      timer = window.setTimeout(tick, next);
    };
    void tick();
    return () => { off = true; window.clearTimeout(timer); };
  }, [address]);

  const visible = !!address && !!state && noteView(state, Date.now()).visible;
  useEffect(() => {
    if (visible) document.body.dataset.vsHistory = 'on';
    else delete document.body.dataset.vsHistory;
    window.dispatchEvent(new Event('vs-history'));
    return () => { delete document.body.dataset.vsHistory; window.dispatchEvent(new Event('vs-history')); };
  }, [visible]);

  if (!visible || !slot || !state || !address) return null;

  const now = Date.now();
  const shares = state.scopes.map((s) => share(s, state.firstTradeAt, now));
  const { pct, detail } = noteView(state, now);

  const card = (
    <aside className={`toast toast--info ix-note hn${open ? ' is-open' : ''}${state.held ? '' : ' is-on'}`} role="status" aria-label="History">
      <div
        className="ix-note__top"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          setOpen((v) => !v);
        }}
      >
        <span className="toast__ic" aria-hidden="true">
          <span className="toast__glyph">{state.held ? <PauseMark /> : <i className="ix-note__spin" />}</span>
        </span>
        <div className="toast__body">
          <span className="toast__title">{state.held ? 'History paused' : 'Reading your history'}</span>
          <span className="toast__detail">{detail}</span>
        </div>
        <span className="ix-note__pct">{pct === null ? '…' : `${pct}%`}</span>
      </div>

      <div className="ix-note__more">
        <div className="ix-note__panel hn-panel">
          <div className="hn-parts">
            {state.scopes.map((s, i) => (
              <div key={s.kind} className="hn-part">
                <span className="hn-part__k">{LABEL[s.kind]}</span>
                <span className="hn-part__v">
                  {s.complete
                    ? s.limited ? `${s.rows.toLocaleString('en-US')}, SoDEX keeps no older` : `${s.rows.toLocaleString('en-US')}, all`
                    : `${s.rows.toLocaleString('en-US')}${s.oldest !== null ? `, to ${day(s.oldest)}` : ''}`}
                </span>
                <span className="hn-part__bar" aria-hidden="true"><span style={{ width: `${Math.round((shares[i] ?? 0) * 100)}%` }} /></span>
              </div>
            ))}
          </div>
          <div className="hn-row">
            <button type="button" className="ix-note__pause" onClick={() => {
                // Pause stops the account setup's own index too (setup/indexer.ts): both read the same two pages a minute.
                if (!state.held) setIndexEnabled(false, address);
                walks.hold(address, !state.held);
                setState({ ...state, held: !state.held });
              }}>
              {state.held ? 'Resume' : 'Pause'}
            </button>
            <div className="ix-note__speeds" role="group" aria-label="Reading speed">
              {WALK_SPEEDS.map((sp) => (
                <button
                  key={sp.id}
                  type="button"
                  title={sp.detail}
                  className={state.speed === sp.id ? 'is-on' : ''}
                  aria-pressed={state.speed === sp.id}
                  onClick={() => { walks.setSpeed(sp.id as WalkSpeed); setState({ ...state, speed: sp.id }); }}
                >
                  {sp.label}
                </button>
              ))}
            </div>
            <button type="button" className="ix-note__clear" onClick={() => { void walks.forget(address).then(() => walks.state(address)).then(setState); }}>
              Remove
            </button>
          </div>
        </div>
      </div>

      <div className={`ix-note__bar${pct === null && !state.held ? ' is-wait' : ''}`} aria-hidden="true">
        {pct !== null && <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />}
      </div>
    </aside>
  );

  return createPortal(card, slot);
}

function PauseMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 4.5v7M10 4.5v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
