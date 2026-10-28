/**
 * Take Profit & Stop Loss for one open position, in the Settings language
 * (dialogParts.tsx). The position, its entry and the mark; then each exit as
 * a section: its trigger price and the gain or loss that price makes, in % of
 * the entry or USD. Last, how it exits: at market or as a limit at the
 * trigger, and for the whole position or part of it.
 */
import { fmtDecimalString, toInputText } from '../numStyle';
import { decimalInput } from './numberInput';
import { useState } from 'react';
import { CoinIcon } from './CoinIcon';
import { Modal } from './Modal';
import { DlgFoot, DlgRow, DlgSection, DlgSeg } from './dialogParts';
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

/** $86,231.50 (86.231,50 in the default format, numStyle.ts) — the figures in the position block. */
const usd = (n: number, dp: number): string => `$${fmtDecimalString(trim(n, dp))}`;

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

  /** Which way the price has to move for this exit to fire. */
  const direction = (leg: Leg) => ((leg === 'tp') === (side === 'long') ? 'rises' : 'falls');
  const field = (leg: Leg, title: string, gainWord: string) => {
    const row = legs[leg];
    const ok = legOk(leg);
    const bad = row.price.trim() !== '' && !ok;
    return (
      <DlgSection label={title}>
        <DlgRow title="Trigger price" line={`Fires when the ${basis} price ${direction(leg)} to it. Empty means no ${title.toLowerCase()}.`}>
          <span className={`dlg-field${bad ? ' is-bad' : ''}`}>
            <span className="dlg-pre">$</span>
            <input
              aria-label={`${title} price`}
              value={toInputText(row.price)}
              placeholder={toInputText('0.00')}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              onChange={(e) => setPrice(leg, decimalInput(e.target.value, { prev: row.price }))}
            />
          </span>
        </DlgRow>
        <DlgRow title={gainWord} line={`What the ${title.toLowerCase()} makes at that price; type here to set the price from it.`}>
          <span className="dlg-field">
            <input
              aria-label={`${title} ${gainWord.toLowerCase()}`}
              value={toInputText(row.gain)}
              placeholder={toInputText('0.00')}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              onChange={(e) => setGain(leg, decimalInput(e.target.value, { signed: true, prev: row.gain }))}
            />
            <span className="dlg-unit">{row.unit === 'pct' ? '%' : 'USD'}</span>
          </span>
          <DlgSeg
            label={`${gainWord} in`}
            value={row.unit}
            disabled={busy}
            onChange={(u) => {
              if (u !== row.unit) swap(leg);
            }}
            options={[
              { value: 'pct' as GainUnit, label: '%', aria: `${gainWord} in percent of the entry` },
              { value: 'usd' as GainUnit, label: 'USD', aria: `${gainWord} in USD` },
            ]}
          />
        </DlgRow>
        {bad && <p className="dlg-warn">{triggerHint(side, leg, basis)}</p>}
      </DlgSection>
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
        <DlgFoot>
          <button type="button" className="dlg-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="dlg-btn is-go" disabled={!can} onClick={() => onConfirm({ tp: draft('tp'), sl: draft('sl') })}>
            Confirm
          </button>
        </DlgFoot>
      }
    >
      <div className="dlg">
        <div className="dlg-facts">
          <div className="dlg-fact">
            <span>Position</span>
            <b className={side === 'long' ? 'pos' : 'neg'}>{side === 'long' ? 'Long' : 'Short'} {fmtDecimalString(fullQty)} {coin}</b>
          </div>
          <div className="dlg-fact">
            <span>Avg. entry price</span>
            <b>{entry > 0 ? usd(entry, Math.max(dp, 2)) : '—'}</b>
          </div>
          <div className="dlg-fact">
            <span>Mark price</span>
            <b>{mark !== null && mark > 0 ? usd(mark, Math.max(dp, 2)) : '—'}</b>
          </div>
        </div>
        {field('tp', 'Take Profit', 'Gain')}
        {field('sl', 'Stop Loss', 'Loss')}
        <DlgSection label="How it exits">
          <DlgRow title="Order type" line={limit ? 'The exit rests as a limit order at the trigger price.' : 'The exit closes at market as soon as it triggers.'}>
            <DlgSeg
              label="Order type"
              value={limit ? 'limit' : 'market'}
              disabled={busy}
              onChange={(v) => setLimit(v === 'limit')}
              options={[
                { value: 'market', label: 'Market' },
                { value: 'limit', label: 'Limit' },
              ]}
            />
          </DlgRow>
          <DlgRow title="Size" line={configure ? 'Choose how much of the position this exit closes.' : 'The exit closes the whole position.'}>
            <DlgSeg
              label="Exit size"
              value={configure ? 'part' : 'all'}
              disabled={busy}
              onChange={(v) => {
                const on = v === 'part';
                if (on === configure) return;
                setConfigure(on);
                retarget(on ? Number(size) : full);
              }}
              options={[
                { value: 'all', label: 'Whole position' },
                { value: 'part', label: 'Part' },
              ]}
            />
          </DlgRow>
          {configure && (
            <DlgRow title="Size to close" line={`Up to ${fmtDecimalString(fullQty)} ${coin}.`}>
              <span className={`dlg-field${sizeOk ? '' : ' is-bad'}`}>
                <input
                  aria-label="Exit size"
                  value={toInputText(size)}
                  placeholder="0"
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={busy}
                  onChange={(e) => {
                    const v = decimalInput(e.target.value, { prev: size });
                    setSize(v);
                    retarget(Number(v));
                  }}
                />
                <span className="dlg-unit">{coin}</span>
              </span>
            </DlgRow>
          )}
          {configure && !sizeOk && <p className="dlg-warn">Size has to be within the position.</p>}
        </DlgSection>
      </div>
    </Modal>
  );
}
