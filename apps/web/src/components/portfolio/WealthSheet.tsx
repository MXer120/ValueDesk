/**
 * Invest in, or redeem from, an escrow vault (CXMT, Unitree). Wallet transactions on
 * ValueChain, spending the wallet's USDC or shares, never Spot or Perps. What it does comes
 * from the fund's channel at this moment: a batch request, or a maker's quote.
 *
 * A successful transaction is not arrival: shares or USDC come later, and the sheet says when
 * SoDEX expects them. Never run on a real wallet yet; see trading/wealth.ts.
 */
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { NoWallet } from '../EmptyState';
import { requestTransfer } from '../account/actions';
import { decimalInput } from '../numberInput';
import { Spinner, useStepLabel } from '../funds/ui';
import { formatUnits, parseUnits } from '../../trading/onboard';
import type { FundsStep } from '../../trading/funds';
import {
  QUOTE_REASON, fillQuote, readVaultFacts, requestProblem, requestQuote, requestVault,
  type FundAction, type RfqQuote, type VaultFacts, type WealthFund,
} from '../../trading/wealth';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import '../funds/funds.css';

export interface WealthSheetTarget {
  fund: WealthFund;
  name: string;
  action: Extract<FundAction, { kind: 'batch' | 'rfq' }>;
  side: 'buy' | 'sell';
}

const when = (s: number | null): string => (s ? new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');

export function WealthSheet({ target, onClose, address, provider, onDone }: {
  target: WealthSheetTarget | null;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  onDone: () => void;
}) {
  const title = target ? `${target.side === 'buy' ? 'Invest in' : 'Redeem from'} ${target.name}` : '';
  return (
    <Modal open={!!target} title={title} onClose={onClose} size="sm" className="fx fx-money">
      {!address
        ? <NoWallet line="Connect a wallet to invest." compact />
        : target && <SheetBody key={`${target.fund.fundId}:${target.side}`} target={target} address={address} provider={provider} onDone={onDone} onClose={onClose} />}
    </Modal>
  );
}

function SheetBody({ target, address, provider, onDone, onClose }: {
  target: WealthSheetTarget; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose: () => void;
}) {
  const { fund, action, side } = target;
  const [facts, setFacts] = useState<VaultFacts | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<RfqQuote | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const label = useStepLabel();

  useEffect(() => {
    let off = false;
    readVaultFacts(fund.fundId, address).then((f) => { if (!off) setFacts(f); }).catch((e) => { if (!off) setError((e as Error).message); });
    return () => { off = true; };
  }, [fund.fundId, address]);

  const dp = side === 'buy' ? (facts?.assetDecimals ?? 6) : (facts?.shareDecimals ?? fund.share.decimals);
  const unit = side === 'buy' ? 'USDC' : fund.share.coin;
  const held = facts ? (side === 'buy' ? facts.assetBalance : facts.shareBalance) : null;
  let units = 0n;
  try { units = amount ? parseUnits(amount, dp) : 0n; } catch { units = 0n; }
  const problem = facts && amount ? requestProblem(side, units, facts) : null;
  const delivery = action.kind === 'batch' ? action.deliveryAt : action.deliveryAt;

  const fail = (e: unknown) => { if (!isUserRejection(e)) setError((e as Error).message); };

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const q = await requestQuote(fund.fundId, side, address, units);
      if (!q.quotable) setError(QUOTE_REASON[q.reason?.code ?? ''] ?? 'The maker did not quote this.');
      else setQuote(q);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const h = action.kind === 'rfq' && quote
        ? await fillQuote({ provider, owner: address, fundId: fund.fundId, rfq: action.rfq, quote, onStep: setStep })
        : await requestVault({ provider, owner: address, fundId: fund.fundId, side, amount: units, onStep: setStep });
      setHash(h);
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); setStep(null); }
  };

  if (hash) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">
          Request sent. Expected by {when(delivery)}. It shows as in progress in your Wealth history until it settles.
        </p>
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="fx-stack">
      <div className="fx-box">
        <div className="fx-box__head">
          <span>{side === 'buy' ? 'You pay' : 'You redeem'}</span>
          <span className="fx-max">In your wallet: {held === null ? <Spinner /> : `${formatUnits(held, dp)} ${unit}`}</span>
        </div>
        <div className="fx-amount">
          <input value={amount} onChange={(e) => { setAmount(decimalInput(e.target.value, { prev: amount })); setQuote(null); }} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
          <span className="fx-amount__unit pfx-unit"><CoinIcon coin={unit} size={16} /> {unit}</span>
          <button type="button" className="fx-chip" disabled={!held} onClick={() => { setAmount(formatUnits(held ?? 0n, dp)); setQuote(null); }}>Max</button>
        </div>
      </div>

      <div className="fx-kv">
        <div><span>How</span><b>{action.kind === 'batch' ? 'Batch, at the next price' : 'At a maker\'s quote'}</b></div>
        {action.kind === 'batch' && <div><span>Cutoff</span><b>{when(action.cutoffAt)}</b></div>}
        <div><span>Expected delivery</span><b>{when(delivery)}</b></div>
        {facts && <div><span>Minimum</span><b>{formatUnits(side === 'buy' ? facts.minDeposit : facts.minRedeem, dp)} {unit}</b></div>}
        {quote?.receiveAmount && (
          <div><span>You receive</span><b>{formatUnits(BigInt(quote.receiveAmount), side === 'buy' ? fund.share.decimals : (facts?.assetDecimals ?? 6))} {side === 'buy' ? fund.share.coin : 'USDC'}</b></div>
        )}
      </div>

      {!provider ? (
        <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p>
      ) : action.kind === 'rfq' && !quote ? (
        <button type="button" className="fx-cta" disabled={busy || !units || !!problem} onClick={() => void ask()}>{busy ? <Spinner label="Asking" /> : 'Get a quote'}</button>
      ) : (
        <button type="button" className="fx-cta" disabled={busy || !units || !!problem} onClick={() => void send()}>
          {busy ? (step ? label(step) : <Spinner label="Sending" />) : side === 'buy' ? 'Invest' : 'Redeem'}
        </button>
      )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <p className="fx-note">
        {side === 'buy'
          ? <>Paid from USDC in your wallet on ValueChain, with SOSO for gas. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>. Returns are not guaranteed.</>
          : 'Paid to your wallet on ValueChain. Part of a redemption can settle later.'}
      </p>
    </div>
  );
}
