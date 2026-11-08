/**
 * Bots > one bot: its figures, its own latency to SoDEX, its chart, orders, trades and log; its settings, and a
 * change of settings by restart (owner 2026-11-07):
 *
 *   Clean restart (recommended)  the bot stops and closes what it holds; the new one starts flat once it has
 *   Instant restart              the new one starts at once and takes over what the old one holds (same market)
 *
 * One wallet signature either way (executor feature 'bot-restart'). An executor without it applies the changes in
 * place, as before. Pause, resume, stop and delete stay in the header.
 */
import { useEffect, useMemo, useState } from 'react';
import { FINAL_STATUSES, type AlgoEvent, type AlgoView } from '@copy-engine';
import { DASH, fmtDateTime, fmtTime, fmtUsd } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { SeriesChart } from '../datachart/SeriesChart';
import { useBotLog } from '../../bots/useBots';
import { BotLog } from './BotLog';
import { demoEvents } from '../../bots/demo';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, botFeeWords, draftOfSpec, gridRange, specChanges, specOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotAvatar, BotIcon } from './BotIcon';
import { botSeries } from './BotSheet';
import { BotSettings, NameField } from './BotSettings';
import { StopMenu } from './StopMenu';
import { BotAllocation } from './Allocation';
import { TAKER_COLORS, effectiveDraft, fmtBpUsd } from './BotNewPage';
import { estimate, ownRuns } from '../../bots/estimate';
import { FleetChart, LatencyCard, costTone, fmtCost } from './BotsOverview';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { BotsHead, StatePill, type BotsCtx } from './BotsPage';
import { Button, EmptyState, Icon, IconButton, Inset, Panel, RollingNumber, SegmentedBar, Shell, ShellHeader, Skeleton, StatCard, StatusPill, Tabs, type Tone } from './kit/kit';

type Tab = 'overview' | 'settings' | 'orders' | 'trades' | 'activity';
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
      {ended && <Button variant="danger" icon="trash" disabled={busy} onClick={() => void ctx.remove(v)}>Delete</Button>}
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
  const [busy, setBusy] = useState<How | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markets = useBotMarkets('24h');
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  const changes = specChanges(before, d);
  const n = changes.length;
  // A list refresh brings a new spec object every few seconds: only pick it up while nothing is being edited.
  useEffect(() => { if (!n) setD(before); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [before]);
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  const restart = async (how: How) => {
    setBusy(how);
    setError(null);
    try {
      await ctx.restart(v, specOf(effectiveDraft({ ...d, paper: v.algo.spec.paper }, est), null), how);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="bots-settingspage">
      <Shell className="bots-stgshell">
        <ShellHeader icon="gear" title="Settings" subtitle={ended ? 'As it ran. Start a new bot to change them.' : 'Change anything, then restart to apply.'} aside={n ? <Button variant="quiet" onClick={() => setD(before)}>Undo changes</Button> : undefined} />
        <Panel className="bots-sizepanel">
          <fieldset className="bots-fieldset" disabled={ended}>
            <BotSettings d={d} set={(p) => setD((x) => ({ ...x, ...p }))} range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={v.bot?.mark ?? null} liveAllowed={ctx.liveAllowed} hidePractice noLead={est?.lead === null} />
            <NameField d={d} set={(p) => setD((x) => ({ ...x, ...p }))} />
          </fieldset>
        </Panel>
      </Shell>
      {error && <p className="bots-err" role="alert">{error}</p>}
      {!ended && (
        <div className={`bots-restartbar${n ? ' is-dirty' : ''}`}>
          <span className="bots-restartbar__t">
            <b>{n ? `${n} change${n === 1 ? '' : 's'}` : 'No change yet'}</b>
            <small>{n ? 'A restart applies them.' : 'Edit any setting above.'}</small>
          </span>
          <Button variant="secondary" icon="bolt" disabled={!n || busy !== null} loading={busy === 'takeover'} onClick={() => void restart('takeover')} title={holds ? 'Starts now and keeps its position.' : 'Starts now.'}>Instant restart</Button>
          <Button variant="go" icon="shield" disabled={!n || busy !== null} loading={busy === 'clean'} onClick={() => void restart('clean')} title={holds ? 'Closes its position, then starts fresh.' : 'Stops, then starts fresh.'}>Clean restart<span className="bots-rec">Recommended</span></Button>
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
function RealCost({ v, estBp }: { v: AlgoView; estBp: number | null }) {
  const b = v.bot;
  const t = b?.takers;
  const sum = t ? t.t1002 + t.t23342 + t.other : 0;
  const cost = b?.costPerMillion ?? null;
  return (
    <div className="bots-est">
      <div className="bots-est__big">
        <span className="bots-est__k">Per $1M, this bot{b ? ` · ${fmtUsd(b.volume, 0)} traded` : ''}</span>
        <RollingNumber value={cost === null ? DASH : fmtCost(cost)} className={`bots-est__v ${cost === null ? '' : cost < 0 ? 'pos' : 'neg'}`} />
        <span className="bots-est__sub">{estBp !== null ? <>Estimate for this market {fmtBpUsd(estBp)}</> : 'No estimate for this market'}</span>
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
          <small className="bots-fine">Of {fmtUsd(sum, 0)} its quotes filled.</small>
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
            <td className="right num">{fmtUsd(o.price)}</td>
            <td className="right num">{o.quantity}</td>
            <td className="right num">{fmtUsd(o.price * o.quantity, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BotDetail({ ctx, view, id }: { ctx: BotsCtx; view: BotsView; id: string }) {
  const v = ctx.bots.find((x) => x.algo.id === id) ?? null;
  const [tab, setTab] = useState<Tab>('overview');
  const realEv = useBotLog(id, !!v && !ctx.demo && (tab === 'trades' || tab === 'activity'));
  const demoEv = useMemo(() => (ctx.demo && v ? demoEvents(v) : null), [ctx.demo, v]);
  const log = demoEv ? { events: demoEv, error: null, more: false, loading: false, loadMore: () => undefined } : realEv;
  const markets = useBotMarkets('24h', !!v && v.algo.spec.kind === 'mm');
  const back = <IconButton icon="arrowLeft" label="All bots" variant="secondary" onClick={() => goBots({ page: 'overview' })} />;
  if (!v) {
    return (
      <>
        <BotsHead view={view} title="Bot" lead={back} />
        <Shell>
          <Panel>
            {ctx.loading ? <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div> : (
              <EmptyState icon="robot" title="No such bot" description={ctx.address ? 'Not one of your bots, or deleted.' : 'Connect the wallet it runs for.'} actions={<Button onClick={() => goBots({ page: 'overview' })}>All bots</Button>} />
            )}
          </Panel>
        </Shell>
      </>
    );
  }
  const strategy = strategyOf(v.algo.spec) ?? 'maker';
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  const gate = v.algo.spec.kind === 'mm' && (v.algo.spec.stillBps ?? 0) > 0;
  const feeBps = (markets.data?.fee.makerBps ?? 1.2) + ctx.feeTenths / 10;
  const b = v.bot;
  const cap = v.algo.spec.kind === 'mm' ? v.algo.spec.maxInventoryUsd : null;
  const hold = Math.abs(b?.inventoryUsd ?? 0);
  const pnlTone = b && b.netPnl > 0.004 ? 'positive' : b && b.netPnl < -0.004 ? 'negative' : undefined;
  const trendPnl = (v.algo.book?.series ?? []).map((p) => p[2]);
  const trendVol = (v.algo.book?.series ?? []).map((p) => p[1]);
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  const estBps = est ? (gate && est.gateCostBps !== null ? est.gateCostBps : est.estCostBps) : null;
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
            {gate && <span className="bots-chipx">Gate on</span>}
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
          <StatCard index={2} label="Per $1M" value={fmtCost(b?.costPerMillion)} valueTone={costTone(b?.costPerMillion)} hint={estBps !== null ? `Estimate ${fmtCost(estBps * 100)}` : undefined} />
          <StatCard index={3} label="Fees paid" value={b ? fmtUsd(b.tradeFees + b.builderFees, 2) : DASH} hint={`incl. ${botFeeWords()} ValueDesk`} />
          <StatCard index={4} label="Holding" value={b ? fmtUsd(b.inventoryUsd, 2) : DASH} goal={cap ? { ratio: Math.min(1, hold / cap), label: `Cap ${fmtUsd(cap, 0)}` } : undefined} />
        </div>
      </Shell>

      <div className="bots-pagetabs">
        <Tabs<Tab>
          label="Bot sections"
          value={tab}
          onChange={setTab}
          tabs={[{ value: 'overview', label: 'Overview' }, { value: 'settings', label: 'Settings' }, { value: 'orders', label: 'Orders', count: b?.orders.length ?? 0 }, { value: 'trades', label: 'Trades' }, { value: 'activity', label: 'Activity' }]}
        />
      </div>

      {tab === 'overview' && (
        <div className="bots-dgrid">
          <div className="bots-dgrid__main">
            <FleetChart bots={[v]} title="Performance" />
          </div>
          <aside className="bots-dgrid__side">
            <LatencyCard ctx={ctx} bot={v.algo.id} practice={v.algo.spec.paper} compact marks={v.algo.startedAt ? [{ t: v.algo.startedAt, label: 'Started' }] : []} />
            {!ended && (
              <Shell className="bots-sidecard is-plain">
                <ShellHeader icon="wallet" title="Margin" subtitle="What this bot sets aside of your account" />
                <Panel className="bots-sidepanel"><BotAllocation v={v} ctx={ctx} /></Panel>
              </Shell>
            )}
            {v.algo.spec.kind === 'mm' && (
              <Shell className="bots-sidecard is-plain">
                <ShellHeader icon="compass" title="Your cost here" subtitle="What this bot really paid, and who took its quotes" aside={<Button variant="quiet" onClick={() => goBots({ page: 'savings' })}>Lower it</Button>} />
                <Panel className="bots-sidepanel">
                  <RealCost v={v} estBp={markets.data ? estimate(effectiveDraft(draftOfSpec(v.algo.spec), est), est, ownRuns(ctx.bots, markets.data.markets)).bp : null} />
                </Panel>
              </Shell>
            )}
          </aside>
        </div>
      )}
      {tab === 'settings' && <SettingsTab v={v} ctx={ctx} />}
      {tab !== 'overview' && tab !== 'settings' && (
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
