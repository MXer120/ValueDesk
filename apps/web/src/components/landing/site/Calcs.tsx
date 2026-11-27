/**
 * The calculators (owner 2026-11-23: V4's fee calculator "is very smart", plus "one with SoPoints like that, estimated
 * from volume done or USD allocated"). Both in V4's calculator layout, switched with the app's own Segmented control.
 *
 * SoPoints: SoDEX's points for trading on SoDEX, estimated by ValueDesk's model, which the server answers (the page never
 * holds it, owner 2026-11-27: "our formula cant be in the frontend code"; sodex/sopointsEstimate.ts): from a week's
 * futures volume and the average open position held over the week (the "USD allocated" that counts: positions earn
 * points too). Shown as the typical week with the busy-week to quiet-week range, never as one sure number.
 * The fees on that volume use the new wallet's bot fee and SoDEX's maker fee read now; plain arithmetic, labelled.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Segmented, Slider } from '../../bots/kit/kit';
import { bp, FEES } from '../shared';
import { Calculator, Glide, money } from '../v4/V4';
import { HeatGlass } from '../v4/heat';
import { useEstimate } from '../../sodex/sopointsEstimate';
import '../../vip.css';
import '../v4/v4.css';

const STEPS = 1000;
/** A log slider from 10^lo to 10^hi, two significant figures; t = 0 is zero when `zero`. */
function logScale(lo: number, hi: number, zero = false) {
  const of = (t: number): number => {
    if (zero && t === 0) return 0;
    const v = Math.pow(10, lo + ((hi - lo) * t) / STEPS);
    const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / mag) * mag;
  };
  const t = (usd: number): number => (usd <= 0 ? 0 : Math.round(((Math.log10(usd) - lo) / (hi - lo)) * STEPS));
  return { of, t };
}
const VOL = logScale(3, 7); // $1K .. $10M a week
const POS = logScale(2, 6, true); // $0, $100 .. $1M held
const usdText = (v: number): string => (v === 0 ? '$0' : v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const pts = (v: number): string => Math.round(v).toLocaleString('en-US');

export function PointsCalc({ makerBps }: { makerBps: number | null }) {
  const [tv, setTv] = useState(() => VOL.t(100_000));
  const [tp, setTp] = useState(() => POS.t(1_000));
  const futures = VOL.of(tv);
  const oi = POS.of(tp);
  // The server prices the week; a drag asks once it rests, and the last answer stays until the next one is in.
  const plans = useMemo(() => [{ futures, oi }], [futures, oi]);
  const est = useEstimate(plans, null, { debounceMs: 140 });
  const e = est.data?.plans[0] ?? null;
  // The fee the executor would charge: the step for 14 days of this volume (two weeks like this one), VIP from its volume.
  const vol14 = futures * 2;
  const vipMin = FEES.vipMinUsd;
  const vip = vol14 >= vipMin;
  const step = FEES.botLadder.reduce((ix, x, i) => (vol14 >= x.fromUsd ? i : ix), 0);
  const fee = vip ? FEES.botLowest : FEES.botLadder[step]!.fee;
  const ours = (futures * (fee / 10)) / 10_000;
  const sodex = makerBps === null ? null : (futures * makerBps) / 10_000;
  const perPoint = sodex === null || !e || e.mid <= 0 ? null : (ours + sodex) / e.mid;
  return (
    <div className="v4-calc vd-pcalc">
      <div className="v4-calc__in tf">
        <div>
          <div className="v4-calc__row">
            <label className="v4-calc__l" htmlFor="vd-pv">Futures volume in a week</label>
            <output className="v4-calc__vol" htmlFor="vd-pv">{usdText(futures)}</output>
          </div>
          <div className={vip ? 'v4-calc__slider is-tight is-vip' : 'v4-calc__slider is-tight'} style={{ '--p': `${(tv / STEPS) * 100}%` } as CSSProperties}>
            <Slider value={tv} min={0} max={STEPS} step={1} onChange={setTv} label={`Futures volume in a week: ${usdText(futures)}`} className="v4-slider" />
            <span className="v4-gold" aria-hidden="true"><i /></span>
            <div className="v4-calc__ends" aria-hidden="true"><span>$1K</span><span>$10M</span></div>
          </div>
        </div>
        <div>
          <div className="v4-calc__row">
            <label className="v4-calc__l" htmlFor="vd-pp">Average open position, held all week</label>
            <output className="v4-calc__vol is-sm" htmlFor="vd-pp">{usdText(oi)}</output>
          </div>
          <div className="v4-calc__slider is-tight" style={{ '--p': `${(tp / STEPS) * 100}%` } as CSSProperties}>
            <Slider value={tp} min={0} max={STEPS} step={1} onChange={setTp} label={`Average open position: ${usdText(oi)}`} className="v4-slider" />
            <div className="v4-calc__ends" aria-hidden="true"><span>$0</span><span>$1M</span></div>
          </div>
        </div>
        <ul className="vd-pcalc__how">
          <li><b>Volume</b> every futures trade counts</li>
          <li><b>Positions</b> held all week count too</li>
          <li><b>Steady</b> big volume earns less per dollar</li>
        </ul>
      </div>

      <div className="v4-calc__out">
        <HeatGlass layout="card" rib={22} className="v4-calc__heat" />
        <div className="v4-calc__res">
          <p className="v4-calc__k">Estimated own SoPoints for that week</p>
          <p className="v4-calc__big">≈ {e ? <Glide value={e.mid} fmt={pts} /> : '—'}</p>
          <p className="v4-calc__eq">{e ? <>busy week <b>{pts(e.busy)}</b> · quiet week <b>{pts(e.quiet)}</b></> : est.failed ? 'No estimate right now' : 'Estimating…'}</p>
          <div className="v4-calc__split">
            <div>
              <small>Fees on that volume</small>
              <b>{sodex === null ? '—' : <Glide value={ours + sodex} fmt={money} />}</b>
              <span className="v4-dim">{vip ? <span className="vip-text">{bp(fee)} VIP</span> : `${bp(fee)} bot fee`}{makerBps === null ? '' : ` + ${makerBps} bp SoDEX maker`}, two weeks like this one</span>
            </div>
            <div>
              <small>Fees per point</small>
              <b>{perPoint === null ? '—' : <Glide value={perPoint} fmt={money} />}</b>
              <span className="v4-dim">at the central estimate</span>
            </div>
          </div>
          <div className="vd-acts">
            <a href="/points" className="v4-btn is-light is-block">Analyze my SoPoints</a>
            <div className="vd-acts__row">
              <a href="/trade" className="v4-btn is-glass">Trade</a>
              <a href="/bots/new" className="v4-btn is-glass">Start a bot</a>
            </div>
          </div>
        </div>
      </div>
      <p className="v4-calc__note">
        An estimate, not a promise. SoPoints are SoDEX's and SoDEX decides them; it publishes no formula. This uses ValueDesk's model{est.data ? `, fitted on ${est.data.model.fittedOn}` : ''}.
      </p>
    </div>
  );
}

/** The fee calculator's way on: Trade, and one split button - a bot on one half, copy trading on the other. */
function FeeActions() {
  return (
    <div className="vd-acts__row">
      <a href="/trade" className="v4-btn is-light">Trade</a>
      <div className="vd-split" role="group" aria-label="Start a bot or copy a trader">
        <a href="/bots/new">Start a bot</a>
        <a href="/copy">Copy a trader</a>
      </div>
    </div>
  );
}

type Tab = 'fees' | 'points';

/** Both calculators behind one switch. Must sit inside a `.v4` scope (site.tsx Embed). */
export function Calcs({ makerBps, initial = 'fees' }: { makerBps: number | null; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <div className="vd-calcs">
      <div className="vd-calcs__tabs tf">
        <Segmented<Tab> options={[{ value: 'fees', label: 'Fee calculator' }, { value: 'points', label: 'SoPoints estimate' }]} value={tab} onChange={setTab} label="Calculator" size="md" />
      </div>
      {/* Both stay mounted in one grid cell: the switch cross-fades them and the height never jumps. */}
      <div className="vd-calcs__panes">
        <div className={tab === 'fees' ? 'vd-calcs__pane is-on' : 'vd-calcs__pane'} aria-hidden={tab !== 'fees'} {...(tab !== 'fees' ? { inert: '' } : {})}><Calculator makerBps={makerBps} actions={<FeeActions />} /></div>
        <div className={tab === 'points' ? 'vd-calcs__pane is-on' : 'vd-calcs__pane'} aria-hidden={tab !== 'points'} {...(tab !== 'points' ? { inert: '' } : {})}><PointsCalc makerBps={makerBps} /></div>
      </div>
    </div>
  );
}
