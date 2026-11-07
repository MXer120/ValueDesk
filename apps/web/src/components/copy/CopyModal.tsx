/**
 * "Copy 0x5e13…2607": the copy setup as two steps over the trader grid.
 *
 *   1  Rules         beside the trader and a replay of their last fills under
 *                    these rules: sizing, limits and behaviour (risk controls folded)
 *   2  Where it runs this browser / the ValueDesk executor / self-hosted, how
 *                    much the copy trades with, and the signatures that mode
 *                    still needs (copy/CopySetupSheet.tsx CopySetupSteps)
 *
 * One column (owner, 2026-11-07, after two reference screenshots, in our own style): the trader's
 * figures in a row, copy or counter, the expected PnL replayed from their real fills over a wide chart,
 * then the rules as cards - Rules and Risk & markets as two tabs - with the progress of the two steps
 * in the footer. The steps slide into each other; with reduced motion they swap. Step 2 shows only
 * what the mode still needs: the terms, sign-in, key or fee approval done before are a line of pills.
 *
 * Every number is the setup form's (setup.ts) and the backtest's (useCopy.ts);
 * nothing here starts anything until "Start copying", and that needs every step
 * of the mode done by the follower's own signatures.
 */
import { decimalInput } from '../numberInput';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { COPY_FEE_MAX, COPY_FEE_WINDOW_DAYS, EEA_MAX_LEVERAGE, copyFeeFor, feePercent, regionPolicy } from '@copy-engine';
import { subscribeTerms, termsView } from '../../trading/terms';
import { Modal } from '../Modal';
import { DlgSwitch } from '../dialogParts';
import { LoadFailed } from '../LoadFailed';
import { DASH, fmt, fmtUsd, shortAddr } from '../../format';
import { notify } from '../../toast';
import { WalletError } from '../../wallet';
import { VENUE_LABEL, vsApi, type TraderRow } from '../../vsApi';
import { CopySetupSteps, STEP_DONE_LABEL, SetupProgress, copyReady, setupSteps } from '../../copy/CopySetupSheet';
import { ModeCards } from '../../copy/ModeCards';
import { startCopy, supportsCounter, supportsMultiplier } from '../../copy/live';
import { EquityChart } from './EquityChart';
import { Avatar, CopyGlyph, CounterGlyph, WinRate, holdPeeks } from './TraderCard';
import { coinOf } from './sim';
import {
  MULTIPLIER_MIN, SIZING_MODES, TAKER_RATE, fmtRate, fmtSignedPct, fmtSignedUsd, previewFigures, workedExample, type SetupField, type SetupState,
} from './setup';
import { FILL_LIMIT, type CopyContext } from './useCopy';
import { NotCopyableNote, useNotCopyable } from './useNotCopyable';
import { fmtFixed, localize, toInputText } from '../../numStyle';
// The order ticket's slider (its striped rail, fill and thumb) for max leverage.
import '../OrderEntry.css';

const isRejection = (e: unknown): boolean => e instanceof WalletError && /reject|denied|cancel/i.test(e.message);

const SIZING_LABEL: Record<string, string> = { proportional: 'Mirror', fixedRatio: '% of their size', fixedNotional: '$ per trade' };

export interface CopyModalProps {
  c: CopyContext;
  open: boolean;
  /** The board row the dialog was opened from: its figures show before the profile arrives. */
  row: TraderRow | null;
  onClose: () => void;
  /** The copy runs: the page shows My copies. */
  onStarted: () => void;
}

export function CopyModal({ c, open, row, onClose, onStarted }: CopyModalProps) {
  const [step, setStepState] = useState<1 | 2>(1);
  // Which way the next step slides in: forward from the right, back from the left.
  const dir = useRef<'fwd' | 'back'>('fwd');
  const setStep = (n: 1 | 2) => { dir.current = n > step ? 'fwd' : 'back'; setStepState(n); };
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { dir.current = 'fwd'; setStepState(1); setError(null); }
  }, [open, c.leader]);
  // The replay's fill walk goes first: the grid's card reads wait while the dialog is open.
  useEffect(() => (open ? holdPeeks() : undefined), [open]);
  // Paper copies are not offered here any more (owner 2026-11-07): a setup kept from before starts live.
  useEffect(() => { if (open && c.setup.paper) c.patchSetup({ paper: false }); }, [open, c.setup.paper]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c.leader) return null;
  const counter = c.setup.direction === 'counter';
  // A counter-trade needs a copier that knows the direction (copy/live.ts supportsCounter).
  const counterBlocked = counter && !supportsCounter(c.live, c.runOn);
  // A multiple other than 1x needs a copier that sizes by it (copy/live.ts supportsMultiplier).
  const multBlocked = (c.copySettings?.multiplier ?? 1) !== 1 && !supportsMultiplier(c.live, c.runOn);
  const ready = copyReady(c.live, c.runOn, c.setup.paper) && !counterBlocked && !multBlocked;
  const errs = [...Object.values(c.parsed.errors), ...(Object.keys(c.parsed.errors).length ? [] : c.copyErrors)] as string[];

  const title = (
    <span className="cpy-v2head">
      <span className="cpy-mtitle">
        <Avatar address={c.leader} size={22} />
        <span>{counter ? 'Counter-trade' : 'Copy'} {shortAddr(c.leader)}</span>
        <span className="cpy-mtitle__venue">{VENUE_LABEL[c.venue]}</span>
      </span>
      <span className="cpy-v2head__sub">{step === 1 ? 'Set the rules your copy follows.' : 'Where the copier runs and what it trades with.'}</span>
    </span>
  );

  const start = () => {
    const settings = c.copySettings;
    if (!settings) return;
    setError(null);
    setStarting(true);
    startCopy(c.runOn, settings)
      .then(() => {
        const who = shortAddr(c.leader!);
        notify('ok', settings.direction === 'counter'
          ? (settings.paper ? `Paper counter-trade of ${who} started.` : `Counter-trading ${who}.`)
          : (settings.paper ? `Paper copy of ${who} started.` : `Copying ${who}.`));
        onClose();
        onStarted();
      }, (e: unknown) => { if (!isRejection(e)) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setStarting(false));
  };

  const footer = (
    <div className="cpy-mfoot">
      <span className="cpy-v2prog">
        <span className="cpy-v2prog__bar" role="progressbar" aria-label="Steps" aria-valuemin={1} aria-valuemax={2} aria-valuenow={step}>
          <button type="button" className="cpy-v2prog__seg is-on" aria-label="Step 1: rules" onClick={() => setStep(1)} />
          <button type="button" className={`cpy-v2prog__seg${step === 2 ? ' is-on' : ''}`} aria-label="Step 2: where it runs" disabled={errs.length > 0} onClick={() => setStep(2)} title={errs[0]} />
        </span>
        <span className="cpy-v2prog__n">{step}/2</span>
      </span>
      <span className="cpy-mfoot__note">
        {step === 1
          ? (errs.length ? <span className="cpy-mfoot__err">{errs[0]}</span> : 'Next: where the copier runs and what it trades with.')
          // A rule that is wrong (the amount to trade with is on this step) says so here: Start is off for it, and "Ready" would not be true.
          : errs.length ? <span className="cpy-mfoot__err">{errs[0]}</span>
          : ready ? (c.setup.paper ? 'Ready: a paper copy sends nothing to SoDEX.' : 'Ready to start.') : counterBlocked ? 'This copier cannot counter-trade.'
          : multBlocked ? 'This copier copies at 1x only.' : 'Finish the steps above first.'}
      </span>
      <span className="cpy-mfoot__acts">
        {step === 1 ? (
          <>
            <button type="button" className="fx-cta fx-cta--ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="fx-cta" disabled={errs.length > 0} onClick={() => setStep(2)} title={errs[0]}>Next</button>
          </>
        ) : (
          <>
            <button type="button" className="fx-cta fx-cta--ghost" onClick={() => setStep(1)}>Back</button>
            <button
              type="button"
              className={`fx-cta cpy-mstart cpy-mstart--${counter ? 'counter' : 'copy'}`}
              disabled={!ready || !c.copySettings || starting}
              onClick={start}
            >
              {starting ? 'Starting…' : startLabel(c.setup.paper, counter)}
            </button>
          </>
        )}
      </span>
    </div>
  );

  return (
    <Modal open={open} title={title} onClose={onClose} size="lg" className="fx cpy-modal cpy-modal--v2" footer={footer} onBack={step === 2 ? () => setStep(1) : undefined}>
      <div key={step} className={`cpy-stepview cpy-stepview--${dir.current}`}>
        {/* Said only once the executor has answered: before that, its features are not known. */}
        {step === 1 ? <RulesStep c={c} row={row} errs={errs} /> : <RunStep c={c} multBlocked={multBlocked && c.runOn !== 'browser' && !!c.live[c.runOn].info} />}
      </div>
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
    </Modal>
  );
}

const startLabel = (paper: boolean, counter: boolean): string =>
  counter ? (paper ? 'Start paper counter-trade' : 'Start counter-trading') : (paper ? 'Start paper copy' : 'Start copying');

/* ============================================================ step 1 ====== */

function RulesStep({ c, row, errs }: { c: CopyContext; row: TraderRow | null; errs: string[] }) {
  const uid = useId().replace(/:/g, '');
  const s = c.profile.data?.summary ?? null;
  const av = s?.accountValue ?? row?.accountValue ?? null;
  const pnl30 = s?.pnl['30d'] ?? row?.pnl['30d'] ?? null;
  const wr = s?.winRate ?? row?.winRate ?? null;
  const closes = s?.winRateCloses ?? row?.winRateCloses ?? null;
  const set = (k: SetupField) => (v: string) => c.patchSetup({ [k]: v } as Partial<SetupState>);
  const e = c.parsed.errors;
  const example = workedExample(c.parsed, c.profile.data ?? null, (sym) => coinOf(c.venue, sym));
  const eea = regionPolicy(c.live.terms?.country ?? null, c.live.viewerCountry).maxLeverage === EEA_MAX_LEVERAGE;
  const counter = c.setup.direction === 'counter';
  // Which of their positions and recent coins a copy cannot follow on SoDEX, before it starts (owner, 2026-10-29).
  const copyVenue = c.venue === 'sodex' || c.venue === 'hyperliquid' ? c.venue : null;
  const [tab, setTab] = useState<'rules' | 'risk'>('rules');
  // A rule of the other tab that is wrong says so on its tab.
  const riskBad = ['stopLoss', 'takeProfit', 'drawdown', 'allow', 'deny'].some((k) => (e as Record<string, string | undefined>)[k]);
  const rulesBad = ['mode', 'ratioPct', 'notional', 'multiplier', 'maxLeverage', 'maxPosition', 'slippageBps'].some((k) => (e as Record<string, string | undefined>)[k]);
  const notCopyable = useNotCopyable({
    enabled: copyVenue !== null,
    venue: copyVenue ?? 'hyperliquid',
    positions: c.profile.data?.positions ?? null,
    positionsAt: c.profile.data?.updatedAt ?? null,
    fills: c.fills.data,
  });

  return (
    <div className="cpy-v2">
      <div className="cpy-v2__top">
        <dl className="cpy-v2__stats">
          <div><dt>Equity</dt><dd>{av === null ? DASH : fmtUsd(av, 0)}</dd></div>
          <div><dt>30D PnL</dt><dd className={pnl30 === null ? '' : pnl30 >= 0 ? 'pos' : 'neg'}>{fmtSignedUsd(pnl30, 0)}</dd></div>
          <div><dt>Win rate</dt><dd><WinRate value={wr} closes={closes} /></dd></div>
        </dl>
        <NotCopyableNote n={notCopyable} />

        <div className="cpy-dir" role="radiogroup" aria-label="Direction">
          {(['copy', 'counter'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={c.setup.direction === d}
              className={`cpy-dir__opt cpy-dir__opt--${d}${c.setup.direction === d ? ' is-on' : ''}`}
              onClick={() => c.patchSetup({ direction: d })}
            >
              {d === 'copy' ? <CopyGlyph /> : <CounterGlyph />}
              {d === 'copy' ? 'Copy' : 'Counter-trade'}
            </button>
          ))}
        </div>
        {counter && (
          <p className="cpy-dir__note">
            You take the opposite side of every trade: their long is your short, their close is your close. You gain when they
            lose, and lose when they win - a good record is your risk here.
          </p>
        )}

        <Preview c={c} />
      </div>

      <div className="cpy-v2__tabs" role="tablist" aria-label="Copy rules">
        <button type="button" role="tab" aria-selected={tab === 'rules'} className={`cpy-v2__tab${tab === 'rules' ? ' is-on' : ''}`} onClick={() => setTab('rules')}>
          Rules{rulesBad && <i className="cpy-v2__tabdot" aria-label="needs a fix" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'risk'} className={`cpy-v2__tab${tab === 'risk' ? ' is-on' : ''}`} onClick={() => setTab('risk')}>
          Risk & markets{riskBad && <i className="cpy-v2__tabdot" aria-label="needs a fix" />}
        </button>
      </div>

      {tab === 'rules' ? (
      <div className="cpy-v2__cards dlg" role="tabpanel">
          <Rule
            title="Sizing"
            hint={SIZING_MODES.find((m) => m.v === c.setup.mode)?.hint}
            note={example ? <>{example.text}{example.caveat && <span className="cpy-caveat"> {example.caveat}</span>}</> : undefined}
            wide
          >
            <span className="dlg-seg" role="group" aria-label="Sizing">
              {SIZING_MODES.map((m) => (
                <button key={m.v} type="button" title={m.hint} aria-pressed={c.setup.mode === m.v} className={c.setup.mode === m.v ? 'is-on' : undefined} onClick={() => c.patchSetup({ mode: m.v })}>
                  {SIZING_LABEL[m.v] ?? m.label}
                </button>
              ))}
            </span>
            {c.setup.mode === 'fixedRatio' && <Num id={`${uid}-ratio`} value={c.setup.ratioPct} onChange={set('ratioPct')} unit="%" error={e.ratioPct} label="Percent of their size" />}
            {c.setup.mode === 'fixedNotional' && <Num id={`${uid}-notional`} value={c.setup.notional} onChange={set('notional')} unit="USDC" error={e.notional} label="Per trade" />}
          </Rule>
          <Rule title="Multiplier" hint="Copies a multiple of the trader's positions. 1× mirrors them. Your caps below still apply.">
            <SlideField value={c.setup.multiplier} min={MULTIPLIER_MIN} max={5} step={0.1} unit="×" onChange={set('multiplier')} error={e.multiplier} label="Multiplier" />
          </Rule>
          <Rule title="Max leverage" hint={eea ? `Caps every copied position. In the EU and EEA copies are capped at ${EEA_MAX_LEVERAGE}x.` : 'Caps every copied position, even when the trader uses more.'}>
            <SlideField value={c.setup.maxLeverage} min={1} max={eea ? EEA_MAX_LEVERAGE : LEV_MAX} step={1} unit="×" onChange={set('maxLeverage')} error={e.maxLeverage} label="Max leverage" />
          </Rule>
          <Rule title="Max position" hint="The largest a single copied position may get, in dollars.">
            <Num id={`${uid}-maxpos`} value={c.setup.maxPosition} onChange={set('maxPosition')} unit="USDC" error={e.maxPosition} label="Max position" />
          </Rule>
          <Rule title="Max entry deviation" hint={`How far from the trader's price a copy may fill. ${c.setup.slippageBps || '0'} bps = ${fmtFixed(Number(c.setup.slippageBps || 0) / 100, 2)}%.`}>
            <SlideField value={c.setup.slippageBps} min={0} max={100} step={1} unit="bps" onChange={set('slippageBps')} error={e.slippageBps} label="Max entry deviation" />
          </Rule>
          <Rule
            title="Only new positions"
            hint={c.setup.onlyNew
              ? 'Copies only positions the trader opens after you start. What they hold now is left alone until they close it.'
              : 'Off: the positions the trader holds now are joined at the start too, at the current price.'}
          >
            <Switch checked={c.setup.onlyNew} onChange={(v) => c.patchSetup({ onlyNew: v })} label="Only copy newly opened positions" on="Only new" off="Off" />
          </Rule>
      </div>
      ) : (
      <div className="cpy-v2__cards dlg" role="tabpanel">
            <Rule title="Stop loss" hint="Closes a copied position when it has lost this share of its margin. Leave it empty to turn it off.">
              <Num id={`${uid}-sl`} value={c.setup.stopLoss} onChange={set('stopLoss')} unit="%" placeholder="off" error={e.stopLoss} label="Stop loss" />
            </Rule>
            <Rule title="Take profit" hint="Closes a copied position at this gain on its margin. Leave it empty to turn it off.">
              <Num id={`${uid}-tp`} value={c.setup.takeProfit} onChange={set('takeProfit')} unit="%" placeholder="off" error={e.takeProfit} label="Take profit" />
            </Rule>
            <Rule title="Drawdown stop" hint="Closes everything and stops the copy when its equity falls this far from its peak.">
              <Num id={`${uid}-dd`} value={c.setup.drawdown} onChange={set('drawdown')} unit="%" placeholder="off" error={e.drawdown} label="Drawdown stop" />
            </Rule>
            <Rule title="Only these coins" hint="Comma separated, e.g. BTC, ETH. Leave it empty for every coin.">
              <Text id={`${uid}-allow`} value={c.setup.allow} onChange={set('allow')} placeholder="all coins" error={e.allow} label="Only copy" />
            </Rule>
            <Rule title="Never these coins" hint="Comma separated.">
              <Text id={`${uid}-deny`} value={c.setup.deny} onChange={set('deny')} placeholder="none" error={e.deny} label="Never copy" />
            </Rule>
            <Rule title="Isolated margin" hint="Each copied position has its own margin, so one cannot drain the others.">
              <Switch checked={c.setup.marginMode === 'isolated'} onChange={(v) => c.patchSetup({ marginMode: v ? 'isolated' : 'cross' })} label="Isolated margin" on="Isolated" off="Cross" />
            </Rule>
            {c.runOn === 'browser' && (
              <Rule title="Ask before each trade" hint="Every copied order waits for your yes in this tab (60 seconds). Browser copies only.">
                <Switch checked={c.setup.confirmEach} onChange={(v) => c.patchSetup({ confirmEach: v })} label="Ask before each trade" on="Asks first" off="Automatic" />
              </Rule>
            )}
      </div>
      )}
      <button type="button" className="fx-link cpy-reset cpy-v2__reset" onClick={c.resetSetup}>Reset</button>
      {errs.length > 1 && <p className="fx-note fx-note--err">{errs.join(' ')}</p>}
    </div>
  );
}

/**
 * The expected result: the trader's PnL against yours, replayed from their real fills
 * under these rules (sizing, multiplier, leverage cap, region cap, fees, slippage cap;
 * for a counter-trade, the other side). The trader's line is scaled to your allocation,
 * so the two read on one axis. Nothing is estimated: without fills there are no lines.
 */
function Preview({ c }: { c: CopyContext }) {
  const r = c.sim.result;
  const counter = c.setup.direction === 'counter';
  const windows = [{ v: '7d', label: '7D' }, { v: '30d', label: '30D' }] as const;
  const big = r && r.copiedFills + r.skippedFills > 0 && !Object.keys(c.parsed.errors).length ? previewFigures(r).you.roi : null;
  const head = (
    <div className="cpy-replay__head">
      <span className="cpy-v2ret">
        <span className="cpy-replay__k">{counter ? 'Expected PnL, counter-trading' : 'Expected PnL, copying'} ({c.window === '7d' ? '7D' : '30D'})</span>
        {big !== null && <b className={`cpy-v2ret__v${big > 0 ? ' pos' : big < 0 ? ' neg' : ''}`}>{fmtSignedPct(big)}</b>}
      </span>
      <span className="cpy-seg cpy-seg--sm" role="group" aria-label="Replay window">
        {windows.map((w) => (
          <button key={w.v} type="button" aria-pressed={c.window === w.v} className={c.window === w.v ? 'is-on' : undefined} onClick={() => c.setWindow(w.v)}>{w.label}</button>
        ))}
      </span>
    </div>
  );
  let body: ReactNode;
  if (c.fills.loading) body = <p className="cpy-replay__note">Reading their latest fills from {VENUE_LABEL[c.venue]} (up to {fmt(FILL_LIMIT, 0)}; a busy trader takes a moment)…</p>;
  else if (c.sim.busy && !r) body = <p className="cpy-replay__note">Replaying {fmt(c.fills.data?.length ?? 0, 0)} fills under your rules…</p>;
  else if (c.fills.error) body = c.fills.code === 'not_available' ? <p className="cpy-replay__note">{VENUE_LABEL[c.venue]} fills are not available here, so there is no history to replay.</p> : <LoadFailed what="Fills" onRetry={c.fills.reload} />;
  else if (Object.keys(c.parsed.errors).length) body = <p className="cpy-replay__note">Fix the rules to see the expected result.</p>;
  else if (!r || r.copiedFills + r.skippedFills === 0) body = <p className="cpy-replay__note">No trades in this window, so there is no history to replay.</p>;
  else {
    const f = previewFigures(r);
    const tone = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    body = (
      <>
        <dl className={`cpy-pv${c.sim.busy ? ' is-busy' : ''}`}>
          <div>
            <dt>Return</dt>
            <dd className={tone(f.you.roi)}>{fmtSignedPct(f.you.roi)}</dd>
            <span className="cpy-pv__them">Trader {fmtSignedPct(f.them.roi)}</span>
          </div>
          <div>
            <dt>PnL</dt>
            <dd className={tone(f.you.pnl)}>{fmtSignedUsd(f.you.pnl)}</dd>
            <span className="cpy-pv__them">Trader {fmtSignedUsd(f.them.pnl)}</span>
          </div>
          <div>
            <dt>Max drawdown</dt>
            <dd>{fmtSignedPct(-f.you.maxDrawdown)}</dd>
            <span className="cpy-pv__them">Trader {fmtSignedPct(-f.them.maxDrawdown)}</span>
          </div>
        </dl>
        <div className={`pf copy cpy-replay__chart${c.sim.busy ? ' is-busy' : ''}`}>
          <EquityChart you={r.equityCurve} leader={r.leaderCurve} base={r.startEquity} pnl />
        </div>
        <div className="cpy-replay__legend">
          <span><i className="copy-swatch copy-swatch--you" aria-hidden="true" />{counter ? 'You, counter-trading' : 'You'}</span>
          <span><i className="copy-swatch copy-swatch--leader" aria-hidden="true" />Trader, scaled to your {fmtUsd(r.startEquity, 0)}</span>
        </div>
        <p className="cpy-replay__sub">
          {fmt(r.copiedFills, 0)} of {fmt(r.copiedFills + r.skippedFills, 0)} fills copied · fees {fmtUsd(r.feesUsd, 2)}
          {r.stoppedBy ? ' · a stop rule of yours ended the run early' : ''}
          {c.sim.truncated ? ` · their last ${fmt(FILL_LIMIT, 0)} fills reach back to ${new Date(r.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} only` : ''}
        </p>
      </>
    );
  }
  return (
    <section className="cpy-replay" aria-live="polite">
      {head}
      {body}
      <p className="cpy-replay__fine">A replay of their real fills at their price plus your full slippage cap, with fees. Not a forecast.</p>
    </section>
  );
}

const LEV_MAX = 50;

/**
 * A number in a box with its fill (owner 2026-11-07, after a reference): drag across the box, or arrow keys, to set it;
 * a press on the number types it. A typed value may go past the slider's end (the setup's own limits say what holds).
 */
function SlideField({ value, min, max, step, unit, onChange, error, label }: {
  value: string; min: number; max: number; step: number; unit: string; onChange: (v: string) => void; error?: string; label: string;
}) {
  const [typing, setTyping] = useState(false);
  const n = Number(String(value).replace(',', '.'));
  const cur = Number.isFinite(n) ? n : min;
  const p = Math.max(0, Math.min(1, (cur - min) / Math.max(1e-9, max - min)));
  const dp = step < 1 ? 1 : 0;
  const snap = (v: number) => String(Number((Math.round(Math.max(min, Math.min(max, v)) / step) * step).toFixed(dp)));
  const at = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(snap(min + ((e.clientX - r.left) / Math.max(1, r.width)) * (max - min)));
  };
  return (
    <>
      <span
        className={`cpy-slide${error ? ' is-bad' : ''}${typing ? ' is-typing' : ''}`}
        role="slider"
        tabIndex={typing ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={cur}
        aria-valuetext={`${localize(String(cur))} ${unit}`}
        title={error}
        onPointerDown={(e) => {
          if (typing || (e.target as HTMLElement).closest('.cpy-slide__v')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e); }}
        onKeyDown={(e) => {
          if (typing) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(snap(cur + step)); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(snap(cur - step)); }
          else if (e.key === 'Enter') setTyping(true);
        }}
      >
        <span className="cpy-slide__fill" style={{ width: `${p * 100}%` }} aria-hidden="true" />
        {typing ? (
          <input
            className="cpy-slide__in"
            autoFocus
            value={toInputText(value)}
            onChange={(e) => onChange(decimalInput(e.target.value, { prev: value }))}
            onBlur={() => setTyping(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setTyping(false); } }}
            inputMode="decimal"
            spellCheck={false}
            aria-label={label}
            aria-invalid={error ? true : undefined}
          />
        ) : (
          <button type="button" className="cpy-slide__v" title="Type a value" onClick={() => setTyping(true)}>{localize(String(cur))}</button>
        )}
        <span className="cpy-slide__u" aria-hidden="true">{unit}</span>
      </span>
      {error && <small className="cpy-ferr" role="alert">{error}</small>}
    </>
  );
}

/* ============================================================ step 2 ====== */

function RunStep({ c, multBlocked }: { c: CopyContext; multBlocked: boolean }) {
  const uid = useId().replace(/:/g, '');
  const wallet = c.wallet;
  /* The wallet's SoDEX account value: a number, 'none' (no SoDEX account yet), 'error', or null while it loads. */
  const [equity, setEquity] = useState<number | 'none' | 'error' | null>(null);
  useEffect(() => {
    setEquity(null);
    if (!wallet) return;
    let dead = false;
    vsApi.trader('sodex', wallet).then(
      (p) => { if (!dead) setEquity(p?.summary.accountValue ?? 'none'); },
      () => { if (!dead) setEquity('error'); },
    );
    return () => { dead = true; };
  }, [wallet]);
  const taker = TAKER_RATE.sodex;
  /* The copy fee this wallet pays (owner 2026-11-07: "get the users actual fee instead of up to"). The ValueDesk executor
     charges the ladder's step of the wallet's 14-day volume (executor service.ts copyFeeFor); the fee terms carry that
     volume when they count the same 14 days. This browser charges the top step (copy/browserCopier.ts). */
  useSyncExternalStore(subscribeTerms, () => termsView(wallet)?.volumeUsd ?? null, () => null);
  const tv = termsView(wallet);
  const vol14 = tv && tv.volumeDays === COPY_FEE_WINDOW_DAYS ? tv.volumeUsd : null;
  const feeTenths = c.setup.paper ? 0 : c.runOn === 'hosted' ? copyFeeFor(vol14) : COPY_FEE_MAX;
  const fee = feeTenths / 100_000;
  const chips = useMemo(() => [0.25, 0.5, 0.75, 1], []);

  return (
    <div className="cpy-v2">
        <h3 className="cpy-h">Where the copier runs</h3>
        <ModeCards value={c.runOn} onChange={c.setRunOn} />
        {c.setup.direction === 'counter' && !supportsCounter(c.live, c.runOn) && (
          <p className="fx-note fx-note--err">
            {c.runOn === 'self'
              ? c.live.self.info
                ? 'Your copier is older than counter-trading: download the current copier (Copy setup), start it again, then come back.'
                : 'Connect your copier first; it must be a version that counter-trades.'
              : c.live.hosted.info
                ? 'The ValueDesk executor does not run counter-trades yet. Run it in this browser instead.'
                : 'Checking the ValueDesk executor…'}
          </p>
        )}
        {multBlocked && (
          <p className="fx-note fx-note--err">
            {c.runOn === 'self'
              ? 'Your copier is older than the size multiplier: download the current copier, start it again, or set the multiplier to 1×.'
              : 'The ValueDesk executor does not size by a multiplier yet. Set it to 1×, or run the copy in this browser.'}
          </p>
        )}
        <dl className="cpy-fees">
          <div>
            <dt>Your copy fee</dt>
            <dd title={c.runOn === 'hosted' ? 'The step of your verified 14-day volume; it falls as the volume grows.' : 'A copy in this browser pays the first step.'}>
              {c.setup.paper ? 'none (paper)' : `${localize(feePercent(feeTenths))} per copied order`}
            </dd>
            {c.runOn === 'hosted' && vol14 !== null && <small className="cpy-fees__sub">{`14-day volume ${fmtUsd(vol14, 0)}`}</small>}
          </div>
          <div><dt>SoDEX taker fee</dt><dd>{fmtRate(taker)}</dd></div>
          <div><dt>Round trip, est.</dt><dd>{fmtRate(taker * 2 + fee * 2)} + slippage</dd></div>
        </dl>

        <div className="cpy-alloc">
          <label className="cpy-alloc__k" htmlFor={`${uid}-alloc`}>Trade with</label>
          <span className={`cpy-alloc__box${c.parsed.errors.allocation || c.copyErrors.some((x) => x.startsWith('Allocation')) ? ' is-bad' : ''}`}>
            <input
              id={`${uid}-alloc`}
              value={toInputText(c.setup.allocation)}
              onChange={(e) => c.patchSetup({ allocation: decimalInput(e.target.value, { prev: c.setup.allocation }) })}
              inputMode="decimal"
              placeholder="1000"
              spellCheck={false}
            />
            <span className="cpy-alloc__u">USDC</span>
          </span>
          <span className="cpy-alloc__row">
            <span className="cpy-alloc__have">
              {!wallet ? 'Connect a wallet to see your SoDEX balance.'
                : equity === null ? 'SoDEX account value: …'
                : equity === 'none' ? (c.setup.paper ? 'No SoDEX account yet: fine for a paper copy.' : 'No SoDEX account yet: deposit on SoDEX before a live copy.')
                : equity === 'error' ? 'SoDEX account value could not be read.'
                : `SoDEX account value: ${fmtUsd(equity, 2)}`}
            </span>
            {typeof equity === 'number' && equity > 0 && (
              <span className="cpy-alloc__chips">
                {chips.map((f) => (
                  <button key={f} type="button" className="cpy-chip" onClick={() => c.patchSetup({ allocation: String(Math.floor(equity * f)) })}>
                    {f === 1 ? 'Max' : `${f * 100}%`}
                  </button>
                ))}
              </span>
            )}
          </span>
          <p className="fx-note">The copy sizes its positions against this amount. It stays in your SoDEX account: nothing is moved.</p>
        </div>

        <Needs c={c} />

        <p className="fx-note">
          You choose the trader and every rule; ValueDesk never holds your funds. Not investment advice: past results do not predict future
          ones. <a className="fx-link" href="/copy-terms" target="_blank" rel="noopener">Copy terms and risks</a>.
        </p>
    </div>
  );
}

/**
 * What the mode still needs, and only that (owner, 2026-11-03: "if the users already did
 * that once dont show it"): the steps done before (terms, sign-in, key, fee approval) are
 * a line of pills; with everything done, the pills and "Ready" are all there is.
 */
function Needs({ c }: { c: CopyContext }) {
  const steps = setupSteps(c.live, c.runOn, c.setup.paper);
  const done = steps.filter((x) => x.done);
  const left = steps.length - done.length;
  return (
    <section className="cpy-needs" aria-label="What this copy needs">
      <h3 className="cpy-h">
        {left === 0 ? 'Ready' : c.setup.paper ? 'Paper copy: still needed' : 'Still needed'}
        {left > 0 && <span className="cpy-needs__n">{left} of {steps.length}</span>}
      </h3>
      {done.length > 0 && (
        <ul className="cpy-needs__done" aria-label="Done before">
          {done.map((x) => (
            <li key={x.id} className="cpy-pill cpy-pill--ok">
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 6.4 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {STEP_DONE_LABEL[x.id] ?? x.id}
            </li>
          ))}
        </ul>
      )}
      {left > 0 && (
        <>
          <SetupProgress live={c.live} mode={c.runOn} paper={c.setup.paper} />
          <CopySetupSteps mode={c.runOn} live={c.live} paper={c.setup.paper} hideDone />
        </>
      )}
    </section>
  );
}

/* ============================================================= parts ====== */

/* The Settings language (dialogParts.tsx): fields with their unit, switches that say what they mean. */
/** One rule: its name, what it does in one line, its control, and an optional worked line. */
function Rule({ title, hint, note, children, wide }: { title: string; hint?: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`cpy-v2card${wide ? ' cpy-v2card--wide' : ''}`}>
      <div className="cpy-v2card__text">
        <span className="cpy-v2card__t">{title}</span>
        {(hint || note) && <span className="cpy-v2card__d">{hint}{note && <span className="cpy-rule__d">{note}</span>}</span>}
      </div>
      <div className="cpy-v2card__ctl">{children}</div>
    </div>
  );
}

function Num({ id, value, onChange, unit, placeholder, error, label }: {
  id: string; value: string; onChange: (v: string) => void; unit: string; placeholder?: string; error?: string; label: string;
}) {
  return (
    <>
      <span className={`dlg-field cpy-dfield${error ? ' is-bad' : ''}`} title={error}>
        <input id={id} value={toInputText(value)} onChange={(e) => onChange(decimalInput(e.target.value, { prev: value }))} inputMode="decimal" placeholder={placeholder} spellCheck={false} aria-label={label} aria-invalid={error ? true : undefined} />
        <span className="dlg-unit">{unit}</span>
      </span>
      {error && <small className="cpy-ferr" role="alert">{error}</small>}
    </>
  );
}

function Text({ id, value, onChange, placeholder, error, label }: {
  id: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string; label: string;
}) {
  return (
    <>
      <span className={`dlg-field cpy-dfield${error ? ' is-bad' : ''}`} title={error}>
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-label={label} aria-invalid={error ? true : undefined} />
      </span>
      {error && <small className="cpy-ferr" role="alert">{error}</small>}
    </>
  );
}

function Switch({ checked, onChange, label, on = 'On', off = 'Off' }: { checked: boolean; onChange: (v: boolean) => void; label: string; on?: string; off?: string }) {
  return <DlgSwitch on={checked} onChange={onChange} label={label} onWord={on} offWord={off} />;
}
