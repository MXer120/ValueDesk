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
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, botFeeWords, draftOfSpec, gridRange, patchOf, specOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { botSeries } from './BotSheet';
import { BotSettings, NameField } from './BotSettings';
import { Estimate, effectiveDraft } from './BotNewPage';
import { LatencyCard, fmtCost } from './BotsOverview';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { BotsHead, StatePill, type BotsCtx } from './BotsPage';
import { Button, EmptyState, Icon, IconButton, Inset, Panel, Shell, ShellHeader, Skeleton, StatCard, StatusPill, Tabs, type Tone } from './kit/kit';

type Tab = 'overview' | 'settings' | 'trades' | 'activity';
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
    ['Stop if it loses', d.maxLossUsd === null ? 'No limit' : fmtUsd(d.maxLossUsd, 2)],
    ['Stop after', d.volumeTargetUsd === null ? 'You stop it' : `${fmtUsd(d.volumeTargetUsd, 0)} traded`],
    ['On stop', d.onStop === 'close' ? 'Close position' : 'Keep it'],
    ['Orders', d.paper ? 'Practice' : 'Real'],
  ];
  return (
    <dl className="bots-review__list is-cols">
      {rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}
    </dl>
  );
}

/** Which restart: the clean one is the default; taking over needs the same market and mode (they do not change here). */
function RestartDialog({ open, onClose, onPick, busy, holds }: { open: boolean; onClose: () => void; onPick: (h: How) => void; busy: boolean; holds: boolean }) {
  const [how, setHow] = useState<How>('clean');
  return (
    <Modal open={open} onClose={onClose} title="Restart with the new settings" size="md" className="tf bots-restart">
      <div className="bots-restart__opts" role="radiogroup" aria-label="How to restart">
        <button type="button" role="radio" aria-checked={how === 'clean'} className={`bots-kind${how === 'clean' ? ' is-on' : ''}`} onClick={() => setHow('clean')}>
          <span className="tf-tile is-positive"><Icon name="shield" size={18} /></span>
          <span className="bots-kind__t">
            <b>Clean restart <StatusPill size="sm" tone="positive">Recommended</StatusPill></b>
            <small>{holds ? 'Closes its position first, then starts fresh.' : 'Stops, then starts fresh.'}</small>
          </span>
          {how === 'clean' && <span className="bots-check" aria-hidden="true"><Icon name="check" size={12} /></span>}
        </button>
        <button type="button" role="radio" aria-checked={how === 'takeover'} className={`bots-kind${how === 'takeover' ? ' is-on' : ''}`} onClick={() => setHow('takeover')}>
          <span className="tf-tile is-warning"><Icon name="bolt" size={18} /></span>
          <span className="bots-kind__t">
            <b>Instant restart</b>
            <small>{holds ? 'Starts now and takes over its position.' : 'Starts now, no pause.'}</small>
          </span>
          {how === 'takeover' && <span className="bots-check" aria-hidden="true"><Icon name="check" size={12} /></span>}
        </button>
      </div>
      <div className="bots-restart__act">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="play" loading={busy} onClick={() => onPick(how)}>{how === 'clean' ? 'Clean restart' : 'Instant restart'}</Button>
      </div>
    </Modal>
  );
}

function SettingsTab({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const before = useMemo(() => draftOfSpec(v.algo.spec), [v.algo.spec]);
  const [d, setD] = useState<BotDraft>(before);
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markets = useBotMarkets('24h');
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  useEffect(() => { if (!editing) setD(before); }, [before, editing]);
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  const patch = patchOf(before, d);
  const n = Object.keys(patch).length + (d.label !== before.label ? 0 : 0);
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      setEditing(false);
      setAsk(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <Panel className="bots-tabpanel bots-setview">
        <SettingsView d={before} />
        {!ended && <div className="bots-setview__act"><Button variant="secondary" icon="gear" onClick={() => setEditing(true)}>Change settings</Button></div>}
      </Panel>
    );
  }
  return (
    <div className="bots-settingsform">
      <Panel className="bots-sizepanel">
        <BotSettings d={d} set={(p) => setD((x) => ({ ...x, ...p }))} range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={null} liveAllowed={ctx.liveAllowed} hidePractice noLead={est?.lead === null} />
        <NameField d={d} set={(p) => setD((x) => ({ ...x, ...p }))} />
      </Panel>
      {error && <p className="bots-err" role="alert">{error}</p>}
      <div className={`bots-savebar${n ? ' is-dirty' : ''}`}>
        <span>{n ? `${n} change${n === 1 ? '' : 's'}` : 'No change yet'}</span>
        <Button variant="quiet" disabled={busy} onClick={() => { setD(before); setEditing(false); }}>Cancel</Button>
        {ctx.canRestart
          ? <Button variant="primary" icon="play" disabled={!n || busy} onClick={() => setAsk(true)}>Restart with changes</Button>
          : <Button variant="primary" icon="check" loading={busy} disabled={!n} onClick={() => void run(() => ctx.update(v.algo.id, patch))}>Save changes</Button>}
      </div>
      <RestartDialog open={ask} onClose={() => setAsk(false)} busy={busy} holds={holds} onPick={(how) => void run(() => ctx.restart(v, specOf(effectiveDraft({ ...d, paper: v.algo.spec.paper }, est), null), how))} />
    </div>
  );
}

function Summary({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const b = v.bot;
  const series = useMemo(() => botSeries(v), [v]);
  const hasData = (v.algo.book?.series.length ?? 0) >= 3;
  return (
    <div className="bots-sum">
      <div className="bots-sum__two">
        <Panel className="bots-chartpanel">
          <p className="bots-sum__k">Volume and net PnL</p>
          {hasData ? <SeriesChart series={series} height={232} daily={false} /> : <EmptyState icon="chart" title="Charting soon" description="Starts after 15 minutes." />}
        </Panel>
        <LatencyCard ctx={ctx} bot={v.algo.id} practice={v.algo.spec.paper} marks={v.algo.startedAt ? [{ t: v.algo.startedAt, label: 'Started' }] : []} />
      </div>
      <div className="bots-sum__two">
        <Panel className="bots-sum__box">
          <h4>Where the money went</h4>
          <Inset className="bots-ledger">
            <div><span>Spread and price</span><b className={b && b.grossPnl > 0 ? 'pos' : b && b.grossPnl < 0 ? 'neg' : ''}>{b ? fmtPnl(b.grossPnl) : DASH}</b></div>
            <div><span>SoDEX fees</span><b>{b ? `−${fmtUsd(b.tradeFees, 2)}` : DASH}</b></div>
            <div><span>ValueDesk fee ({botFeeWords()})</span><b>{b ? `−${fmtUsd(b.builderFees, 2)}` : DASH}</b></div>
            <div className="is-total"><span>Net PnL</span><b className={b && b.netPnl > 0.004 ? 'pos' : b && b.netPnl < -0.004 ? 'neg' : ''}>{b ? fmtPnl(b.netPnl) : DASH}</b></div>
          </Inset>
          {b && <p className="bots-fine">{b.fills} fills · {Math.round(b.makerShare * 100)}% maker</p>}
        </Panel>
        <Panel className="bots-sum__box">
          <h4>On the book now</h4>
          {b && b.orders.length ? (
            <table className="bots-table is-mini">
              <thead><tr><th>Side</th><th className="right">Price</th><th className="right">Size</th></tr></thead>
              <tbody>
                {[...b.orders].sort((x, y) => y.price - x.price).slice(0, 12).map((o) => (
                  <tr key={`${o.tag}-${o.price}`}>
                    <td><StatusPill size="sm" tone={o.side === 'buy' ? 'positive' : 'negative'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</StatusPill></td>
                    <td className="right num">{fmtUsd(o.price)}</td>
                    <td className="right num">{o.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState compact icon="list" title={FINAL_STATUSES.has(v.algo.status) ? 'Ended' : b?.closing ? 'Closing its position' : 'Nothing resting now'} />
          )}
        </Panel>
      </div>
    </div>
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
  const [tab, setTab] = useState<Tab>('overview');
  const { events, error } = useBotEvents(id, !!v && (tab === 'trades' || tab === 'activity'));
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
  return (
    <>
      <BotsHead
        view={view}
        lead={<>{back}<span className="tf-tile bots-head__coin"><CoinIcon coin={v.algo.spec.symbol} size={22} /></span></>}
        title={<span className="bots-dhead">{botName(v)}<StatePill s={botState(v)} />{v.algo.spec.paper && <StatusPill tone="brand" size="md">Practice</StatusPill>}</span>}
        sub={<span className="bots-dsub"><BotIcon strategy={strategy} size={13} />{v.algo.spec.symbol} · {STRATEGY_INFO[strategy].name}{gate ? ' · gate' : ''} · since {fmtDateTime(v.algo.startedAt ?? v.algo.createdAt)} · {statusWords(v)}</span>}
        actions={<Controls v={v} ctx={ctx} />}
      />

      <Shell className="bots-kpis">
        <div className="bots-kpigrid is-5">
          <StatCard index={0} label="Volume" value={b ? fmtUsd(b.volume, 2) : DASH} trend={trendVol} hint={b ? `${b.fills} fills` : undefined} />
          <StatCard index={1} label="Net PnL" value={fmtPnl(b?.netPnl)} valueTone={pnlTone} trend={trendPnl} trendTone={pnlTone ?? 'neutral'} hint="After fees" />
          <StatCard index={2} label="Fees paid" value={b ? fmtUsd(b.tradeFees + b.builderFees, 2) : DASH} />
          <StatCard index={3} label="Cost per $1M" value={fmtCost(b?.costPerMillion)} valueTone={b?.costPerMillion !== null && b?.costPerMillion !== undefined && b.costPerMillion < 0 ? 'positive' : undefined} hint={est ? `Estimate ${fmtCost((gate && est.gateCostBps !== null ? est.gateCostBps : est.estCostBps) * 100)}` : undefined} />
          <StatCard index={4} label="Holding" value={b ? fmtUsd(b.inventoryUsd, 2) : DASH} goal={cap ? { ratio: Math.min(1, hold / cap), label: `Cap ${fmtUsd(cap, 0)}` } : undefined} />
        </div>
      </Shell>

      <div className={`bots-detailgrid${v.algo.spec.kind === 'mm' ? '' : ' is-one'}`}>
        <Shell className="bots-detailcard">
          <div className="bots-tabsbar">
            <Tabs<Tab>
              label="Bot sections"
              value={tab}
              onChange={setTab}
              tabs={[{ value: 'overview', label: 'Summary' }, { value: 'settings', label: 'Settings' }, { value: 'trades', label: 'Trades' }, { value: 'activity', label: 'Activity' }]}
            />
          </div>
          <div className="bots-tabbody" role="tabpanel">
            {tab === 'overview' && <Summary v={v} ctx={ctx} />}
            {tab === 'settings' && <SettingsTab v={v} ctx={ctx} />}
            {tab === 'trades' && <Panel className="bots-tabpanel"><Trades events={events} /></Panel>}
            {tab === 'activity' && <Panel className="bots-tabpanel"><Activity events={events} error={error} /></Panel>}
          </div>
        </Shell>
        {v.algo.spec.kind === 'mm' && (
          <aside className="bots-newside">
            <Shell className="bots-sidecard">
              <ShellHeader icon="compass" title="This market" subtitle="Estimate vs this bot" />
              <Panel className="bots-sidepanel">
                {markets.data ? <Estimate m={est} gate={gate} feeBps={feeBps} compact /> : markets.error ? <p className="bots-fine">Estimates unavailable.</p> : <div className="bots-skels"><Skeleton className="bots-skel is-big" /></div>}
                <Inset className="bots-vs">
                  <span>This bot</span>
                  <b className={b?.costPerMillion !== null && b?.costPerMillion !== undefined && b.costPerMillion < 0 ? 'pos' : ''}>{fmtCost(b?.costPerMillion)}</b>
                  <small>per $1M over {b ? fmtUsd(b.volume, 0) : DASH}</small>
                </Inset>
                <Button variant="quiet" className="bots-start" onClick={() => goBots({ page: 'savings' })}>Ways to lower it</Button>
              </Panel>
            </Shell>
          </aside>
        )}
      </div>
    </>
  );
}
