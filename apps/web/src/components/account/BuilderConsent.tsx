/**
 * The builder-fee disclosure: what the user is told BEFORE their wallet is
 * asked for the approval signature (trading/session.ts calls it through
 * `confirmBuilderFee`, and only when a builder is configured and SoDEX does not
 * already list a covering approval).
 *
 * It states, in plain words and with the build's own numbers: the fee per perps
 * order and per spot sell, that spot buys are not charged, the maximum being
 * approved, who receives it, that SoDEX charges it per fill on top of its own
 * fee, and that it can be revoked. Nothing is signed until "Approve" is pressed.
 *
 * Three answers, because closing a dialog is not the same as saying no:
 *   approve  - the wallet is asked for ONE typed-data signature
 *   decline  - optional builds only: trading is enabled without the fee
 *   cancel   - the close button / Escape: nothing happens at all
 *
 * Asked on its own from the key options (`terms.purpose === 'approve'`: trading
 * is not being enabled) there are two - approve, or cancel - and the buttons
 * and the last sentence say what applies there.
 *
 * It is the app's ordinary Modal (glass, focus trap, Escape) with the ordinary
 * key/value table - no new surface, no new tokens.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { fmtBuilderRate, type BuilderTerms } from '../../trading/builder';
import type { BuilderChoice } from '../../trading/session';
import './account.css';

/** SoDEX's own ceiling for a perps builder fee, tenths of a bp (0.2 %). */
const PERPS_CAP = 200;

const perFill = (rate: number, what: string): string => (rate > 0 ? `${fmtBuilderRate(rate)} of each fill${what}` : 'no builder fee');

/** The disclosure's body. Exported so it can be rendered (and read) on its own. */
export function BuilderTermsView({ terms }: { terms: BuilderTerms }) {
  const partial = terms.alreadyApproved.length > 0;
  return (
    <div className="stack acct-fee">
      <p>
        Orders you place here go to SoDEX with ValueDesk named as their builder. SoDEX then charges a builder fee on
        each fill, on top of its own trading fee, and pays it to ValueDesk.
      </p>
      <table className="kv acct-fee__terms">
        <tbody>
          <tr>
            <th>Perps orders</th>
            <td>{perFill(terms.perps, ', buys and sells')}</td>
          </tr>
          <tr>
            <th>Spot sells</th>
            <td>{perFill(terms.spot, '')}</td>
          </tr>
          <tr>
            <th>Spot buys</th>
            <td>no builder fee</td>
          </tr>
          <tr>
            <th>Maximum you approve</th>
            <td>{fmtBuilderRate(terms.maxFeeRate)} of a fill</td>
          </tr>
          <tr>
            <th>Paid to</th>
            <td>ValueDesk, SoDEX builder account #{terms.builderId}</td>
          </tr>
        </tbody>
      </table>
      <p>
        Your wallet signs one message approving that maximum for that builder account. ValueDesk cannot charge more
        than the maximum; raising it would need a new signature from you. The fee applies to maker and taker fills
        alike.
        {terms.maxFeeRate > PERPS_CAP ? ` SoDEX limits builder fees on perps to ${fmtBuilderRate(PERPS_CAP)} whatever is approved.` : ''}
      </p>
      {partial && (
        <p>
          SoDEX already lists your approval for {terms.alreadyApproved.join(' and ')} orders. Approving now covers
          {terms.alreadyApproved.includes('perps') ? ' spot' : ' perps'} orders too.
        </p>
      )}
      <p className="muted">
        You can revoke the approval at any time: press "ValueDesk fee" in the order ticket.{' '}
        {terms.purpose === 'approve'
          ? terms.required
            ? 'Trading through ValueDesk requires it: until it is approved, orders placed here are not sent. Your SoDEX account and funds are not affected.'
            : 'The fee is optional: where it is not approved, orders placed here carry no builder fee.'
          : terms.required
            ? 'Trading through ValueDesk requires it: if you decline, trading stays off here. Your SoDEX account and funds are not affected.'
            : 'The fee is optional: you can enable trading without it.'}
      </p>
    </div>
  );
}

interface Pending {
  terms: BuilderTerms;
  resolve: (c: BuilderChoice) => void;
}

/**
 * `ask(terms)` opens the disclosure and resolves with the user's answer; render
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
      size="sm"
      title="ValueDesk builder fee"
      onClose={() => settle('cancel')}
      // A fee is agreed to on purpose: a stray click on the backdrop is not an answer.
      dismissOnBackdrop={false}
      footer={
        <>
          <button onClick={() => settle('cancel')}>Cancel</button>
          {/* Declining is an answer of its own only while enabling: there it still enables trading. */}
          {!req.terms.required && req.terms.purpose !== 'approve' && (
            <button onClick={() => settle('decline')}>
              {req.terms.alreadyApproved.length ? 'Keep it as it is' : 'Enable without the fee'}
            </button>
          )}
          <button className="btn-primary" onClick={() => settle('approve')}>
            {req.terms.purpose === 'approve' ? 'Approve the fee' : 'Approve and enable trading'}
          </button>
        </>
      }
    >
      <BuilderTermsView terms={req.terms} />
    </Modal>
  ) : null;

  return { ask, dialog };
}
