/**
 * Bots > one bot, with full control, in the Bots kit: pause / resume, stop (closing what it holds, or keeping it),
 * delete once it has ended, and every setting the executor lets change while it runs, saved with one signature and
 * applied at once. Its figures, chart, orders on the book, trades and log; what Explore estimates the market costs,
 * beside what this bot has cost.
 */
import { useEffect, useMemo, useState } from 'react';
import { FINAL_STATUSES, type AlgoEvent, type AlgoView } from '@copy-engine';
import { DASH, fmtDateTime, fmtTime, fmtUsd } from '../../format';
import { CoinIcon } from '../CoinIcon';
import { SeriesChart } from '../datachart/SeriesChart';
import { useBotEvents } from '../../bots/useBots';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, botFeeWords, draftOfSpec, gridRange, patchOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { botSeries } from './BotSheet';
import { BotSettings } from './BotSettings';
import { Estimate } from './BotNewPage';
import { fmtCost } from './BotsOverview';
import { botName, botState, fmtPnl, statusWords } from './botWords';
import { BotsHead, StatePill, type BotsCtx } from './BotsPage';
import { Button, EmptyState, IconButton, Inset, Panel, ProgressBar, Shell, ShellHeader, Skeleton, StatCard, StatusPill, Tabs, type Tone } from './kit/kit';

type Tab = 'overview' | 'settings' | 'trades' | 'activity';

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

function SettingsTab({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const before = useMemo(() => draftOfSpec(v.algo.spec), [v.algo.spec]);
  const [d, setD] = useState<BotDraft>(before);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setD(before), [before]);
  const ended = botState(v) === 'ended' || botState(v) === 'failed';
  const patch = patchOf(before, d);
  const n = Object.keys(patch).length;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctx.update(v.algo.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (ended) return <EmptyState icon="gear" title="It has ended" description="Its settings no longer change. Start a new bot from New bot." />;
  return (
    <div className="bots-settingsform">
      <p className="bots-fine bots-settings__lede">Every change applies at once: what rests is pulled and placed again as the new settings say. The market{v.algo.spec.kind === 'grid' ? ', the range and the levels' : ' and the Binance lead'} stay what it started with.</p>
      <BotSettings d={d} set={(p) => setD((x) => ({ ...x, ...p }))} running range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={null} liveAllowed={ctx.liveAllowed} />
      {error && <p className="bots-err" role="alert">{error}</p>}
      <div className={`bots-savebar${n ? ' is-dirty' : ''}`}>
        <span>{n ? `${n} change${n === 1 ? '' : 's'}: one wallet signature.` : 'No change yet.'}</span>
        <Button variant="quiet" disabled={!n || busy} onClick={() => setD(before)}>Undo</Button>
        <Button variant="primary" icon="check" loading={busy} disabled={!n} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </div>
  );
}

function Summary({ v }: { v: AlgoView }) {
  const b = v.bot;
  const series = useMemo(() => botSeries(v), [v]);
  const hasData = (v.algo.book?.series.length ?? 0) >= 3;
  return (
    <div className="bots-sum">
      <Panel className="bots-chartpanel">
        {hasData ? <SeriesChart series={series} height={232} daily={false} /> : <EmptyState icon="chart" title="Charting soon" description="The chart starts after its first 15 minutes: volume as bars, net PnL as the line, one point every 5 minutes." />}
      </Panel>
      <div className="bots-sum__two">
        <Panel className="bots-sum__box">
          <h4>Where the money went</h4>
          <Inset className="bots-ledger">
            <div><span>Spread and price</span><b className={b && b.grossPnl > 0 ? 'pos' : b && b.grossPnl < 0 ? 'neg' : ''}>{b ? fmtPnl(b.grossPnl) : DASH}</b></div>
            <div><span>SoDEX trading fees</span><b>{b ? `−${fmtUsd(b.tradeFees, 2)}` : DASH}</b></div>
            <div><span>ValueDesk fee ({botFeeWords()})</span><b>{b ? `−${fmtUsd(b.builderFees, 2)}` : DASH}</b></div>
            <div className="is-total"><span>Net PnL</span><b className={b && b.netPnl > 0.004 ? 'pos' : b && b.netPnl < -0.004 ? 'neg' : ''}>{b ? fmtPnl(b.netPnl) : DASH}</b></div>
          </Inset>
          {b && <p className="bots-fine">{b.fills} fills, {Math.round(b.makerShare * 100)}% resting (maker). Fees are estimated at SoDEX's maker rate and the {botFeeWords()} bot fee; SoDEX's own trades list the exact ones.</p>}
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
            <EmptyState compact icon="list" title={FINAL_STATUSES.has(v.algo.status) ? 'Nothing: it has ended' : b?.closing ? 'Closing what it holds' : 'No order resting right now'} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function Trades({ events }: { events: AlgoEvent[] | null }) {
  const fills = (events ?? []).filter((e) => e.kind === 'fill' && e.price !== null && e.qty !== null);
  if (!events) return <div className="bots-skels"><Skeleton className="bots-skel" /><Skeleton className="bots-skel" /></div>;
  if (!fills.length) return <EmptyState icon="list" title="No fill yet" description="Its orders rest at the best price and fill when the market trades into them." />;
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
              <EmptyState icon="robot" title="No such bot" description={ctx.address ? "It is not one of this wallet's bots, or it was deleted." : 'Connect the wallet it runs for.'} actions={<Button onClick={() => goBots({ page: 'overview' })}>All bots</Button>} />
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
  return (
    <>
      <BotsHead
        view={view}
        lead={<>{back}<span className="tf-tile bots-head__coin"><CoinIcon coin={v.algo.spec.symbol} size={22} /></span></>}
        title={<span className="bots-dhead">{botName(v)}<StatePill s={botState(v)} />{v.algo.spec.paper && <StatusPill tone="brand" size="md">Practice · no real orders</StatusPill>}</span>}
        sub={<span className="bots-dsub"><BotIcon strategy={strategy} size={13} />{v.algo.spec.symbol} · {STRATEGY_INFO[strategy].name}{gate ? ' · market gate on' : ''} · started {fmtDateTime(v.algo.startedAt ?? v.algo.createdAt)} · {statusWords(v)}</span>}
        actions={<Controls v={v} ctx={ctx} />}
      />

      <Shell className="bots-kpis">
        <div className="bots-kpigrid is-5">
          <StatCard index={0} label="Volume" value={b ? fmtUsd(b.volume, 2) : DASH} hint={b ? `${b.fills} fills` : undefined} />
          <StatCard index={1} label="Net PnL" value={fmtPnl(b?.netPnl)} valueTone={pnlTone} hint="After every fee" />
          <StatCard index={2} label="Fees paid" value={b ? fmtUsd(b.tradeFees + b.builderFees, 2) : DASH} hint="SoDEX and ValueDesk" />
          <StatCard index={3} label="Cost per $1M" value={fmtCost(b?.costPerMillion)} valueTone={b?.costPerMillion !== null && b?.costPerMillion !== undefined && b.costPerMillion < 0 ? 'positive' : undefined} hint="What its volume cost, net" />
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
            {tab === 'overview' && <Summary v={v} />}
            {tab === 'settings' && <SettingsTab v={v} ctx={ctx} />}
            {tab === 'trades' && <Panel className="bots-tabpanel"><Trades events={events} /></Panel>}
            {tab === 'activity' && <Panel className="bots-tabpanel"><Activity events={events} error={error} /></Panel>}
          </div>
        </Shell>
        {v.algo.spec.kind === 'mm' && (
          <aside className="bots-newside">
            <Shell className="bots-sidecard">
              <ShellHeader icon="compass" title="This market" subtitle="Explore's estimate against this bot" />
              <Panel className="bots-sidepanel">
                {markets.data ? <Estimate m={est} gate={gate} feeBps={feeBps} /> : markets.error ? <p className="bots-fine">Estimates are not available right now ({markets.error}).</p> : <div className="bots-skels"><Skeleton className="bots-skel is-big" /><Skeleton className="bots-skel" /></div>}
                <Inset className="bots-vs">
                  <span>This bot so far</span>
                  <b className={b?.costPerMillion !== null && b?.costPerMillion !== undefined && b.costPerMillion < 0 ? 'pos' : ''}>{fmtCost(b?.costPerMillion)}</b>
                  <small>per $1M over {b ? fmtUsd(b.volume, 0) : DASH} traded</small>
                  {cap ? <ProgressBar value={hold} max={cap} size="sm" kind="meter" tone={hold / cap > 0.8 ? 'warning' : 'neutral'} label="Holding against its cap" /> : null}
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
