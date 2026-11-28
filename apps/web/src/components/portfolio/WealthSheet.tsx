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
import { Switch } from '../bots/kit/kit';
import { placeOrder } from '../../trading/actions';
import { executorReady, startOn } from '../../algo/executorAlgos';
import { HEDGE_MARKET, HEDGE_MEASURED, hedgeCloseSpec, hedgeQuantity, pricingAt } from '../../trading/instantExit';
import { readTradingStatus, type TradingStatus } from '../../trading/wealth';
import { fillSsiQuote, parseSsiQuote, readSsiFacts, requestSsiQuote, type SsiFacts, type SsiQuote } from '../../trading/ssi';
import { earnCoins } from '../../trading/wealthEarn';
import '../funds/funds.css';
import './recurring.css';

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
        : target && target.action.kind === 'rfq' && target.action.protocol === 'ssi'
          ? <SsiBody key={`${target.fund.fundId}:${target.side}`} target={target} address={address} provider={provider} onDone={onDone} onClose={onClose} />
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
  // Instant exit (a batch redemption with a perp hedge closed at the pricing moment): trading/instantExit.ts.
  const market = side === 'sell' && action.kind === 'batch' ? HEDGE_MARKET[fund.fundId] ?? null : null;
  const [hedge, setHedge] = useState(false);
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [hedgeNote, setHedgeNote] = useState<string | null>(null);
  useEffect(() => {
    if (!market) return;
    let off = false;
    readTradingStatus(fund.fundId).then((st) => { if (!off) setStatus(st); }).catch(() => undefined);
    return () => { off = true; };
  }, [market, fund.fundId]);
  const pricedMs = pricingAt(status);
  const exec = market ? executorReady('hosted', false) : { ready: false, why: null };

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
      if (hedge && market && pricedMs) {
        const qty = hedgeQuantity(Number(formatUnits(units, dp)));
        try {
          await placeOrder('perps', { symbol: market, side: 'sell', type: 'market', quantity: qty });
        } catch (e) {
          setHedgeNote(`The redemption is requested, but the hedge was not opened: ${(e as Error).message}`);
          return;
        }
        try {
          await startOn('hosted', hedgeCloseSpec(market, pricedMs), Date.now() % 1_000_000);
          setHedgeNote(`Hedged: ${qty} ${market} sold, and ValueDesk’s executor buys it back at ${when(pricedMs / 1000)}, when the batch is priced.`);
        } catch (e) {
          setHedgeNote(`The short of ${qty} ${market} is open, but the timed close could not be set (${(e as Error).message}). Close it yourself at ${when(pricedMs / 1000)}.`);
        }
      }
    } catch (e) { fail(e); } finally { setBusy(false); setStep(null); }
  };

  if (hash) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">
          Request sent. Expected by {when(delivery)}. It shows as in progress in your Wealth history until it settles.
        </p>
        {hedgeNote && <p className="fx-note">{hedgeNote}</p>}
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
        <div><span>How</span><b>{action.kind === 'batch' ? 'Batch, at the next price' : side === 'sell' ? 'Instant exit, at a maker\'s quote' : 'At a maker\'s quote'}</b></div>
        {action.kind === 'batch' && pricedMs && <div><span>Priced at</span><b>{when(pricedMs / 1000)}</b></div>}
        {action.kind === 'batch' && <div><span>Cutoff</span><b>{when(action.cutoffAt)}</b></div>}
        <div><span>Expected delivery</span><b>{when(delivery)}</b></div>
        {facts && <div><span>Minimum</span><b>{formatUnits(side === 'buy' ? facts.minDeposit : facts.minRedeem, dp)} {unit}</b></div>}
        {quote?.receiveAmount && (
          <div><span>You receive</span><b>{formatUnits(BigInt(quote.receiveAmount), side === 'buy' ? fund.share.decimals : (facts?.assetDecimals ?? 6))} {side === 'buy' ? fund.share.coin : 'USDC'}</b></div>
        )}
      </div>

      {market && (
        <div className="fx-box ie-box">
          <Switch
            checked={hedge}
            onChange={setHedge}
            disabled={!exec.ready || !pricedMs}
            label="Instant exit: lock today's price with a hedge"
            description={exec.ready
              ? `Sells ${units ? hedgeQuantity(Number(formatUnits(units, dp))) : 'the same size of'} ${market} now from Futures, and ValueDesk's executor buys it back when the batch is priced${pricedMs ? ` (${when(pricedMs / 1000)})` : ''}.`
              : (exec.why ?? 'ValueDesk’s executor is needed to close the hedge on time.')}
          />
          <p className="fx-note">
            {`Measured on ${HEDGE_MEASURED.batches} UNITREE batches (${HEDGE_MEASURED.from} – ${HEDGE_MEASURED.to}): the price moved ${HEDGE_MEASURED.unhedgedRmsPct}% (RMS) between the last request and the batch price; with the hedge ${HEDGE_MEASURED.hedgedRmsPct}% was left, because the perp at the open is not the batch price. The hedge cost ${HEDGE_MEASURED.costLowPct}–${HEDGE_MEASURED.costHighPct}% in fees and book impact. It needs USDC in Futures as margin.`}
          </p>
        </div>
      )}
      {!provider ? (
        <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p>
      ) : action.kind === 'rfq' && !quote ? (
        <button type="button" className="fx-cta" disabled={busy || !units || !!problem} onClick={() => void ask()}>{busy ? <Spinner label="Asking" /> : 'Get a quote'}</button>
      ) : (
        <button type="button" className="fx-cta" disabled={busy || !units || !!problem} onClick={() => void send()}>
          {busy ? (step ? label(step) : <Spinner label="Sending" />) : side === 'buy' ? 'Invest' : hedge ? 'Redeem and hedge' : 'Redeem'}
        </button>
      )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <p className="fx-note">
        {side === 'buy'
          ? <>Paid from USDC in your wallet on ValueChain, with SOSO for gas. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>.</>
          : 'Paid to your wallet on ValueChain. Part of a redemption can settle later.'}
      </p>
    </div>
  );
}

/**
 * An index fund (ANT Believers Index): a maker's signed order for exactly this amount, filled from the wallet at once
 * (sodex.com: "settles in real time"). The order is checked and simulated before the wallet is asked (trading/ssi.ts).
 */
function SsiBody({ target, address, provider, onDone, onClose }: {
  target: WealthSheetTarget; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose: () => void;
}) {
  const { fund, action, side } = target;
  const [asset, setAsset] = useState<string | null>(null);
  const [facts, setFacts] = useState<SsiFacts | null>(null);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<SsiQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const label = useStepLabel();
  const token = fund.share.address;
  useEffect(() => {
    let off = false;
    earnCoins().then((c) => { const a = c.usdc.valuechain.token; if (off) return; setAsset(a); return readSsiFacts(address, token, a).then((f) => { if (!off) setFacts(f); }); })
      .catch((e) => { if (!off) setError((e as Error).message); });
    return () => { off = true; };
  }, [address, token]);
  useEffect(() => { if (!quote) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [quote]);
  const dp = side === 'buy' ? 6 : fund.share.decimals;
  const unit = side === 'buy' ? 'USDC' : fund.share.coin;
  const held = facts ? (side === 'buy' ? facts.usdc : facts.shares) : null;
  let units = 0n;
  try { units = amount ? parseUnits(amount, dp) : 0n; } catch { units = 0n; }
  const problem = !facts || !amount ? null : units <= 0n ? 'Enter an amount.' : held !== null && units > held ? `More than the ${unit} in your wallet.` : facts.gas === 0n ? 'This wallet has no SOSO for gas on ValueChain.' : null;
  const left = quote ? quote.expiry - Math.floor(now / 1000) : 0;
  const fail = (e: unknown) => { if (!isUserRejection(e)) setError((e as Error).message); };
  const ask = async () => {
    if (!asset) return;
    setBusy(true); setError(null);
    try { setQuote(parseSsiQuote(await requestSsiQuote(fund.fundId, side, address, units), { side, owner: address, token, asset, payAmount: units, assetDecimals: 6 })); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const fill = async () => {
    if (!provider || !quote || !asset) return;
    setBusy(true); setError(null);
    if (action.kind !== 'rfq') return;
    try { setHash(await fillSsiQuote({ provider, owner: address, token, asset, rfq: action.rfq, q: quote, onStep: setStep })); onDone(); }
    catch (e) { fail(e); } finally { setBusy(false); setStep(null); }
  };
  if (hash) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--ok">{side === 'buy' ? 'Bought. The index tokens are in your wallet on ValueChain.' : 'Redeemed. The USDC is in your wallet on ValueChain.'}</p>
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }
  const outDp = side === 'buy' ? fund.share.decimals : 18;
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
        <div><span>How</span><b>At a maker’s quote, settled at once</b></div>
        {quote && <div><span>You receive</span><b>{`${formatUnits(quote.receive, outDp)} ${side === 'buy' ? fund.share.coin : 'USDC'}`}</b></div>}
        {quote && <div><span>At least</span><b>{`${formatUnits(quote.minReceive, outDp)} ${side === 'buy' ? fund.share.coin : 'USDC'}`}</b></div>}
        {quote && <div><span>Quote valid for</span><b>{left > 0 ? `${left} s` : 'Expired'}</b></div>}
      </div>
      {!provider ? <p className="fx-note">Reconnect your wallet: this is a wallet transaction on ValueChain.</p>
        : !quote || left <= 0 ? (
          <button type="button" className="fx-cta" disabled={busy || !units || !!problem || !asset} onClick={() => void ask()}>{busy ? <Spinner label="Asking" /> : quote ? 'Get a new quote' : 'Get a quote'}</button>
        ) : (
          <button type="button" className="fx-cta" disabled={busy} onClick={() => void fill()}>{busy ? (step ? label(step) : <Spinner label="Sending" />) : side === 'buy' ? 'Buy' : 'Redeem'}</button>
        )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <p className="fx-note">
        {side === 'buy'
          ? <>Paid from USDC in your wallet on ValueChain, with SOSO for gas. <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>.</>
          : 'Paid to your wallet on ValueChain, with SOSO for gas.'}
        {' '}The order is checked against the fund and simulated on ValueChain before your wallet is asked.
      </p>
    </div>
  );
}
