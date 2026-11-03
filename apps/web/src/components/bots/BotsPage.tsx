/**
 * Bots: automated strategies that run on the ValueDesk executor (24/7) in the trader's own SoDEX account -
 * a volume maker and a grid (bots/presets.ts says why these two). Every order rests on the book.
 *
 * Built from the design system's cards (portfolio/parts.tsx: Card, Row, Stat), as Portfolio and Scan are:
 *
 *   Bots        the rail card: running, volume, net PnL, both fees, cost per $1M, what they hold; New bot, Stop all
 *   Volume      every bot together: volume per 5 minutes (bars) and net PnL (line), fills, resting share, fee floor
 *   Your bots   the list: one row per bot - market, state, volume, net PnL, cost per $1M, holding, controls -
 *               All / Running / Stopped; with none yet, the strategies to pick from
 *   a bot       its own window (BotSheet): chart, where the money went, trades, activity
 *   new / edit  BotForm: strategy, market, preset, plain settings, limits, practice, cost per $1M
 *
 * Before the executor is set up (terms, and for real orders the fee approval and the key): the bot setup
 * (BotSetupSheet), the copy setup's steps worded for bots.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { AlgoView } from '@copy-engine';
import { FINAL_STATUSES } from '@copy-engine';
import type { Eip1193Provider } from '../../wallet';
import { DASH, fmtUsd, signClass } from '../../format';
import { useLiveCopy, readiness } from '../../copy/live';
import { SetupProgress } from '../../copy/CopySetupSheet';
import { liveBotsFor } from '../../algo/liveAlgos';
import { notify } from '../../toast';
import { useConfirm } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { EmptyState } from '../EmptyState';
import { openConnectDialog } from '../account/connect';
import { Card, Row, Stat } from '../portfolio/parts';
import { SeriesChart, type ChartSeries } from '../datachart/SeriesChart';
import { BotIcon } from './BotIcon';
import { BotForm, StrategyCards } from './BotForm';
import { BotSheet } from './BotSheet';
import { BotSetupSheet, botReady } from './BotSetupSheet';
import { botName, botState, fmtPnl, STATE_WORD, type BotState } from './botWords';
import { useBots } from '../../bots/useBots';
import { fleetSeries, fleetTotals } from '../../bots/fleet';
import { DEFAULT_BOT_FEE_TENTHS, STRATEGY_INFO, costPerMillion, draftFor, strategyOf, type Strategy } from '../../bots/presets';
import './bots.css';

type Show = 'all' | 'running' | 'ended';
const SHOWS: Array<{ id: Show; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'ended', label: 'Stopped' },
];

const fmtCost = (cpm: number | null): string => (cpm === null ? DASH : cpm < 0 ? `earns ${fmtUsd(-cpm, 0)}` : fmtUsd(cpm, 0));

function StatePill({ s }: { s: BotState }) {
  return <span className={`bots-state is-${s}`}>{STATE_WORD[s]}</span>;
}

/** The portfolio's segmented control (PeriodSeg's look), for the list's filter. */
function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
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

/** Every bot together, over time: volume per step (bars, right axis) and net PnL (line, left axis). */
function FleetChart({ bots, children }: { bots: AlgoView[]; children?: ReactNode }) {
  const series = useMemo<ChartSeries[]>(() => {
    const s = fleetSeries(bots, Date.now());
    return [
      { key: 'vol', kind: 'bars', color: '#5b6b80', points: s.volume, format: (x) => fmtUsd(x, 0), title: 'Volume' },
      { key: 'pnl', kind: 'line', color: '#f7f7f7', negColor: '#ef4a3c', points: s.pnl, scale: 'left', format: (x) => fmtUsd(x, 2), title: 'Net PnL' },
    ];
  }, [bots]);
  const t = useMemo(() => fleetTotals(bots), [bots]);
  const enough = series[0]!.points.length >= 3;
  const floor = costPerMillion(draftFor('maker'), null, null);
  return (
    <Card title="Volume and net PnL" className="pf-card--chart bots-chartcard">
      <div className="pf-readout">
        <span className="pf-readout__label">Volume, every bot</span>
        <span className="pf-readout__value">{fmtUsd(t.volume, 2)}</span>
        <span className="pf-readout__sub">
          Net PnL <span className={signClass(t.netPnl)}>{fmtPnl(t.netPnl)}</span> · cost per $1M {fmtCost(t.costPerMillion)}
        </span>
      </div>
      {children ?? (enough ? (
        <div className="bots-chartwell">
          <SeriesChart series={series} height={220} daily={false} />
          <p className="bots-chartkey"><span className="bots-key is-vol" />Volume per interval<span className="bots-key is-pnl" />Net PnL</p>
        </div>
      ) : (
        <div className="pf-chart pf-chart--empty"><p>{bots.length ? 'The chart starts after the first 15 minutes: a point every 5 minutes.' : 'Start a bot to chart its volume and PnL here.'}</p></div>
      ))}
      <div className="pf-statstrip">
        <Stat label="Fills" value={t.fills ? t.fills.toLocaleString('en-US') : DASH} privacy="funds" />
        <Stat label="Resting (maker)" value={t.volume >= 1 ? `${Math.round((t.makerValue / t.volume) * 100)}%` : DASH} hint="Share of the volume that filled resting on the book: the maker fee, never the spread." />
        <Stat label="Fee floor per $1M" value={fmtUsd(floor.fees, 0)} hint={`SoDEX's maker fee (${fmtUsd(floor.trade, 0)}) plus ValueDesk's 0.5 bp (${fmtUsd(floor.builder, 0)}) on every $1M a bot trades.`} />
      </div>
    </Card>
  );
}

export function BotsPage({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const live = useLiveCopy(address, provider);
  const signedIn = readiness(live, 'hosted').connected;
  const { bots, loading, error, start, act, stopAll, update } = useBots(address, signedIn);
  const [show, setShow] = useState<Show>('all');
  const [form, setForm] = useState<{ strategy: Strategy | null; editing: AlgoView | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ paper: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const liveAllowed = liveBotsFor(address);
  const fee = live.hosted.info?.bots?.fee ?? DEFAULT_BOT_FEE_TENTHS;
  const supported = !live.hosted.info || !!live.hosted.info.features?.includes('bots');

  const shown = bots.filter((v) => (show === 'all' ? true : show === 'running' ? !FINAL_STATUSES.has(v.algo.status) : FINAL_STATUSES.has(v.algo.status)));
  const opened = openId ? bots.find((v) => v.algo.id === openId) ?? null : null;
  const anyRunning = bots.some((v) => !FINAL_STATUSES.has(v.algo.status));
  const practiceReady = botReady(live, true);
  const ready = !!address && supported && signedIn && practiceReady.ready;
  const t = useMemo(() => fleetTotals(bots), [bots]);

  const run = async (id: string, what: () => Promise<void>, done?: string) => {
    setBusy(id);
    try {
      await what();
      if (done) notify('ok', done);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (v: AlgoView) => {
    const s = v.algo.spec;
    const closes = (s.kind === 'mm' || s.kind === 'grid') && s.onStop === 'close' && Math.abs(v.bot?.inventory ?? 0) > 0;
    const ok = await confirm({
      title: `Stop ${botName(v)}?`,
      body: closes
        ? `It pulls its orders and closes what it holds (${fmtUsd(Math.abs(v.bot!.inventoryUsd), 2)}): resting at the best price first, a capped taker after a minute.`
        : 'It pulls its orders. What it holds stays in your account as it is.',
      confirmLabel: 'Stop bot',
      danger: true,
    });
    if (ok) await run(v.algo.id, () => act('cancel', v.algo.id), closes ? 'Stopping: closing what it holds.' : 'Bot stopped.');
  };

  const remove = async (v: AlgoView) => {
    const ok = await confirm({ title: `Delete ${botName(v)}?`, body: 'It leaves your list. Its record and log stay kept on the executor.', confirmLabel: 'Delete', danger: true });
    if (ok) await run(v.algo.id, async () => {
      await act('archive', v.algo.id);
      if (openId === v.algo.id) setOpenId(null);
    }, 'Bot deleted.');
  };

  const stopEverything = async () => {
    const ok = await confirm({ title: 'Stop all bots?', body: 'Every bot pulls its orders at once. Nothing is closed: what they hold stays in your account.', confirmLabel: 'Stop all', danger: true });
    if (ok) await run('all', stopAll, 'Every bot stopped.');
  };

  const controls = (v: AlgoView, compact: boolean) => {
    const st = botState(v);
    const ended = st === 'ended' || st === 'failed';
    const b = busy === v.algo.id;
    return (
      <span className={`bots-ctl${compact ? ' is-compact' : ''}`}>
        {!ended && st !== 'closing' && (
          st === 'paused'
            ? <button type="button" className="acct-act" disabled={b} onClick={(e) => { e.stopPropagation(); void run(v.algo.id, () => act('resume', v.algo.id)); }}>Resume</button>
            : <button type="button" className="acct-act" disabled={b} onClick={(e) => { e.stopPropagation(); void run(v.algo.id, () => act('pause', v.algo.id)); }}>Pause</button>
        )}
        {!ended && <button type="button" className="acct-act" disabled={b || st === 'closing'} onClick={(e) => { e.stopPropagation(); setForm({ strategy: strategyOf(v.algo.spec), editing: v }); }}>Edit</button>}
        {!ended && <button type="button" className="acct-act acct-act--danger" disabled={b} onClick={(e) => { e.stopPropagation(); void stop(v); }}>{st === 'closing' ? 'Stop now' : 'Stop'}</button>}
        {ended && <button type="button" className="acct-act acct-act--danger" disabled={b} onClick={(e) => { e.stopPropagation(); void remove(v); }}>Delete</button>}
      </span>
    );
  };

  const newBot = (strategy: Strategy | null = null) => setForm({ strategy, editing: null });
  const pick = (s: Strategy) => (ready ? newBot(s) : address ? setSetup({ paper: true }) : void openConnectDialog());

  /* --- the rail card ---------------------------------------------------------- */
  let rail: ReactNode;
  if (!address) {
    rail = (
      <>
        <p className="pf-note">Bots run around the clock in your own SoDEX account. Connect the wallet whose account they trade in.</p>
        <button type="button" className="pf-btn pf-btn--primary pf-btn--wide" onClick={() => void openConnectDialog()}>Connect wallet</button>
      </>
    );
  } else if (!supported) {
    rail = <p className="pf-note">The ValueDesk executor does not run bots yet. They arrive with its next update.</p>;
  } else if (!ready) {
    rail = (
      <>
        <p className="pf-note">Accept the terms to start a practice bot. Real orders add the 0.5 bp fee and a trading key.</p>
        <SetupProgress live={live} mode="hosted" paper bots />
        <button type="button" className="pf-btn pf-btn--primary pf-btn--wide" onClick={() => setSetup({ paper: true })}>Set up</button>
      </>
    );
  } else {
    rail = (
      <>
        <div className="pf-well">
          <Row label="Running" value={<>{t.running}<span className="pf-dim"> of {t.bots}</span></>} privacy="funds" />
          <Row label="Volume" value={fmtUsd(t.volume, 2)} />
          <Row label="Net PnL" value={fmtPnl(t.netPnl)} cls={signClass(t.netPnl)} hint="After every fee, with what they hold valued at the price now." />
          <Row label="Cost per $1M" value={fmtCost(t.costPerMillion)} cls={t.costPerMillion !== null && t.costPerMillion < 0 ? 'pos' : ''} hint="Net PnL per $1M traded, with the sign turned: what the volume cost after what it earned." />
        </div>
        <div className="pf-well">
          <Row label="SoDEX fees" value={fmtUsd(t.tradeFees, 2)} />
          <Row label="ValueDesk fee (0.5 bp)" value={fmtUsd(t.builderFees, 2)} />
          <Row label="Holding" value={fmtUsd(t.holdingUsd, 2)} hint="What the bots hold from their own fills, at the price now." />
        </div>
        <button type="button" className="pf-btn pf-btn--primary pf-btn--wide" onClick={() => newBot()}>New bot</button>
        {anyRunning && <button type="button" className="pf-btn pf-btn--wide bots-stopall" disabled={busy === 'all'} onClick={() => void stopEverything()}>Stop all</button>}
      </>
    );
  }

  /* --- the list card ---------------------------------------------------------- */
  let list: ReactNode;
  if (!ready || (!bots.length && !loading)) {
    list = (
      <div className="bots-pick">
        <p className="pf-note">{ready ? 'Pick a strategy. Each starts as a practice run against the real book, with presets you can change.' : 'Three strategies, each built for volume at the lowest cost. Every order rests on the book.'}</p>
        <StrategyCards onPick={pick} />
      </div>
    );
  } else if (loading && !bots.length) {
    list = <div className="bots-skel" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="bots-bone" />)}</div>;
  } else if (!shown.length) {
    list = <EmptyState icon="chart" title={show === 'running' ? 'No bot running' : 'No stopped bot'} line={show === 'running' ? 'Start one with New bot.' : 'Bots you stop show here.'} compact />;
  } else {
    list = (
      <div className="bots-tablewrap">
        <table className="datatable lb-table bots-table">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Market</th>
              <th>State</th>
              <th className="right">Volume</th>
              <th className="right">Net PnL</th>
              <th className="right">Cost per $1M</th>
              <th className="right">Holding</th>
              <th className="right" aria-label="Controls" />
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => {
              const st = strategyOf(v.algo.spec) ?? 'maker';
              const b = v.bot;
              const cpm = b?.costPerMillion ?? null;
              return (
                <tr key={v.algo.id} className="bots-row" tabIndex={0} onClick={() => setOpenId(v.algo.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(v.algo.id)}>
                  <td>
                    <span className="bots-who">
                      <BotIcon strategy={st} size={16} />
                      <span className="bots-who__t">
                        <b>{botName(v)}</b>
                        <small>{STRATEGY_INFO[st].name} · {v.algo.spec.paper ? 'practice' : 'real orders'}</small>
                      </span>
                    </span>
                  </td>
                  <td><span className="bots-mkt"><CoinIcon coin={v.algo.spec.symbol} size={16} />{v.algo.spec.symbol}</span></td>
                  <td><StatePill s={botState(v)} /></td>
                  <td className="right" data-k="Volume">{b ? fmtUsd(b.volume, 2) : DASH}</td>
                  <td className={`right ${signClass(b?.netPnl)}`} data-k="Net PnL">{fmtPnl(b?.netPnl)}</td>
                  <td className={`right ${cpm !== null && cpm < 0 ? 'pos' : ''}`} data-k="Cost per $1M">{fmtCost(cpm)}</td>
                  <td className="right" data-k="Holding">{b ? fmtUsd(b.inventoryUsd, 2) : DASH}</td>
                  <td className="right">{controls(v, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="pf bots" aria-busy={loading}>
      <div className="bots-top">
        <Card title="Bots" className="pf-card--identity bots-rail">{rail}</Card>
        <FleetChart bots={ready ? bots : []} />
      </div>

      <Card
        title={ready && bots.length ? 'Your bots' : 'Strategies'}
        className="bots-listcard"
        action={ready && bots.length > 0 ? <Seg value={show} options={SHOWS} onChange={setShow} label="Show" /> : undefined}
      >
        {error && ready && <p className="fx-note fx-note--err" role="alert">{error}</p>}
        {list}
      </Card>

      {form && (
        <BotForm
          open
          onClose={() => setForm(null)}
          strategy={form.strategy}
          editing={form.editing}
          liveAllowed={liveAllowed}
          botFeeTenths={fee}
          onStart={async (spec) => {
            const v = await start(spec);
            notify('ok', `${botName(v)} started${v.algo.spec.paper ? ' (practice)' : ''}.`);
            setOpenId(v.algo.id);
          }}
          onSave={async (patch) => {
            await update(form.editing!.algo.id, patch);
            notify('ok', 'Changes saved.');
          }}
          setupWhy={(paper) => botReady(live, paper).why}
          onSetup={(paper) => setSetup({ paper })}
        />
      )}

      {opened && <BotSheet v={opened} open onClose={() => setOpenId(null)} actions={controls(opened, false)} />}

      <BotSetupSheet open={!!setup} onClose={() => setSetup(null)} live={live} paper={setup?.paper ?? true} />
      {dialog}
    </div>
  );
}
