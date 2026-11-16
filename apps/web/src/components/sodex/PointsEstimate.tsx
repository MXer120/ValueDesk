/**
 * SoPoints (/points): "Your SoPoints, estimated" - what a wallet's trading is worth in points, from public data only
 * (owner 2026-11-16: "upgrade the SoPoints page"). SoDEX's own balance needs its sign-in, which does not open for this
 * site yet (pointsAuth.ts; checked 2026-11-16: sodex.com/auth/v2 sends no CORS header for valuedesk.so, while
 * alpha-biz.sodex.dev already allows it), so the page estimates instead of showing a lock.
 *
 * The estimate is the page's own published arithmetic (points.ts difficultyFrom): this week's pool over the venue's
 * 7-day volume, applied to the wallet's volume. SoDEX also counts open interest and holdings, so the card says it is
 * an estimate and where the exact figure lives. Nothing here is a number of ours.
 */
import { useState } from 'react';
import { Card } from '../portfolio/parts';
import { DASH, fmt } from '../../format';
import { SODEX_SITE } from '../../sodexProgrammes';
import type { PointsContext } from '../Points';
import { Pill, SegSwitch, Tile, Tiles } from './parts';

const WINDOW_DAYS = { '24H': 1, '7D': 7, '30D': 30 } as const;
const AMOUNTS = [10_000, 100_000, 1_000_000, 10_000_000] as const;
type Amount = `${(typeof AMOUNTS)[number]}`;
type Market = 'plain' | 'boosted';

const usd = (n: number) => (n >= 1_000_000 ? `$${fmt(n / 1_000_000, n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `$${fmt(n / 1000, 0)}K` : `$${fmt(n, 0)}`);
const pts = (n: number) => (n >= 100 ? fmt(n, 0) : fmt(n, 1));

export function PointsEstimate({ c }: { c: PointsContext }) {
  const [amount, setAmount] = useState<Amount>('100000');
  const [market, setMarket] = useState<Market>('plain');
  const d = c.diff;
  const boost = Math.max(1, ...(c.weights?.weights ?? []).map((w) => Number(w.coefficient) || 1));

  // The wallet's part: its volume in the standing window, as a week's worth.
  const days = WINDOW_DAYS[c.window];
  const vol = c.standing?.found ? c.standing.volumeUsd : null;
  const weekVol = vol != null ? vol * (7 / days) : null;
  const mine = d && weekVol != null ? weekVol * d.pointsPerDollar : null;
  const share = d && weekVol != null && d.venueVolume > 0 ? (weekVol / d.venueVolume) * 100 : null;

  // The calculator.
  const amt = Number(amount);
  const calc = d ? amt * d.pointsPerDollar * (market === 'boosted' ? boost : 1) : null;

  return (
    <Card title="Your SoPoints, estimated" action={<Pill tone="info">Estimate</Pill>} className="sdx-est">
      {!c.address ? (
        <p className="pf-note">Connect a wallet to see what your trading earns. The calculator below works without one.</p>
      ) : !c.standing ? (
        <p className="pf-note">{c.publicSettled ? `No SoDEX volume for this wallet in the last ${c.window === '24H' ? 'day' : c.window === '7D' ? '7 days' : '30 days'}.` : 'Reading your volume…'}</p>
      ) : (
        <Tiles>
          <Tile label={`Your volume, ${c.window}`} value={vol != null ? usd(vol) : DASH} sub={c.window === '7D' ? 'spot and futures' : `≈ ${weekVol != null ? usd(weekVol) : DASH} a week`} />
          <Tile label="SoPoints a week" value={mine != null ? `≈ ${pts(mine)}` : DASH} sub="from volume alone" />
          <Tile label={`Your rank, ${c.window}`} value={c.standing.rank ? `#${fmt(c.standing.rank, 0)}` : DASH} sub={c.ranked ? `of ${fmt(c.ranked, 0)} wallets` : 'by volume'} />
          <Tile label="Share of the pool" value={share != null ? `${fmt(share, share < 0.01 ? 4 : 2)}%` : DASH} sub={d ? `of ${fmt(d.pool, 0)} this week` : undefined} />
        </Tiles>
      )}

      <div className="sdx-est__calc">
        <span className="sdx-est__k">What volume earns</span>
        <div className="sdx-est__ctl">
          <SegSwitch<Amount> label="Weekly volume" value={amount} onChange={setAmount} options={AMOUNTS.map((a) => ({ v: `${a}` as Amount, label: usd(a) }))} />
          {boost > 1 && (
            <SegSwitch<Market> label="Market" value={market} onChange={setMarket} options={[{ v: 'plain', label: 'Any market' }, { v: 'boosted', label: `Boosted ×${boost}` }]} />
          )}
        </div>
        <div className="sdx-est__out">
          <b>{calc != null ? `≈ ${pts(calc)}` : DASH}</b>
          <span>SoPoints a week</span>
          {d && <small>{market === 'boosted' ? `×${boost} on a boosted market` : `${fmt(d.pointsPerDollar * 1000, 2)} per $1K of volume`}</small>}
        </div>
      </div>

      <p className="sdx-est__fine">
        {d ? `Volume ÷ $${fmt(d.dollarsPerPoint, 0)} per point: this week's pool over the venue's 7-day volume. ` : ''}
        SoDEX also counts open interest, holdings and squad boosts, so your real figure can differ.{' '}
        <a href={SODEX_SITE.points} target="_blank" rel="noopener noreferrer">Exact balance on SoDEX</a>
      </p>
    </Card>
  );
}
