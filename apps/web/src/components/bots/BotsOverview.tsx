/**
 * Bots > Overview: the fleet, however large, in the Bots kit (kit/kit.tsx, TUFFUI's layers). Its figures as KPI
 * cards; this wallet's own latency to SoDEX and volume / net PnL side by side; and every bot as tiles (a handful)
 * or a list (many): search, filter by state, sort by any column, 25 a page, pause / resume / stop for one bot or
 * every bot shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FINAL_STATUSES, type AlgoView } from '@copy-engine';
import { DASH, fmtUsd } from '../../format';
import { SetupProgress } from '../../copy/CopySetupSheet';
import { openConnectDialog } from '../account/connect';
import { CoinIcon } from '../CoinIcon';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';
import { cleanUsd, fleetSeries, fleetTotals, fleetWindow, foldRuns, realBots, type FleetSeries } from '../../bots/fleet';
import { useStored } from '../../hooks';
import { ErrorBoundary } from '../ErrorBoundary';
import { STRATEGIES, STRATEGY_INFO, botFeeWords, costPerMillion, draftFor, strategyOf, type Strategy } from '../../bots/presets';
import { useBotLatency } from '../../bots/data';
import { hostedExecutor } from '../../copy/executor';
import { demoLatency } from '../../bots/demo';
import { goBots, type BotsView } from '../../bots/routes';
import { BotAvatar, BotIcon } from './BotIcon';
import { LatencyChart, mergeRegions, type ChartMark } from './LatencyChart';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { StopMenu } from './StopMenu';
import { AllocationPanel } from './Allocation';
import { BotsVip } from './BotsVip';
import { BotsHead, StatePill, isLive, type BotsCtx } from './BotsPage';
import { FleetWatchdog } from './Watchdog';
import { Button, EmptyState, Icon, IconButton, Panel, ProgressBar, SearchField, Segmented, Shell, ShellHeader, Skeleton, Sparkline, StatCard, StatusPill } from './kit/kit';

const PAGE = 25;
/** What $1M of volume did, signed: +$359 when it earned, −$185 when it cost (owner: never white, never "earns"). */
export const fmtCost = (cpm: number | null | undefined): string => (cpm === null || cpm === undefined ? DASH : cpm < 0 ? `+${fmtUsd(-cpm, 0)}` : cpm > 0 ? `−${fmtUsd(cpm, 0)}` : fmtUsd(0, 0));
export const costCls = (cpm: number | null | undefined): string => (cpm === null || cpm === undefined ? '' : cpm < 0 ? 'pos' : cpm > 0 ? 'neg' : '');
export const costTone = (cpm: number | null | undefined): 'positive' | 'negative' | undefined => (cpm === null || cpm === undefined ? undefined : cpm < 0 ? 'positive' : cpm > 0 ? 'negative' : undefined);
export { StatePill };

type Show = 'all' | 'running' | 'paused' | 'ended';
type SortKey = 'started' | 'name' | 'market' | 'volume' | 'pnl' | 'cost' | 'holding';
type Layout = 'tiles' | 'list';

/* ------------------------------------------------------------- latency ----- */

/**
 * This wallet's own bots' latency to SoDEX (never another wallet's), laid out like the owner's reference: icon tile,
 * "Latency", scope · window, the legend and the window switch on the right, the chart in its panel.
 */
export function LatencyCard({ marks = [], ctx, bot, practice, compact }: { marks?: ChartMark[]; ctx: BotsCtx; bot?: string; practice?: boolean; compact?: boolean }) {
  const [hours, setHours] = useState<'6' | '24' | '48'>('24');
  const [region, setRegion] = useState<string>('all');
  const token = ctx.address && ctx.live.hosted.signedIn ? hostedExecutor.token(ctx.address) : null;
  const real = useBotLatency(48, ctx.demo ? null : token, bot);
  const demoLat = useMemo(() => (ctx.demo ? demoLatency(Date.now(), bot ? bot.length : 3) : null), [ctx.demo, bot]);
  const lat = demoLat ? { data: demoLat, error: null, loading: false, refresh: () => {} } : real;
  const regions = lat.data?.regions ?? [];
  const one = regions.find((r) => r.id === region) ?? null;
  const buckets = one ? one.buckets : mergeRegions(regions);
  const scope = one ? one.label.toLowerCase() : regions.length > 1 ? 'all regions' : (regions[0]?.label.split(' · ')[0] ?? 'tokyo').toLowerCase();
  const nowP95 = (one ? [one] : regions).map((r) => r.now.p95).filter((x): x is number => x !== null);
  const empty = (title: string, line: string) => <div className="bots-lat__well"><EmptyState icon="gauge" title={title} description={line} /></div>;
  return (
    <Shell className={`bots-latcard${compact ? ' is-compact' : ''}`}>
      <ShellHeader
        icon="gauge"
        title="Latency"
        subtitle={
          <>
            {regions.length > 1
              ? <button type="button" className="bots-lat__scope" onClick={() => { const ids = ['all', ...regions.map((r) => r.id)]; setRegion(ids[(ids.indexOf(region) + 1) % ids.length]!); }}>{scope}</button>
              : scope}
            {' · '}{hours}h{nowP95.length ? ` · p95 now ${Math.max(...nowP95)} ms` : ''}
          </>
        }
        aside={
          <>
            {!compact && <span className="bots-lat__legend" aria-hidden="true">
              <span><i className="is-p95" />p95</span>
              <span><i className="is-p50" />p50</span>
              <span><i className="is-p99" />p99</span>
            </span>}
            <Segmented value={hours} label="Window" onChange={setHours} options={[{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '48', label: '48h' }]} />
          </>
        }
      />
      <Panel className="bots-lat__panel">
        {practice && !ctx.demo
          ? empty('Practice bot', 'It sends no orders, so there is nothing to time.')
          : !ctx.address
          ? empty('Your bots only', 'Connect your wallet to see how fast your orders reach SoDEX.')
          : !token && !ctx.demo
            ? empty('Your bots only', 'Finish the bot setup to see it.')
            : lat.error && !lat.data
              ? empty('Not available right now', `The executor did not answer (${lat.error}).`)
              : !lat.data
                ? <Skeleton className="bots-lat__skel" />
                : <LatencyChart buckets={buckets} bucketMs={lat.data.bucketMs} regionLabel={one ? one.id : regions.length === 1 ? regions[0]!.id : 'all regions'} marks={marks} hours={Number(hours)} height={compact ? 170 : undefined} />}
      </Panel>
    </Shell>
  );
}

/* --------------------------------------------------------------- fleet ----- */

type Span = '1h' | '6h' | '24h' | '7d' | 'all';
const SPAN_MS: Record<Span, number | null> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, all: null };

/** Volume and net PnL of every bot together: timeframes, series on and off, and the whole card full screen. */
/**
 * The chart only: the timeframe's figures are the Fleet panel's (Overview) and the KPI cards' (a bot's page), not
 * repeated here. The series is built for the timeframe (fleet.ts fleetSeries `from`), so 1H and 6H keep their points.
 */
export function FleetChart({ bots, title = 'Volume and net PnL', series: given, empty }: { bots: AlgoView[]; title?: string; series?: FleetSeries; empty?: { title: string; line: string } }) {
  const [span, setSpan] = useState<Span>('24h');
  const [showVol, setShowVol] = useState(true);
  const [showPnl, setShowPnl] = useState(true);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };
  const cut = SPAN_MS[span];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const from = useMemo(() => (cut ? Date.now() - cut : -Infinity), [cut, bots]);
  const s = useMemo(() => given ?? fleetSeries(bots, Date.now(), undefined, Number.isFinite(from) ? from : undefined), [bots, given, from]);
  // Bars a chart can show: the volume summed into about 50 buckets for the timeframe (owner: every 5-min point
  // became a forest of thin spikes), the net PnL as its last value in each.
  const series = useMemo<ChartSeries[]>(() => {
    const vol = s.volume.filter((p) => p[0] >= from);
    // The net PnL within the timeframe (owner 2026-11-08): zero where the timeframe starts, not the total since the
    // first bot - the value before the window is taken off every point, and the line starts at the window's edge.
    const base = cut ? (s.pnl.filter((p) => p[0] < from).at(-1)?.[1] ?? 0) : 0;
    const pnl: Array<[number, number]> = s.pnl.filter((p) => p[0] >= from).map(([t, v]) => [t, v - base]);
    if (cut && pnl.length && s.pnl.some((p) => p[0] < from)) pnl.unshift([from, 0]);
    const first = vol[0]?.[0] ?? Date.now();
    const width = (cut ?? Math.max(3_600_000, Date.now() - first)) / 50;
    const steps = [300_000, 600_000, 900_000, 1_800_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000];
    const step = steps.find((x) => x >= width) ?? 86_400_000;
    const bucket = (t: number) => Math.floor(t / step) * step;
    const vb = new Map<number, number>();
    for (const [t, v] of vol) vb.set(bucket(t), (vb.get(bucket(t)) ?? 0) + v);
    const pb = new Map<number, number>();
    for (const [t, v] of pnl) pb.set(bucket(t), v);
    const out: ChartSeries[] = [];
    if (showVol) out.push({ key: 'vol', kind: 'bars', color: '#3d4a5c', points: [...vb.entries()].sort((x, y) => x[0] - y[0]), format: (x) => fmtUsd(x, 0), title: 'Volume' });
    if (showPnl) out.push({ key: 'pnl', kind: 'line', area: true, color: '#00b481', negColor: '#ef4a3c', points: [...pb.entries()].sort((x, y) => x[0] - y[0]), scale: 'left', format: (x) => fmtUsd(x, 2), title: 'Net PnL' });
    return out;
  }, [s, from, cut, showVol, showPnl]);
  const enough = s.volume.filter((p) => p[0] >= from).length >= 3 && series.length > 0;
  return (
    <Shell className={`bots-chartcard${full ? ' is-full' : ''}`} ref={box as never}>
      <ShellHeader icon="chart" title={title} subtitle={span === 'all' ? 'All time' : `Last ${span}`} aside={<IconButton icon={full ? 'x' : 'expand'} label={full ? 'Exit full screen' : 'Full screen'} variant="secondary" onClick={toggleFull} />} />
      <div className="bots-charttools">
            <span className="bots-toggles">
              <button type="button" className={`bots-toggle${showVol ? ' is-on' : ''}`} aria-pressed={showVol} onClick={() => setShowVol(!showVol)}><i className="is-vol" />Volume</button>
              <button type="button" className={`bots-toggle${showPnl ? ' is-on' : ''}`} aria-pressed={showPnl} onClick={() => setShowPnl(!showPnl)}><i className="is-pnl" />Net PnL</button>
            </span>
            <Segmented value={span} label="Timeframe" onChange={setSpan} options={[{ value: '1h', label: '1H' }, { value: '6h', label: '6H' }, { value: '24h', label: '24H' }, { value: '7d', label: '7D' }, { value: 'all', label: 'All' }]} />
      </div>
      <Panel className="bots-chartpanel">
        {enough
          ? <SeriesChart key={`${span}-${full}`} series={series} height={full ? Math.max(320, window.innerHeight - 150) : 232} daily={false} magnet />
          : <EmptyState icon="chart" title={bots.length ? 'Not enough points yet' : empty?.title ?? 'No bot yet'} description={bots.length ? 'A point every 5 minutes. Try a longer timeframe.' : empty?.line ?? 'Start a bot to chart it here.'} />}
      </Panel>
    </Shell>
  );
}

/* ----------------------------------------------------------- strategies ----- */

function StrategyPick({ ctx }: { ctx: BotsCtx }) {
  const pick = (s: Strategy) => { if (ctx.ready) goBots({ page: 'new', market: null, kind: s }); else if (ctx.address) ctx.setup(true); else void openConnectDialog(); };
  return (
    <div className="bots-strats">
      {STRATEGIES.map((s) => {
        const info = STRATEGY_INFO[s];
        const cost = costPerMillion(draftFor(s), null, null, ctx.feeTenths);
        return (
          <Panel key={s} className="bots-strat">
            <div className="bots-strat__top">
              <span className="tf-tile is-neutral"><BotIcon strategy={s} size={18} /></span>
              <div className="bots-strat__t">
                <p className="bots-strat__name">{info.name}{s === 'market' && <StatusPill tone="positive" size="sm">Lowest cost</StatusPill>}</p>
                <p className="bots-strat__line">{info.line}</p>
              </div>
            </div>
            <div className="bots-strat__foot">
              <span><small>Fees per $1M</small><b>{fmtUsd(cost.fees, 0)}</b></span>
              <span><small>Best for</small><b>{info.best}</b></span>
              <Button variant={s === 'market' ? 'primary' : 'secondary'} icon="plus" onClick={() => pick(s)}>{ctx.ready ? 'Set up' : 'Choose'}</Button>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

/** This browser saw the wallet set up before (terms or a sign-in kept, any version): its bots are spoken of. */
function knownHere(address: string): boolean {
  try {
    const a = address.toLowerCase();
    return Object.keys(localStorage).some((k) => k === `vd.copy.terms:${a}` || (k.startsWith('vd.copy.session:') && k.endsWith(`:${a}`)));
  } catch {
    return false;
  }
}

/** Sign in, and while the wallet is open the button says it waits for the approval there (owner 2026-11-08). */
export function SignInButton({ ctx }: { ctx: BotsCtx }) {
  const [waiting, setWaiting] = useState(false);
  const go = async () => {
    setWaiting(true);
    try { await ctx.signIn(); } finally { setWaiting(false); }
  };
  return (
    <span className="bots-signin">
      <Button variant="primary" icon="wallet" loading={waiting} onClick={() => void go()}>{waiting ? 'Waiting for your wallet…' : 'Sign in'}</Button>
      {waiting && <small className="bots-fine" role="status">Approve the sign-in in your wallet. It is a free signature and changes nothing.</small>}
    </span>
  );
}

function Setup({ ctx }: { ctx: BotsCtx }) {
  // Signed out (a new browser, or 30 days on): one read signature, never the terms again - they are on record.
  if (ctx.address && ctx.supported && !ctx.seen) {
    return (
      <Shell className="bots-setupcard">
        <ShellHeader icon="wallet" title="Sign in to your bots" subtitle="One free signature, it only reads" />
        <Panel className="bots-setup">
          <p className="bots-setup__line">{knownHere(ctx.address)
            ? 'Your bots keep running. Sign in to see them and to pause, stop or close them. It changes nothing and lasts 30 days in this browser.'
            : 'It shows your bots, or the setup if this wallet has none yet. It changes nothing and lasts 30 days in this browser.'}</p>
          <SignInButton ctx={ctx} />
        </Panel>
      </Shell>
    );
  }
  const body = !ctx.address
    ? { line: 'Bots trade around the clock in your own SoDEX account, from the ValueDesk executor. Connect the wallet whose account they trade in.', act: <Button variant="primary" icon="wallet" onClick={() => void openConnectDialog()}>Connect wallet</Button> }
    : !ctx.supported
      ? { line: 'The ValueDesk executor does not run bots yet. They arrive with its next update.', act: null }
      : { line: `Accept the terms to start a practice bot: it runs against the real book and sends nothing. Real orders add the ${botFeeWords(ctx.feeTenths)} fee and a trading key.`, act: <Button variant="primary" onClick={() => ctx.setup(true)}>Set up</Button> };
  return (
    <Shell className="bots-setupcard">
      <ShellHeader icon="bolt" title="Start here" subtitle={ctx.address ? 'Two short steps, one signature each' : 'No wallet connected'} />
      <Panel className="bots-setup">
        <p className="bots-setup__line">{body.line}</p>
        {ctx.address && ctx.supported && <div className="bots-setup__steps"><SetupProgress live={ctx.live} mode="hosted" paper bots /></div>}
        {body.act}
      </Panel>
    </Shell>
  );
}

/* ---------------------------------------------------------------- bots ----- */

function Controls({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const state = botState(v);
  const ended = state === 'ended' || state === 'failed';
  const busy = ctx.busy === v.algo.id;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <span className="bots-ctl" onClick={stop}>
      {!ended && state !== 'closing' && (state === 'paused'
        ? <Button variant="quiet" icon="play" disabled={busy} onClick={() => void ctx.resume(v)}>Resume</Button>
        : <Button variant="quiet" icon="pause" disabled={busy} onClick={() => void ctx.pause(v)}>Pause</Button>)}
      {!ended && <StopMenu v={v} ctx={ctx} closing={state === 'closing'} />}
      {ended && <Button variant="danger" icon="trash" disabled={busy} onClick={() => void ctx.remove(v)}>Delete</Button>}
    </span>
  );
}

function TileControls({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const state = botState(v);
  const ended = state === 'ended' || state === 'failed';
  const busy = ctx.busy === v.algo.id;
  return (
    <span className="bots-tile__ctl" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {!ended && state !== 'closing' && (state === 'paused'
        ? <IconButton icon="play" label="Resume" disabled={busy} onClick={() => void ctx.resume(v)} />
        : <IconButton icon="pause" label="Pause" disabled={busy} onClick={() => void ctx.pause(v)} />)}
      {!ended && <StopMenu v={v} ctx={ctx} closing={state === 'closing'} compact />}
      {ended && <IconButton icon="trash" label="Delete" className="is-danger" disabled={busy} onClick={() => void ctx.remove(v)} />}
    </span>
  );
}

function BotTile({ v, ctx, runs = 1 }: { v: AlgoView; ctx: BotsCtx; runs?: number }) {
  const st = strategyOf(v.algo.spec) ?? 'maker';
  const b = v.bot;
  const state = botState(v);
  const cap = v.algo.spec.kind === 'mm' ? v.algo.spec.maxInventoryUsd : null;
  const hold = Math.abs(b?.inventoryUsd ?? 0);
  const pnl = b?.netPnl ?? 0;
  const tone = pnl > 0.004 ? 'positive' : pnl < -0.004 ? 'negative' : 'neutral';
  const trend = (v.algo.book?.series ?? []).map((p) => p[2]);
  const gate = v.algo.spec.kind === 'mm' && (v.algo.spec.stillBps ?? 0) > 0;
  const ended = state === 'ended' || state === 'failed';
  const open = () => goBots({ page: 'bot', id: v.algo.id });
  const since = v.algo.startedAt ?? v.algo.createdAt;
  const hours = Math.max(0, ((v.algo.endedAt ?? Date.now()) - since) / 3_600_000);
  const age = hours >= 48 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${Math.floor(hours)}h` : `${Math.max(1, Math.round(hours * 60))}m`;
  return (
    <li>
      <div role="link" tabIndex={0} className={`bots-tile bots-row is-${state}`} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }} aria-label={`${botName(v)}, ${v.algo.spec.symbol}`}>
        <div className="bots-tile__top">
          <BotAvatar symbol={v.algo.spec.symbol} strategy={st} size={38} />
          <div className="bots-tile__t">
            <p className="bots-tile__name">{botName(v)}</p>
            <p className="bots-tile__sub">{v.algo.spec.symbol.replace(/-USD$/, '')} · {STRATEGY_INFO[st].name}{gate ? ' · gate' : ''}</p>
          </div>
          <span className="bots-tile__pills">
            {v.algo.spec.paper && <StatusPill size="sm" tone="brand">Practice</StatusPill>}
            {runs > 1 && <StatusPill size="sm" title={`${runs} stopped runs of this bot, added up`}>{runs} runs</StatusPill>}
            <StatePill s={state} size="sm" />
          </span>
        </div>
        <div className="bots-tile__hero">
          <div>
            <p className="bots-tile__k">Net PnL</p>
            <p className={`bots-tile__pnl is-${tone}`}>{fmtPnl(b?.netPnl)}</p>
          </div>
          {trend.length > 2 && <Sparkline values={trend} tone={tone} w={110} h={34} />}
        </div>
        <dl className="bots-tile__nums">
          <div><dt>Volume</dt><dd>{b ? fmtUsd(b.volume, 0) : DASH}</dd></div>
          <div><dt>Per $1M</dt><dd className={costCls(b?.costPerMillion)}>{fmtCost(b?.costPerMillion)}</dd></div>
          <div><dt>Holding</dt><dd>{!b || ended ? DASH : fmtUsd(cleanUsd(b.inventoryUsd), 0)}{cap && !ended ? <small> / {fmtUsd(cap, 0)}</small> : null}</dd></div>
        </dl>
        {cap && !ended ? <ProgressBar value={hold} max={cap} size="sm" tone={hold / cap > 0.8 ? 'warning' : 'neutral'} kind="meter" label="Holding against its cap" className="bots-tile__bar" /> : <span className="bots-tile__bar is-none" />}
        <div className="bots-tile__foot">
          <span className="bots-tile__status"><Icon name="clock" size={12} />{age} · {v.working ?? v.algo.statusReason ?? STRATEGY_INFO[st].name}</span>
          <TileControls v={v} ctx={ctx} />
        </div>
      </div>
    </li>
  );
}

export function BotsOverview({ ctx, view }: { ctx: BotsCtx; view: BotsView }) {
  const { bots } = ctx;
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'started', desc: true });
  const [page, setPage] = useState(0);
  const [fleetSpan, setFleetSpan] = useStored<Span>('vs.bots.fleetSpan', '24h');
  const [layout, setLayout] = useState<Layout | null>(null);
  const t = useMemo(() => fleetTotals(bots), [bots]);
  // The list: a bot's stopped runs folded into one row (foldRuns); the figures above count every real bot.
  const folded = useMemo(() => foldRuns(bots, botName), [bots]);
  // Money is real bots' only (practice is counted on its own): the panel's series is built for its timeframe.
  const real = useMemo(() => realBots(bots), [bots]);
  const fleetFrom = useMemo(() => (SPAN_MS[fleetSpan] ? Date.now() - SPAN_MS[fleetSpan]! : -Infinity), [fleetSpan, real]);
  const s = useMemo(() => fleetSeries(real, Date.now(), undefined, Number.isFinite(fleetFrom) ? fleetFrom : undefined), [real, fleetFrom]);
  const floor = costPerMillion(draftFor('market'), null, null, ctx.feeTenths);
  const lay: Layout = layout ?? (bots.length > 12 ? 'list' : 'tiles');

  const counts = useMemo(() => {
    const c = { all: folded.list.length, running: 0, paused: 0, ended: 0 };
    for (const v of folded.list) {
      const st = botState(v);
      if (st === 'running' || st === 'waiting' || st === 'closing') c.running++;
      else if (st === 'paused') c.paused++;
      else c.ended++;
    }
    return c;
  }, [folded]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = folded.list.filter((v) => {
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
        default: return (isLive(v) ? 1e15 : 0) + (v.algo.startedAt ?? v.algo.createdAt);
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [folded, show, q, sort]);
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
      <button type="button" className={`bots-sort${sort.k === k ? ' is-on' : ''}`} onClick={() => setSort((x) => ({ k, desc: x.k === k ? !x.desc : k !== 'name' && k !== 'market' }))}>
        {label}
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d={sort.k === k && !sort.desc ? 'M2 6.5 5 3.5l3 3' : 'M2 3.5 5 6.5l3-3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </th>
  );

  // Signed in shows the bots and their stop buttons; only starting new ones waits for the setup (ctx.ready).
  const ready = ctx.seen;
  const val = (x: string) => (ready ? x : DASH);
  // The Fleet panel's timeframe (24 hours by default): volume, net PnL (at the mark), fees and cost in it; volume and
  // PnL sparklines both as running totals inside it.
  const fw = useMemo(() => fleetWindow(s, fleetFrom), [s, fleetFrom]);
  const trendVol = fw.volTrend;
  const trendPnl = fw.pnlTrend;
  const pnlTone = fw.netPnl > 0.004 ? 'positive' : fw.netPnl < -0.004 ? 'negative' : undefined;
  const heldAll = bots.filter(isLive).reduce((x, v) => x + Math.abs(v.bot?.inventoryUsd ?? 0), 0);
  const fleetLine = [`${t.running} running`, t.paused ? `${t.paused} paused` : '', t.stopped ? `${t.stopped} stopped` : '', t.practice.bots ? `${t.practice.bots} practice (not counted)` : ''].filter(Boolean).join(' · ');

  return (
    <>
      <BotsHead
        view={view}
        title="Bots"
        sub="Market makers running 24/7 in your SoDEX account."
        actions={ready ? (
          <>
            {anyRunning && <StopMenu ctx={ctx} label="Stop all" held={heldAll} disabled={ctx.busy === 'all'} onPick={(how) => void ctx.stopAll(how)} />}
            <Button variant="primary" icon="plus" onClick={() => (ctx.ready ? goBots({ page: 'new', market: null, kind: null }) : ctx.setup(true))}>New bot</Button>
          </>
        ) : undefined}
      />

      {(ctx.address || ctx.demo) && <ErrorBoundary name="VIP" bare><BotsVip ctx={ctx} strip /></ErrorBoundary>}

      {!ctx.ready && (!ctx.seen || !bots.length) && <Setup ctx={ctx} />}

      <ErrorBoundary name="Fleet">
      <Shell className="bots-kpis">
        <ShellHeader icon="robot" title="Fleet" subtitle={ready ? fleetLine : 'Your bots, together'} aside={<Segmented value={fleetSpan} label="Fleet timeframe" onChange={setFleetSpan} options={[{ value: '24h', label: '24H' }, { value: '7d', label: '7D' }, { value: 'all', label: 'All' }]} />} />
        <div className="bots-kpigrid">
          <StatCard index={0} label="Running" value={ready ? `${t.running}` : DASH} hint={ready ? [t.paused ? `${t.paused} paused` : '', t.practice.running ? `${t.practice.running} practice` : '', t.bots ? `of ${t.bots} real` : ''].filter(Boolean).join(' · ') || undefined : undefined} />
          <StatCard index={1} label="Volume" value={val(fmtUsd(fw.volume, 0))} trend={ready ? trendVol : undefined} />
          <StatCard index={2} label="Net PnL" value={val(fmtPnl(fw.netPnl))} valueTone={ready ? pnlTone : undefined} trend={ready ? trendPnl : undefined} trendTone={pnlTone ?? 'neutral'} hint="After every fee, open positions at the mark" />
          <StatCard index={3} label="Per $1M" value={val(fmtCost(fw.costPerMillion))} valueTone={ready ? costTone(fw.costPerMillion) : undefined} hint="What the volume cost, net" />
          <StatCard index={4} label="Fees paid" value={val(fmtUsd(fw.fees, 2))} hint={`At least ${fmtUsd(floor.fees, 0)} per $1M`} />
          <StatCard index={5} label="Holding" value={val(fmtUsd(cleanUsd(t.holdingUsd), 0))} hint={t.holdingUsd > 0.005 ? `Long ${fmtUsd(t.longUsd, 0)} · short ${fmtUsd(t.shortUsd, 0)}` : 'Running bots, now'} />
        </div>
      </Shell>

      </ErrorBoundary>

      <ErrorBoundary name="Watchdog"><FleetWatchdog bots={bots} name={botName} open={(id) => goBots({ page: 'bot', id })} /></ErrorBoundary>

      <div className="bots-two">
        <ErrorBoundary name="Latency"><LatencyCard marks={marks} ctx={ctx} /></ErrorBoundary>
        <ErrorBoundary name="Volume and net PnL"><FleetChart bots={ready ? real : []} empty={ready && t.practice.bots ? { title: 'No real bot yet', line: 'Practice bots are not charted with real money.' } : undefined} /></ErrorBoundary>
      </div>

      {ready && <ErrorBoundary name="Margin"><AllocationPanel ctx={ctx} /></ErrorBoundary>}

      <ErrorBoundary name="Your bots">
      {!ready || (!bots.length && !ctx.loading) ? (
        <Shell className="bots-listcard">
          <ShellHeader icon="layers" title="Strategies" subtitle="Maker fee only, never the spread" />
          <StrategyPick ctx={ctx} />
        </Shell>
      ) : (
        <Shell className="bots-listcard">
          <ShellHeader
            icon="list"
            title={<>Your bots <span className="bots-count">{counts.all}</span></>}
            subtitle={`${counts.running} running · ${counts.paused} paused · ${counts.ended} stopped`}
            aside={
              <>
                <Segmented value={show} label="Show" onChange={(v) => { setShow(v); setPage(0); }} options={[
                  { value: 'all', label: 'All', count: counts.all },
                  { value: 'running', label: 'Running', count: counts.running },
                  { value: 'paused', label: 'Paused', count: counts.paused },
                  { value: 'ended', label: 'Stopped', count: counts.ended },
                ]} />
                <Segmented value={lay} label="Layout" onChange={setLayout} options={[{ value: 'tiles', label: 'Tiles' }, { value: 'list', label: 'List' }]} />
              </>
            }
          />
          <Panel className="bots-listpanel">
            {ctx.error && <p className="bots-err" role="alert">{ctx.error}</p>}
            {ctx.loading && !bots.length ? (
              <div className="bots-skels">{[0, 1, 2].map((i) => <Skeleton key={i} className="bots-skel" />)}</div>
            ) : (
              <>
                <div className="bots-toolbar">
                  <SearchField value={q} onChange={(x) => { setQ(x); setPage(0); }} placeholder="Search name or market" label="Search bots" className="bots-toolbar__search" />
                  <span className="bots-toolbar__n">{filtered.length.toLocaleString('en-US')} shown</span>
                  <span className="bots-toolbar__sp" />
                  <Button variant="quiet" icon="pause" disabled={!canPause.length || ctx.busy === 'all'} onClick={() => void ctx.pauseAll(canPause)}>Pause{canPause.length > 1 ? ` all ${canPause.length}` : ''}</Button>
                  <Button variant="quiet" icon="play" disabled={!canResume.length || ctx.busy === 'all'} onClick={() => void ctx.resumeAll(canResume)}>Resume{canResume.length > 1 ? ` all ${canResume.length}` : ''}</Button>
                </div>
                {!filtered.length ? (
                  <EmptyState icon="search" title={q ? 'No bot matches' : show === 'running' ? 'No bot running' : show === 'paused' ? 'No bot paused' : 'No stopped bot'} description={q ? 'Try another name or market.' : 'Start one with New bot.'} />
                ) : lay === 'tiles' ? (
                  <ul className="bots-tiles">{rows.map((v) => <BotTile key={v.algo.id} v={v} ctx={ctx} runs={folded.runs.get(v.algo.id)} />)}</ul>
                ) : (
                  <div className="bots-tablewrap">
                    <table className="bots-table">
                      <thead>
                        <tr>
                          {head('name', 'Bot')}
                          {head('market', 'Market')}
                          <th>State</th>
                          {head('volume', 'Volume', true)}
                          {head('pnl', 'Net PnL', true)}
                          {head('cost', 'Per $1M', true)}
                          {head('holding', 'Holding', true)}
                          {head('started', 'Started', true)}
                          <th className="right"><span className="tf-sr">Controls</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((v) => {
                          const st = strategyOf(v.algo.spec) ?? 'maker';
                          const b = v.bot;
                          const open = () => goBots({ page: 'bot', id: v.algo.id });
                          return (
                            <tr key={v.algo.id} className="bots-row" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
                              <td>
                                <span className="bots-who">
                                  <BotAvatar symbol={v.algo.spec.symbol} strategy={st} size={30} />
                                  <span className="bots-who__t">
                                    <b>{botName(v)}</b>
                                    <small>{STRATEGY_INFO[st].name}{v.algo.spec.kind === 'mm' && (v.algo.spec.stillBps ?? 0) > 0 ? ' · gate' : ''} · {v.algo.spec.paper ? 'practice' : 'real orders'}{(folded.runs.get(v.algo.id) ?? 1) > 1 ? ` · ${folded.runs.get(v.algo.id)} runs` : ''}</small>
                                  </span>
                                </span>
                              </td>
                              <td><span className="bots-mkt"><CoinIcon coin={v.algo.spec.symbol} size={16} />{v.algo.spec.symbol}</span></td>
                              <td><StatePill s={botState(v)} size="sm" /></td>
                              <td className="right num" data-k="Volume">{b ? fmtUsd(b.volume, 2) : DASH}</td>
                              <td className={`right num ${b && b.netPnl > 0.004 ? 'pos' : b && b.netPnl < -0.004 ? 'neg' : ''}`} data-k="Net PnL">{fmtPnl(b?.netPnl)}</td>
                              <td className={`right num ${costCls(b?.costPerMillion)}`} data-k="Per $1M">{fmtCost(b?.costPerMillion)}</td>
                              <td className="right num" data-k="Holding">{!b || !isLive(v) ? DASH : fmtUsd(cleanUsd(b.inventoryUsd), 2)}</td>
                              <td className="right num dim" data-k="Started">{new Date(v.algo.startedAt ?? v.algo.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                              <td className="right"><Controls v={v} ctx={ctx} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {pages > 1 && (
                  <nav className="bots-pager" aria-label="Pages">
                    <Button variant="quiet" icon="arrowLeft" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</Button>
                    <span>Page {at + 1} of {pages}</span>
                    <Button variant="quiet" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next<Icon name="arrowRight" size={14} /></Button>
                  </nav>
                )}
              </>
            )}
          </Panel>
        </Shell>
      )}
      </ErrorBoundary>
    </>
  );
}
