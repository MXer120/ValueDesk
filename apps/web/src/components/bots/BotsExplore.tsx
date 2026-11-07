/**
 * Bots > Explore: what a market maker costs on every SoDEX market, without running there (bots/data.ts
 * useBotMarkets), in the Bots kit. For each market, from its own trades: who takes small makers' quotes (the patient
 * taker costs makers little, the fast one about 1 bp a fill), what makers our size kept 30 s after each fill, the
 * spread, how much the price moves, and how much flow there is to take. Sort by any of it; open a market for its
 * hourly profile, weekday against weekend, and Start a bot there.
 */
import { Fragment, useMemo, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { BotsHead, type BotsCtx } from './BotsPage';
import { TAKER_COLORS, Takers } from './BotNewPage';
import { Button, Checkbox, EmptyState, Icon, Inset, Panel, ProgressBar, SearchField, Segmented, Shell, ShellHeader, Skeleton, StatCard, StatusPill } from './kit/kit';

type Key = 'cost' | 'gate' | 'patient' | 'fast' | 'spread' | 'vol' | 'room' | 'symbol';
const usd = (bp: number | null | undefined) => (bp === null || bp === undefined ? DASH : bp < 0 ? `earns ${fmtUsd(-bpToPerMillion(bp), 0)}` : fmtUsd(bpToPerMillion(bp), 0));
const CONF_TONE = { high: 'positive', medium: 'warning', low: 'neutral' } as const;

/** The 24 UTC hours: column height = volume, colour = cost (cheap toward --pos, dear toward --neg), from the 7 d profile. */
function HourProfile({ m, feeBps }: { m: BotMarket; feeBps: number }) {
  const maxV = Math.max(1, ...m.hourly.map((h) => h.volumeUsdH));
  const now = new Date().getUTCHours();
  return (
    <div className="bots-hours" role="img" aria-label="Cost and volume by UTC hour, last 7 days">
      {m.hourly.map((h) => {
        const c = h.costBps;
        const tone = c === null ? 'none' : c <= feeBps + 0.25 ? 'cheap' : c <= feeBps + 0.6 ? 'mid' : 'dear';
        return (
          <span key={h.h} className={`bots-hour is-${tone}${h.h === now ? ' is-now' : ''}`} title={`${String(h.h).padStart(2, '0')}:00 UTC: ${c === null ? 'too few fills' : `${usd(c)} per $1M`}, ${fmtUsd(h.volumeUsdH, 0)}/h traded`}>
            <i style={{ height: `${Math.max(8, (h.volumeUsdH / maxV) * 100)}%` }} />
            <small>{h.h % 6 === 0 ? String(h.h).padStart(2, '0') : ''}</small>
          </span>
        );
      })}
    </div>
  );
}

const bp = (x: number | null) => (x === null ? DASH : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} bp`);

export function BotsExplore({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const [win, setWin] = useState<'24h' | '7d'>('24h');
  const [gate, setGate] = useState<'off' | 'on'>('off');
  const [q, setQ] = useState('');
  const [onlySure, setOnlySure] = useState(true);
  const [room, setRoom] = useState<'any' | '1k' | '10k'>('1k');
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'cost', desc: false });
  const [open, setOpen] = useState<string | null>(null);
  const r = useBotMarkets(win);
  const feeBps = r.data ? r.data.fee.makerBps + r.data.fee.builderBps : 1.3;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cost = (m: BotMarket) => (gate === 'on' && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps);
    const minRoom = room === '10k' ? 10_000 : room === '1k' ? 1_000 : 0;
    const xs = (r.data?.markets ?? []).filter((m) => (!onlySure || m.confidence !== 'low') && m.capacityUsdH >= minRoom && (!needle || m.symbol.toLowerCase().includes(needle)));
    const val = (m: BotMarket): number | string => {
      switch (sort.k) {
        case 'symbol': return m.symbol;
        case 'gate': return m.gateCostBps ?? Infinity;
        case 'patient': return m.takers.t1002;
        case 'fast': return m.takers.t23342;
        case 'spread': return m.spreadBps;
        case 'vol': return m.volBpsH;
        case 'room': return m.capacityUsdH;
        default: return cost(m);
      }
    };
    return [...xs].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [r.data, q, onlySure, sort, gate, room]);
  const cheapest = list.length ? [...list].sort((a, b) => a.estCostBps - b.estCostBps)[0] : null;
  const head = (k: Key, label: string, right = true) => (
    <th className={right ? 'right' : undefined} aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`bots-sort${sort.k === k ? ' is-on' : ''}`} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k === 'patient' || k === 'room' || k === 'vol' }))}>
        {label}
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d={sort.k === k && !sort.desc ? 'M2 6.5 5 3.5l3 3' : 'M2 3.5 5 6.5l3-3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </th>
  );

  return (
    <>
      <BotsHead view={view} title="Explore" sub="What a market maker costs on every SoDEX market, read from each market's own trades: no live run needed." />

      <Shell className="bots-kpis">
        <ShellHeader icon="compass" title="Every market, estimated" subtitle={r.data ? `Read ${new Date(r.data.at).toISOString().slice(11, 16)} UTC · refreshes every 5 minutes` : 'Reading the markets…'} />
        <div className="bots-kpigrid is-4">
          <StatCard index={0} label="Markets read" value={r.data ? String(r.data.markets.length) : DASH} hint={`${list.length} match the filters`} />
          <StatCard index={1} label="Lowest estimate" value={cheapest ? usd(cheapest.estCostBps) : DASH} hint={cheapest ? `${cheapest.base} · per $1M, all-in` : undefined} />
          <StatCard index={2} label="Fees per $1M" value={fmtUsd(bpToPerMillion(feeBps), 0)} hint="The floor, before the spread kept" />
          <StatCard index={3} label="Window" value={win === '24h' ? '24 h' : '7 days'} hint={gate === 'on' ? 'Gate on' : 'Gate off'} />
        </div>
      </Shell>

      <Shell className="bots-listcard">
        <ShellHeader
          icon="list"
          title="Markets"
          subtitle="Sorted by cost. Open a market for its hours and weekend figures."
          aside={
            <>
              <Segmented value={win} label="Window" onChange={setWin} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />
              <Segmented value={gate} label="Market gate" onChange={setGate} options={[{ value: 'off', label: 'Gate off' }, { value: 'on', label: 'Gate on' }]} />
            </>
          }
        />
        <Panel className="bots-listpanel">
          <div className="bots-toolbar">
            <SearchField value={q} onChange={setQ} placeholder="Search market" label="Search markets" className="bots-toolbar__search" />
            <Segmented value={room} label="Room to trade" onChange={setRoom} options={[{ value: 'any', label: 'Any room' }, { value: '1k', label: '$1k/h+' }, { value: '10k', label: '$10k/h+' }]} />
            <Checkbox checked={onlySure} onChange={setOnlySure} label="Enough trades to read" />
            <span className="bots-toolbar__sp" />
            <span className="bots-toolbar__n">{list.length} markets</span>
          </div>
          {r.error && !r.data ? (
            <EmptyState tone="error" icon="warning" title="Estimates unavailable" description={`The data service did not answer (${r.error}).`} actions={<Button onClick={r.refresh}>Retry</Button>} />
          ) : !r.data ? (
            <div className="bots-skels">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>
          ) : !list.length ? (
            <EmptyState icon="search" title="No market matches" description="Try another name, a smaller room, or include markets with few trades." />
          ) : (
            <div className="bots-tablewrap">
              <table className="bots-table bots-xtable">
                <thead>
                  <tr>
                    {head('symbol', 'Market', false)}
                    {head('cost', gate === 'on' ? 'Per $1M, gate on' : 'Per $1M')}
                    {head('gate', 'With gate')}
                    {head('patient', 'Patient taker')}
                    {head('fast', 'Fast taker')}
                    {head('spread', 'Spread')}
                    {head('vol', 'Moves')}
                    {head('room', 'Room')}
                    <th className="right"><span className="tf-sr">Start</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((m) => {
                    const c = gate === 'on' && m.gateCostBps !== null ? m.gateCostBps : m.estCostBps;
                    const isOpen = open === m.symbol;
                    return (
                      <Fragment key={m.symbol}>
                        <tr className={`bots-row${isOpen ? ' is-open' : ''}`} tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.symbol)} onKeyDown={(e) => e.key === 'Enter' && setOpen(isOpen ? null : m.symbol)}>
                          <td>
                            <span className="bots-mkt">
                              <Icon name="arrowRight" size={12} className="bots-chev" />
                              <CoinIcon coin={m.symbol} size={18} />
                              <b>{m.base}</b>
                              <StatusPill size="sm" tone={CONF_TONE[m.confidence]} title={`${m.smallMakers.fills.toLocaleString('en-US')} fills by makers our size in the window`}>{m.confidence}</StatusPill>
                            </span>
                          </td>
                          <td className={`right num bots-strong${c < feeBps ? ' pos' : ''}`} data-k="Per $1M">{usd(c)}<small className="bots-range">{usd(m.estCostLowBps)}–{usd(m.estCostHighBps)}</small></td>
                          <td className="right num" data-k="With gate">{usd(m.gateCostBps)}</td>
                          <td className="right" data-k="Patient taker"><span className="bots-share"><ProgressBar value={m.takers.t1002} max={1} size="sm" color={TAKER_COLORS.patient} label="Patient taker share" /><b>{Math.round(m.takers.t1002 * 100)}%</b></span></td>
                          <td className="right" data-k="Fast taker"><span className="bots-share"><ProgressBar value={m.takers.t23342} max={1} size="sm" color={TAKER_COLORS.fast} label="Fast taker share" /><b>{Math.round(m.takers.t23342 * 100)}%</b></span></td>
                          <td className="right num" data-k="Spread">{m.spreadBps.toFixed(2)} bp</td>
                          <td className="right num" data-k="Moves">{Math.round(m.volBpsH)} bp/h</td>
                          <td className="right num" data-k="Room">{fmtUsd(m.capacityUsdH, 0)}/h</td>
                          <td className="right"><Button variant="secondary" icon="plus" onClick={(e) => { e.stopPropagation(); goBots({ page: 'new', market: m.symbol, kind: null }); }}>Start bot</Button></td>
                        </tr>
                        {isOpen && (
                          <tr className="bots-xdetail">
                            <td colSpan={9}>
                              <div className="bots-xgrid">
                                <Inset className="bots-xbox">
                                  <h4>By hour, UTC <small>last 7 days</small></h4>
                                  <HourProfile m={m} feeBps={feeBps} />
                                  <p className="bots-hourkey"><span><i className="is-cheap" />Cheap</span><span><i className="is-mid" />Middle</span><span><i className="is-dear" />Dear</span><span>Taller: more traded</span></p>
                                </Inset>
                                <Inset className="bots-xbox">
                                  <h4>Weekday and weekend</h4>
                                  <div className="bots-wk">
                                    <div><small>Weekdays</small><b>{usd(m.weekdayCostBps)}</b></div>
                                    <div><small>Weekends</small><b>{usd(m.weekendCostBps)}</b></div>
                                  </div>
                                  <Takers m={m} />
                                  <div className="bots-ledger is-plain">
                                    <div><span>Kept on patient-taker fills</span><b className={(m.smallMakers.on1002Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{bp(m.smallMakers.on1002Bps)}</b></div>
                                    <div><span>Kept on fast-taker fills</span><b className={(m.smallMakers.on23342Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{bp(m.smallMakers.on23342Bps)}</b></div>
                                    <div><span>Makers our size</span><b>{m.smallMakers.count} · {fmtUsd(m.smallMakers.volumeUsdH, 0)}/h</b></div>
                                    <div><span>Market volume</span><b>{fmtUsd(m.volumeUsdH, 0)}/h</b></div>
                                    <div><span>Tick</span><b>{m.tick} ({m.tickBps.toFixed(2)} bp)</b></div>
                                  </div>
                                </Inset>
                              </div>
                            </td>
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
        <p className="bots-method">
          How it is estimated: every trade on SoDEX names both accounts. For each market we take the makers our size (any maker under a tenth of the market's maker volume that fills like a bot), measure what each of their fills kept 30 seconds later, and add the fees. The patient taker's fills cost makers little; the fast taker's cost about 1 bp each, so a market's cost follows who takes there. On BTC this read within about 0.15 bp of our live runs. "With gate": only the minutes the price moved less than 12 bp in the minute before. Fees: SoDEX's maker fee and ValueDesk's {(ctx.feeTenths / 10).toFixed(1)} bp.
        </p>
      </Shell>
    </>
  );
}
