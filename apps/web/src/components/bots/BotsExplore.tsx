/**
 * Bots > Explore: what a market maker costs on every SoDEX market, without running there (bots/data.ts
 * useBotMarkets). For each market, from its own trades: who takes small makers' quotes (the patient taker costs
 * makers little, the fast one about 1 bp a fill), what makers our size kept 30 s after each fill, the spread, how
 * much the price moves, and how much flow there is to take. Sort by any of it; open a market for its hourly profile,
 * weekday against weekend, and Start a bot there.
 */
import { Fragment, useMemo, useState } from 'react';
import { DASH, fmtUsd } from '../../format';
import { Card, Stat } from '../portfolio/parts';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { useBotMarkets, bpToPerMillion, type BotMarket } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { BotsHead, type BotsCtx } from './BotsPage';

type Key = 'cost' | 'gate' | 'patient' | 'fast' | 'spread' | 'vol' | 'room' | 'symbol';
const usd = (bp: number | null | undefined) => (bp === null || bp === undefined ? DASH : bp < 0 ? `earns ${fmtUsd(-bpToPerMillion(bp), 0)}` : fmtUsd(bpToPerMillion(bp), 0));

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} className={`pf-ctl ${o.id === value ? 'is-on' : ''}`} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/** The 24 UTC hours: bar height = volume, colour = cost (cheap toward --pos, dear toward --neg), from the 7 d profile. */
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
            <i style={{ height: `${Math.max(6, (h.volumeUsdH / maxV) * 100)}%` }} />
            <small>{h.h % 6 === 0 ? String(h.h).padStart(2, '0') : ''}</small>
          </span>
        );
      })}
    </div>
  );
}

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
      <button type="button" className={`bots-sort${sort.k === k ? ' is-on' : ''}`} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k === 'patient' || k === 'room' || k === 'vol' }))}>{label}</button>
    </th>
  );

  return (
    <>
      <BotsHead view={view} title="Explore" sub="What a market maker costs on every SoDEX market, read from each market's own trades: no live run needed." />
      <Card className="bots-kpicard">
        <div className="pf-statstrip bots-kpistrip">
          <Stat label="Markets read" value={r.data ? r.data.markets.length : DASH} />
          <Stat label="Lowest estimate" value={cheapest ? <><CoinIcon coin={cheapest.symbol} size={14} /> {cheapest.base} {usd(cheapest.estCostBps)}</> : DASH} hint="Per $1M, all-in, over the window." />
          <Stat label="Fees per $1M" value={fmtUsd(bpToPerMillion(feeBps), 0)} hint={`SoDEX's maker fee and ValueDesk's ${(ctx.feeTenths / 10).toFixed(1)} bp: the floor nothing goes under, before the spread a maker keeps.`} />
          <Stat label="Read at" value={r.data ? new Date(r.data.at).toISOString().slice(11, 16) + ' UTC' : DASH} hint="Estimates refresh every 5 minutes." />
        </div>
      </Card>
      <Card
        title="Every market"
        className="bots-listcard"
        action={
          <span className="bots-toolbar__act">
            <Seg value={win} label="Window" onChange={setWin} options={[{ id: '24h', label: '24h' }, { id: '7d', label: '7d' }]} />
            <Seg value={gate} label="Market gate" onChange={setGate} options={[{ id: 'off', label: 'Gate off' }, { id: 'on', label: 'Gate on' }]} />
          </span>
        }
      >
        <div className="bots-toolbar">
          <label className="bots-search">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.3 3.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search market" aria-label="Search markets" />
          </label>
          <Seg value={room} label="Room to trade" onChange={setRoom} options={[{ id: 'any', label: 'Any room' }, { id: '1k', label: '$1k/h+' }, { id: '10k', label: '$10k/h+' }]} />
          <label className="bots-check"><input type="checkbox" checked={onlySure} onChange={(e) => setOnlySure(e.target.checked)} /><span>Enough trades to read</span></label>
          <span className="bots-toolbar__sp" />
          <span className="bots-toolbar__n">{list.length} markets</span>
        </div>
        {r.error && !r.data ? (
          <EmptyState icon="chart" title="Estimates unavailable" line={`The data service did not answer (${r.error}).`} action={<button type="button" className="pf-btn" onClick={r.refresh}>Retry</button>} compact />
        ) : !r.data ? (
          <div className="bots-skel" aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i} className="bots-bone" />)}</div>
        ) : !list.length ? (
          <EmptyState icon="chart" title="No market matches" line="Try another name, or include markets with few trades." compact />
        ) : (
          <div className="bots-tablewrap">
            <table className="datatable lb-table bots-table bots-xtable">
              <thead>
                <tr>
                  {head('symbol', 'Market', false)}
                  {head('cost', gate === 'on' ? 'Cost per $1M, gate on' : 'Cost per $1M')}
                  {head('gate', 'With gate')}
                  {head('patient', 'Patient taker')}
                  {head('fast', 'Fast taker')}
                  {head('spread', 'Spread')}
                  {head('vol', 'Moves')}
                  {head('room', 'Room')}
                  <th className="right" aria-label="Start" />
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
                          <span className="bots-mkt"><CoinIcon coin={m.symbol} size={16} /><b>{m.base}</b><span className={`bots-conf is-${m.confidence}`} title={`${m.smallMakers.fills.toLocaleString('en-US')} fills by makers our size in the window`}>{m.confidence}</span></span>
                        </td>
                        <td className={`right bots-strong${c < feeBps ? ' pos' : ''}`} data-k="Cost per $1M">{usd(c)}<small className="bots-range">{usd(m.estCostLowBps)}–{usd(m.estCostHighBps)}</small></td>
                        <td className="right" data-k="With gate">{usd(m.gateCostBps)}</td>
                        <td className="right" data-k="Patient taker"><span className="bots-share"><i style={{ width: `${m.takers.t1002 * 100}%` }} className="is-patient" />{Math.round(m.takers.t1002 * 100)}%</span></td>
                        <td className="right" data-k="Fast taker"><span className="bots-share"><i style={{ width: `${m.takers.t23342 * 100}%` }} className="is-fast" />{Math.round(m.takers.t23342 * 100)}%</span></td>
                        <td className="right" data-k="Spread">{m.spreadBps.toFixed(2)} bp</td>
                        <td className="right" data-k="Moves">{Math.round(m.volBpsH)} bp/h</td>
                        <td className="right" data-k="Room">{fmtUsd(m.capacityUsdH, 0)}/h</td>
                        <td className="right"><button type="button" className="acct-act" onClick={(e) => { e.stopPropagation(); goBots({ page: 'new', market: m.symbol, kind: null }); }}>Start bot</button></td>
                      </tr>
                      {isOpen && (
                        <tr className="bots-xdetail">
                          <td colSpan={9}>
                            <div className="bots-xgrid">
                              <section>
                                <h4>By hour, UTC (7 days)</h4>
                                <HourProfile m={m} feeBps={feeBps} />
                                <p className="bots-fine">Taller: more traded. Toward green: cheaper for makers our size; toward red: dearer. Empty: too few fills that hour.</p>
                              </section>
                              <section>
                                <h4>Weekday and weekend</h4>
                                <dl className="bots-ledger">
                                  <dt>Weekdays</dt><dd>{usd(m.weekdayCostBps)}</dd>
                                  <dt>Weekends</dt><dd>{usd(m.weekendCostBps)}</dd>
                                  <dt>Small makers' fills on the patient taker</dt><dd className={(m.smallMakers.on1002Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{m.smallMakers.on1002Bps === null ? DASH : `${m.smallMakers.on1002Bps >= 0 ? '+' : '−'}${Math.abs(m.smallMakers.on1002Bps).toFixed(2)} bp`}</dd>
                                  <dt>…on the fast taker</dt><dd className={(m.smallMakers.on23342Bps ?? 0) >= 0 ? 'pos' : 'neg'}>{m.smallMakers.on23342Bps === null ? DASH : `${m.smallMakers.on23342Bps >= 0 ? '+' : '−'}${Math.abs(m.smallMakers.on23342Bps).toFixed(2)} bp`}</dd>
                                  <dt>Makers our size</dt><dd>{m.smallMakers.count} · {fmtUsd(m.smallMakers.volumeUsdH, 0)}/h</dd>
                                  <dt>Market volume</dt><dd>{fmtUsd(m.volumeUsdH, 0)}/h</dd>
                                  <dt>Tick</dt><dd>{m.tick} ({m.tickBps.toFixed(2)} bp)</dd>
                                </dl>
                              </section>
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
        <p className="bots-fine bots-method">
          How it is estimated: every trade on SoDEX names both accounts. For each market we take the makers our size (any maker under a tenth of the market's maker volume), and measure what each of their fills kept 30 seconds later, against the price then, and add the fees. The patient taker's fills cost makers little; the fast taker's cost about 1 bp each, so a market's cost follows who takes there. Our live runs on BTC came within about 0.1 bp of this. "With gate": the same, only over the minutes the price moved less than 12 bp in the minute before.
        </p>
      </Card>
    </>
  );
}
