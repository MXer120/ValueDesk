/**
 * Bots > Savings (redesigned 2026-11-14, owner: "redesign the savings page" / "For fee tier, needs to show both sodex
 * fee tier, our fee tiers, the fee credits"): the wallet's fees on SoDEX and on ValueDesk side by side with where it
 * stands (SavingsFees), its fee credits and invite link (SavingsCredits), then what would make its bots cheaper, each
 * in dollars at the pace they trade now:
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
import { type ReactNode } from 'react';
import type { AlgoView } from '@copy-engine';
import { notify } from '../../toast';
import { DASH, fmtUsd } from '../../format';
import { FEE_TIERS, STAKING_TIERS, fmtSoso, fmtThreshold, feeTierAt, stakingTierAt } from '../../fees';
import { useVenueFees } from '../useVenueFees';
import { CoinIcon } from '../CoinIcon';
import { openConnectDialog } from '../account/connect';
import { useBotMarkets, bpToPerMillion } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { draftOfSpec, patchOf } from '../../bots/presets';
import { botName } from './botWords';
import { BotsVip } from './BotsVip';
import { BotsHead, isLive, type BotsCtx } from './BotsPage';
import { Button, EmptyState, IconTile, Panel, ProgressBar, Shell, ShellHeader, StatCard, StatusPill, type IconName, type Tone } from './kit/kit';
import { useEffect, useSyncExternalStore } from 'react';
import { BOT_FEE_VIP } from '@copy-engine';
import { refreshTerms, subscribeTerms, termsRevision, termsView } from '../../trading/terms';
import { useInviteMe } from '../../invites/invites';
import { SavingsFees } from './SavingsFees';
import { SavingsCredits } from './SavingsCredits';

const DAY = 86_400_000;

/** The monthly figure as context, never the headline: "$1/mo" read as the whole saving (owner 2026-11-07). */
const monthWords = (m: number | null): string => (m === null ? 'at your volume' : m < 1 ? 'under $1 a month at your pace' : `≈ ${fmtUsd(m, 0)} a month at your pace`);
const month = (perDay: number) => perDay * 30;

/** A bot's volume per day: what it traded over the time it ran (start to its end, or now; at least an hour). */
function perDayOf(volume: number, since: number, until: number): number {
  const days = Math.max(1 / 24, (until - since) / DAY);
  return volume / days;
}
/** A bot's pace: over the time it ran, never counting days after it stopped. */
const paceOf = (v: AlgoView, now: number): number => perDayOf(v.bot?.volume ?? 0, v.algo.startedAt ?? v.algo.createdAt, v.algo.endedAt ?? now);

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
          <b className={perMillion !== null && perMillion > 0 ? 'pos' : ''}>{perMillion === null ? DASH : `+${fmtUsd(perMillion, 0)}`}<span> per $1M</span></b>
          <small>{monthWords(perMonth)}</small>
        </div>
        {action && <div className="bots-saving__act">{action}</div>}
      </Panel>
    </li>
  );
}

/** One bar of the waterfall: where it starts, how long, and its value. */
function WfRow({ label, value, max, from, kind }: { label: string; value: number; max: number; from: number; kind: 'now' | 'save' | 'after' }) {
  return (
    <div className={`bots-wf__row is-${kind}`}>
      <span className="bots-wf__l">{label}</span>
      <span className="bots-wf__track"><i style={{ left: `${(from / max) * 100}%`, width: `${Math.max(0.8, (value / max) * 100)}%` }} /></span>
      <b className="bots-wf__v">{kind === 'save' ? `+${fmtUsd(value, 0)}` : `−${fmtUsd(value, 0)}`}</b>
    </div>
  );
}

export function BotsSavings({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const fees = useVenueFees(ctx.address, !!ctx.address);
  // The 14-day volume the builder ledger counted (the signed terms): where the wallet stands on ValueDesk's ladders.
  useSyncExternalStore(subscribeTerms, termsRevision, termsRevision);
  useEffect(() => { if (ctx.address && !termsView(ctx.address)) void refreshTerms(ctx.address); }, [ctx.address]);
  const terms = ctx.address ? termsView(ctx.address) : null;
  const me = useInviteMe(ctx.address);
  const creditWords = me?.welcome?.active
    ? `Your invite welcome: 0.1 bp on your next ${fmtUsd(me.welcome.leftUsd, 0)} of volume.`
    : me?.credits.paying ? `Your fee credits pay it down: ${fmtUsd(me.credits.balanceUsd, 2)} left.` : null;
  const markets = useBotMarkets('7d');
  const now = Date.now();
  const live = ctx.bots.filter(isLive).filter((v) => !v.algo.spec.paper);
  const all = ctx.bots.filter((v) => !v.algo.spec.paper);
  // The pace now: the real bots running, each over the time it has run. With none running, the pace the stopped
  // ones kept while they ran (not their volume spread over the days since they stopped); then practice.
  const livePace = live.reduce((x, v) => x + paceOf(v, now), 0);
  const pastPace = all.length ? Math.max(...all.map((v) => paceOf(v, now))) : 0;
  const practicePace = ctx.bots.filter((v) => v.algo.spec.paper && isLive(v)).reduce((x, v) => x + paceOf(v, now), 0);
  const pace = livePace > 0 ? livePace : pastPace;
  const perDay = pace > 0 ? pace : practicePace;
  const basis = livePace > 0 ? "your running bots' real volume" : pastPace > 0 ? "the pace your last real bot kept" : practicePace > 0 ? "your practice bots' volume" : null;

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
    const pd = paceOf(v, now);
    if (!here || !best || best.symbol === v.algo.spec.symbol) return null;
    const room = best.capacityUsdH * 24 > pd;
    const perM = bpToPerMillion(here.estCostBps - best.estCostBps);
    return perM > 5 && room ? { v, here, to: best, perM, perMonth: month((perM / 1_000_000) * pd) } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const gates = live.filter((v) => v.algo.spec.kind === 'mm' && v.algo.spec.ref && !(v.algo.spec.stillBps ?? 0)).map((v) => {
    const here = est.get(v.algo.spec.symbol);
    if (!here || here.gateCostBps === null || here.gateCostBps >= here.estCostBps) return null;
    const pd = paceOf(v, now);
    const perM = bpToPerMillion(here.estCostBps - here.gateCostBps);
    return { v, perM, perMonth: month((perM / 1_000_000) * pd) };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  const turnOnGate = async (v: (typeof gates)[number]['v']) => {
    const before = draftOfSpec(v.algo.spec);
    try { await ctx.update(v.algo.id, patchOf(before, { ...before, gate: true })); } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
  };

  const totalPerM = (tierSavePerM ?? 0) + (stakeRows[0]?.perM ?? 0) + Math.max(0, ...moves.map((m) => m.perM), ...gates.map((g) => g.perM));
  const total = (tierSavePerM !== null && perDay * 14 >= (next?.minVolume ?? Infinity) ? month((tierSavePerM / 1_000_000) * perDay) : 0)
    + (stakeRows[0]?.perMonth ?? 0) + moves.reduce((x, m) => x + m.perMonth, 0) + gates.reduce((x, g) => x + g.perMonth, 0);

  // The waterfall: what $1M costs now (the bots' own figure, else the fees and Explore's average), and each lever.
  const fleetCpm = (() => { const vol = all.reduce((x, v) => x + (v.bot?.volume ?? 0), 0); const net = all.reduce((x, v) => x + (v.bot?.netPnl ?? 0), 0); return vol >= 100 ? (-net / vol) * 1_000_000 : null; })();
  const nowPerM = fleetCpm !== null && fleetCpm > 0 ? fleetCpm : null;
  const levers = [
    ...(tierSavePerM !== null && tierSavePerM > 0 ? [{ label: `Fee tier ${next?.tier ?? ''}`.trim(), perM: tierSavePerM }] : []),
    ...(stakeRows[0] && stakeRows[0].perM > 0 ? [{ label: `Stake ${Math.round(stakeRows[0].t.discount * 100)}%`, perM: stakeRows[0].perM }] : []),
    ...(moves.length ? [{ label: 'Cheaper market', perM: Math.max(...moves.map((m) => m.perM)) }] : []),
    ...(gates.length ? [{ label: 'Market gate', perM: Math.max(...gates.map((g) => g.perM)) }] : []),
  ];
  const wfMax = Math.max(1, nowPerM ?? 0, levers.reduce((x, y) => x + y.perM, 0));

  return (
    <>
      <BotsHead view={view} title="Savings" sub="Your fees on SoDEX and on ValueDesk, what lowers them, and credits from invites." />
      {!ctx.address ? (
        <Shell>
          <Panel>
            <EmptyState icon="wallet" title="No wallet connected" description="Savings are worked out from your own fee tier, staking and bots." actions={<Button variant="primary" icon="wallet" onClick={() => void openConnectDialog()}>Connect wallet</Button>} />
          </Panel>
        </Shell>
      ) : (
        <>
          <Shell className="bots-kpis">
            <ShellHeader icon="piggy" title="Where you stand" subtitle={basis ? `Savings at ${basis}` : "Your fees now; savings show at your bots' pace once one runs"} />
            <div className="bots-kpigrid is-5">
              <StatCard index={0} label="SoDEX maker fee" value={perps ? `${(makerNow * 10_000).toFixed(2)} bp` : DASH} hint={perps ? `Tier ${tier.tier}${stake.discount ? `, ${Math.round(stake.discount * 100)}% staking off` : ''}` : 'Read from SoDEX'} />
              <StatCard index={1} label="ValueDesk trading fee" value={terms ? `${(Math.min(terms.fee.perps, terms.fee.spot) / 10).toFixed(1)} bp` : DASH} hint={terms?.volumeUsd != null ? `${fmtUsd(terms.volumeUsd, 0)} counted in ${terms.volumeDays ?? 14} days` : 'Futures and spot orders'} />
              <StatCard index={2} label="ValueDesk bot fee" value={`${(ctx.feeTenths / 10).toFixed(1)} bp`} hint={ctx.feeTenths <= BOT_FEE_VIP ? 'VIP' : 'By 14-day volume'} />
              <StatCard index={3} label="Fee credits" value={me ? fmtUsd(me.credits.balanceUsd, 2) : DASH} valueTone={me && me.credits.balanceUsd > 0 ? 'positive' : undefined} hint={me?.credits.paying ? 'Paying your ValueDesk fees' : 'Earned from invites'} />
              <StatCard index={4} label="Could save per $1M" value={totalPerM > 0 ? fmtUsd(totalPerM, 0) : DASH} valueTone={totalPerM > 0 ? 'positive' : undefined} hint={total > 0 ? monthWords(total) : 'What applies, added up'} />
            </div>
          </Shell>

          <Shell className="bots-listcard">
            <ShellHeader icon="layers" title="Your fees" subtitle="Every order pays SoDEX's fee and ValueDesk's builder fee; both fall with your 14-day volume" />
            <SavingsFees sodexTier={perps ? tier.tier : null} stakeOff={stake.discount} volumeUsd={terms?.volumeUsd ?? null} botTenths={ctx.feeTenths} vip={ctx.feeTenths <= BOT_FEE_VIP} credit={creditWords} />
          </Shell>

          <SavingsCredits address={ctx.address} />

          <BotsVip ctx={ctx} />

          <Shell className="bots-listcard">
            <ShellHeader icon="piggy" title="Every saving, per $1M" subtitle={nowPerM !== null ? `From what $1M costs your bots now to where these levers take it` : 'What each lever takes off $1M of volume'} />
            <Panel className="bots-wf">
              {levers.length ? (
                <>
                  <div className="bots-wf__rows">
                    {nowPerM !== null && <WfRow label="Now" value={nowPerM} max={wfMax} from={0} kind="now" />}
                    {levers.map((l, i) => <WfRow key={l.label} label={l.label} value={l.perM} max={wfMax} from={nowPerM !== null ? Math.max(0, nowPerM - levers.slice(0, i).reduce((x, y) => x + y.perM, 0) - l.perM) : levers.slice(0, i).reduce((x, y) => x + y.perM, 0)} kind="save" />)}
                    {nowPerM !== null && <WfRow label="After" value={Math.max(0, nowPerM - levers.reduce((x, y) => x + y.perM, 0))} max={wfMax} from={0} kind="after" />}
                  </div>
                  <p className="bots-wf__foot">Saves <b className="pos">{fmtUsd(levers.reduce((x, y) => x + y.perM, 0), 0)}</b> per $1M{total > 0 ? ` · ${monthWords(total)}` : ''}</p>
                </>
              ) : <EmptyState compact icon="check" title="Nothing left to save here" />}
            </Panel>
          </Shell>

          <div className="bots-savegrid">

          <Shell className="bots-listcard">
            <ShellHeader icon="chart" title="Next SoDEX tier" subtitle="At your bots' pace" aside={perps ? <StatusPill tone="neutral">Tier {tier.tier}</StatusPill> : undefined} />
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
                      ? perDay * 14 >= next.minVolume ? 'Your bots reach it within 14 days.' : `${fmtUsd(needPerDay! - perDay, 0)} a day more volume needed.`
                      : `${fmtUsd(needPerDay!, 0)} a day for 14 days.`}
                    perMillion={tierSavePerM}
                    perMonth={month((tierSavePerM / 1_000_000) * Math.max(perDay, needPerDay!))}
                    action={<Button variant="secondary" icon="plus" onClick={() => goBots({ page: 'new', market: best?.symbol ?? null, kind: null })}>Add a bot</Button>}
                  />
                </ul>
                
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
                    line={`${fmtSoso(r.soso)} SOSO more · off every SoDEX fee`}
                    perMillion={r.perM}
                    perMonth={perDay > 0 ? r.perMonth : null}
                  />
                ))}
              </ul>
            ) : <Panel><EmptyState compact icon="star" title="You are at the top staking tier" /></Panel>}
            <p className="bots-method">SOSO's price can fall: weigh the stake against the saving.</p>
          </Shell>

          </div>

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
                    line="Skips the fast minutes: fewer, cheaper fills."
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
                    line={`${fmtUsd(bpToPerMillion(m.here.estCostBps), 0)} vs ${fmtUsd(bpToPerMillion(m.to.estCostBps), 0)} per $1M over 7 days`}
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
