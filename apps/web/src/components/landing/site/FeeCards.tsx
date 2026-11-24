/**
 * The fee cards (owner 2026-11-23: "more like the screenshot ... golden for bots. Get every little detail"): the
 * reference's anatomy one to one - title and a one-line subtitle, the big price with its unit beside it, a small grey
 * line under it, a slim light button, a tight checklist with round checks (the accent rows first, some with an info
 * mark that explains them), and a plain footer line. Priced per order, never per month. The lowest fee always has its
 * condition right under it. Figures: shared.tsx FEES only.
 */
import type { ReactNode } from 'react';
import { bp, FEES, usdStep } from '../shared';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');

const Check = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.4 8.3 2.3 2.2 4.9-5" /></svg>;
const Info = ({ tip }: { tip: string }) => <button type="button" className="vd-fc__info" data-tip={tip} aria-label={tip}>i</button>;

interface Line { t: ReactNode; accent?: boolean; tip?: string }
interface Card {
  k: 'analytics' | 'bots' | 'copy';
  tone: 'steel' | 'gold';
  t: string; s: string;
  v: ReactNode; unit: string; sub: ReactNode;
  cta: { href: string; label: string };
  lines: Line[];
  foot: string;
  lit?: boolean;
}

export function feeCards(start: string): Card[] {
  return [
    {
      k: 'analytics', tone: 'steel', t: 'Analytics', s: 'Read the whole market',
      v: 'Free', unit: '', sub: 'No wallet, no sign-up',
      cta: { href: '/trade', label: 'Open the terminal' },
      lines: [
        { t: 'Liquidation map, live and history', accent: true },
        { t: 'Five venues side by side', accent: true, tip: 'SoDEX, Hyperliquid, trade.xyz, Lighter and Arcus' },
        { t: 'Who traded each candle', accent: true },
        { t: 'Leaderboards and wallet scan' },
        { t: 'News and the macro calendar' },
        { t: 'FOMC odds and the press conference live' },
        { t: 'ETF flows' },
        { t: 'Funding: SoDEX against Hyperliquid' },
      ],
      foot: 'Free, always',
    },
    {
      k: 'bots', tone: 'gold', t: 'Bots', s: 'Market maker, grid and hedge, around the clock', lit: true,
      v: bp(FEES.botLowest), unit: '/order', sub: <>VIP · {VIP_RULE}</>,
      cta: { href: '/bots/new', label: `Start with just ${start}` },
      lines: [
        ...FEES.botLadder.map((x): Line => ({ t: <><b>{bp(x.fee)}</b> {x.fromUsd === 0 ? 'for everyone' : `from ${usdStep(x.fromUsd)}`}</>, accent: true, tip: x.fromUsd === 0 ? undefined : `Your bots' volume over ${FEES.windowDays} days` })),
        { t: <><b>{bp(FEES.botLowest)}</b> VIP</>, accent: true, tip: `${VIP_RULE}; applied by itself` },
        { t: 'Runs with the laptop closed' },
        { t: 'Your size, your loss limit' },
        { t: 'Volatility and flow gates' },
        { t: 'Perps and spot markets' },
        { t: 'Stop any time' },
      ],
      foot: 'VIP applies by itself',
    },
    {
      k: 'copy', tone: 'steel', t: 'Copy trading', s: 'Follow Hyperliquid or SoDEX wallets',
      v: bp(FEES.copyLowest), unit: '/copied order', sub: <>{FEES.copyLowestCondition.replace(/^from/, 'From')}</>,
      cta: { href: '/copy', label: 'Copy a trader' },
      lines: [
        ...FEES.copyLadder.slice(1).map((x): Line => ({ t: <><b>{bp(x.fee)}</b> {x.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(x.fromUsd)} copied`}</>, accent: true, tip: x.fromUsd === 0 ? undefined : `Copied volume over ${FEES.windowDays} days` })),
        { t: 'Copy or counter any wallet' },
        { t: 'Your size, your leverage cap' },
        { t: 'In your browser or hosted' },
      ],
      foot: 'Stop any time',
    },
  ];
}

export function FeeCards({ start, only }: { start: string; only?: Card['k'] }) {
  const cards = feeCards(start).filter((c) => !only || c.k === only);
  return (
    <div className={cx('vd-fc', only && 'is-one')}>
      {cards.map((c) => (
        <article key={c.k} className={cx('vd-fc__card', `is-${c.tone}`, c.lit && 'is-lit')}>
          <span className="vd-fc__dots" aria-hidden="true" />
          <span className="vd-fc__glow" aria-hidden="true" />
          <h3>{c.t}</h3>
          <p className="vd-fc__s">{c.s}</p>
          <p className="vd-fc__v">{c.v}{c.unit && <small>{c.unit}</small>}</p>
          <p className="vd-fc__sub">{c.sub}</p>
          <a href={c.cta.href} className="vd-fc__btn">{c.cta.label}</a>
          <ul>
            {c.lines.map((l, i) => (
              <li key={i} className={cx(l.accent && 'is-accent')}>
                <span className="vd-fc__ck"><Check /></span>
                <span>{l.t}</span>
                {l.tip && <Info tip={l.tip} />}
              </li>
            ))}
          </ul>
          <p className="vd-fc__foot">{c.foot}</p>
        </article>
      ))}
    </div>
  );
}
