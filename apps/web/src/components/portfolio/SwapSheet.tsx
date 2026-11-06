/**
 * Swap USDT to USDC: SoDEX's route (trading/swap.ts) in the funds sheets' clothes. A quote
 * from the live book, the amount, what comes out, and one button that says what stands in
 * the way until it says Swap.
 */
import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { NoWallet } from '../EmptyState';
import { useAccountResource } from '../../accountFeeds';
import { api } from '../../api';
import { DASH, fmt, num, pick } from '../../format';
import { useAsync } from '../../hooks';
import { placeOrder } from '../../trading/actions';
import { OutcomeUnknownError } from '../../trading/gateway';
import {
  SWAP_BUTTON_TEXT, SWAP_FLOOR_PRICE, SWAP_FROM_COIN, SWAP_SYMBOL, runSwap, swapAmount, swapButton, swapQuote,
  type BookLevel, type SwapResult,
} from '../../trading/swap';
import { requestEnableTrading } from '../account/actions';
import { decimalInput } from '../numberInput';
import { Spinner } from '../funds/ui';
import '../funds/funds.css';

const levels = (raw: unknown): BookLevel[] =>
  (Array.isArray(raw) ? raw : []).map((l) => (Array.isArray(l)
    ? { price: num(l[0]), quantity: num(l[1]) }
    : { price: num(pick(l, 'price', 'p')), quantity: num(pick(l, 'quantity', 'q', 'size')) }));

export function SwapSheet({ open, onClose, address, unlocked, onChanged }: {
  open: boolean;
  onClose: () => void;
  address: string | null;
  unlocked: boolean;
  onChanged: () => void;
}) {
  return (
    <Modal open={open} title="Swap USDT to USDC" onClose={onClose} size="sm" className="fx fx-money">
      {!address
        ? <NoWallet line="Connect a wallet to swap." compact />
        : open && <SwapBody address={address} unlocked={unlocked} onChanged={onChanged} onClose={onClose} />}
    </Modal>
  );
}

function SwapBody({ address, unlocked, onChanged, onClose }: { address: string; unlocked: boolean; onChanged: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);

  const book = useAsync(() => api.orderbook('spot', SWAP_SYMBOL, 20), [], { pollMs: 3000 });
  const spot = useAccountResource(`state:spot:${address}`, () => api.state('spot', address), 20_000);
  const balance = useMemo(() => {
    if (!spot.data) return null;
    const row = ((spot.data.state?.B ?? []) as unknown[]).find((b) => pick(b, 'a', 'coin') === SWAP_FROM_COIN);
    return row ? Math.max(0, num(pick(row, 't', 'total')) - num(pick(row, 'l', 'locked'))) : 0;
  }, [spot.data]);

  const bids = useMemo(() => {
    const raw = book.data as unknown as { book?: { bids?: unknown } | null } | null;
    return raw?.book ? levels(raw.book.bids) : null;
  }, [book.data]);
  const quote = useMemo(() => (bids && amount ? swapQuote(bids, amount) : null), [bids, amount]);
  const button = swapButton({ amount, balance, quote });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runSwap(amount, {
        place: (t) => placeOrder('spot', t),
        history: async () => {
          const h = await api.orderHistory('spot', address, 20) as unknown;
          return (Array.isArray(h) ? h : ((h as { orders?: unknown[] } | null)?.orders ?? [])) as Array<Record<string, unknown>>;
        },
      });
      setResult(r);
      onChanged();
      spot.refresh();
    } catch (e) {
      setError(e instanceof OutcomeUnknownError
        ? `${e.message} Check Order History in Spot before swapping again.`
        : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const left = Math.max(0, num(swapAmount(amount)) - result.usdt);
    return (
      <div className="fx-stack">
        {result.status === 'filled' && <p className="fx-note fx-note--ok">Swapped {fmt(result.usdt, 2)} USDT for {fmt(result.usdc, 2)} USDC. It is in your Spot balance.</p>}
        {result.status === 'partial' && <p className="fx-note fx-note--warn">Part of it filled: {fmt(result.usdt, 2)} USDT for {fmt(result.usdc, 2)} USDC. {fmt(left, 2)} USDT stays in Spot.</p>}
        {result.status === 'failed' && <p className="fx-note fx-note--err">Nothing filled: the book moved. Your USDT is untouched.</p>}
        {result.status === 'unknown' && <p className="fx-note fx-note--warn">The order was sent, and its result has not arrived. Check Order History in Spot before swapping again.</p>}
        <button type="button" className="fx-cta" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="fx-stack pfx-swap">
      <div className="pfx-swap__pair">
        <div className="pfx-swap__box">
          <div className="pfx-swap__row">
            <span className="pfx-swap__k">From</span>
            <span className="pfx-swap__k">
              Spot {balance === null ? <Spinner /> : <b>{fmt(balance, 2)}</b>}
              <button type="button" className="pfx-swap__max" disabled={!balance} onClick={() => setAmount(swapAmount(balance ?? 0))}>Max</button>
            </span>
          </div>
          <div className="pfx-swap__row">
            <input className="pfx-swap__in" value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0" aria-label="USDT to swap" />
            <span className="pfx-swap__coin"><CoinIcon coin="USDT" size={22} /> USDT</span>
          </div>
        </div>
        <span className="pfx-swap__arrow" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div className="pfx-swap__box">
          <div className="pfx-swap__row"><span className="pfx-swap__k">To</span></div>
          <div className="pfx-swap__row">
            <output className={`pfx-swap__in${quote ? '' : ' is-empty'}`}>{quote ? fmt(quote.receive, 2) : '0'}</output>
            <span className="pfx-swap__coin"><CoinIcon coin="USDC" size={22} /> USDC</span>
          </div>
        </div>
      </div>
      <div className="fx-kv">
        <div><span>Rate</span><b>1 USDT = {quote && quote.filled > 0 ? fmt(quote.avgPrice, 5) : DASH} USDC</b></div>
        <div><span>Lowest fill</span><b>{fmt(Number(SWAP_FLOOR_PRICE), 2)} USDC</b></div>
        <div><span>Fee</span><b>None</b></div>
      </div>
      {!unlocked ? (
        <button type="button" className="fx-cta" onClick={() => requestEnableTrading()}>Enable trading to swap</button>
      ) : (
        <button type="button" className="fx-cta" disabled={busy || button !== 'swap'} onClick={() => void submit()}>
          {busy ? <Spinner label="Swapping" /> : SWAP_BUTTON_TEXT[button]}
        </button>
      )}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      {book.error && !book.data && <p className="fx-note fx-note--err">Could not read the USDT/USDC book. Try again in a moment.</p>}
    </div>
  );
}
