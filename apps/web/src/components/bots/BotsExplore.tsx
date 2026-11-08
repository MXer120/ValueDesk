/**
 * Bots > Explore: what a market maker does per $1M on every SoDEX market, without running there (bots/data.ts
 * useBotMarkets). From each market's own trades: who takes small makers' quotes (uninformed flow is cheap to fill,
 * informed flow costs about 1 bp a fill), what makers our size kept 30 s after each fill, the spread, how much the
 * price moves, and the market's activity. Sort by any of it; open a market for its cost, flow and hours; Configure
 * a bot there.
 *
 * Several bots per market (owner 2026-11-08): the market maker is the category, every setting the tests kept is a bot
 * (bots/recipes.ts). The table shows the best bot on each market, or one bot everywhere; an open market compares all
 * of them on its own reading (bots/estimate.ts, which also learns from the wallet's own bots).
 */
import { Fragment, useMemo, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, type BotMarket } from '../../bots/data';
import { draftFor } from '../../bots/presets';
import { RECIPE, recipesOf, type RecipeId } from '../../bots/recipes';
import { bestOf, estimate, ownRuns, rankRecipes, type OwnRun } from '../../bots/estimate';
import { StrategyTile } from './BotIcon';
import { goBots, type BotsView } from '../../bots/routes';
import { BotsHead, type BotsCtx } from './BotsPage';
import { TAKER_COLORS, Takers, bpCls, fmtBpUsd } from './BotNewPage';
import { Button, Checkbox, EmptyState, Icon, Panel, ProgressBar, SearchField, Segmented, Shell, ShellHeader, Skeleton, StatCard, StatusPill } from './kit/kit';

type Key = 'cost' | 'bot' | 'uninformed' | 'informed' | 'spread' | 'vol' | 'activity' | 'symbol';
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;
const bp = (x: number | null) => (x === null ? DASH : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} bp`);

/** The 24 UTC hours: column height = volume, colour = what $1M did (green earned, red cost), from the 7 d profile. */
function HourProfile({ m, feeBps }: { m: BotMarket; feeBps: number }) {
  const maxV = Math.max(1, ...m.hourly.map((h) => h.volumeUsdH));
  const now = new Date().getUTCHours();
  return (
    <div className="bots-hp">
      <div className="bots-hp__bars" role="img" aria-label="What $1M did and how much traded, by UTC hour, last 7 days">
        {m.hourly.map((h) => {
          const c = h.costBps;
          const tone = c === null ? 'none' : c <= 0 ? 'earn' : c <= feeBps + 0.4 ? 'mid' : 'dear';
          return (
            <span key={h.h} className={`bots-hp__h is-${tone}${h.h === now ? ' is-now' : ''}`} title={`${String(h.h).padStart(2, '0')}:00 UTC · ${c === null ? 'too few fills' : `${fmtBpUsd(c)} per $1M`} · ${fmtUsd(h.volumeUsdH, 0)}/h`}>
              <i style={{ height: `${Math.max(6, (h.volumeUsdH / maxV) * 100)}%` }} />
            </span>
          );
        })}
      </div>
      <div className="bots-hp__axis">{['00', '06', '12', '18', '24'].map((t) => <span key={t}>{t}</span>)}</div>
      <div className="bots-hp__key"><span><i className="is-earn" />Earned</span><span><i className="is-mid" />Near the fee</span><span><i className="is-dear" />Costly</span><span className="is-now"><i />Now</span></div>
    </div>
  );
}

const PROOF = { proven: { tone: 'positive', label: 'Proven live' }, tested: { tone: 'neutral', label: 'Tested' }, early: { tone: 'warning', label: 'Early' } } as const;
const BASE = draftFor('market');

/** Every bot on one market, cheapest first, each with what it rests on. */
function BotsHere({ m, runs }: { m: BotMarket; runs: readonly OwnRun[] }) {
  const ranked = rankRecipes(m, BASE, runs);
  const best = bestOf(ranked);
  return (
    <section className="bots-xd__b is-full">
      <h4>Bots on {m.base} <small>{ranked.length} {ranked.length === 1 ? 'fits' : 'compared on this market\'s reading'}</small></h4>
      <div className="bots-xbots" role="list">
        {ranked.map(({ id, est }) => {
          const rc = RECIPE[id];
          const top = best?.id === id;
          return (
            <div key={id} className={`bots-xbot${top ? ' is-best' : ''}`} role="listitem">
              <StrategyTile strategy={rc.strategy} size={32} />
              <span className="bots-xbot__t">
                <b>{rc.name}{top && <StatusPill size="sm" tone="positive">best here</StatusPill>}</b>
                <small>{rc.line}</small>
              </span>
              <span className="bots-xbot__ev">
                {rc.evidence.slice(0, 2).map((e) => <span key={e.what} className={`bots-ev is-${e.kind}`}>{e.what}<b className={bpCls(e.bp)}>{fmtBpUsd(e.bp)}</b></span>)}
                <StatusPill size="sm" tone={PROOF[rc.proof].tone}>{PROOF[rc.proof].label}</StatusPill>
              </span>
              <span className="bots-xbot__n">
                <b className={bpCls(est.bp)}>{fmtBpUsd(est.bp)}</b>
                <small>{Math.round(est.volumeX * 100)}% volume</small>
              </span>
              <Button variant={top ? 'primary' : 'secondary'} size="sm" onClick={() => goBots({ page: 'new', market: m.symbol, kind: id })}>Configure</Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Detail({ m, feeBps, runs }: { m: BotMarket; feeBps: number; runs: readonly OwnRun[] }) {
  return (
    <div className="bots-xd">
      <BotsHere m={m} runs={runs} />
      <section className="bots-xd__b">
        <h4>Per $1M</h4>
        <p className={`bots-xd__big ${bpCls(m.estCostBps)}`}>{fmtBpUsd(m.estCostBps)}</p>
        <p className="bots-xd__sub">{fmtBpUsd(m.estCostLowBps)} to {fmtBpUsd(m.estCostHighBps)} <StatusPill size="sm" tone={CONF_TONE[m.confidence]} dot>{m.confidence}</StatusPill></p>
        <dl className="bots-xd__grid">
          <div><dt>Gate on</dt><dd className={bpCls(m.gateCostBps)}>{fmtBpUsd(m.gateCostBps)}</dd></div>
          <div><dt>Weekdays</dt><dd className={bpCls(m.weekdayCostBps)}>{fmtBpUsd(m.weekdayCostBps)}</dd></div>
          <div><dt>Weekends</dt><dd className={bpCls(m.weekendCostBps)}>{fmtBpUsd(m.weekendCostBps)}</dd></div>
          <div><dt>Fees</dt><dd className="neg">{fmtBpUsd(feeBps)}</dd></div>
        </dl>
      </section>
      <section className="bots-xd__b">
        <h4>Flow</h4>
        <Takers m={m} />
        <dl className="bots-xd__grid">
          <div><dt>Kept, uninformed</dt><dd className={(m.smallMakers.on1002Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{bp(m.smallMakers.on1002Bps)}</dd></div>
          <div><dt>Kept, informed</dt><dd className={(m.smallMakers.on23342Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{bp(m.smallMakers.on23342Bps)}</dd></div>
          <div><dt>Makers our size</dt><dd>{m.smallMakers.count}</dd></div>
          <div><dt>Their volume</dt><dd>{fmtUsd(m.smallMakers.volumeUsdH, 0)}/h</dd></div>
        </dl>
      </section>
      <section className="bots-xd__b is-wide">
        <h4>By hour, UTC <small>last 7 days</small></h4>
        <HourProfile m={m} feeBps={feeBps} />
        <dl className="bots-xd__grid is-4">
          <div><dt>Activity</dt><dd>{fmtUsd(m.volumeUsdH, 0)}/h</dd></div>
          <div><dt>Spread</dt><dd>{m.spreadBps.toFixed(2)} bp</dd></div>
          <div><dt>Moves</dt><dd>{Math.round(m.volBpsH)} bp/h</dd></div>
          <div><dt>Tick</dt><dd>{m.tickBps.toFixed(2)} bp</dd></div>
        </dl>
      </section>
    </div>
  );
}

type Pick = 'best' | RecipeId;

export function BotsExplore({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const [win, setWin] = useState<'24h' | '7d'>('24h');
  const [pick, setPick] = useState<Pick>('best');
  const [q, setQ] = useState('');
  const [onlySure, setOnlySure] = useState(true);
  const [activity, setActivity] = useState<'any' | '100k' | '1m'>('any');
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'cost', desc: false });
  const [open, setOpen] = useState<string | null>(null);
  const r = useBotMarkets(win);
  const feeBps = r.data ? r.data.fee.makerBps + r.data.fee.builderBps : 1.3;
  const runs = useMemo(() => ownRuns(ctx.bots, r.data?.markets ?? null), [ctx.bots, r.data]);
  // Each market's figure for the picked bot, or its best bot.
  const rows = useMemo(() => {
    const out = new Map<string, { id: RecipeId; bp: number | null; volumeX: number; n: number }>();
    for (const m of r.data?.markets ?? []) {
      if (pick === 'best') {
        const ranked = rankRecipes(m, BASE, runs);
        const top = bestOf(ranked)!;
        out.set(m.symbol, { id: top.id, bp: top.est.bp, volumeX: top.est.volumeX, n: ranked.length });
      } else {
        const id: RecipeId = m.lead === null && RECIPE[pick].oracle ? 'touch' : pick;
        const e = estimate({ ...BASE, ...RECIPE[id].params, strategy: RECIPE[id].strategy, symbol: m.symbol }, m, runs);
        out.set(m.symbol, { id, bp: e.bp, volumeX: e.volumeX, n: 1 });
      }
    }
    return out;
  }, [r.data, pick, runs]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cost = (m: BotMarket) => rows.get(m.symbol)?.bp ?? m.estCostBps;
    const min = activity === '1m' ? 1_000_000 : activity === '100k' ? 100_000 : 0;
    const xs = (r.data?.markets ?? []).filter((m) => (!onlySure || m.confidence !== 'low') && m.volumeUsdH >= min && (!needle || m.symbol.toLowerCase().includes(needle)));
    const val = (m: BotMarket): number | string => {
      switch (sort.k) {
        case 'symbol': return m.symbol;
        case 'bot': return RECIPE[rows.get(m.symbol)?.id ?? 'r10'].name;
        case 'uninformed': return m.takers.t1002;
        case 'informed': return m.takers.t23342;
        case 'spread': return m.spreadBps;
        case 'vol': return m.volBpsH;
        case 'activity': return m.volumeUsdH;
        default: return cost(m);
      }
    };
    return [...xs].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [r.data, q, onlySure, sort, rows, activity]);
  const costOf = (m: BotMarket) => rows.get(m.symbol)?.bp ?? m.estCostBps;
  const best = list.length ? [...list].sort((a, b) => costOf(a) - costOf(b))[0] : null;
  const pickName = pick === 'best' ? 'Best bot' : RECIPE[pick].name;
  const head = (k: Key, label: string, right = true, title?: string) => (
    <th className={right ? 'right' : undefined} title={title} aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`bots-th${sort.k === k ? ' is-on' : ''}`} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k === 'uninformed' || k === 'activity' || k === 'vol' }))}>
        {label}{sort.k === k && <Icon name={sort.desc ? 'down' : 'up'} size={10} />}
      </button>
    </th>
  );

  return (
    <>
      <BotsHead view={view} title="Explore" sub="What every bot does per $1M on every market, from the market's own trades." />

      <Shell className="bots-kpis">
        <ShellHeader icon="compass" title="Every market, estimated" subtitle={r.data ? `Read ${new Date(r.data.at).toISOString().slice(11, 16)} UTC · every 5 minutes` : 'Reading the markets…'} />
        <div className="bots-kpigrid is-4">
          <StatCard index={0} label="Markets read" value={r.data ? String(r.data.markets.length) : DASH} hint={`${list.length} match the filters`} />
          <StatCard index={1} label="Best per $1M" value={best ? fmtBpUsd(costOf(best)) : DASH} valueTone={best ? (costOf(best) < 0 ? 'positive' : 'negative') : undefined} hint={best ? `${best.base}, ${RECIPE[rows.get(best.symbol)?.id ?? 'r10'].name}` : undefined} />
          <StatCard index={2} label="Fees per $1M" value={fmtBpUsd(feeBps)} valueTone="negative" hint="SoDEX and ValueDesk" />
          <StatCard index={3} label="Bots compared" value={String(recipesOf('market').length)} hint={runs.length ? `Learning from ${runs.length} of your bots` : 'Market makers, every market'} />
        </div>
      </Shell>

      <Shell className="bots-listcard">
        <ShellHeader
          icon="list"
          title="Markets"
          subtitle="Open one for its cost, flow and hours"
          aside={<Segmented value={win} label="Window" onChange={setWin} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />}
        />
        <Panel className="bots-listpanel">
          <div className="bots-botpick" role="radiogroup" aria-label="Bot">
            <span className="bots-botpick__l">Bot</span>
            <button type="button" role="radio" aria-checked={pick === 'best'} className={`bots-chip${pick === 'best' ? ' is-on' : ''}`} onClick={() => setPick('best')}>{pick === 'best' && <Icon name="check" size={12} />}<b>Best for each market</b></button>
            {recipesOf('market').map((rc) => (
              <button key={rc.id} type="button" role="radio" aria-checked={pick === rc.id} className={`bots-chip${pick === rc.id ? ' is-on' : ''}`} onClick={() => setPick(rc.id)}>{pick === rc.id && <Icon name="check" size={12} />}<b>{rc.name}</b></button>
            ))}
          </div>
          <div className="bots-toolbar">
            <SearchField value={q} onChange={setQ} placeholder="Search market" label="Search markets" className="bots-toolbar__search" />
            <Segmented value={activity} label="Activity" onChange={setActivity} options={[{ value: 'any', label: 'Any activity' }, { value: '100k', label: '$100K/h+' }, { value: '1m', label: '$1M/h+' }]} />
            <Checkbox checked={onlySure} onChange={setOnlySure} label="Well read only" />
            <span className="bots-toolbar__sp" />
            <span className="bots-toolbar__n">{list.length} markets</span>
          </div>
          {r.error && !r.data ? (
            <EmptyState tone="error" icon="warning" title="Estimates unavailable" description={`The data service did not answer (${r.error}).`} actions={<Button onClick={r.refresh}>Retry</Button>} />
          ) : !r.data ? (
            <div className="bots-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>
          ) : !list.length ? (
            <EmptyState icon="search" title="No market matches" description="Try another name or less activity." />
          ) : (
            <div className="bots-tablewrap">
              <table className="bots-table bots-mt bots-xtable">
                <colgroup><col style={{ width: 28 }} /><col /><col style={{ width: 120 }} /><col style={{ width: 170 }} /><col style={{ width: 132 }} /><col style={{ width: 132 }} /><col style={{ width: 84 }} /><col style={{ width: 92 }} /><col style={{ width: 112 }} /><col style={{ width: 150 }} /></colgroup>
                <thead>
                  <tr>
                    <th />
                    {head('symbol', 'Market', false)}
                    {head('cost', 'Per $1M', true, `What $1M of ${pick === 'best' ? 'the best bot' : pickName}'s volume is estimated to do here, all-in`)}
                    {head('bot', pick === 'best' ? 'Best bot' : 'Bot', false)}
                    {head('uninformed', 'Uninformed', true, "Share of small makers' fills taken by uninformed flow (cheap)")}
                    {head('informed', 'Informed', true, 'Share taken by informed flow (about 1 bp a fill)')}
                    {head('spread', 'Spread')}
                    {head('vol', 'Moves', true, 'How far the price travels per hour')}
                    {head('activity', 'Activity / h', true, "The market's traded volume per hour")}
                    <th className="right"><span className="tf-sr">Configure</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((m) => {
                    const row = rows.get(m.symbol);
                    const c = row?.bp ?? m.estCostBps;
                    const shift = c - m.estCostBps;
                    const rc = RECIPE[row?.id ?? 'r10'];
                    const isOpen = open === m.symbol;
                    return (
                      <Fragment key={m.symbol}>
                        <tr className={`bots-row${isOpen ? ' is-open' : ''}`} tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.symbol)} onKeyDown={(e) => e.key === 'Enter' && setOpen(isOpen ? null : m.symbol)}>
                          <td><Icon name="arrowRight" size={12} className="bots-chev" /></td>
                          <td>
                            <span className="bots-mt__name">
                              <CoinIcon coin={m.symbol} size={22} />
                              <span><b>{m.base}</b><small>{m.symbol}</small></span>
                              {m.confidence !== 'high' && <StatusPill size="sm" tone={CONF_TONE[m.confidence]}>{m.confidence}</StatusPill>}
                              {m.lead === null && <StatusPill size="sm">no oracle</StatusPill>}
                            </span>
                          </td>
                          <td className={`right num bots-strong ${bpCls(c)}`}>{fmtBpUsd(c)}<small className="bots-range">{fmtBpUsd(m.estCostLowBps + shift)} to {fmtBpUsd(m.estCostHighBps + shift)}</small></td>
                          <td><span className="bots-xbotcell"><StrategyTile strategy={rc.strategy} size={22} /><span><b>{rc.name}</b>{pick === 'best' && row && row.n > 1 && <small>best of {row.n}</small>}</span></span></td>
                          <td className="right"><span className="bots-share"><ProgressBar value={m.takers.t1002} max={1} size="sm" color={TAKER_COLORS.patient} label="Uninformed flow share" /><b>{Math.round(m.takers.t1002 * 100)}%</b></span></td>
                          <td className="right"><span className="bots-share"><ProgressBar value={m.takers.t23342} max={1} size="sm" color={TAKER_COLORS.fast} label="Informed flow share" /><b>{Math.round(m.takers.t23342 * 100)}%</b></span></td>
                          <td className="right num dim">{m.spreadBps < 0.05 ? '<0.1' : m.spreadBps.toFixed(1)} bp</td>
                          <td className="right num dim">{Math.round(m.volBpsH)} bp/h</td>
                          <td className="right num">{fmtUsd(m.volumeUsdH, 0)}</td>
                          <td className="right"><Button variant="secondary" icon="gear" onClick={(e) => { e.stopPropagation(); goBots({ page: 'new', market: m.symbol, kind: row?.id ?? null }); }}>Configure bot</Button></td>
                        </tr>
                        {isOpen && (
                          <tr className="bots-xdetail">
                            <td colSpan={10}><Detail m={m} feeBps={feeBps} runs={runs} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <details className="bots-methodbox"><summary>How it's estimated</summary><p className="bots-method">
          Every trade on SoDEX names both accounts. For each market we take the makers our size (under a tenth of the market's maker volume, filling like a bot), measure what each fill kept 30 seconds later, and add the fees. Uninformed flow costs makers little; informed flow costs about 1 bp a fill, so a market's cost follows who takes there. On BTC this read within about 0.15 bp of our live runs. That reading is the oracle maker's; every other bot adds what our live runs and backtests measured against it, and each safeguard is read on the market's own fills (the market gate over calm minutes only, the flow gate while uninformed flow traded enough, quiet hours without their hours). Your own bots' results are blended in by volume: the more they trade, the more the estimate is theirs. Fees: SoDEX's maker fee and ValueDesk's {(ctx.feeTenths / 10).toFixed(1)} bp. 1 bp is $100 per $1M.
        </p></details>
      </Shell>
    </>
  );
}
