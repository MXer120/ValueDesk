/**
 * USDC Earn in the app (owner 2026-11-27: "use usdc earn as margin"): subscribe with USDC from the wallet on
 * ValueChain, then, if asked, move the vsoUSDC into Futures, where SoDEX counts it as margin; or redeem back to USDC.
 * The bridge request and the order it creates: trading/wealthEarn.ts. The move to Futures is the app's own transfer
 * (trading/funds.ts transferFunds: a ValueChain deposit into Spot, then Spot to Futures with the trading key).
 *
 * Figures shown are SoDEX's live ones: the 7-day APY from the Wealth board, the collateral ratio from the asset
 * config, the minimums from the bridge contract. "About a minute" is what SoDEX's last 60 orders took (0.8-1.3 min,
 * read from the contract 2026-11-27).
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { NoWallet } from '../EmptyState';
import { requestTransfer } from '../account/actions';
import { decimalInput } from '../numberInput';
import { Spinner, useStepLabel } from '../funds/ui';
import { ViewSeg } from './RangePicker';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { transferFunds, type FundsStep } from '../../trading/funds';
import {
  earnProblem, expectedOut, minOutOf, readEarnFacts, requestEarn, waitCallFor, type CallFor, type EarnFacts,
} from '../../trading/wealthEarn';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { fmt } from '../../format';
import '../funds/funds.css';
import './recurring.css';

export interface EarnSheetTarget {
  side: 'buy' | 'sell';
  /** Shares held in Futures and Spot, which a redemption cannot spend until they are back in the wallet. */
  away?: { perps: number; spot: number };
}

type Then = 'perps' | 'evm';
const THEN: ReadonlyArray<readonly [Then, string]> = [['perps', 'Use as Futures margin'], ['evm', 'Keep in wallet']];

type Stage = 'sent' | 'bridge' | 'arrived' | 'futures' | 'done' | 'failed';

export function EarnSheet({ target, onClose, address, provider, onDone, apy }: {
  target: EarnSheetTarget | null;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  onDone: () => void;
  /** SoDEX's 7-day APY for USDC Earn, as its board sends it ("4.31115819"). */
  apy: string | undefined;
}) {
  const title = target?.side === 'sell' ? 'Redeem USDC Earn' : 'Invest in USDC Earn';
  return (
    <Modal open={!!target} title={title} onClose={onClose} size="sm" className="fx fx-money earn-sheet">
      {!address
        ? <NoWallet line="Connect a wallet to use USDC Earn." compact />
        : target && <Body key={target.side} target={target} address={address} provider={provider} onDone={onDone} onClose={onClose} apy={apy} />}
    </Modal>
  );
}

function Body({ target, address, provider, onDone, onClose, apy }: {
  target: EarnSheetTarget; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose: () => void; apy: string | undefined;
}) {
  const { side } = target;
  const [facts, setFacts] = useState<EarnFacts | null>(null);
  const [amount, setAmount] = useState('');
  const [then, setThen] = useState<Then>('perps');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [order, setOrder] = useState<CallFor | null>(null);
  const label = useStepLabel();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let off = false;
    readEarnFacts(address).then((f) => { if (!off) setFacts(f); }).catch((e) => { if (!off) setError((e as Error).message); });
    return () => { off = true; };
  }, [address]);

  const usdcDp = facts?.usdc.valuechain.decimals ?? 6;
  const shareDp = facts?.share.valuechain.decimals ?? 18;
  const dp = side === 'buy' ? usdcDp : shareDp;
  const unit = side === 'buy' ? 'USDC' : 'vsoUSDC';
  const held = facts ? (side === 'buy' ? facts.usdcBalance : facts.shareBalance) : null;
  let units = 0n;
  try { units = amount ? parseUnits(amount, dp) : 0n; } catch { units = 0n; }
  const problem = facts && amount ? earnProblem(side, units, facts) : facts && !facts.open ? facts.why : null;
  const out = facts && units > 0n ? expectedOut(side, units, facts.nav, usdcDp, shareDp) : 0n;
  const ratio = facts?.share.marginRatio ?? null;
  const apyNum = apy !== undefined && Number.isFinite(Number(apy)) ? Number(apy) : null;
  const away = target.away && (target.away.perps > 0 || target.away.spot > 0) ? target.away : null;

  const fail = (e: unknown) => { if (!isUserRejection(e) && alive.current) setError((e as Error).message); };

  const toFutures = async (o: CallFor) => {
    if (!facts) return;
    setStage('futures');
    await transferFunds({ owner: address, provider, coin: facts.share, from: 'evm', to: 'perps', amount: formatUnits(o.outAmount, shareDp), onStep: setStep });
    if (alive.current) setStage('done');
    onDone();
  };

  const send = async () => {
    if (!provider || !facts) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requestEarn({ provider, owner: address, side, amount: units, onStep: setStep });
      setStep(null);
      setStage('sent');
      onDone();
      if (!r.order) { setStage('done'); return; }
      setOrder(r.order);
      setStage('bridge');
      const final = await waitCallFor(r.caller, r.order.callForId, 10 * 60_000, (o) => { if (alive.current) setOrder(o); });
      if (!alive.current) return;
      if (!final || final.status === 0 || final.status === 4) { setStage('bridge'); return; }
      if (final.status !== 1) { setStage('failed'); onDone(); return; }
      setStage('arrived');
      onDone();
      if (side === 'buy' && then === 'perps') await toFutures(final);
      else setStage('done');
    } catch (e) { fail(e); } finally { if (alive.current) { setBusy(false); setStep(null); } }
  };

  if (stage) {
    const steps: Array<[Stage, string]> = side === 'buy'
      ? [['sent', 'Sent'], ['bridge', 'Subscribing'], ['arrived', 'Shares in wallet'], ...(then === 'perps' ? [['futures', 'In Futures'] as [Stage, string]] : [])]
      : [['sent', 'Sent'], ['bridge', 'Redeeming'], ['arrived', 'USDC in wallet']];
    const order_: Stage[] = steps.map(([k]) => k);
    const at = stage === 'done' ? order_.length - 1 : stage === 'failed' ? -1 : Math.max(0, order_.indexOf(stage));
    const got = order && order.status === 1 ? formatUnits(order.outAmount, side === 'buy' ? shareDp : usdcDp) : null;
    return (
      <div className="fx-stack">
        <div className={`fx-dprog${stage === 'failed' ? ' is-failed' : ''}`} role="status" aria-live="polite">
          <div className="fx-dprog__what">
            {side === 'buy' ? `${amount} USDC` : `${amount} vsoUSDC`}
            <small> {side === 'buy' ? 'into USDC Earn' : 'out of USDC Earn'}</small>
          </div>
          {stage === 'failed'
            ? <p className="fx-dprog__fail">{`SoDEX did not settle this request (status ${order?.status ?? '?'}). What was sent is returned to your wallet; check it there.`}</p>
            : (
              <ol className="fx-dprog__steps">
                {steps.map(([k, l], i) => (
                  <li key={k} className={i < at || stage === 'done' ? 'is-past' : i === at ? 'is-now' : ''}><span className="fx-dprog__dot" aria-hidden="true" />{l}</li>
                ))}
              </ol>
            )}
        </div>
        {stage === 'bridge' && !busy && <p className="fx-note">Still settling. It shows as in progress in your Wealth history and arrives in your wallet on ValueChain.</p>}
        {stage === 'bridge' && busy && <p className="fx-note">SoDEX settles this through Base. It usually takes about a minute.</p>}
        {stage === 'futures' && busy && step && <p className="fx-note">{label(step)}</p>}
        {got && stage !== 'failed' && <div className="fx-kv"><div><span>Received</span><b>{fmtShort(got)} {side === 'buy' ? 'vsoUSDC' : 'USDC'}</b></div></div>}
        {error && (
          <>
            <p className="fx-note fx-note--err" role="alert">{error}</p>
            {side === 'buy' && then === 'perps' && stage === 'futures' && (
              <button type="button" className="fx-cta fx-cta--ghost" onClick={() => requestTransfer({ from: 'evm', to: 'perps', coin: 'soUSDC' })}>Move vsoUSDC to Futures</button>
            )}
          </>
        )}
        {stage === 'done' && side === 'sell' && (
          <button type="button" className="fx-cta fx-cta--ghost" onClick={() => requestTransfer({ from: 'evm', coin: 'USDC' })}>Move the USDC</button>
        )}
        <button type="button" className="fx-cta" disabled={busy && stage !== 'bridge'} onClick={onClose}>{stage === 'done' ? 'Done' : 'Close'}</button>
      </div>
    );
  }

  return (
    <div className="fx-stack">
      <div className="fx-box">
        <div className="fx-box__head">
          <span>{side === 'buy' ? 'You pay' : 'You redeem'}</span>
          <span className="fx-max">In your wallet: {held === null ? <Spinner /> : `${fmtShort(formatUnits(held, dp))} ${unit}`}</span>
        </div>
        <div className="fx-amount">
          <input value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
          <span className="fx-amount__unit pfx-unit"><CoinIcon coin="USDC" size={16} /> {unit}</span>
          <button type="button" className="fx-chip" disabled={!held} onClick={() => setAmount(formatUnits(held ?? 0n, dp))}>Max</button>
        </div>
      </div>

      {side === 'buy' && (
        <div className="earn-then">
          <span>Then</span>
          <ViewSeg value={then} options={THEN} onChange={setThen} label="Where the shares go" />
        </div>
      )}

      <div className="fx-kv">
        <div><span>7-day APY, SoDEX</span><b>{apyNum === null ? '—' : `${apyNum.toFixed(2)}%`}</b></div>
        {side === 'buy' && then === 'perps' && <div><span>Counts as Futures margin</span><b>{ratio === null ? '—' : `${Math.round(ratio * 100)}% of its value`}</b></div>}
        {facts && <div><span>Minimum</span><b>{fmtShort(formatUnits(side === 'buy' ? facts.minIn : facts.minRedeem, dp))} {unit}</b></div>}
        {out > 0n && <div><span>You receive, at today’s NAV</span><b>≈ {fmtShort(formatUnits(out, side === 'buy' ? shareDp : usdcDp))} {side === 'buy' ? 'vsoUSDC' : 'USDC'}</b></div>}
        {out > 0n && <div><span>At least</span><b>{fmtShort(formatUnits(minOutOf(out), side === 'buy' ? shareDp : usdcDp))} {side === 'buy' ? 'vsoUSDC' : 'USDC'}</b></div>}
        <div><span>Arrives</span><b>Usually in about a minute</b></div>
      </div>

      {side === 'buy' && then === 'perps' && (
        <p className="fx-note">
          Losses, fees and funding are settled in USDC. With no USDC in Futures they become a negative USDC balance, charged no interest, that your margin covers. SoDEX never sells the vsoUSDC for it; it is liquidated only if your total margin falls below zero.
        </p>
      )}
      {side === 'sell' && away && (
        <p className="fx-note fx-note--warn">
          {away.perps > 0 && <>{`${fmt(away.perps, 4)} vsoUSDC is in Futures.`} </>}{away.spot > 0 && <>{`${fmt(away.spot, 4)} vsoUSDC is in Spot.`} </>}
          Only shares in your wallet can be redeemed. <button type="button" className="fx-link" onClick={() => requestTransfer({ from: away.perps > 0 ? 'perps' : 'spot', to: 'evm', coin: 'soUSDC' })}>Move them to your wallet</button>.
        </p>
      )}

      {!provider ? (
        <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p>
      ) : (
        <button type="button" className="fx-cta" disabled={busy || !units || !!problem || !facts} onClick={() => void send()}>
          {busy ? (step ? label(step) : <Spinner label="Sending" />) : side === 'buy' ? (then === 'perps' ? 'Invest and use as margin' : 'Invest') : 'Redeem'}
        </button>
      )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <p className="fx-note">
        {side === 'buy'
          ? <>Paid from USDC in your wallet on ValueChain, with SOSO for gas. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>.</>
          : 'Paid to your wallet on ValueChain, with SOSO for gas.'}
        {' '}The yield is SoDEX’s, variable and not guaranteed.
      </p>
    </div>
  );
}

/** At most six decimals in the sheet: vsoUSDC has eighteen. */
function fmtShort(v: string): string {
  const [i, f = ''] = v.split('.');
  const d = f.slice(0, 6).replace(/0+$/, '');
  return d ? `${i}.${d}` : i!;
}
