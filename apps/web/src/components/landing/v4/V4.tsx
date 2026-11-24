/**
 * Landing version 4, "Heat" (owner 2026-11-23): pricing- and calculator-led. The liquidation heatmap's ramp through
 * ribbed glass is the signature (heat.tsx); the page leads with the lowest fee WITH its condition, the small start, a
 * fee calculator on the real ladder, pricing cards, the safety facts, the live market table and the FAQ.
 *
 * Nothing on it is made up: every figure is live (shared.tsx useLiveDesk) or a constant the executor charges
 * (shared.tsx FEES), or plain arithmetic on those, labelled as such. The heat field and the whale are drawings.
 * Motion pauses off screen and follows prefers-reduced-motion. English only (data-no-i18n).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';


import { Slider } from '../../bots/kit/kit';

import { bp, FEES, reducedMotion, usdStep } from '../shared';
import { HeatGlass } from './heat';
import '../../vip.css';
import './v4.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

const VIP_MIN_USD = FEES.vipMinUsd;
const VIP_WHEN = FEES.vipCondition.replace(/^VIP:\s*/, '');

/** A number that glides to its new value (the calculator's results). */
export function Glide({ value, fmt }: { value: number; fmt: (v: number) => string }) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reducedMotion()) { setV(value); from.current = value; return; }
    const a = from.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 380);
      const x = a + (value - a) * (1 - Math.pow(1 - k, 3));
      setV(x);
      from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(v)}</>;
}

export const money = (v: number): string => {
  const a = Math.abs(v);
  const s = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}$${s}`;
};

function Arrow() {
  return <svg className="v4-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>;
}

/* ------------------------------------------------------------------------------------- calculator ----- */

const LOG_MIN = 4; // $10K
const LOG_MAX = 7; // $10M
const STEPS = 1000;
const volOf = (t: number): number => {
  const v = Math.pow(10, LOG_MIN + ((LOG_MAX - LOG_MIN) * t) / STEPS);
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag; // two significant figures, so the arithmetic below is easy to redo by hand
};
const tOf = (usd: number): number => Math.round(((Math.log10(usd) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * STEPS);
const volText = (v: number): string => (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : `$${+(v / 1e3).toFixed(1)}K`);

export function Calculator({ makerBps, actions }: { makerBps: number | null; actions?: ReactNode }) {
  const [t, setT] = useState(() => tOf(500_000));
  const vol = volOf(t);
  // As the executor does (VIP_BY_VOLUME): the ladder step by 14-day bot volume, and VIP on its own from the VIP volume.
  const vip = vol >= VIP_MIN_USD;
  const ladderIx = FEES.botLadder.reduce((ix, s, i) => (vol >= s.fromUsd ? i : ix), 0);
  const fee = vip ? FEES.botLowest : FEES.botLadder[ladderIx]!.fee; // tenths of a bp
  const ours = (vol * (fee / 10)) / 10_000;
  const sodex = makerBps === null ? null : (vol * makerBps) / 10_000;
  const marks = [...FEES.botLadder.slice(1).map((s) => ({ usd: s.fromUsd, vip: false })), { usd: VIP_MIN_USD, vip: true }];

  return (
    <div className="v4-calc">
      <div className="v4-calc__in tf">
        <div className="v4-calc__row">
          <label className="v4-calc__l" htmlFor="v4-vol">Your bots' volume in {FEES.windowDays} days</label>
          <output className="v4-calc__vol" htmlFor="v4-vol">{volText(vol)}</output>
        </div>
        <div className={cx('v4-calc__slider', vip && 'is-vip')} style={{ '--p': `${(t / STEPS) * 100}%` } as CSSProperties}>
          <Slider value={t} min={0} max={STEPS} step={1} onChange={setT} label={`Bot volume in ${FEES.windowDays} days: ${volText(vol)}`} className="v4-slider" />
          <span className="v4-gold" aria-hidden="true"><i /></span>
          <div className="v4-calc__marks" aria-hidden="true">
            {marks.map((m) => (
              <span key={m.usd} className={cx(m.vip && 'is-vip')} style={{ left: `${(tOf(m.usd) / STEPS) * 100}%` }}>{usdStep(m.usd)}</span>
            ))}
          </div>
          <div className="v4-calc__ends" aria-hidden="true"><span>$10K</span><span>$10M</span></div>
        </div>

        <p className={cx('v4-calc__auto', vip && 'is-vip')}>
          {vip
            ? <><span className="v4-vip vip-pill">VIP</span>Applied automatically: {VIP_WHEN}.</>
            : <><span className="vip-text">VIP</span> applies automatically from {usdStep(VIP_MIN_USD)} in {FEES.windowDays} days.</>}
        </p>

        <ol className="v4-ladder" aria-label="Bot fee ladder">
          {FEES.botLadder.map((s, i) => (
            <li key={s.fromUsd} className={cx(!vip && i === ladderIx && 'is-on')}>
              <small>{s.fromUsd === 0 ? 'Everyone' : `From ${usdStep(s.fromUsd)}`}</small>
              <b>{bp(s.fee)}</b>
            </li>
          ))}
          <li className={cx('is-vipstep', vip && 'is-on')}>
            <small><span className="v4-vip vip-pill">VIP</span></small>
            <b className="vip-text">{bp(FEES.botLowest)}</b>
          </li>
        </ol>
      </div>

      <div className="v4-calc__out">
        <HeatGlass layout="card" rib={22} className="v4-calc__heat" />
        <div className="v4-calc__res">
          <p className="v4-calc__k">ValueDesk fee on {volText(vol)}</p>
          <p className="v4-calc__big"><Glide value={ours} fmt={money} /></p>
          <p className="v4-calc__eq">{volText(vol)} × <b className={cx(vip && 'vip-text')}>{bp(fee)}</b> ÷ 10,000 {vip ? <span className="v4-vip vip-pill">VIP</span> : <span className="v4-step">{ladderIx === 0 ? 'everyone' : `from ${usdStep(FEES.botLadder[ladderIx]!.fromUsd)}`}</span>}</p>
          <div className="v4-calc__split">
            <div>
              <small>SoDEX maker fee, paid to SoDEX</small>
              <b>{sodex === null ? '—' : <Glide value={sodex} fmt={money} />}</b>
              <span className="v4-dim">{makerBps === null ? 'reading SoDEX…' : `${volText(vol)} × ${makerBps} bp now`}</span>
            </div>
            <div>
              <small>Both fees together</small>
              <b>{sodex === null ? '—' : <Glide value={ours + sodex} fmt={money} />}</b>
              <span className="v4-dim">before the bot's own result</span>
            </div>
          </div>
          {actions ?? <a href="/bots/new" className="v4-btn is-light is-block">Start a bot<Arrow /></a>}
        </div>
      </div>
    </div>
  );
}
