/**
 * The strip under "You send -> You receive" once a deposit shows up in SoDEX's
 * own deposit history (depositWatch.ts), and the one-time notice when it lands -
 * shared by the Deposit sheet's address view and its Base bridge view.
 */
import { useEffect, useRef } from 'react';
import { fmtDecimalString } from '../../numStyle';
import { chainLabel } from '../../trading/funds';
import { nudgeAccountCheck } from '../../trading/session';
import type { DepositStage, DepositWatch } from './depositWatch';
import { announceMoney } from './moneyNotice';

/** An arrived (or failed) deposit is announced on the wallet button too (moneyNotice.ts), once. */
export function useDepositNotice(owner: string, watch: DepositWatch | null): void {
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!watch || (watch.stage !== 'done' && watch.stage !== 'failed') || told.current === watch.row.id) return;
    told.current = watch.row.id;
    // A first deposit that landed opens the account: look now, not at the watch's next turn.
    if (watch.stage === 'done') nudgeAccountCheck(owner, true);
    const what = `Deposit of ${watch.row.amount ?? ''} ${watch.row.coin}`.replace(/  +/g, ' ');
    announceMoney({ kind: 'deposit', status: watch.stage === 'done' ? 'done' : 'failed', text: `${what} ${watch.stage === 'done' ? 'completed' : 'failed'}` });
  }, [watch, owner]);
}

/** Three steps, the current one lit. */
export function DepositProgress({ w }: { w: DepositWatch }) {
  const raw = w.row.rawStatus || w.row.status;
  const processing = raw === 'Reporting' ? 'Reporting to SoDEX' : 'Deposit processing';
  const steps: Array<[DepositStage, string]> = [['detected', 'Deposit detected'], ['processing', processing], ['done', 'Deposited successfully']];
  const at = steps.findIndex(([k]) => k === w.stage);
  const off = w.stage === 'failed' || w.stage === 'review' || w.stage === 'refunding';
  return (
    <div className={`fx-dprog${w.stage === 'failed' ? ' is-failed' : w.stage === 'review' ? ' is-review' : ''}`} role="status" aria-live="polite">
      <div className="fx-dprog__what">
        {w.row.amount ? `${fmtDecimalString(w.row.amount)} ${w.row.coin}` : w.row.coin}
        {w.row.chain ? <small> via {chainLabel(w.row.chain)}</small> : null}
      </div>
      {off ? (
        <p className={w.stage === 'failed' ? 'fx-dprog__fail' : 'fx-dprog__note'}>
          {w.stage === 'review'
            ? `SoDEX is holding this deposit for review (${raw}).`
            : w.stage === 'refunding'
              ? `SoDEX is refunding this deposit (${raw}).`
              : `SoDEX could not credit this deposit (${raw}). See Account History for details.`}
        </p>
      ) : (
        <ol className="fx-dprog__steps">
          {steps.map(([k, label], i) => (
            <li key={k} className={i < at ? 'is-past' : i === at ? 'is-now' : ''}>
              <span className="fx-dprog__dot" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
