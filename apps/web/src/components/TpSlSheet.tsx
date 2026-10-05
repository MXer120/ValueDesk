/**
 * Take Profit & Stop Loss for one open position. One sheet, both exits: the
 * position, its entry and the mark, then a price and the gain or loss that
 * price makes. The swap on the gain field turns that figure from a percent of
 * the entry into USDC. Limit makes the exit a limit order at the trigger.
 * Configure size closes part of the position.
 */
import { useState } from 'react';
import { CoinIcon } from './CoinIcon';
import { Modal } from './Modal';
import {
  gainFromPrice,
  planExit,
  priceFromGain,
  sameNum,
  triggerHint,
  triggerSideOk,
  type ExitDraft,
  type ExitExisting,
  type GainUnit,
  type Leg,
  type Side,
} from './tpsl';

export interface TpSlConfirm {
  tp: ExitDraft;
  sl: ExitDraft;
}

interface LegState {
  price: string;
  gain: string;
  unit: GainUnit;
}

const trim = (n: number, dp: number): string => {
  const s = n.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** $86,231.50 — the figures in the position block. */
const usd = (n: number, dp: number): string => {
  const [whole, frac] = trim(n, dp).split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `$${grouped}.${frac}` : `$${grouped}`;
};

const decimalsOf = (tick?: string): number => {
  if (!tick || !tick.includes('.')) return tick ? 0 : 2;
  return Math.min(8, tick.length - tick.indexOf('.') - 1);
};

function seed(existing: ExitExisting | undefined, entry: number, side: Side, leg: Leg, qty: number): LegState {
  const price = existing?.price ?? '';
  const n = Number(price);
  const gain = price.trim() && Number.isFinite(n) ? gainFromPrice(entry, n, side, leg, qty, 'pct') : null;
  return { price, gain: gain === null ? '' : trim(gain, 2), unit: 'pct' };
}

const SwapIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <path d="M2 4.5h8.2M8.2 2.6 10.6 4.5 8.2 6.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 9.5H3.8M5.8 7.6 3.4 9.5 5.8 11.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const InfoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 6.4V10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="7" cy="4.3" r="0.7" fill="currentColor" />
  </svg>
);

export function TpSlSheet({
  symbol, coin, side, entry, mark, fullQty, tick, tp, sl, busy, onClose, onConfirm,
}: {
  symbol: string;
  coin: string;
  side: Side;
  entry: number;
  mark: number | null;
  /** The whole position, as the venue reported it. */
  fullQty: string;
  tick?: string;
  tp?: ExitExisting;
  sl?: ExitExisting;
  busy: boolean;
  onClose: () => void;
  onConfirm: (req: TpSlConfirm) => void;
}) {
  const full = Number(fullQty);
  const partial = [tp, sl].find((e) => !!e?.quantity && !sameNum(e.quantity, fullQty));
  const [limit, setLimit] = useState(Boolean(tp?.limit || sl?.limit));
  const [configure, setConfigure] = useState(Boolean(partial));
  const [size, setSize] = useState(partial?.quantity || fullQty);
  const qty = configure ? Number(size) : full;
  const [legs, setLegs] = useState<Record<Leg, LegState>>(() => ({
    tp: seed(tp, entry, side, 'tp', Number(partial?.quantity || fullQty) || full),
    sl: seed(sl, entry, side, 'sl', Number(partial?.quantity || fullQty) || full),
  }));
  const dp = decimalsOf(tick);
  const bound = mark !== null && mark > 0 ? mark : entry;
  const basis = mark !== null && mark > 0 ? 'mark' : 'entry';

  const rewriteGain = (leg: Leg, price: string, unit: GainUnit, at: number): string => {
    const n = Number(price);
    if (!price.trim() || !Number.isFinite(n)) return '';
    const g = gainFromPrice(entry, n, side, leg, at, unit);
    return g === null ? '' : trim(g, 2);
  };

  const setPrice = (leg: Leg, price: string) => {
    setLegs((cur) => ({ ...cur, [leg]: { ...cur[leg], price, gain: rewriteGain(leg, price, cur[leg].unit, qty) } }));
  };
  const setGain = (leg: Leg, gain: string) => {
    setLegs((cur) => {
      const next = { ...cur[leg], gain };
      if (!gain.trim()) return { ...cur, [leg]: { ...next, price: '' } };
      const n = Number(gain);
      if (!Number.isFinite(n)) return { ...cur, [leg]: next };
      const px = priceFromGain(entry, n, side, leg, qty, cur[leg].unit);
      return { ...cur, [leg]: { ...next, price: px === null ? cur[leg].price : trim(px, dp) } };
    });
  };
  const swap = (leg: Leg) => {
    setLegs((cur) => {
      const unit: GainUnit = cur[leg].unit === 'pct' ? 'usd' : 'pct';
      return { ...cur, [leg]: { ...cur[leg], unit, gain: rewriteGain(leg, cur[leg].price, unit, qty) } };
    });
  };
  const retarget = (at: number) => {
    setLegs((cur) => ({
      tp: { ...cur.tp, gain: rewriteGain('tp', cur.tp.price, cur.tp.unit, at) },
      sl: { ...cur.sl, gain: rewriteGain('sl', cur.sl.price, cur.sl.unit, at) },
    }));
  };

  const draft = (leg: Leg): ExitDraft => ({
    price: legs[leg].price.trim(),
    quantity: configure ? size.trim() : fullQty,
    limit,
  });
  const tpPlan = planExit(tp, draft('tp'));
  const slPlan = planExit(sl, draft('sl'));
  const legOk = (leg: Leg) => {
    const price = legs[leg].price.trim();
    if (!price) return true;
    return triggerSideOk(Number(price), bound, side, leg);
  };
  const sizeOk = !configure || (Number(size) > 0 && Number.isFinite(full) && Number(size) <= full + Math.max(full, 1) * 1e-8);
  const dirty = tpPlan.action !== 'keep' || slPlan.action !== 'keep';
  const can = legOk('tp') && legOk('sl') && sizeOk && dirty && !busy;

  const field = (leg: Leg, title: string, gainWord: string) => {
    const row = legs[leg];
    const ok = legOk(leg);
    return (
      <section className="vs-tpsl__leg">
        <h3>{title}</h3>
        <div className="vs-tpsl__pair">
          <div className="vs-tpsl__field">
            <span>Price</span>
            <span className="vs-tpsl__val">
              <span className="vs-tpsl__usd">$</span>
              <input
                aria-label={`${title} price`}
                value={row.price}
                placeholder="0.00"
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
                onChange={(e) => setPrice(leg, e.target.value)}
              />
            </span>
          </div>
          <div className="vs-tpsl__field">
            <span>{gainWord}</span>
            <span className="vs-tpsl__val">
              <input
                aria-label={`${title} ${gainWord.toLowerCase()}`}
                value={row.gain}
                placeholder="0.00"
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
                onChange={(e) => setGain(leg, e.target.value)}
              />
              <span className="vs-tpsl__unit">{row.unit === 'pct' ? '%' : 'USD'}</span>
              <button
                type="button"
                className="vs-tpsl__swap"
                aria-label={row.unit === 'pct' ? `Show ${gainWord.toLowerCase()} in USD` : `Show ${gainWord.toLowerCase()} in percent`}
                disabled={busy}
                onClick={() => swap(leg)}
              >
                <SwapIcon />
              </button>
            </span>
          </div>
        </div>
        {row.price.trim() !== '' && !ok && <p className="fx-note fx-note--warn">{triggerHint(side, leg, basis)}</p>}
      </section>
    );
  };

  return (
    <Modal
      open
      className="fx vs-tpsl"
      title={<span className="vs-tpsl__name"><CoinIcon coin={coin || symbol} size={22} /> Take Profit &amp; Stop Loss</span>}
      onClose={onClose}
      dismissOnBackdrop={!busy}
      footer={
        <button type="button" className="fx-cta" disabled={!can} onClick={() => onConfirm({ tp: draft('tp'), sl: draft('sl') })}>
          Confirm
        </button>
      }
    >
      <div className="vs-tpsl__facts">
        <div className="vs-tpsl__stat">
          <span>Current Position</span>
          <b className={side === 'long' ? 'pos' : 'neg'}>{fullQty} {coin}</b>
        </div>
        <div className="vs-tpsl__stat">
          <span>Avg. Entry Price</span>
          <b>{entry > 0 ? usd(entry, Math.max(dp, 2)) : '—'}</b>
        </div>
        <div className="vs-tpsl__stat">
          <span>Mark Price</span>
          <b>{mark !== null && mark > 0 ? usd(mark, Math.max(dp, 2)) : '—'}</b>
        </div>
      </div>
      {field('tp', 'Take Profit', 'Gain')}
      {field('sl', 'Stop Loss', 'Loss')}
      <div className="vs-tpsl__opts">
        <div className="vs-tpsl__opt">
          <label className="fx-check">
            <input type="checkbox" checked={limit} disabled={busy} onChange={(e) => setLimit(e.target.checked)} />
            <span>Limit</span>
          </label>
          <button type="button" className="vs-tpsl__info" title="The exit rests as a limit order at the trigger price." aria-label="About limit exits">
            <InfoIcon />
          </button>
        </div>
        <div className="vs-tpsl__opt">
          <label className="fx-check">
            <input
              type="checkbox"
              checked={configure}
              disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                setConfigure(on);
                retarget(on ? Number(size) : full);
              }}
            />
            <span>Configure size</span>
          </label>
          <button type="button" className="vs-tpsl__info" title="Choose how much of the position this exit closes." aria-label="About exit size">
            <InfoIcon />
          </button>
        </div>
        {configure && (
          <label className="vs-tpsl__field">
            <span>Size</span>
            <span className="vs-tpsl__val">
              <input
                aria-label="Exit size"
                value={size}
                placeholder="0"
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
                onChange={(e) => {
                  setSize(e.target.value);
                  retarget(Number(e.target.value));
                }}
              />
              <span className="vs-tpsl__unit">{coin}</span>
            </span>
          </label>
        )}
        {configure && !sizeOk && <p className="fx-note fx-note--warn">Size has to be within the position.</p>}
      </div>
    </Modal>
  );
}
