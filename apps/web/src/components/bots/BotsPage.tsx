/**
 * Bots: automated strategies that run on the ValueDesk executor (24/7) in the trader's own SoDEX account -
 * a volume maker, a grid, a DCA bot (bots/presets.ts says why these three). Every order rests on the book.
 *
 *   the bar      All / Running / Stopped, New bot, Stop all
 *   the totals   volume, net PnL, fees, cost per $1M and how many run, over the wallet's bots
 *   the list     one row per bot: market, state, volume, net PnL, cost per $1M, what it holds, controls
 *   a bot        its own window (BotSheet): chart, where the money went, trades, activity
 *   new / edit   BotForm: strategy, market, preset, plain settings, limits, practice, cost per $1M
 *
 * With nothing to show: the strategies as cards. Before the executor is set up (terms, sign-in, and for real
 * orders the fee approval and the key): the copy setup's own steps (CopySetupSheet), as algos use them.
 */
import { useMemo, useState } from 'react';
import type { AlgoView } from '@copy-engine';
import { FINAL_STATUSES } from '@copy-engine';
import type { Eip1193Provider } from '../../wallet';
import { fmtUsd, signClass } from '../../format';
import { useLiveCopy, readiness } from '../../copy/live';
import { CopySetupSheet, SetupProgress } from '../../copy/CopySetupSheet';
import { executorReady } from '../../algo/executorAlgos';
import { liveBotsFor } from '../../algo/liveAlgos';
import { notify } from '../../toast';
import { useConfirm } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { EmptyState, NoWallet } from '../EmptyState';
import { openConnectDialog } from '../account/connect';
import { BotIcon } from './BotIcon';
import { BotForm, StrategyCards } from './BotForm';
import { BotSheet } from './BotSheet';
import { botName, botState, fmtPnl, STATE_WORD, type BotState } from './botWords';
import { useBots } from '../../bots/useBots';
import { DEFAULT_BOT_FEE_TENTHS, STRATEGY_INFO, strategyOf, type Strategy } from '../../bots/presets';
import './bots.css';

type Show = 'all' | 'running' | 'ended';

function Totals({ bots }: { bots: AlgoView[] }) {
  const t = useMemo(() => {
    let volume = 0;
    let net = 0;
    let fees = 0;
    let running = 0;
    for (const v of bots) {
      if (!v.bot) continue;
      volume += v.bot.volume;
      net += v.bot.netPnl;
      fees += v.bot.tradeFees + v.bot.builderFees;
      if (!FINAL_STATUSES.has(v.algo.status)) running++;
    }
    return { volume, net, fees, running, cpm: volume >= 1 ? (-net / volume) * 1_000_000 : null };
  }, [bots]);
  return (
    <div className="bots-totals">
      <div className="bots-total">
        <span className="bots-total__k">Running</span>
        <span className="bots-total__v">{t.running}<small> of {bots.length}</small></span>
      </div>
      <div className="bots-total">
        <span className="bots-total__k">Volume</span>
        <span className="bots-total__v">{fmtUsd(t.volume, 2)}</span>
      </div>
      <div className="bots-total">
        <span className="bots-total__k">Net PnL</span>
        <span className={`bots-total__v ${signClass(t.net)}`}>{fmtPnl(t.net)}</span>
      </div>
      <div className="bots-total">
        <span className="bots-total__k">Fees paid</span>
        <span className="bots-total__v">{fmtUsd(t.fees, 2)}</span>
      </div>
      <div className="bots-total" title="Net PnL per $1M traded, sign turned: what the volume cost after what it earned.">
        <span className="bots-total__k">Cost per $1M</span>
        <span className={`bots-total__v ${t.cpm !== null && t.cpm < 0 ? 'pos' : ''}`}>{t.cpm === null ? '—' : t.cpm < 0 ? `earns ${fmtUsd(-t.cpm, 0)}` : fmtUsd(t.cpm, 0)}</span>
      </div>
    </div>
  );
}

function StatePill({ s }: { s: BotState }) {
  return <span className={`bots-state is-${s}`}>{STATE_WORD[s]}</span>;
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
  const practiceReady = executorReady('hosted', true);

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

  let content;
  if (!address) {
    content = <NoWallet line="Connect a wallet to run bots on your SoDEX account." compact />;
  } else if (!supported) {
    content = <EmptyState icon="alert" title="Not on this executor yet" line="The ValueDesk executor does not run bots yet. They arrive with its next update." />;
  } else if (!signedIn || !practiceReady.ready) {
    content = (
      <div className="bots-onboard">
        <div className="bots-onboard__text">
          <b>Set up the ValueDesk executor</b>
          <span>Bots run there around the clock, in your own SoDEX account. Accept the terms and sign in to start a practice bot; approve the fee and a trading key for real orders.</span>
          <SetupProgress live={live} mode="hosted" paper />
        </div>
        <button type="button" className="fx-cta" onClick={() => setSetup({ paper: true })}>Set up</button>
      </div>
    );
  } else if (loading && !bots.length) {
    content = <div className="bots-skel" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="bots-bone" />)}</div>;
  } else if (!bots.length) {
    content = null;
  } else if (!shown.length) {
    content = <EmptyState icon="chart" title={show === 'running' ? 'No bot running' : 'No stopped bot'} line={show === 'running' ? 'Start one with New bot.' : 'Bots you stop show here.'} compact />;
  } else {
    content = (
      <div className="lbp-sheet">
        <table className="datatable lb-table lbp-table bots-table">
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
                        <small>{STRATEGY_INFO[st].name}{v.algo.spec.paper ? '' : ' · live'}</small>
                      </span>
                      {v.algo.spec.paper && <span className="algo-practice">Practice</span>}
                    </span>
                  </td>
                  <td><span className="bots-mkt"><CoinIcon coin={v.algo.spec.symbol} size={16} />{v.algo.spec.symbol}</span></td>
                  <td><StatePill s={botState(v)} /></td>
                  <td className="right" data-k="Volume">{b ? fmtUsd(b.volume, 2) : '—'}</td>
                  <td className={`right ${signClass(b?.netPnl)}`} data-k="Net PnL">{fmtPnl(b?.netPnl)}</td>
                  <td className={`right ${cpm !== null && cpm < 0 ? 'pos' : ''}`}>{cpm === null ? '—' : cpm < 0 ? `earns ${fmtUsd(-cpm, 0)}` : fmtUsd(cpm, 0)}</td>
                  <td className="right">{b ? fmtUsd(b.inventoryUsd, 2) : '—'}</td>
                  <td className="right">{controls(v, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const ready = !!address && supported && signedIn && practiceReady.ready;

  return (
    <section className="panel lbp bots" aria-busy={loading}>
      <header className="bots-head">
        <div className="bots-head__text">
          <h1>Bots</h1>
          <p>Automated strategies in your own SoDEX account, run around the clock by ValueDesk. Every order rests on the book: SoDEX's maker fee plus {(fee / 10).toFixed(1)} bp, never the spread.</p>
        </div>
        {ready && <button type="button" className="fx-cta bots-new" onClick={() => newBot()}>New bot</button>}
      </header>

      {ready && bots.length > 0 && <Totals bots={bots} />}

      {ready && bots.length > 0 && (
        <div className="lbp-bar">
          <div className="lbp-seg" role="radiogroup" aria-label="Show">
            {(['all', 'running', 'ended'] as Show[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={show === s} className={show === s ? 'is-on' : ''} onClick={() => setShow(s)}>
                {s === 'all' ? 'All' : s === 'running' ? 'Running' : 'Stopped'}
              </button>
            ))}
          </div>
          <span className="bots-bar__gap" />
          {anyRunning && <button type="button" className="acct-act acct-act--danger" disabled={busy === 'all'} onClick={() => void stopEverything()}>Stop all</button>}
        </div>
      )}

      {error && ready && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      {content}

      {((ready && !bots.length && !loading) || (!ready && supported)) && (
        <div className="bots-empty">
          <div className="bots-empty__head">
            <b>{ready ? 'Start your first bot' : 'What you can run'}</b>
            <span>{ready ? 'Pick a strategy. Each one starts as a practice run against the real book, with presets you can change.' : 'Three strategies, each built for volume at the lowest cost. Every order rests on the book.'}</span>
          </div>
          <StrategyCards onPick={(s) => (ready ? newBot(s) : address ? setSetup({ paper: true }) : openConnectDialog())} />
        </div>
      )}

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
          setupWhy={(paper) => {
            const r = executorReady('hosted', paper);
            return r.ready ? null : r.why;
          }}
          onSetup={() => setSetup({ paper: true })}
        />
      )}

      {opened && <BotSheet v={opened} open onClose={() => setOpenId(null)} actions={controls(opened, false)} />}

      <CopySetupSheet open={!!setup} onClose={() => setSetup(null)} mode="hosted" onMode={() => {}} live={live} paper={setup?.paper ?? true} />
      {dialog}
    </section>
  );
}
