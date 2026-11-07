/**
 * Bots > Savings: what would make the bots' volume cheaper, each in dollars at the pace they trade now, in the Bots
 * kit.
 *
 *   Fee tier     SoDEX's maker fee falls with 14-day volume (fees.ts FEE_TIERS): how far the next tier is, how much
 *                more a day reaches it, and what it saves on every $1M after
 *   Staking      SOSO staked takes a share off every fee (STAKING_TIERS): what each step costs in SOSO, what it saves
 *   Markets      a bot on a market where makers our size pay more than on another (Explore's estimates)
 *   Market gate  a market maker without the gate, where the gate's estimate is lower
 *
 * Every figure is the user's own (their tier and staking from SoDEX, their bots' volume) times the published tables
 * or Explore's estimates; nothing is promised.
 */
import { useMemo, type ReactNode } from 'react';
import { DASH, fmtUsd } from '../../format';
import { FEE_TIERS, STAKING_TIERS, fmtSoso, fmtThreshold, feeTierAt, stakingTierAt } from '../../fees';
import { useVenueFees } from '../useVenueFees';
import { CoinIcon } from '../CoinIcon';
import { openConnectDialog } from '../account/connect';
import { useBotMarkets, bpToPerMillion } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { draftOfSpec, patchOf } from '../../bots/presets';
import { botName } from './botWords';
import { BotsHead, isLive, type BotsCtx } from './BotsPage';
import { Button, EmptyState, IconTile, Panel, ProgressBar, Shell, ShellHeader, StatCard, StatusPill, type IconName, type Tone } from './kit/kit';

const DAY = 86_400_000;
const month = (perDay: number) => perDay * 30;

/** A bot's volume per day: what it traded over the time it has run (at least an hour). */
function perDayOf(volume: number, since: number, now: number): number {
  const days = Math.max(1 / 24, (now - since) / DAY);
  return volume / days;
}

function Saving({ title, line, perMonth, perMillion, action, icon, tile, tone = 'neutral' }: {
  title: string; line: string; perMonth: number | null; perMillion: number | null; action?: ReactNode; icon?: IconName; tile?: ReactNode; tone?: Tone;
}) {
  return (
    <li>
      <Panel className="bots-saving">
        <IconTile icon={icon} tone={tone}>{tile}</IconTile>
        <div className="bots-saving__t">
          <p className="bots-saving__title">{title}</p>
          <p className="bots-saving__line">{line}</p>
        </div>
        <div className="bots-saving__n">
          <b className={perMonth !== null && perMonth > 0 ? 'pos' : ''}>{perMonth === null ? DASH : `${fmtUsd(perMonth, 0)}/mo`}</b>
          {perMillion !== null && <small>{fmtUsd(perMillion, 0)} per $1M</small>}
        </div>
        {action && <div className="bots-saving__act">{action}</div>}
      </Panel>
    </li>
  );
}

export function BotsSavings({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const fees = useVenueFees(ctx.address, !!ctx.address);
  const markets = useBotMarkets('7d');
  const now = Date.now();
  const live = ctx.bots.filter(isLive).filter((v) => !v.algo.spec.paper);
  const all = ctx.bots.filter((v) => !v.algo.spec.paper);
  const pace = useMemo(() => all.reduce((x, v) => x + perDayOf(v.bot?.volume ?? 0, v.algo.startedAt ?? v.algo.createdAt, now), 0), [all, now]);
  const practicePace = useMemo(() => ctx.bots.filter((v) => v.algo.spec.paper).reduce((x, v) => x + perDayOf(v.bot?.volume ?? 0, v.algo.startedAt ?? v.algo.createdAt, now), 0), [ctx.bots, now]);
  const perDay = pace > 0 ? pace : practicePace;
  const basis = pace > 0 ? "your bots' real volume" : practicePace > 0 ? "your practice bots' volume" : null;

  const perps = fees.perps;
  const tier = feeTierAt(perps?.feeTier ?? 0) ?? FEE_TIERS[0]!;
  const next = FEE_TIERS.find((t) => t.tier === tier.tier + 1) ?? null;
  const stake = stakingTierAt(perps?.stakingTier ?? 0) ?? STAKING_TIERS[0]!;
  const keep = 1 - stake.discount;
  const makerNow = perps?.maker ?? tier.perpsMaker * keep;
  const tierSavePerM = next ? (tier.perpsMaker - next.perpsMaker) * keep * 1_000_000 : null;
  const needPerDay = next ? next.minVolume / 14 : null;
  const reach = next ? Math.min(1, (perDay * 14) / next.minVolume) : 1;

  const stakeRows = STAKING_TIERS.filter((t) => t.tier > stake.tier).slice(0, 3).map((t) => {
    const perM = (tier.perpsMaker * (t.discount - stake.discount)) * 1_000_000;
    return { t, perM, perMonth: month((perM / 1_000_000) * perDay), soso: t.soso - stake.soso };
  });

  const est = new Map((markets.data?.markets ?? []).map((m) => [m.symbol, m]));
  const best = (markets.data?.markets ?? []).filter((m) => m.confidence === 'high').sort((a, b) => a.estCostBps - b.estCostBps)[0] ?? null;
  const moves = live.filter((v) => v.algo.spec.kind === 'mm').map((v) => {
    const here = est.get(v.algo.spec.symbol);
    const pd = perDayOf(v.bot?.volume ?? 0, v.algo.startedAt ?? v.algo.createdAt, now);
    if (!here || !best || best.symbol === v.algo.spec.symbol) return null;
    const room = best.capacityUsdH * 24 > pd;
    const perM = bpToPerMillion(here.estCostBps - best.estCostBps);
    return perM > 5 && room ? { v, here, to: best, perM, perMonth: month((perM / 1_000_000) * pd) } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const gates = live.filter((v) => v.algo.spec.kind === 'mm' && v.algo.spec.ref && !(v.algo.spec.stillBps ?? 0)).map((v) => {
    const here = est.get(v.algo.spec.symbol);
    if (!here || here.gateCostBps === null || here.gateCostBps >= here.estCostBps) return null;
    const pd = perDayOf(v.bot?.volume ?? 0, v.algo.startedAt ?? v.algo.createdAt, now);
    const perM = bpToPerMillion(here.estCostBps - here.gateCostBps);
    return { v, perM, perMonth: month((perM / 1_000_000) * pd) };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  const turnOnGate = async (v: (typeof gates)[number]['v']) => {
    const before = draftOfSpec(v.algo.spec);
    await ctx.update(v.algo.id, patchOf(before, { ...before, gate: true }));
  };

  const total = (tierSavePerM !== null && perDay * 14 >= (next?.minVolume ?? Infinity) ? month((tierSavePerM / 1_000_000) * perDay) : 0)
    + (stakeRows[0]?.perMonth ?? 0) + moves.reduce((x, m) => x + m.perMonth, 0) + gates.reduce((x, g) => x + g.perMonth, 0);

  return (
    <>
      <BotsHead view={view} title="Savings" sub="What would make your bots' volume cheaper, in dollars at the pace they trade now." />
      {!ctx.address ? (
        <Shell>
          <Panel>
            <EmptyState icon="wallet" title="No wallet connected" description="Savings are worked out from your own fee tier, staking and bots." actions={<Button variant="primary" icon="wallet" onClick={() => void openConnectDialog()}>Connect wallet</Button>} />
          </Panel>
        </Shell>
      ) : (
        <>
          <Shell className="bots-kpis">
            <ShellHeader icon="piggy" title="Where you stand" subtitle={basis ? `At ${basis}` : 'Start a bot to see savings at its pace'} />
            <div className="bots-kpigrid is-5">
              <StatCard index={0} label="Your maker fee" value={perps ? `${(makerNow * 10_000).toFixed(2)} bp` : DASH} hint="Staking included" />
              <StatCard index={1} label="Fee tier" value={perps ? `Tier ${tier.tier}` : DASH} hint={`Maker ${(tier.perpsMaker * 10_000).toFixed(1)} bp here`} />
              <StatCard index={2} label="Staking" value={perps ? (stake.discount ? `${Math.round(stake.discount * 100)}% off` : 'None') : DASH} hint="Off every SoDEX fee" />
              <StatCard index={3} label="Bots trade" value={perDay > 0 ? `${fmtUsd(perDay, 0)}/day` : DASH} hint="Over the time they ran" />
              <StatCard index={4} label="Could save" value={total > 0 ? `${fmtUsd(total, 0)}/mo` : DASH} valueTone={total > 0 ? 'positive' : undefined} hint="What applies, added up" />
            </div>
          </Shell>

          <Shell className="bots-listcard">
            <ShellHeader icon="chart" title="Fee tier" subtitle="SoDEX's maker fee falls with your 14-day volume" aside={perps ? <StatusPill tone="neutral">Tier {tier.tier}</StatusPill> : undefined} />
            {next && tierSavePerM !== null ? (
              <>
                <Panel className="bots-tier">
                  <div className="bots-tier__row">
                    <span><small>Now</small><b>Tier {tier.tier} · {(tier.perpsMaker * 10_000).toFixed(1)} bp</b></span>
                    <span className="right"><small>Next, from {fmtThreshold(next.minVolume)} in 14 days</small><b>Tier {next.tier} · {(next.perpsMaker * 10_000).toFixed(1)} bp</b></span>
                  </div>
                  <ProgressBar value={reach} max={1} size="lg" striped tone={reach >= 1 ? 'positive' : 'brand'} label={`Progress to tier ${next.tier}`} valueText={`${Math.round(reach * 100)}% of tier ${next.tier}'s volume at your bots' pace`} />
                  <p className="bots-tier__k"><span>{perDay > 0 ? `${fmtUsd(perDay * 14, 0)} in 14 days at your bots' pace` : 'No bot volume yet'}</span><span>{Math.round(reach * 100)}%</span></p>
                </Panel>
                <ul className="bots-savings">
                  <Saving
                    icon="up"
                    tone="positive"
                    title={`Reach tier ${next.tier}`}
                    line={perDay > 0
                      ? perDay * 14 >= next.minVolume ? `At ${fmtUsd(perDay, 0)} a day your bots alone reach it in under 14 days.` : `About ${fmtUsd(needPerDay!, 0)} a day over 14 days. Your bots trade ${fmtUsd(perDay, 0)}: ${fmtUsd(needPerDay! - perDay, 0)} a day more (your manual trading counts too).`
                      : `About ${fmtUsd(needPerDay!, 0)} a day over 14 days.`}
                    perMillion={tierSavePerM}
                    perMonth={month((tierSavePerM / 1_000_000) * Math.max(perDay, needPerDay!))}
                    action={<Button variant="secondary" icon="plus" onClick={() => goBots({ page: 'new', market: best?.symbol ?? null, kind: null })}>Add a bot</Button>}
                  />
                </ul>
                <p className="bots-method">At tier {next.tier} every $1M costs {fmtUsd(tierSavePerM, 0)} less in maker fees; the monthly figure is at the volume the tier needs, or yours if higher. More volume costs its own fees, so the tier pays where that volume was going to trade anyway.</p>
              </>
            ) : (
              <Panel><EmptyState compact icon="star" title={perps ? "You are at the top of SoDEX's volume tiers" : fees.loading ? 'Reading your fee tier from SoDEX…' : 'Your fee tier could not be read from SoDEX'} /></Panel>
            )}
          </Shell>

          <Shell className="bots-listcard">
            <ShellHeader icon="shield" title="Staking" subtitle="SOSO staked on SoDEX takes a share off every fee" aside={<StatusPill tone={stake.discount ? 'positive' : 'neutral'}>{stake.discount ? `${Math.round(stake.discount * 100)}% off now` : 'Not staking'}</StatusPill>} />
            {stakeRows.length ? (
              <ul className="bots-savings">
                {stakeRows.map((r) => (
                  <Saving
                    key={r.t.tier}
                    icon="coins"
                    tone="brand"
                    title={`Stake ${fmtSoso(r.t.soso)} SOSO: ${Math.round(r.t.discount * 100)}% off`}
                    line={`${fmtSoso(r.soso)} SOSO more than you stake now. Takes ${Math.round(r.t.discount * 100)}% off every SoDEX fee, the bots' and yours.`}
                    perMillion={r.perM}
                    perMonth={perDay > 0 ? r.perMonth : null}
                  />
                ))}
              </ul>
            ) : <Panel><EmptyState compact icon="star" title="You are at the top staking tier" /></Panel>}
            <p className="bots-method">SOSO is staked on SoDEX itself, and its price can fall: weigh what the stake costs against what it saves.</p>
          </Shell>

          <Shell className="bots-listcard">
            <ShellHeader icon="robot" title="Your bots" subtitle="A cheaper market, or the market gate, per bot" />
            {!live.length ? (
              <Panel><EmptyState icon="robot" title="No real bot running" description="Market and gate savings show here for bots trading with real orders." /></Panel>
            ) : !moves.length && !gates.length ? (
              <Panel><EmptyState compact icon="check" title={markets.data ? 'Every bot already runs where it costs least, with the gate where it helps' : 'Reading the market estimates…'} /></Panel>
            ) : (
              <ul className="bots-savings">
                {gates.map((g) => (
                  <Saving
                    key={`g-${g.v.algo.id}`}
                    icon="pulse"
                    tone="warning"
                    title={`Turn on the market gate: ${botName(g.v)}`}
                    line={`On ${g.v.algo.spec.symbol} the minutes Binance moves fast cost makers our size more. Without them: fewer fills, cheaper ones.`}
                    perMillion={g.perM}
                    perMonth={g.perMonth}
                    action={<Button variant="secondary" disabled={ctx.busy === g.v.algo.id} onClick={() => void turnOnGate(g.v)}>Turn on</Button>}
                  />
                ))}
                {moves.map((m) => (
                  <Saving
                    key={`m-${m.v.algo.id}`}
                    tile={<CoinIcon coin={m.to.symbol} size={20} />}
                    title={`Run ${botName(m.v)} on ${m.to.base} instead of ${m.here.base}`}
                    line={`Makers our size paid ${fmtUsd(bpToPerMillion(m.here.estCostBps), 0)} per $1M on ${m.here.base} and ${fmtUsd(bpToPerMillion(m.to.estCostBps), 0)} on ${m.to.base} over the last 7 days. A bot keeps its market: start one there and stop this one.`}
                    perMillion={m.perM}
                    perMonth={m.perMonth}
                    action={<Button variant="secondary" icon="plus" onClick={() => goBots({ page: 'new', market: m.to.symbol, kind: null })}>Start on {m.to.base}</Button>}
                  />
                ))}
              </ul>
            )}
          </Shell>
        </>
      )}
    </>
  );
}
