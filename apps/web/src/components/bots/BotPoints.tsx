/**
 * SoPoints from this bot (owner 2026-11-28: "on bot pages, add an element which shows estimated sopoints through bots
 * & their cost ... a small element below your cost"). The bot's volume as a weekly pace (its volume over the time it
 * has run, times seven days), priced by the server's SoPoints model (POST /api/vs/sopoints/estimate, the same answer the
 * SoPoints page uses), on the bot's own market: futures or spot, boosted when this round boosts that market. Its cost
 * per point is what it cost (fees less what its trading made, its open position at the price now) over the points its
 * volume earned in that time. The model prices the bot on its own, as if it were the wallet's only trading: the line
 * under the figure says so. Nothing shows before an hour of running or its first $1K traded (a pace from minutes is noise).
 */
import { useEffect, useMemo, useState } from 'react';
import type { AlgoView } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { fetchVolumeWeights, type VolumeWeights } from '../../points';
import { useEstimate, type EstPlan } from '../sodex/sopointsEstimate';
import { RollingNumber, StatusPill } from './kit/kit';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

let weightsP: Promise<VolumeWeights | null> | null = null;
const weightsOnce = () => (weightsP ??= fetchVolumeWeights().catch(() => { weightsP = null; return null; }));

const sig2 = (x: number) => { const m = 10 ** (Math.floor(Math.log10(x)) - 1); return Math.round(x / m) * m; };
const pts = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 0 : 1));

/** 'BTC-USD' and 'vBTC_vUSDC' both read 'BTC'. */
const coinOf = (symbol: string) => symbol.replace(/-USD$/i, '').replace(/_vUSDC$/i, '').replace(/^v(?=[A-Z])/, '').toUpperCase();

export function BotPoints({ v }: { v: AlgoView }) {
  const b = v.bot;
  const spec = v.algo.spec as AlgoView['algo']['spec'] & { engine?: 'perps' | 'spot' };
  const spot = spec.engine === 'spot';
  const [w, setW] = useState<VolumeWeights | null>(null);
  useEffect(() => { let on = true; void weightsOnce().then((x) => on && setW(x)); return () => { on = false; }; }, []);

  const start = v.algo.startedAt;
  const end = v.algo.endedAt ?? Date.now();
  const ran = start ? Math.max(0, end - start) : 0;
  const volume = b?.volume ?? 0;
  const ready = ran >= HOUR && volume >= 1_000;
  // Two significant figures: the pace moves with the clock, the question to the server only when it really changes.
  const weekVol = ready ? sig2((volume * WEEK) / ran) : 0;

  // This round's coefficient for the bot's market (1 when it is not boosted).
  const coin = coinOf(spec.symbol);
  const coef = useMemo(() => {
    const row = w?.weights.find((r) => coinOf(r.symbol) === coin && /spot/i.test(r.market_type) === spot);
    return row ? Number(row.coefficient) || 1 : 1;
  }, [w, coin, spot]);

  const plans = useMemo<EstPlan[] | null>(() => (ready ? [{ futures: spot ? 0 : Math.round(weekVol), spot: spot ? Math.round(weekVol) : 0, oi: 0, boostedShare: coef > 1 ? 1 : 0, coef }] : null), [ready, spot, weekVol, coef]);
  const est = useEstimate(plans, null);
  const band = est.data?.plans[0] ?? null;

  const weekPts = band?.mid ?? null;
  // Points over the time it ran: the weekly figure for the share of a week it ran.
  const runPts = weekPts !== null ? weekPts * (ran / WEEK) : null;
  const cost = b?.costPerMillion != null ? (b.costPerMillion * volume) / 1e6 : null;
  const perPt = cost !== null && runPts && runPts > 0 ? cost / runPts : null;
  const ended = !!v.algo.endedAt;

  return (
    <div className="bots-est bots-pts">
      <div className="bots-est__big">
        <span className="bots-est__k">{ended ? 'Over its run' : 'A week at its pace'}{ready ? ` · ${fmtUsd(ended ? volume : weekVol, 0)} ${spot ? 'spot' : 'futures'}` : ''}</span>
        <span className="bots-pts__v">
          <RollingNumber value={!ready || weekPts === null ? DASH : `≈ ${pts(ended ? runPts! : weekPts)}`} className="bots-est__v is-md" />
          <StatusPill size="sm" tone="neutral" title="ValueDesk’s estimate from SoDEX’s scored weeks, not a SoDEX figure">Estimate</StatusPill>
        </span>
        <span className="bots-est__sub">
          {!ready ? 'Shows after its first hour and $1K traded' : est.failed ? 'No estimate right now' : band ? `Busy week ≈ ${pts(ended ? band.busy * (runPts! / band.mid) : band.busy)}, quiet ≈ ${pts(ended ? band.quiet * (runPts! / band.mid) : band.quiet)}${coef > 1 ? ` · ${coin} counts ×${coef}` : ''}` : 'Estimating…'}
        </span>
      </div>
      <div className="bots-pts__row">
        <span>Cost per point</span>
        <b className={perPt === null ? '' : perPt < 0 ? 'pos' : ''}>{perPt === null ? DASH : perPt < 0 ? `earned ${fmtUsd(-perPt, 2)}` : fmtUsd(perPt, 2)}</b>
      </div>
      <small className="bots-fine">Its volume alone, as if it were your only trading; your squad’s boost comes on top.</small>
    </div>
  );
}
