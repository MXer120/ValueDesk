/**
 * The three fee cards (owner 2026-11-23, after a reference: glossy dark cards, one lit, a checklist - "but less like
 * subscriptions"): priced per order, never per month; the ladder steps are the highlighted lines, the rest is what you
 * get. Each lowest fee carries its condition. Figures: shared.tsx FEES only.
 */
import type { ReactNode } from 'react';
import { Arrow } from '../Home';
import { bp, FEES, usdStep } from '../shared';
import { IC, PAGE_PATHS } from './Site';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');

interface Card {
  k: 'analytics' | 'bots' | 'copy';
  t: string;
  s: string;
  v: ReactNode;
  unit: string;
  cond: ReactNode;
  cta: { href: string; label: string };
  steps: ReactNode[];
  feats: string[];
  foot: string;
  lit?: boolean;
}

export function feeCards(start: string): Card[] {
  return [
    {
      k: 'analytics', t: 'Analytics', s: 'Read the market', v: 'Free', unit: 'always', cond: 'No wallet, no sign-up',
      cta: { href: '/trade', label: 'Open the terminal' },
      steps: [],
      feats: ['Liquidation map, live and history', 'Who traded each candle', 'Leaderboards and wallet scan', 'News, macro calendar, FOMC odds', 'ETF flows', 'Five venues side by side'],
      foot: 'Nothing to pay, ever',
    },
    {
      k: 'bots', t: 'Bots', s: 'Market maker and grid, around the clock', lit: true,
      v: <><small>from </small><span className="vip-text">{bp(FEES.botLowest)}</span></>, unit: 'per order', cond: <><span className="vip-pill">VIP</span> {VIP_RULE}</>,
      cta: { href: '/bots/new', label: `Start with just ${start}` },
      steps: [...FEES.botLadder.map((x) => <><b>{bp(x.fee)}</b> {x.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(x.fromUsd)} in ${FEES.windowDays} days`}</>), <><b className="vip-text">{bp(FEES.botLowest)}</b> VIP, applied by itself</>],
      feats: ['Runs with the laptop closed', 'Your size, your loss limit', 'Perps and spot markets', 'Stop any time'],
      foot: 'SoDEX charges its own trading fee on top',
    },
    {
      k: 'copy', t: 'Copy trading', s: 'Follow Hyperliquid or SoDEX wallets',
      v: <><small>from </small>{bp(FEES.copyLowest)}</>, unit: 'per copied order', cond: FEES.copyLowestCondition,
      cta: { href: '/copy', label: 'Copy a trader' },
      steps: FEES.copyLadder.map((x) => <><b>{bp(x.fee)}</b> {x.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(x.fromUsd)} copied`}</>),
      feats: ['Copy or counter any wallet', 'Your size, your leverage cap', 'In your browser or hosted'],
      foot: 'SoDEX charges its own trading fee on top',
    },
  ];
}

export function FeeCards({ start, only }: { start: string; only?: Card['k'] }) {
  const cards = feeCards(start).filter((c) => !only || c.k === only);
  return (
    <div className={cx('vd-fc', only && 'is-one')}>
      {cards.map((c) => (
        <article key={c.k} className={cx('vd-fc__card', c.lit && 'is-lit')}>
          <span className="vd-fc__spark" aria-hidden="true" />
          <header>
            <h3>{c.t}</h3>
            <p>{c.s}</p>
          </header>
          <p className="vd-fc__v">{c.v}<small> {c.unit}</small></p>
          <p className="vd-fc__cond">{c.cond}</p>
          <a href={c.cta.href} className="vd-fc__btn">{c.cta.label}<Arrow /></a>
          <ul>
            {c.steps.map((x, i) => <li key={`s${i}`} className="is-step"><span className="vd-fc__ck">{IC.check}</span><span>{x}</span></li>)}
            {c.feats.map((x) => <li key={x}><span className="vd-fc__ck">{IC.check}</span><span>{x}</span></li>)}
          </ul>
          <p className="vd-fc__foot">{c.foot}</p>
        </article>
      ))}
    </div>
  );
}

export { PAGE_PATHS };
