/**
 * Bots > Overview: the fleet, however large. Its figures; the executor's latency to SoDEX (LatencyChart); volume
 * and net PnL over time; and every bot in one list - search, filter by state, sort by any column, 25 a page, and
 * pause / resume / stop for one bot or every bot shown.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { AlgoView } from '@copy-engine';
import { DASH, fmtUsd, signClass } from '../../format';
import { SetupProgress } from '../../copy/CopySetupSheet';
import { openConnectDialog } from '../account/connect';
import { Card, Stat } from '../portfolio/parts';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';
import { fleetSeries, fleetTotals } from '../../bots/fleet';
import { STRATEGY_INFO, botFeeWords, costPerMillion, draftFor, strategyOf } from '../../bots/presets';
import { useBotLatency } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { BotIcon } from './BotIcon';
import { StrategyCards } from './BotForm';
import { LatencyChart, mergeRegions, type ChartMark } from './LatencyChart';
import { botName, botState, fmtPnl, STATE_WORD, type BotState } from './botWords';
import { BotsHead, isLive, type BotsCtx } from './BotsPage';

const PAGE = 25;
export const fmtCost = (cpm: number | null | undefined): string => (cpm === null || cpm === undefined ? DASH : cpm < 0 ? `earns ${fmtUsd(-cpm, 0)}` : fmtUsd(cpm, 0));

export function StatePill({ s }: { s: BotState }) {
  return <span className={`bots-state is-${s}`}>{STATE_WORD[s]}</span>;
}

type Show = 'all' | 'running' | 'paused' | 'ended';
const SHOWS: Array<{ id: Show; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'paused', label: 'Paused' },
  { id: 'ended', label: 'Stopped' },
];
type SortKey = 'started' | 'name' | 'market' | 'volume' | 'pnl' | 'cost' | 'holding';

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: ReactNode }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} className={`pf-ctl ${o.id === value ? 'is-on' : ''}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The executor's write latency to SoDEX: p50 / p95 / p99 per 10 minutes over a day, per region or all of them. */
export function LatencyCard({ marks = [] }: { marks?: ChartMark[] }) {
  const [hours, setHours] = useState(24);
  const [region, setRegion] = useState<string>('all');
  const lat = useBotLatency(48);
  const regions = lat.data?.regions ?? [];
  const one = regions.find((r) => r.id === region) ?? null;
  const buckets = one ? one.buckets : mergeRegions(regions);
  const nowP = (k: 'p50' | 'p95') => {
    const xs = (one ? [one] : regions).map((r) => r.now[k]).filter((x): x is number => x !== null);
    return xs.length ? Math.max(...xs) : null;
  };
  const kind = (k: 'place' | 'cancel') => {
    const xs = (one ? [one] : regions).map((r) => r.kinds[k].p50).filter((x): x is number => x !== null);
    return xs.length ? Math.max(...xs) : null;
  };
  const where = one ? one.where : regions.length === 1 ? regions[0]!.where : `${regions.length} regions`;
  const title = (
    <span className="bots-lat__title">
      <span className="bots-lat__ic" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3.5 13a6.5 6.5 0 1 1 13 0" /><path d="M10 13l3.2-3.6" /></svg>
      </span>
      Latency
      <small>{one ? one.label.toLowerCase() : 'all regions'} · {hours}h</small>
    </span>
  );
  return (
    <Card
      title={title}
      className="bots-latcard"
      action={
        <span className="bots-lat__legend" aria-hidden="true">
          <span><i className="is-p95" />p95</span>
          <span><i className="is-p50" />p50</span>
          <span><i className="is-p99" />p99</span>
        </span>
      }
    >
      <div className="bots-lat__bar">
        {regions.length > 1 && (
          <Seg value={region} label="Region" onChange={setRegion} options={[{ id: 'all', label: 'All' }, ...regions.map((r) => ({ id: r.id, label: r.label }))]} />
        )}
        <Seg value={String(hours)} label="Window" onChange={(v) => setHours(Number(v))} options={[{ id: '6', label: '6h' }, { id: '24', label: '24h' }, { id: '48', label: '48h' }]} />
      </div>
      {lat.error && !lat.data ? (
        <div className="bots-lat__empty"><p>Latency is not available from the executor yet ({lat.error}).</p></div>
      ) : !lat.data ? (
        <div className="bots-skel bots-skel--chart" aria-hidden="true"><span className="bots-bone" /></div>
      ) : (
        <LatencyChart buckets={buckets} bucketMs={lat.data.bucketMs} regionLabel={one ? one.id : regions.length === 1 ? regions[0]!.id : 'all regions'} marks={marks} hours={hours} />
      )}
      <div className="pf-statstrip">
        <Stat label="p50 now" value={nowP('p50') !== null ? `${nowP('p50')} ms` : DASH} hint="Half of the writes in the last 10 minutes reached SoDEX's answer faster than this." />
        <Stat label="p95 now" value={nowP('p95') !== null ? `${nowP('p95')} ms` : DASH} hint="19 of 20 writes in the last 10 minutes were faster." />
        <Stat label="Place / cancel p50" value={kind('place') !== null || kind('cancel') !== null ? `${kind('place') ?? DASH} / ${kind('cancel') ?? DASH} ms` : DASH} hint="The last hour: an order, and a cancel, from the executor to SoDEX's answer." />
        <Stat label="Runs on" value={where || DASH} hint="Where the executor that places your bots' orders runs. Its orders go through SoDEX's official route." />
      </div>
    </Card>
  );
}

/** Every bot together, over time: volume per step (bars) and net PnL (line). */
function FleetChart({ bots }: { bots: AlgoView[] }) {
  const series = useMemo<ChartSeries[]>(() => {
    const s = fleetSeries(bots, Date.now());
    return [
      { key: 'vol', kind: 'bars', color: '#5b6b80', points: s.volume, format: (x) => fmtUsd(x, 0), title: 'Volume' },
      { key: 'pnl', kind: 'line', color: '#f7f7f7', negColor: '#ef4a3c', points: s.pnl, scale: 'left', format: (x) => fmtUsd(x, 2), title: 'Net PnL' },
    ];
  }, [bots]);
  const enough = series[0]!.points.length >= 3;
  return (
    <Card title="Volume and net PnL" className="bots-chartcard">
      {enough ? (
        <div className="bots-chartwell">
          <SeriesChart series={series} height={210} daily={false} />
          <p className="bots-chartkey"><span className="bots-key is-vol" />Volume per interval<span className="bots-key is-pnl" />Net PnL</p>
        </div>
      ) : (
        <div className="pf-chart pf-chart--empty"><p>{bots.length ? 'The chart starts after the first 15 minutes: a point every 5 minutes.' : 'Start a bot to chart its volume and net PnL here.'}</p></div>
      )}
    </Card>
  );
}

function Setup({ ctx }: { ctx: BotsCtx }) {
  if (!ctx.address) {
    return (
      <Card title="Start here" className="bots-setupcard">
        <p className="pf-note">Bots trade around the clock in your own SoDEX account, from the ValueDesk executor. Connect the wallet whose account they trade in.</p>
        <button type="button" className="pf-btn pf-btn--primary" onClick={() => void openConnectDialog()}>Connect wallet</button>
      </Card>
    );
  }
  if (!ctx.supported) return <Card title="Start here" className="bots-setupcard"><p className="pf-note">The ValueDesk executor does not run bots yet. They arrive with its next update.</p></Card>;
  return (
    <Card title="Start here" className="bots-setupcard">
      <p className="pf-note">Accept the terms to start a practice bot: it runs against the real book and sends nothing. Real orders add the {botFeeWords(ctx.feeTenths)} fee and a trading key.</p>
      <SetupProgress live={ctx.live} mode="hosted" paper bots />
      <button type="button" className="pf-btn pf-btn--primary" onClick={() => ctx.setup(true)}>Set up</button>
    </Card>
  );
}

export function BotsOverview({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const { bots } = ctx;
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'started', desc: true });
  const [page, setPage] = useState(0);
  const t = useMemo(() => fleetTotals(bots), [bots]);
  const floor = costPerMillion(draftFor('market'), null, null, ctx.feeTenths);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = bots.filter((v) => {
      const st = botState(v);
      if (show === 'running' && !(st === 'running' || st === 'waiting' || st === 'closing')) return false;
      if (show === 'paused' && st !== 'paused') return false;
      if (show === 'ended' && !(st === 'ended' || st === 'failed')) return false;
      if (!needle) return true;
      return botName(v).toLowerCase().includes(needle) || v.algo.spec.symbol.toLowerCase().includes(needle) || v.algo.id.toLowerCase().includes(needle);
    });
    const val = (v: AlgoView): number | string => {
      const b = v.bot;
      switch (sort.k) {
        case 'name': return botName(v).toLowerCase();
        case 'market': return v.algo.spec.symbol;
        case 'volume': return b?.volume ?? -1;
        case 'pnl': return b?.netPnl ?? -Infinity;
        case 'cost': return b?.costPerMillion ?? Infinity;
        case 'holding': return Math.abs(b?.inventoryUsd ?? 0);
        default: return v.algo.startedAt ?? v.algo.createdAt;
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [bots, show, q, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const at = Math.min(page, pages - 1);
  const rows = filtered.slice(at * PAGE, at * PAGE + PAGE);
  const shownLive = filtered.filter(isLive);
  const canPause = shownLive.filter((v) => botState(v) !== 'paused' && botState(v) !== 'closing');
  const canResume = shownLive.filter((v) => botState(v) === 'paused');
  const anyRunning = bots.some(isLive);
  const marks: ChartMark[] = bots.flatMap((v) => (v.algo.startedAt ? [{ t: v.algo.startedAt, label: `${botName(v)} started` }] : []));

  const head = (k: SortKey, label: string, right = false) => (
    <th className={right ? 'right' : undefined} aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`bots-sort${sort.k === k ? ' is-on' : ''}`} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== 'name' && k !== 'market' }))}>
        {label}
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d={sort.k === k && !sort.desc ? 'M2 6.5 5 3.5l3 3' : 'M2 3.5 5 6.5l3-3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </th>
  );

  const actions = ctx.ready ? (
    <>
      {anyRunning && <button type="button" className="pf-btn bots-stopall" disabled={ctx.busy === 'all'} onClick={() => void ctx.stopAll()}>Stop all</button>}
      <button type="button" className="pf-btn pf-btn--primary" onClick={() => goBots({ page: 'new', market: null, kind: null })}>New bot</button>
    </>
  ) : undefined;

  return (
    <>
      <BotsHead view={view} title="Bots" sub="Market makers that run around the clock in your SoDEX account, from the ValueDesk executor." actions={actions} />

      {!ctx.ready && <Setup ctx={ctx} />}

      <Card className="bots-kpicard">
        <div className="pf-statstrip bots-kpistrip">
          <Stat label="Running" value={ctx.ready ? <>{t.running}<span className="pf-dim"> of {t.bots}</span></> : DASH} privacy="funds" />
          <Stat label="Volume" value={ctx.ready ? fmtUsd(t.volume, 2) : DASH} privacy="funds" />
          <Stat label="Net PnL" value={ctx.ready ? fmtPnl(t.netPnl) : DASH} cls={signClass(t.netPnl)} hint="After every fee, with what they hold valued at the price now." privacy="funds" />
          <Stat label="Cost per $1M" value={ctx.ready ? fmtCost(t.costPerMillion) : DASH} cls={t.costPerMillion !== null && t.costPerMillion < 0 ? 'pos' : ''} hint="Net PnL per $1M traded, sign turned: what the volume cost after what it earned." />
          <Stat label="Fees paid" value={ctx.ready ? fmtUsd(t.tradeFees + t.builderFees, 2) : DASH} hint={`SoDEX's maker fee and ValueDesk's ${botFeeWords(ctx.feeTenths)}: at least ${fmtUsd(floor.fees, 0)} per $1M.`} privacy="funds" />
          <Stat label="Holding" value={ctx.ready ? fmtUsd(t.holdingUsd, 2) : DASH} hint="What the bots hold from their own fills, at the price now." privacy="funds" />
        </div>
      </Card>

      <div className="bots-two">
        <LatencyCard marks={marks} />
        <FleetChart bots={ctx.ready ? bots : []} />
      </div>

      <Card
        title={ctx.ready && bots.length ? `Your bots · ${bots.length}` : 'Strategies'}
        className="bots-listcard"
        action={ctx.ready && bots.length > 0 ? <Seg value={show} options={SHOWS} onChange={(v) => { setShow(v); setPage(0); }} label="Show" /> : undefined}
      >
        {ctx.error && ctx.ready && <p className="fx-note fx-note--err" role="alert">{ctx.error}</p>}
        {!ctx.ready || (!bots.length && !ctx.loading) ? (
          <div className="bots-pick">
            <p className="pf-note">{ctx.ready ? 'Pick a strategy. Each starts as a practice run against the real book, and you choose the market and size.' : 'Every order rests on the book: you pay the maker fee, never the spread.'}</p>
            <StrategyCards onPick={(s) => { if (ctx.ready) goBots({ page: 'new', market: null, kind: s }); else if (ctx.address) ctx.setup(true); else void openConnectDialog(); }} />
          </div>
        ) : ctx.loading && !bots.length ? (
          <div className="bots-skel" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="bots-bone" />)}</div>
        ) : (
          <>
            <div className="bots-toolbar">
              <label className="bots-search">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.3 3.3" /></svg>
                <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search name or market" aria-label="Search bots" />
              </label>
              <span className="bots-toolbar__n">{filtered.length.toLocaleString('en-US')} shown</span>
              <span className="bots-toolbar__sp" />
              <button type="button" className="acct-act" disabled={!canPause.length || ctx.busy === 'all'} onClick={() => void ctx.pauseAll(canPause)}>Pause {canPause.length > 1 ? `all ${canPause.length}` : ''}</button>
              <button type="button" className="acct-act" disabled={!canResume.length || ctx.busy === 'all'} onClick={() => void ctx.resumeAll(canResume)}>Resume {canResume.length > 1 ? `all ${canResume.length}` : ''}</button>
            </div>
            {!filtered.length ? (
              <EmptyState icon="chart" title={q ? 'No bot matches' : show === 'running' ? 'No bot running' : show === 'paused' ? 'No bot paused' : 'No stopped bot'} line={q ? 'Try another name or market.' : 'Start one with New bot.'} compact />
            ) : (
              <div className="bots-tablewrap">
                <table className="datatable lb-table bots-table">
                  <thead>
                    <tr>
                      {head('name', 'Bot')}
                      {head('market', 'Market')}
                      <th>State</th>
                      {head('volume', 'Volume', true)}
                      {head('pnl', 'Net PnL', true)}
                      {head('cost', 'Cost per $1M', true)}
                      {head('holding', 'Holding', true)}
                      {head('started', 'Started', true)}
                      <th className="right" aria-label="Controls" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => {
                      const st = strategyOf(v.algo.spec) ?? 'maker';
                      const b = v.bot;
                      const state = botState(v);
                      const ended = state === 'ended' || state === 'failed';
                      const busy = ctx.busy === v.algo.id;
                      const open = () => goBots({ page: 'bot', id: v.algo.id });
                      return (
                        <tr key={v.algo.id} className="bots-row" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
                          <td>
                            <span className="bots-who">
                              <BotIcon strategy={st} size={16} />
                              <span className="bots-who__t">
                                <b>{botName(v)}</b>
                                <small>{STRATEGY_INFO[st].name}{st === 'market' && v.algo.spec.kind === 'mm' && (v.algo.spec.stillBps ?? 0) > 0 ? ' · gate' : ''} · {v.algo.spec.paper ? 'practice' : 'real orders'}</small>
                              </span>
                            </span>
                          </td>
                          <td><span className="bots-mkt"><CoinIcon coin={v.algo.spec.symbol} size={16} />{v.algo.spec.symbol}</span></td>
                          <td><StatePill s={state} /></td>
                          <td className="right" data-k="Volume">{b ? fmtUsd(b.volume, 2) : DASH}</td>
                          <td className={`right ${signClass(b?.netPnl)}`} data-k="Net PnL">{fmtPnl(b?.netPnl)}</td>
                          <td className={`right ${b?.costPerMillion !== null && b?.costPerMillion !== undefined && b.costPerMillion < 0 ? 'pos' : ''}`} data-k="Cost per $1M">{fmtCost(b?.costPerMillion)}</td>
                          <td className="right" data-k="Holding">{b ? fmtUsd(b.inventoryUsd, 2) : DASH}</td>
                          <td className="right bots-dim" data-k="Started">{new Date(v.algo.startedAt ?? v.algo.createdAt).toISOString().slice(5, 16).replace('T', ' ')}</td>
                          <td className="right">
                            <span className="bots-ctl is-compact">
                              {!ended && state !== 'closing' && (state === 'paused'
                                ? <button type="button" className="acct-act" disabled={busy} onClick={(e) => { e.stopPropagation(); void ctx.resume(v); }}>Resume</button>
                                : <button type="button" className="acct-act" disabled={busy} onClick={(e) => { e.stopPropagation(); void ctx.pause(v); }}>Pause</button>)}
                              {!ended && <button type="button" className="acct-act acct-act--danger" disabled={busy} onClick={(e) => { e.stopPropagation(); void ctx.stop(v); }}>{state === 'closing' ? 'Stop now' : 'Stop'}</button>}
                              {ended && <button type="button" className="acct-act acct-act--danger" disabled={busy} onClick={(e) => { e.stopPropagation(); void ctx.remove(v); }}>Delete</button>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pages > 1 && (
              <nav className="bots-pager" aria-label="Pages">
                <button type="button" className="acct-act" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button>
                <span>Page {at + 1} of {pages}</span>
                <button type="button" className="acct-act" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next</button>
              </nav>
            )}
          </>
        )}
      </Card>
    </>
  );
}
