/**
 * Bots > one bot: its figures, its own latency to SoDEX, its chart, orders, trades and log; its settings, and a
 * change of settings by restart (owner 2026-11-07):
 *
 *   Clean restart (recommended)  the bot stops and closes what it holds; the new one starts flat once it has
 *   Instant restart              the new one starts at once and takes over what the old one holds (same market)
 *
 * One wallet signature either way (executor feature 'bot-restart'). A change the executor makes on the running bot
 * (a name, a loss limit, a run time, a volume target, sizes and distances: fleet.ts inPlacePatch) is a plain Save
 * instead, and nothing restarts. A stopped bot runs again, and a practice bot runs with real orders, from New bot
 * filled with its settings. Pause, resume, stop and delete stay in the header.
 */
import { botCard } from '../share/shareData';
import { openShare } from '../share/host';
import { HedgeLegs, HedgeSettings } from './HedgeDetail';
import { useEffect, useMemo, useState } from 'react';
import { FINAL_STATUSES, regionPolicy, type AlgoEvent, type AlgoView } from '@copy-engine';
import { DASH, fmtDateTime, fmtQty, fmtUsd } from '../../format';
import { fmtPriceAuto } from '../palette/model';
import { useBotLeverage } from '../../bots/leverage';
import { useTwins } from '../../bots/useEngines';
import { ENGINE_NAME, marketLabel } from '../../bots/engines';
import { CoinIcon } from '../CoinIcon';
import { SeriesChart } from '../datachart/SeriesChart';
import { useBotLog } from '../../bots/useBots';
import { inPlacePatch } from '../../bots/fleet';
import { canUpdateOn } from '../../algo/executorAlgos';
import { BotLog } from './BotLog';
import { MarketConditions } from './BotsRegime';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, botFeeWords, draftOfSpec, leverageCap, gridRange, specChanges, specOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotAvatar, BotIcon } from './BotIcon';
import { botSeries } from './BotSheet';
import { BotSettings, NameField } from './BotSettings';
import { StopMenu } from './StopMenu';
import { Watchdog } from './Watchdog';
import { Term } from './Term';
import { BotAllocation } from './Allocation';
import { TAKER_COLORS, effectiveDraft } from './BotNewPage';
import { estimate, feeAdjOf, ownRuns } from '../../bots/estimate';
import { FleetChart, LatencyCard, costTone, fmtCost } from './BotsOverview';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { BotsHead, StatePill, type BotsCtx } from './BotsPage';
import { SignInButton } from './BotsOverview';
import { Button, EmptyState, Icon, IconButton, Inset, Panel, ProgressBar, RollingNumber, SegmentedBar, Shell, ShellHeader, Skeleton, StatCard, StatusPill, Tabs, type Tone } from './kit/kit';

type Tab = 'overview' | 'analysis' | 'settings' | 'orders' | 'trades' | 'activity';
type How = 'clean' | 'takeover';

function Controls({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const st = botState(v);
  const ended = st === 'ended' || st === 'failed';
  const busy = ctx.busy === v.algo.id;
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  return (
    <>
      {!ended && st !== 'closing' && (st === 'paused'
        ? <Button variant="secondary" icon="play" disabled={busy} onClick={() => void ctx.resume(v)}>Resume</Button>
        : <Button variant="secondary" icon="pause" disabled={busy} onClick={() => void ctx.pause(v)}>Pause</Button>)}
      {!ended && <StopMenu v={v} ctx={ctx} closing={st === 'closing'} />}
      {ended && v.bot?.leftover && <Button variant="primary" icon="stop" disabled={busy} onClick={() => void ctx.closeRest(v)}>Close leftover</Button>}
      {ended && <Button variant="danger" icon="trash" disabled={busy || !!v.bot?.leftover} title={v.bot?.leftover ? 'Close the leftover first' : undefined} onClick={() => void ctx.remove(v)}>Delete</Button>}
      {ended && <Button variant="primary" icon="play" onClick={() => ctx.runAgain(v)}>Run again</Button>}
      {v.algo.spec.paper && ctx.liveAllowed && <Button variant={ended ? 'secondary' : 'primary'} icon="bolt" onClick={() => ctx.runAgain(v, true)} title="New bot opens with these settings, set to real orders">Run with real orders</Button>}
      {v.bot && <Button variant="secondary" icon="share" onClick={() => { const c = botCard(v); if (c) openShare(c); }}>Share</Button>}
    </>
  );
}

/** A bot's leverage, safeguards and limits as the header's chips (what it runs with, at a glance). */
function SpecChips({ v }: { v: AlgoView }) {
  const s = v.algo.spec as AlgoView['algo']['spec'] & { stillBps?: number; flowGate?: unknown; quiet?: unknown[]; news?: unknown; maxLossUsd?: number | null; volumeTargetUsd?: number | null; endAt?: number | null; maxInventoryUsd?: number };
  const guards = [
    (s.stillBps ?? 0) > 0 ? 'market gate' : '',
    s.flowGate ? 'flow gate' : '',
    s.quiet?.length ? 'trading hours' : '',
    s.news ? 'news pause' : '',
    s.maxSpreadBps ? `spread limit ${s.maxSpreadBps} bp` : '',
  ].filter(Boolean);
  const limits = [
    typeof s.maxLossUsd === 'number' ? `loss limit ${fmtUsd(s.maxLossUsd, 0)}` : '',
    typeof s.maxInventoryUsd === 'number' ? `holds up to ${fmtUsd(s.maxInventoryUsd, 0)}` : '',
    typeof s.volumeTargetUsd === 'number' ? `stops at ${fmtUsd(s.volumeTargetUsd, 0)} traded` : '',
    typeof s.endAt === 'number' ? `ends ${fmtDateTime(s.endAt)}` : '',
  ].filter(Boolean);
  return (
    <>
      <span className="bots-chipx" title="Leverage it trades at">{s.leverage ? `${s.leverage}x` : 'Account leverage'}</span>
      <span className="bots-chipx" title="Safeguards on">{guards.length ? guards.join(' · ') : 'No safeguard on'}</span>
      <span className={`bots-chipx${typeof s.maxLossUsd === 'number' ? '' : ' is-warn'}`} title="Limits">{limits.length ? limits.join(' · ') : 'No limit set'}</span>
    </>
  );
}

/**
 * The bot's settings as a page (owner 2026-11-07: a real settings page, not a summary, and not a pop-up): the form
 * with what runs now, and the two ways a change takes over, as two buttons. Clean restart is the recommended one.
 */
function SettingsTab({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const before = useMemo(() => draftOfSpec(v.algo.spec), [v.algo.spec]);
  const [d, setD] = useState<BotDraft>(before);
  const lev = useBotLeverage(ctx.address, v.algo.spec.symbol);
  // Only the market's maximum caps a bot's leverage (owner 2026-11-08).
  const regionMax: number | null = null;
  const [busy, setBusy] = useState<How | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markets = useBotMarkets('24h');
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  const changes = specChanges(before, d);
  const n = changes.length;
  // A list refresh brings a new spec object every few seconds: only pick it up while nothing is being edited.
  useEffect(() => { if (!n) setD(before); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [before]);
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  // Futures or spot (owner 2026-11-19): the same coin on the other engine is another market - a clean restart moves the
  // bot there (it closes what it holds here first); an instant restart keeps the market, so it is not offered then.
  const twins = useTwins(before.symbol);
  const moved = d.symbol !== before.symbol;
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  // Closing what it holds: no change and no restart until it has stopped (audit 2026-11-09: a restart then orphaned it).
  const closing = !ended && v.bot?.closing === true;
  const next = () => specOf(effectiveDraft({ ...d, paper: v.algo.spec.paper }, est), null);
  // What the executor changes in place (no restart, nothing closed): a Save. Anything else restarts.
  const patch = useMemo(() => {
    if (!n || ended || !canUpdateOn('hosted')) return null;
    return inPlacePatch(specOf(effectiveDraft({ ...before, paper: v.algo.spec.paper }, est), null), next(), changes.includes('endAt'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, ended, before, d, est]);
  const restart = async (how: How) => {
    setBusy(how);
    setError(null);
    try {
      await ctx.restart(v, next(), how);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!patch) return;
    setBusy('save');
    setError(null);
    try {
      await ctx.update(v.algo.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="bots-settingspage">
      <Shell className="bots-setshell">
        <ShellHeader icon="gear" title="Settings" subtitle={ended ? 'As it ran. Run it again to start a new bot with them.' : closing ? 'It is closing what it holds: settings can change again once it has stopped.' : 'Every setting saves to the running bot at once: nothing restarts, nothing is closed.'} aside={n ? <Button variant="quiet" onClick={() => setD(before)}>Undo changes</Button> : ended ? <Button variant="secondary" icon="play" onClick={() => ctx.runAgain(v)}>Run again</Button> : undefined} />
        <Panel className="bots-sizepanel">
          <fieldset className="bots-fieldset" disabled={ended || closing}>
            <div className="bots-setname"><NameField d={d} set={(p) => setD((x) => ({ ...x, ...p }))} /></div>
            <BotSettings cards d={d} set={(p) => setD((x) => ({ ...x, ...p }))} twins={d.strategy === 'hedge' ? undefined : twins} range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={v.bot?.mark ?? null} liveAllowed={ctx.liveAllowed} hidePractice noLead={est?.lead === null} lev={{ ...lev, max: leverageCap(lev.max, regionMax) }} />
          </fieldset>
        </Panel>
      </Shell>
      {error && <p className="bots-err" role="alert">{error}</p>}
      {!ended && !closing && (
        <div className={`bots-restartbar${n ? ' is-dirty' : ''}`}>
          <span className="bots-restartbar__t">
            <b>{n ? `${n} change${n === 1 ? '' : 's'}` : 'No change yet'}</b>
            <small>{!n ? 'Edit any setting above.' : patch ? 'Save changes the running bot: nothing restarts, nothing is closed.' : moved ? `It moves to ${marketLabel(d.symbol)} ${ENGINE_NAME[d.engine].toLowerCase()}: a clean restart closes what it holds here, then starts there.` : 'This change makes it another bot (its market, its type, or practice and real): a restart applies it.'}</small>
          </span>
          {patch || !n ? (
            <Button variant="go" icon="check" disabled={!patch || busy !== null} loading={busy === 'save'} onClick={() => void save()}>Save</Button>
          ) : (
            <>
              <Button variant="secondary" icon="bolt" disabled={!n || moved || busy !== null} loading={busy === 'takeover'} onClick={() => void restart('takeover')} title={moved ? 'An instant restart keeps the market: a move to another market is a clean restart.' : holds ? 'Starts now and keeps its position.' : 'Starts now.'}>Instant restart</Button>
              <Button variant="go" icon="shield" disabled={!n || busy !== null} loading={busy === 'clean'} onClick={() => void restart('clean')} title={holds ? 'Closes its position, then starts fresh.' : 'Stops, then starts fresh.'}>Clean restart<span className="bots-rec">Recommended</span></Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The bot's own figures (owner 2026-11-08: "has to be users actual cost and actual informed uninformed"): its cost
 * per $1M from its own fills and fees, who took its quotes (BotBook.takers, from the trade stream), and the market's
 * estimate beside it only as a comparison.
 */
function RealCost({ v }: { v: AlgoView }) {
  const b = v.bot;
  const t = b?.takers;
  const sum = t ? t.t1002 + t.t23342 + t.other : 0;
  const cost = b?.costPerMillion ?? null;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Per $1M, this bot{b ? ` · ${fmtUsd(b.volume, 0)} traded` : ''}</span>
        <RollingNumber value={cost === null ? DASH : fmtCost(cost)} className={`bots-est__v ${cost === null ? '' : cost < 0 ? 'pos' : 'neg'}`} />
        <span className="bots-est__sub">{Math.abs(b?.inventory ?? 0) > 0 ? 'After fees, with what it holds valued at the price now' : 'After fees, from its own fills'}</span>
      </div>
      {t && sum > 0 ? (
        <div className="bots-takers">
          <SegmentedBar
            label="Who took this bot's quotes"
            max={1}
            size="md"
            segments={[
              { id: 'p', value: t.t1002 / sum, label: 'Uninformed flow', color: TAKER_COLORS.patient },
              { id: 'f', value: t.t23342 / sum, label: 'Informed flow', color: TAKER_COLORS.fast },
              { id: 'o', value: t.other / sum, label: 'Others', color: TAKER_COLORS.other },
            ]}
          />
          <div className="bots-takers__key">
            <span><i style={{ background: TAKER_COLORS.patient }} />Uninformed <b>{Math.round((t.t1002 / sum) * 100)}%</b></span>
            <span><i style={{ background: TAKER_COLORS.fast }} />Informed <b>{Math.round((t.t23342 / sum) * 100)}%</b></span>
            <span><i style={{ background: TAKER_COLORS.other }} />Others <b>{Math.round((t.other / sum) * 100)}%</b></span>
          </div>
          <small className="bots-fine">Share of the {fmtUsd(sum, 0)} its quotes filled.</small>
        </div>
      ) : <p className="bots-fine">Who takes its quotes shows after its first fills.</p>}
    </div>
  );
}

function Orders({ v }: { v: AlgoView }) {
  const b = v.bot;
  if (!b || !b.orders.length) return <EmptyState compact icon="list" title={FINAL_STATUSES.has(v.algo.status) ? 'Ended' : b?.closing ? 'Closing its position' : 'Nothing resting now'} />;
  return (
    <table className="bots-table">
      <thead><tr><th>Side</th><th className="right">Price</th><th className="right">Size</th><th className="right">Value</th></tr></thead>
      <tbody>
        {[...b.orders].sort((x, y) => y.price - x.price).slice(0, 20).map((o) => (
          <tr key={`${o.tag}-${o.price}`}>
            <td><StatusPill size="sm" tone={o.side === 'buy' ? 'positive' : 'negative'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</StatusPill></td>
            <td className="right num">${fmtPriceAuto(o.price)}</td>
            <td className="right num">{fmtQty(o.quantity)}</td>
            <td className="right num">{fmtUsd(o.price * o.quantity, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Time left in words: '2 d 4 h', '3 h 10 min', '12 min'. */
function leftWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m >= 1440) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${m} min`;
}

/**
 * How far a running bot is toward each limit it stops at (owner 2026-11-08): the loss limit (net PnL after fees, open
 * position at the price now, as the engine checks it), its end time, its volume target. Each one set gets a bar;
 * the loss bar turns amber past half and red past 80%.
 */
/** When the holding last matched SoDEX's position (the executor's check every 30 s): ", matches SoDEX 20 s ago". */
function matchedWords(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  return `, matches SoDEX ${s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`} ago`;
}

export function LimitsProgress({ v }: { v: AlgoView }) {
  const s = v.algo.spec as AlgoView['algo']['spec'] & { maxLossUsd?: number | null; volumeTargetUsd?: number | null; endAt?: number | null };
  const b = v.bot;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (typeof s.endAt !== 'number') return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [s.endAt]);
  const rows: Array<{ id: string; title: string; ratio: number; tone: Tone; text: string }> = [];
  if (typeof s.maxLossUsd === 'number' && s.maxLossUsd > 0) {
    const net = b?.netPnl ?? 0;
    const lost = Math.max(0, -net);
    const r = lost / s.maxLossUsd;
    rows.push({ id: 'loss', title: 'Loss limit', ratio: r, tone: r >= 0.8 ? 'negative' : r >= 0.5 ? 'warning' : 'brand', text: net >= 0 ? `In profit ${fmtUsd(net, 2)}: none of its ${fmtUsd(s.maxLossUsd, 0)} used` : `${fmtUsd(lost, 2)} of ${fmtUsd(s.maxLossUsd, 0)} used · stops at ${fmtUsd(-s.maxLossUsd, 0)}${(s as { onStop?: string }).onStop === 'keep' ? ', keeping what it holds' : ' and closes what it holds'}` });
  }
  if (typeof s.endAt === 'number') {
    const start = v.algo.startedAt ?? v.algo.createdAt;
    const r = s.endAt > start ? (now - start) / (s.endAt - start) : 1;
    rows.push({ id: 'end', title: 'Run time', ratio: r, tone: 'brand', text: now >= s.endAt ? `Ended ${fmtDateTime(s.endAt)}` : `${leftWords(s.endAt - now)} left · ends ${fmtDateTime(s.endAt)}` });
  }
  if (typeof s.volumeTargetUsd === 'number' && s.volumeTargetUsd > 0) {
    const vol = b?.volume ?? 0;
    rows.push({ id: 'vol', title: 'Volume target', ratio: vol / s.volumeTargetUsd, tone: 'positive', text: `${fmtUsd(vol, 0)} of ${fmtUsd(s.volumeTargetUsd, 0)} traded` });
  }
  if (!rows.length) return <p className="bots-fine">No limits set: it runs until you stop it.{v.algo.spec.paper ? '' : ' Set a loss limit in Settings.'}</p>;
  return (
    <div className="bots-limits">
      {rows.map((x) => (
        <div key={x.id} className="bots-limits__row">
          <div className="bots-limits__head"><b>{x.title}</b><span className="num">{Math.min(100, Math.round(x.ratio * 100))}%</span></div>
          <ProgressBar value={Math.min(1, Math.max(0, x.ratio))} max={1} size="sm" tone={x.tone} label={x.title} valueText={x.text} />
          <small className="bots-fine">{x.text}</small>
        </div>
      ))}
    </div>
  );
}

export function BotDetail({ ctx, view, id }: { ctx: BotsCtx; view: BotsView; id: string }) {
  const v = ctx.bots.find((x) => x.algo.id === id) ?? null;
  const [tab, setTab] = useState<Tab>('overview');
  const log = useBotLog(id, !!v && (tab === 'trades' || tab === 'activity' || tab === 'analysis'));
  const markets = useBotMarkets('24h', !!v && v.algo.spec.kind === 'mm');
  const back = <IconButton icon="arrowLeft" label="All bots" variant="secondary" onClick={() => goBots({ page: 'overview' })} />;
  if (!v) {
    return (
      <>
        <BotsHead view={view} title="Bot" lead={back} />
        <Shell>
          <Panel>
            {ctx.address && ctx.supported && !ctx.seen ? (
              <EmptyState icon="wallet" title="Sign in to see this bot" description="Your sign-in to the ValueDesk executor ended. Your bots keep running; sign in to see and control them. It is a free signature." actions={<SignInButton ctx={ctx} />} />
            ) : ctx.loading ? <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div> : (
              <EmptyState icon="robot" title={ctx.error ? 'Your bots could not be read' : 'No such bot'} description={ctx.error ?? (ctx.address ? 'Not one of your bots, or deleted.' : 'Connect the wallet it runs for.')} actions={<Button onClick={() => goBots({ page: 'overview' })}>All bots</Button>} />
            )}
          </Panel>
        </Shell>
      </>
    );
  }
  const strategy = strategyOf(v.algo.spec) ?? 'maker';
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  const b = v.bot;
  const cap = v.algo.spec.kind === 'mm' ? v.algo.spec.maxInventoryUsd : null;
  const hold = Math.abs(b?.inventoryUsd ?? 0);
  const pnlTone = b && b.netPnl > 0.004 ? 'positive' : b && b.netPnl < -0.004 ? 'negative' : undefined;
  const trendPnl = (v.algo.book?.series ?? []).map((p) => p[2]);
  const trendVol = (v.algo.book?.series ?? []).map((p) => p[1]);
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  // The window that holds the bot's run, and its start and stop drawn on the market's chart.
  const runFrom = v.algo.startedAt ?? v.algo.createdAt;
  const runMs = (v.algo.endedAt ?? Date.now()) - runFrom;
  const runWindow = runMs < 3_600_000 ? '1h' : runMs < 6 * 3_600_000 ? '6h' : runMs < 24 * 3_600_000 ? '24h' : '7d';
  const runMarks = [{ t: runFrom, label: 'Started' }, ...(v.algo.endedAt ? [{ t: v.algo.endedAt, label: 'Stopped' }] : [])];
  // One estimate on the page: the market's, blended with this wallet's own runs (estimate.ts), as New bot shows it.
  const estBps = v.algo.spec.kind === 'mm' && markets.data ? estimate(effectiveDraft(draftOfSpec(v.algo.spec), est), est, ownRuns(ctx.bots, markets.data.markets), feeAdjOf(ctx.feeTenths, markets.data.fee.builderBps)).bp : null;
  return (
    <>
      <BotsHead
        view={view}
        lead={<>{back}<BotAvatar symbol={v.algo.spec.symbol} strategy={strategy} size={48} /></>}
        title={<span className="bots-dhead">{botName(v)}<StatePill s={botState(v)} />{v.algo.spec.paper && <StatusPill tone="brand" size="md">Practice</StatusPill>}</span>}
        sub={
          <span className="bots-chips">
            <span className="bots-chipx"><BotIcon strategy={strategy} size={12} />{STRATEGY_INFO[strategy].name}</span>
            <span className="bots-chipx">{v.algo.spec.symbol}</span>
            <SpecChips v={v} />
            <span className="bots-chipx"><Icon name="clock" size={12} />since {fmtDateTime(v.algo.startedAt ?? v.algo.createdAt)}</span>
            <span className="bots-chipx is-plain">{statusWords(v)}</span>
          </span>
        }
        actions={<><Controls v={v} ctx={ctx} />{!ended && <Button variant="primary" icon="gear" onClick={() => setTab('settings')}>Edit settings</Button>}</>}
      />

      <Shell className="bots-kpis">
        <div className="bots-kpigrid is-5">
          <StatCard index={0} label="Net PnL" value={fmtPnl(b?.netPnl)} valueTone={pnlTone} trend={trendPnl} trendTone={pnlTone ?? 'neutral'} hint="After fees" />
          <StatCard index={1} label="Volume" value={b ? fmtUsd(b.volume, 0) : DASH} trend={trendVol} hint={b ? `${b.fills.toLocaleString('en-US')} fills · ${Math.round(b.makerShare * 100)}% maker` : undefined} />
          <StatCard index={2} label={<Term t="perMillion">Per $1M</Term>} value={fmtCost(b?.costPerMillion)} valueTone={costTone(b?.costPerMillion)} hint={estBps !== null ? `Estimate ${fmtCost(estBps * 100)}` : undefined} />
          <StatCard index={3} label="Fees paid" value={b ? fmtUsd(b.tradeFees + b.builderFees, 2) : DASH} hint={`SoDEX's and ValueDesk's (yours now ${botFeeWords(ctx.feeTenths)})`} />
          <StatCard index={4} label={<Term t="holding">Holding</Term>} value={!b || ended ? DASH : fmtUsd(b.inventoryUsd, 2)} hint={!b || ended ? (ended ? (b?.leftover ? `${fmtUsd(b.leftover.usd, 2)} ${b.leftover.side} left on SoDEX, under its minimum order: close the rest` : 'Stopped: it manages nothing now') : undefined) : `${b.inventoryUsd > 0.005 ? 'Long' : b.inventoryUsd < -0.005 ? 'Short' : 'Flat'}${matchedWords(b.matchedAt)}`} goal={cap && !ended ? { ratio: Math.min(1, hold / cap), label: `Cap ${fmtUsd(cap, 0)}` } : undefined} />
        </div>
      </Shell>

      <div className="bots-pagetabs">
        <Tabs<Tab>
          label="Bot sections"
          value={tab}
          onChange={setTab}
          tabs={[{ value: 'overview', label: 'Overview' }, { value: 'analysis', label: 'Analysis' }, { value: 'settings', label: 'Settings' }, { value: 'orders', label: 'Orders', count: b?.orders.length ?? 0 }, { value: 'trades', label: 'Trades' }, { value: 'activity', label: 'Activity' }]}
        />
      </div>

      {tab === 'overview' && (
        <div className="bots-dgrid">
          <div className="bots-dgrid__main">
            <FleetChart bots={[v]} title="Performance" />
            <MarketConditions symbol={v.algo.spec.symbol} initialWindow={runWindow} marks={runMarks} title={`Market conditions on ${v.algo.spec.symbol.replace(/-USD$/i, '')}`} subtitle="Who took makers' quotes and how volatile it was while this bot ran" />
          </div>
          <aside className="bots-dgrid__side">
            {v.algo.spec.kind === 'hedge' && <HedgeLegs v={v} me={ctx.address} />}
            {!ended && <Watchdog v={v} />}
            <LatencyCard ctx={ctx} bot={v.algo.id} practice={v.algo.spec.paper} compact marks={v.algo.startedAt ? [{ t: v.algo.startedAt, label: 'Started' }] : []} />
            {!ended && (
              <Shell className="bots-sidecard is-plain">
                <ShellHeader icon="shield" title="Limits" subtitle="How close it is to each point where it stops" />
                <Panel className="bots-sidepanel"><LimitsProgress v={v} /></Panel>
              </Shell>
            )}
            {!ended && (
              <Shell className="bots-sidecard is-plain">
                <ShellHeader icon="wallet" title="Margin" subtitle="What this bot sets aside of your account" />
                <Panel className="bots-sidepanel"><BotAllocation v={v} ctx={ctx} /></Panel>
              </Shell>
            )}
            {v.algo.spec.kind === 'mm' && (
              <Shell className="bots-sidecard is-plain">
                <ShellHeader icon="compass" title="Your cost here" subtitle={Math.abs(b?.inventory ?? 0) > 0 ? 'So far, open position included at the price now' : 'So far, and who took its quotes'} aside={<Button variant="quiet" onClick={() => goBots({ page: 'savings' })}>Lower it</Button>} />
                <Panel className="bots-sidepanel">
                  <RealCost v={v} />
                </Panel>
              </Shell>
            )}
          </aside>
        </div>
      )}
      {tab === 'analysis' && (
        // Analysis (owner 2026-11-10): the bot's market as it ran (who took quotes, volatility, the bot's start and stop
        // drawn in), how fast its orders reached SoDEX, and what went wrong.
        <div className="bots-analysis">
          <MarketConditions symbol={v.algo.spec.symbol} initialWindow={runWindow} marks={runMarks} title={`Market conditions on ${v.algo.spec.symbol.replace(/-USD$/i, '')}`} subtitle="Who took makers' quotes and how volatile it was while this bot ran" />
          <div className="bots-analysis__row">
            <LatencyCard ctx={ctx} bot={v.algo.id} practice={v.algo.spec.paper} marks={v.algo.startedAt ? [{ t: v.algo.startedAt, label: 'Started' }] : []} />
            <Shell className="bots-detailcard">
              <ShellHeader icon="warning" title="Problems" subtitle="What SoDEX refused and where the bot had to wait" />
              <Panel className="bots-tabpanel"><BotLog {...log} only="problem" /></Panel>
            </Shell>
          </div>
        </div>
      )}
      {tab === 'settings' && (v.algo.spec.kind === 'hedge' ? <HedgeSettings v={v} ctx={ctx} /> : <SettingsTab v={v} ctx={ctx} />)}
      {tab !== 'overview' && tab !== 'settings' && tab !== 'analysis' && (
        <Shell className="bots-detailcard">
          <Panel className="bots-tabpanel" role="tabpanel">
            {tab === 'orders' && <Orders v={v} />}
            {tab === 'trades' && <BotLog {...log} only="fill" />}
            {tab === 'activity' && <BotLog {...log} />}
          </Panel>
        </Shell>
      )}
    </>
  );
}
