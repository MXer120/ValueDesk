/**
 * Bots > one bot, with full control: pause / resume, stop (closing what it holds, or keeping it), delete once it
 * has ended, and every setting the executor lets change while it runs, saved with one signature and applied at
 * once. Its figures, chart, orders on the book, trades and log; what Explore estimates the market costs, to compare.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AlgoView } from '@copy-engine';
import { DASH, fmtDateTime, fmtUsd } from '../../format';
import { Card } from '../portfolio/parts';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { useBotEvents } from '../../bots/useBots';
import { useBotMarkets } from '../../bots/data';
import { goBots, type BotsView } from '../../bots/routes';
import { STRATEGY_INFO, draftOfSpec, gridRange, patchOf, strategyOf, type BotDraft } from '../../bots/presets';
import { BotIcon } from './BotIcon';
import { Activity, Overview, Trades } from './BotSheet';
import { BotSettings } from './BotSettings';
import { Estimate } from './BotNewPage';
import { StatePill } from './BotsOverview';
import { botName, botState, statusWords } from './botWords';
import { BotsHead, type BotsCtx } from './BotsPage';

type Tab = 'overview' | 'settings' | 'trades' | 'activity';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Summary' },
  { id: 'settings', label: 'Settings' },
  { id: 'trades', label: 'Trades' },
  { id: 'activity', label: 'Activity' },
];

function Controls({ v, ctx }: { v: AlgoView; ctx: BotsCtx }) {
  const st = botState(v);
  const ended = st === 'ended' || st === 'failed';
  const busy = ctx.busy === v.algo.id;
  const holds = Math.abs(v.bot?.inventory ?? 0) > 0;
  return (
    <span className="bots-ctl">
      {!ended && st !== 'closing' && (st === 'paused'
        ? <button type="button" className="pf-btn" disabled={busy} onClick={() => void ctx.resume(v)}>Resume</button>
        : <button type="button" className="pf-btn" disabled={busy} onClick={() => void ctx.pause(v)}>Pause</button>)}
      {!ended && holds && st !== 'closing' && <button type="button" className="pf-btn" disabled={busy} onClick={() => void ctx.stop(v, 'keep')}>Stop, keep position</button>}
      {!ended && <button type="button" className="pf-btn bots-danger" disabled={busy} onClick={() => void (holds && st !== 'closing' ? ctx.stop(v, 'close') : ctx.stop(v))}>{st === 'closing' ? 'Stop now' : holds ? 'Stop and close' : 'Stop'}</button>}
      {ended && <button type="button" className="pf-btn bots-danger" disabled={busy} onClick={() => void ctx.remove(v)}>Delete</button>}
    </span>
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
  const changed = Object.keys(patch).length > 0;
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
  if (ended) return <p className="oe-hint">It has ended: its settings no longer change. Start a new bot from New bot.</p>;
  return (
    <div className="dlg bots-settingsform">
      <p className="bots-sub">Every change applies at once: what rests is pulled and placed again as the new settings say. The market{v.algo.spec.kind === 'grid' ? ', the range and the levels' : ' and the Binance lead'} stay what it started with.</p>
      <BotSettings d={d} set={(p) => setD((x) => ({ ...x, ...p }))} running range={d.strategy === 'grid' ? gridRange(d, null) : null} mark={null} liveAllowed={ctx.liveAllowed} />
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <div className="bots-savebar">
        <span>{changed ? `${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? '' : 's'}: one wallet signature.` : 'No change yet.'}</span>
        <button type="button" className="pf-btn" disabled={!changed || busy} onClick={() => setD(before)}>Undo</button>
        <button type="button" className="pf-btn pf-btn--primary" disabled={!changed || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

export function BotDetail({ ctx, view, id }: { ctx: BotsCtx; view: BotsView; id: string }) {
  const v = ctx.bots.find((x) => x.algo.id === id) ?? null;
  const [tab, setTab] = useState<Tab>('overview');
  const { events, error } = useBotEvents(id, !!v && (tab === 'trades' || tab === 'activity'));
  const markets = useBotMarkets('24h', !!v && v.algo.spec.kind === 'mm');
  if (!v) {
    return (
      <>
        <BotsHead view={view} title="Bot" />
        <Card>
          {ctx.loading ? <div className="bots-skel" aria-hidden="true"><span className="bots-bone" /><span className="bots-bone" /></div> : (
            <EmptyState icon="chart" title="No such bot" line={ctx.address ? 'It is not one of this wallet\'s bots, or it was deleted.' : 'Connect the wallet it runs for.'} action={<button type="button" className="pf-btn" onClick={() => goBots({ page: 'overview' })}>All bots</button>} />
          )}
        </Card>
      </>
    );
  }
  const strategy = strategyOf(v.algo.spec) ?? 'maker';
  const est = markets.data?.markets.find((m) => m.symbol === v.algo.spec.symbol) ?? null;
  const gate = v.algo.spec.kind === 'mm' && (v.algo.spec.stillBps ?? 0) > 0;
  const feeBps = (markets.data?.fee.makerBps ?? 1.2) + ctx.feeTenths / 10;
  const title = (
    <span className="bots-dhead">
      <button type="button" className="bots-back" aria-label="All bots" onClick={() => goBots({ page: 'overview' })}>
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4.5 6.5 10l5.5 5.5" /></svg>
      </button>
      <BotIcon strategy={strategy} size={22} />
      <span>{botName(v)}</span>
      <StatePill s={botState(v)} />
      {v.algo.spec.paper && <span className="algo-practice">Practice · no real orders</span>}
    </span>
  );
  return (
    <>
      <BotsHead
        view={view}
        title={title}
        sub={<><CoinIcon coin={v.algo.spec.symbol} size={14} /> {v.algo.spec.symbol} · {STRATEGY_INFO[strategy].name}{gate ? ' · market gate on' : ''} · started {fmtDateTime(v.algo.startedAt ?? v.algo.createdAt)} · {statusWords(v)}</>}
        actions={<Controls v={v} ctx={ctx} />}
      />
      <div className="bots-detailgrid">
        <Card
          className="bots-detailcard"
          title={
            <nav className="pf-seg" aria-label="Bot sections">
              {TABS.map((t) => (
                <button key={t.id} type="button" className={`pf-ctl${tab === t.id ? ' is-on' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </nav>
          }
        >
          {tab === 'overview' && <Overview v={v} actions={null} />}
          {tab === 'settings' && <SettingsTab v={v} ctx={ctx} />}
          {tab === 'trades' && <Trades events={events} />}
          {tab === 'activity' && <Activity events={events} error={error} />}
        </Card>
        {v.algo.spec.kind === 'mm' && (
          <aside className="bots-newside">
            <Card title="This market" className="bots-sidecard">
              {markets.data ? <Estimate m={est} gate={gate} feeBps={feeBps} /> : <p className="oe-hint">{markets.error ? `Estimates are not available right now (${markets.error}).` : 'Reading the estimate…'}</p>}
              <div className="bots-vs">
                <span>This bot so far</span>
                <b className={v.bot?.costPerMillion !== null && v.bot?.costPerMillion !== undefined && v.bot.costPerMillion < 0 ? 'pos' : ''}>{v.bot?.costPerMillion === null || v.bot?.costPerMillion === undefined ? DASH : v.bot.costPerMillion < 0 ? `earns ${fmtUsd(-v.bot.costPerMillion, 0)}` : fmtUsd(v.bot.costPerMillion, 0)}</b>
                <small>per $1M over {v.bot ? fmtUsd(v.bot.volume, 0) : DASH} traded</small>
              </div>
              <button type="button" className="bots-link" onClick={() => goBots({ page: 'savings' })}>Ways to lower it</button>
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}
