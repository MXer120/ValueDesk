/**
 * The transfer just sent, under the Transfer button inside the sheet (`inline`;
 * `edge` hangs it under a Modal's bottom border, which no sheet uses now: out
 * there it covered the page's bottom tabs). No history. An up arrow on a
 * finished result collapses it once; after that the arrow and the panel are gone.
 */
import { fmtDecimalString } from '../../numStyle';
import { useEffect, useState, type ReactNode } from 'react';
import type { FundsAccount } from '../../trading/funds';
import { Arrow, Chevron, SodexMark, WalletMark } from './ui';
import { useTransferLog, type TransferLogEntry } from './transferLog';

export type DockMode = 'collapsed' | 'live' | 'history';

function Mark({ kind }: { kind: 'pending' | 'success' | 'failed' }) {
  const d = kind === 'success' ? 'M3.2 7.2 5.6 9.6 10.8 4.2' : kind === 'failed' ? 'M4 4l6 6M10 4L4 10' : 'M7 3.2v3.2l2.2 1.4';
  return (
    <span className={`fx-xfer__ic is-${kind}`} aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 14 14">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
const statusWord = (status: 'pending' | 'success' | 'failed'): string =>
  status === 'success' ? 'Success' : status === 'failed' ? 'Failed' : 'Pending';

const END_WORD: Record<FundsAccount, string> = { spot: 'Spot', perps: 'Futures', evm: 'EVM' };

export function TransferStatus({
  mode, liveId, onMode, variant = 'edge', owner = null,
}: {
  mode: DockMode;
  liveId: string | null;
  onMode: (mode: DockMode) => void;
  /** `inline` sits inside the sheet, under its button. `edge` sits on a Modal's bottom border (Modal `dock`). */
  variant?: 'edge' | 'inline';
  owner?: string | null;
}) {
  const log = useTransferLog();
  const entry = liveId ? log.find((e) => e.id === liveId) ?? null : null;
  const live = mode === 'live' && entry ? entry : null;
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const tone = !live ? '' : live.status === 'failed' ? ' is-bad' : live.status === 'success' ? ' is-ok' : '';
  const finished = live?.status === 'success' || live?.status === 'failed';

  const showing = !!live;
  useEffect(() => {
    if (!showing) { setOpen(false); return; }
    setGone(false);
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [showing, liveId]);

  if (!live || gone) return null;

  const dismiss = () => setOpen(false);

  return (
    <div className={`fx-dock${variant === 'inline' ? ' fx-dock--inline' : ''}${open ? ' is-open' : ''}${tone}`}>
      <div
        className="fx-dock__clip"
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
          if (!open) { setGone(true); onMode('collapsed'); }
        }}
      >
        <div className="fx-dock__panel" role="status" aria-live="polite">
          <Move amount={live.amount} coin={live.coin} from={live.from} to={live.to} status={live.status} />
          {live.status === 'failed' && live.error && <p className="fx-dock__err">{live.error}</p>}
          {finished && (
            <button type="button" className="fx-dock__up" aria-label="Dismiss" onClick={dismiss}>
              <Chevron />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Move({
  amount, coin, from, to, status,
}: {
  amount: string;
  coin: string;
  from: FundsAccount;
  to: FundsAccount;
  status: 'pending' | 'success' | 'failed';
}): ReactNode {
  return (
    <div className="fx-move">
      <span className="fx-move__route">
        <End account={from} />
        <Arrow />
        <End account={to} />
      </span>
      <span className="fx-move__side">
        <b>{fmtDecimalString(amount)} {coin}</b>
        <span className={`fx-xfer__st is-${status}`}><Mark kind={status} />{statusWord(status)}</span>
      </span>
    </div>
  );
}

function End({ account }: { account: FundsAccount }) {
  return (
    <span className="fx-move__end">
      {account === 'evm' ? <WalletMark size={22} /> : <SodexMark size={22} />}
      <span>{END_WORD[account]}</span>
    </span>
  );
}
