/**
 * The builder-fee sheet, shown before the wallet is asked for the approval
 * signature. Trading turns on from this one approval: the browser's trading
 * key is signed in the wallet afterwards, with no second dialog.
 *
 * Three answers, because closing the sheet is not the same as saying no:
 *   approve  - the wallet is asked for the fee signature
 *   decline  - optional builds only, while enabling: trading comes on without the fee
 *   cancel   - the close button / Escape: nothing happens
 *
 * Asked on its own from the key options (`purpose === 'approve'`) there is
 * only approve or cancel.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { fmtBuilderRate, type BuilderTerms } from '../../trading/builder';
import type { BuilderChoice } from '../../trading/session';
import '../funds/funds.css';
import './account.css';

/** SoDEX's own ceiling for a perps builder fee, tenths of a bp (0.2 %). */
const PERPS_CAP = 200;

const rateLine = (rate: number): string => (rate > 0 ? `${fmtBuilderRate(rate)} of each fill` : 'No fee');

/** The disclosure's body. Exported so it can be rendered on its own. */
export function BuilderTermsView({ terms }: { terms: BuilderTerms }) {
  const partial = terms.alreadyApproved.length > 0;
  const enabling = terms.purpose !== 'approve';
  return (
    <>
      <p className="fx-note">
        {enabling ? 'Approving this turns trading on. ' : ''}
        SoDEX charges this on each fill, on top of its own fee, and pays it to ValueDesk.
      </p>
      <div className="fx-box vs-fee__box">
        <div className="fx-kv">
          <div><span>Futures</span><b>{rateLine(terms.perps)}</b></div>
          <div><span>Spot sells</span><b>{rateLine(terms.spot)}</b></div>
          <div><span>Spot buys</span><b>No fee</b></div>
          <div><span>Maximum</span><b>{fmtBuilderRate(terms.maxFeeRate)}</b></div>
          <div><span>Paid to</span><b>ValueDesk</b></div>
        </div>
      </div>
      {partial && (
        <p className="fx-note">
          SoDEX already lists your approval for {terms.alreadyApproved.join(' and ')}. This approval covers the other market as well.
        </p>
      )}
      {terms.maxFeeRate > PERPS_CAP && (
        <p className="fx-note">SoDEX limits futures fees to {fmtBuilderRate(PERPS_CAP)}.</p>
      )}
      <p className="fx-note">
        Your wallet signs one message for that maximum. A higher maximum needs a new signature.
        You can revoke it from the order ticket.
      </p>
    </>
  );
}

interface Pending {
  terms: BuilderTerms;
  resolve: (c: BuilderChoice) => void;
}

/**
 * `ask(terms)` opens the sheet and resolves with the user's answer; render
 * `dialog` once in the tree. A second `ask` while one is open cancels the first.
 */
export function useBuilderConsent(): { ask: (terms: BuilderTerms) => Promise<BuilderChoice>; dialog: ReactNode } {
  const [req, setReq] = useState<Pending | null>(null);

  const ask = useCallback(
    (terms: BuilderTerms) =>
      new Promise<BuilderChoice>((resolve) => {
        setReq((cur) => {
          cur?.resolve('cancel');
          return { terms, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((choice: BuilderChoice) => {
    setReq((cur) => {
      cur?.resolve(choice);
      return null;
    });
  }, []);

  const dialog = req ? (
    <Modal
      open
      size="md"
      title="Builder fee"
      className="fx vs-fee"
      onClose={() => settle('cancel')}
      dismissOnBackdrop={false}
    >
      <BuilderTermsView terms={req.terms} />
      <div className="vs-fee__actions">
        <button type="button" className="fx-cta" onClick={() => settle('approve')}>Approve</button>
        {!req.terms.required && req.terms.purpose !== 'approve' && (
          <button type="button" className="fx-link" onClick={() => settle('decline')}>
            {req.terms.alreadyApproved.length ? 'Keep the current approval' : 'Enable without the fee'}
          </button>
        )}
      </div>
    </Modal>
  ) : null;

  return { ask, dialog };
}
