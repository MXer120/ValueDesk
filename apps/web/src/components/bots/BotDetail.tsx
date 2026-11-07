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
import { Modal } from '../Modal';
import { SeriesChart } from '../datachart/SeriesChart';
import { useBotEvents } from '../../bots/useBots';
import { demoEvents } from '../../bots/demo';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, botFeeWords, draftOfSpec, gridRange, specChanges, specOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { botSeries } from './BotSheet';
import { BotSettings, NameField } from './BotSettings';
import { Estimate, effectiveDraft } from './BotNewPage';
import { FleetChart, LatencyCard, costTone, fmtCost } from './BotsOverview';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { BotsHead, StatePill, type BotsCtx } from './BotsPage';
import { Button, EmptyState, Icon, IconButton, Inset, Panel, Shell, ShellHeader, Skeleton, StatCard, StatusPill, Tabs, type Tone } from './kit/kit';

type Tab = 'orders' | 'trades' | 'activity';
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
      {!ended && holds && st !== 'closing' && <Button variant="secondary" disabled={busy} onClick={() => void ctx.stop(v, 'keep')}>Stop, keep position</Button>}
      {!ended && <Button variant="danger" icon="stop" disabled={busy} onClick={() => void (holds && st !== 'closing' ? ctx.stop(v, 'close') : ctx.stop(v))}>{st === 'closing' ? 'Stop now' : holds ? 'Stop and close' : 'Stop'}</Button>}
      {ended && <Button variant="danger" icon="trash" disabled={busy} onClick={() => void ctx.remove(v)}>Delete</Button>}
    </>
  );
}

/** The settings as they run, read-only: one line each. */
function SettingsView({ d }: { d: BotDraft }) {
  const rows: Array<[string, string]> = [
    ['Order size', d.strategy === 'grid' ? `${fmtUsd(d.orderUsd, 0)} × ${d.levels} levels` : `${fmtUsd(d.orderUsd, 0)} each side`],
    ...(d.strategy !== 'grid' ? [['Max holding', fmtUsd(d.maxInventoryUsd, 0)] as [string, string]] : []),
    ...(d.strategy === 'grid' ? [['Range', `${d.low ?? DASH} – ${d.high ?? DASH}`] as [string, string]] : []),
    ...(d.strategy === 'market' ? [['Market gate', d.gate ? `On · ${d.gateBps} bp in ${d.gateWindowS} s` : 'Off'] as [string, string], ['Longest rest', `${d.restS} s`] as [string, string]] : []),
    ...(d.strategy !== 'grid' ? [['Quote at', d.offsetTicks < 0 ? '1 tick inside' : 'Best price'] as [string, string]] : []),
    ...(d.strategy === 'market' ? [['Pause if spread over', d.maxSpreadBps === null ? 'Off' : `${d.maxSpreadBps} bp`] as [string, string]] : []),
    ...(d.strategy !== 'grid' ? [['Flow gate', d.flowOn ? `${d.flowAction === 'pause' ? 'Pause' : `${Math.round(d.flowShrink * 100)}% size`} under ${fmtUsd(d.flowMinUsd, 0)} / ${d.flowWindowMin} min` : 'Off'] as [string, string]] : []),
    ['Quiet hours', d.quiet.length ? d.quiet.map((w) => `${w.from}–${w.to} ${w.zone === 'new_york' ? 'NY' : w.zone === 'london' ? 'LDN' : 'UTC'}`).join(', ') : 'Off'],
    ...(d.ladder > 1 ? [['Levels per side', String(d.ladder)] as [string, string]] : []),
    ['Stop if it loses', d.maxLossUsd === null ? 'No limit' : fmtUsd(d.maxLossUsd, 2)],
    ['Stop after', d.volumeTargetUsd === null ? 'You stop it' : `${fmtUsd(d.volumeTargetUsd, 0)} traded`],
    ['On stop', d.onStop === 'close' ? 'Close position' : 'Keep it'],
    ['Orders', d.paper ? 'Practice' : 'Real'],
  ];
  return (
    <dl className="bots-review__list">
      {rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}
    </dl>
  );
}

/** Edit settings: the form, then how the new settings take over (owner: changing needs a restart; clean recommended). */
function EditSettings({ v, ctx, open, onClose }: { v: AlgoView; ctx: BotsCtx; open: boolean; onClose: () => void }) {
  const before = useMemo(() => draftOfSpec(v.algo.spec), [v.algo.spec]);
  const [d, setD] = useState<BotDraft>(before);
  const [how, setHow] = useState<How>('clean');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markets = useBotMarkets('24h', open);
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  // Reset when it opens only: the list refreshes every few seconds with a new spec object, which must not wipe the edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setD(before); setHow('clean'); setError(null); } }, [open]);
  const n = specChanges(before, d).length;
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctx.restart(v, specOf(effectiveDraft({ ...d, paper: v.algo.spec.paper }, est), null), how);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const opt = (h: How, icon: 'shield' | 'bolt', tone: Tone, title: string, line: string, pill?: string) => (
    <button type="button" role="radio" aria-checked={how === h} className={`bots-kind bots-rmode${how === h ? ' is-on' : ''}`} onClick={() => setHow(h)}>
      <span className={`tf-tile is-${tone}`}><Icon name={icon} size={18} /></span>
      <span className="bots-kind__t">
        <b>{title}{pill && <StatusPill size="sm" tone="positive">{pill}</StatusPill>}</b>
        <small>{line}</small>
      </span>
      {how === h && <span className="bots-check" aria-hidden="true"><Icon name="check" size={12} /></span>}
    </button>
  );
  const footer = (
    <div className="tf bots-edit__foot">
      <span className={n ? 'is-dirty' : ''}>{n ? `${n} change${n === 1 ? '' : 's'}` : 'No change yet'}</span>
      <Button variant="quiet" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="play" loading={busy} disabled={!n} onClick={() => void restart()}>{how === 'clean' ? 'Clean restart' : 'Instant restart'}</Button>
    </div>
  );
  return (
    <Modal open={open} onClose={onClose} title="Edit settings" size="lg" className="tf bots-edit" footer={footer}>
      <div className="bots-edit__body">
        <BotSettings d={d} set={(p) => setD((x) => ({ ...x, ...p }))} range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={v.bot?.mark ?? null} liveAllowed={ctx.liveAllowed} hidePractice noLead={est?.lead === null} />
        <NameField d={d} set={(p) => setD((x) => ({ ...x, ...p }))} />
        <section className="bots-edit__restart">
          <p className="bots-edit__k">New settings apply by a restart</p>
          <div className="bots-edit__modes" role="radiogroup" aria-label="How to restart">
            {opt('clean', 'shield', 'positive', 'Clean restart', holds ? 'Closes its position, then starts fresh.' : 'Stops, then starts fresh.', 'Recommended')}
            {opt('takeover', 'bolt', 'warning', 'Instant restart', holds ? 'Starts now and keeps its position.' : 'Starts now, no pause.')}
          </div>
        </section>
        {error && <p className="bots-err" role="alert">{error}</p>}
      </div>
    </Modal>
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

function Trades({ events }: { events: AlgoEvent[] | null }) {
  const fills = (events ?? []).filter((e) => e.kind === 'fill' && e.price !== null && e.qty !== null);
  if (!events) return <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div>;
  if (!fills.length) return <EmptyState icon="list" title="No fill yet" />;
  return (
    <div className="bots-tablewrap">
      <table className="bots-table">
        <thead><tr><th>Time</th><th>Side</th><th className="right">Price</th><th className="right">Size</th><th className="right">Value</th></tr></thead>
        <tbody>
          {fills.map((e) => (
            <tr key={e.id}>
              <td className="dim num">{fmtDateTime(e.at)}</td>
              <td><StatusPill size="sm" tone={e.side === 'sell' ? 'negative' : 'positive'}>{e.side === 'sell' ? 'Sell' : 'Buy'}</StatusPill></td>
              <td className="right num">{fmtUsd(e.price!)}</td>
              <td className="right num">{e.qty}</td>
              <td className="right num">{fmtUsd(e.price! * e.qty!, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KIND: Record<AlgoEvent['kind'], { word: string; tone: Tone }> = {
  status: { word: 'Status', tone: 'brand' },
  order: { word: 'Order', tone: 'neutral' },
  fill: { word: 'Fill', tone: 'positive' },
  cancel: { word: 'Cancel', tone: 'neutral' },
  skip: { word: 'Skip', tone: 'warning' },
  error: { word: 'Error', tone: 'negative' },
  info: { word: 'Info', tone: 'neutral' },
};

function Activity({ events, error }: { events: AlgoEvent[] | null; error: string | null }) {
  if (error && !events) return <EmptyState tone="error" icon="warning" title="The log could not be read" description={error} />;
  if (!events) return <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div>;
  if (!events.length) return <EmptyState icon="clock" title="Nothing yet" />;
  return (
    <ol className="bots-log">
      {events.map((e) => (
        <li key={e.id}>
          <time>{fmtTime(e.at)}</time>
          <StatusPill size="sm" tone={KIND[e.kind].tone}>{KIND[e.kind].word}</StatusPill>
          <span className="bots-logt">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function BotDetail({ ctx, view, id }: { ctx: BotsCtx; view: BotsView; id: string }) {
  const v = ctx.bots.find((x) => x.algo.id === id) ?? null;
  const [tab, setTab] = useState<Tab>('orders');
  const [editing, setEditing] = useState(false);
  const realEv = useBotEvents(id, !!v && !ctx.demo && (tab === 'trades' || tab === 'activity'));
  const demoEv = useMemo(() => (ctx.demo && v ? demoEvents(v) : null), [ctx.demo, v]);
  const events = demoEv ?? realEv.events;
  const error = demoEv ? null : realEv.error;
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
        lead={<>{back}<span className="bots-head__coin"><CoinIcon coin={v.algo.spec.symbol} size={40} /></span></>}
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
        actions={<><Controls v={v} ctx={ctx} />{!ended && <Button variant="primary" icon="gear" onClick={() => setEditing(true)}>Edit settings</Button>}</>}
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

      <div className="bots-dgrid">
        <div className="bots-dgrid__main">
          <FleetChart bots={[v]} title="Performance" />
          <Shell className="bots-detailcard">
            <div className="bots-tabsbar">
              <Tabs<Tab>
                label="Bot sections"
                value={tab}
                onChange={setTab}
                tabs={[{ value: 'orders', label: 'Orders', count: b?.orders.length ?? 0 }, { value: 'trades', label: 'Trades' }, { value: 'activity', label: 'Activity' }]}
              />
            </div>
            <Panel className="bots-tabpanel" role="tabpanel">
              {tab === 'orders' && <Orders v={v} />}
              {tab === 'trades' && <Trades events={events} />}
              {tab === 'activity' && <Activity events={events} error={error} />}
            </Panel>
          </Shell>
        </div>
        <aside className="bots-dgrid__side">
          <Shell className="bots-setcard">
            <ShellHeader icon="gear" title="Settings" subtitle={ended ? 'As it ran' : 'Changes apply by a restart'} aside={!ended && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>} />
            <Panel className="bots-setview"><SettingsView d={draftOfSpec(v.algo.spec)} /></Panel>
          </Shell>
          <LatencyCard ctx={ctx} bot={v.algo.id} practice={v.algo.spec.paper} compact marks={v.algo.startedAt ? [{ t: v.algo.startedAt, label: 'Started' }] : []} />
          {v.algo.spec.kind === 'mm' && (
            <Shell className="bots-sidecard">
              <ShellHeader icon="compass" title="This market" subtitle="Estimate against this bot" aside={<Button variant="quiet" onClick={() => goBots({ page: 'savings' })}>Lower it</Button>} />
              <Panel className="bots-sidepanel">
                {markets.data ? <Estimate m={est} gate={gate} feeBps={feeBps} compact /> : markets.error ? <p className="bots-fine">Estimates unavailable.</p> : <div className="bots-skels"><Skeleton className="bots-skel is-big" /></div>}
              </Panel>
            </Shell>
          )}
        </aside>
      </div>
      {!ended && <EditSettings v={v} ctx={ctx} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
