/**
 * "Copy 0x5e13…2607": the copy setup as two steps over the trader grid.
 *
 *   1/2  Your rules    the trader's figures, a replay of their last fills under
 *                      these rules, then sizing and limits (advanced ones folded)
 *   2/2  Where it runs this browser / the ValueDesk executor / self-hosted, how
 *                      much the copy trades with, and the signatures that mode
 *                      still needs (copy/CopySetupSheet.tsx CopySetupSteps)
 *
 * The owner's reference is Hyperdash's copytrade dialog (settings, then the
 * wallet). Every number is the setup form's (setup.ts) and the backtest's
 * (useCopy.ts); nothing here starts anything until "Start copying", and that
 * needs every step of the mode done by the follower's own signatures.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { COPY_FEE_MAX, EEA_MAX_LEVERAGE, feePercent, regionPolicy } from '@copy-engine';
import { Modal } from '../Modal';
import { LoadFailed } from '../LoadFailed';
import { DASH, fmt, fmtUsd, shortAddr } from '../../format';
import { notify } from '../../toast';
import { WalletError } from '../../wallet';
import { VENUE_LABEL, vsApi, type TraderRow } from '../../vsApi';
import { CopySetupSteps, MODE_HINT, MODE_LABEL, copyReady } from '../../copy/CopySetupSheet';
import { startCopy, supportsCounter, type CopyModeId } from '../../copy/live';
import { EquityChart } from './EquityChart';
import { Avatar, holdPeeks } from './TraderCard';
import { coinOf } from './sim';
import {
  SIZING_MODES, TAKER_RATE, fmtRate, fmtSignedPct, fmtSignedUsd, workedExample, type SetupField, type SetupState,
} from './setup';
import { FILL_LIMIT, type CopyContext } from './useCopy';

const isRejection = (e: unknown): boolean => e instanceof WalletError && /reject|denied|cancel/i.test(e.message);

const MODES: ReadonlyArray<{ id: CopyModeId; badge: string }> = [
  { id: 'browser', badge: 'While this tab is open' },
  { id: 'hosted', badge: 'Around the clock · Tokyo' },
  { id: 'self', badge: 'Your own machine' },
];

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
  const [step, setStep] = useState<1 | 2>(1);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setStep(1); setError(null); }
  }, [open, c.leader]);
  // The replay's fill walk goes first: the grid's card reads wait while the dialog is open.
  useEffect(() => (open ? holdPeeks() : undefined), [open]);

  if (!c.leader) return null;
  const counter = c.setup.direction === 'counter';
  const title = (
    <span className="cpy-mtitle">
      <Avatar address={c.leader} size={22} />
      {counter ? 'Counter-trade' : 'Copy'} {shortAddr(c.leader)}
      <span className="cpy-mtitle__venue">{VENUE_LABEL[c.venue]}</span>
    </span>
  );
  // A counter-trade needs a copier that knows the direction (copy/live.ts supportsCounter).
  const counterBlocked = counter && !supportsCounter(c.live, c.runOn);
  const ready = copyReady(c.live, c.runOn, c.setup.paper) && !counterBlocked;
  const errs = [...Object.values(c.parsed.errors), ...(Object.keys(c.parsed.errors).length ? [] : c.copyErrors)] as string[];

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
      <span className="cpy-progress" aria-label={`Step ${step} of 2`}>
        <span className="cpy-progress__bar"><i style={{ width: step === 1 ? '50%' : '100%' }} /></span>
        <span className="cpy-progress__n">{step}/2</span>
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
              className="fx-cta"
              disabled={!ready || !c.copySettings || starting}
              title={counterBlocked ? 'This copier cannot counter-trade' : !ready ? 'Finish the steps above first' : undefined}
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
    <Modal open={open} title={title} onClose={onClose} size="md" className="fx cpy-modal" footer={footer} onBack={step === 2 ? () => setStep(1) : undefined}>
      {step === 1 ? <RulesStep c={c} row={row} errs={errs} /> : <RunStep c={c} />}
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
  const set = (k: SetupField) => (v: string) => c.patchSetup({ [k]: v } as Partial<SetupState>);
  const e = c.parsed.errors;
  const example = workedExample(c.parsed, c.profile.data ?? null, (sym) => coinOf(c.venue, sym));
  const eea = regionPolicy(c.live.terms?.country ?? null, c.live.viewerCountry).maxLeverage === EEA_MAX_LEVERAGE;

  return (
    <div className="cpy-step">
      <p className="cs-sub">{c.setup.direction === 'counter' ? 'Set how you trade against this trader, in your own account.' : "Set how this trader's trades are copied into your account."}</p>

      <dl className="cpy-stats">
        <div><dt>Equity</dt><dd>{av === null ? DASH : fmtUsd(av, 0)}</dd></div>
        <div><dt>30D PnL</dt><dd className={pnl30 === null ? '' : pnl30 >= 0 ? 'pos' : 'neg'}>{fmtSignedUsd(pnl30, 0)}</dd></div>
        <div><dt>Win rate</dt><dd className={wr !== null && wr >= 0.5 ? 'pos' : ''}>{wr === null ? DASH : `${Math.round(wr * 100)}%`}</dd></div>
      </dl>

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
            {d === 'copy' ? 'Copy' : 'Counter-trade'}
          </button>
        ))}
      </div>
      {c.setup.direction === 'counter' && (
        <p className="cpy-dir__note">
          You take the opposite side of every trade: their long is your short, their close is your close. You gain when they
          lose, and lose when they win - a good record is your risk here.
        </p>
      )}

      <Replay c={c} />

      <h3 className="cpy-h">Your rules</h3>
      <div className="cpy-rows">
        <Rule
          title="Sizing"
          desc={example ? <>{example.text}{example.caveat && <span className="cpy-caveat"> {example.caveat}</span>}</> : SIZING_MODES.find((m) => m.v === c.setup.mode)?.hint}
          wide
        >
          <span className="cpy-seg" role="group" aria-label="Sizing">
            {SIZING_MODES.map((m) => (
              <button key={m.v} type="button" title={m.hint} aria-pressed={c.setup.mode === m.v} className={c.setup.mode === m.v ? 'is-on' : undefined} onClick={() => c.patchSetup({ mode: m.v })}>
                {SIZING_LABEL[m.v] ?? m.label}
              </button>
            ))}
          </span>
          {c.setup.mode === 'fixedRatio' && <Num id={`${uid}-ratio`} value={c.setup.ratioPct} onChange={set('ratioPct')} unit="%" error={e.ratioPct} label="Percent of their size" />}
          {c.setup.mode === 'fixedNotional' && <Num id={`${uid}-notional`} value={c.setup.notional} onChange={set('notional')} unit="USDC" error={e.notional} label="Per trade" />}
        </Rule>
        <Rule title="Max leverage" desc={eea ? `Caps every copied position. In the EU and EEA copies are capped at ${EEA_MAX_LEVERAGE}x.` : 'Caps every copied position, even when the trader uses more.'}>
          <Num id={`${uid}-lev`} value={c.setup.maxLeverage} onChange={set('maxLeverage')} unit="x" error={e.maxLeverage} label="Max leverage" />
        </Rule>
        <Rule title="Max position" desc="The largest a single copied position may get, in dollars.">
          <Num id={`${uid}-maxpos`} value={c.setup.maxPosition} onChange={set('maxPosition')} unit="USDC" error={e.maxPosition} label="Max position" />
        </Rule>
        <Rule title="Max entry deviation" desc={`How far from the trader's price a copy may fill. ${c.setup.slippageBps || '0'} bps = ${(Number(c.setup.slippageBps || 0) / 100).toFixed(2)}%.`}>
          <Num id={`${uid}-slip`} value={c.setup.slippageBps} onChange={set('slippageBps')} unit="bps" error={e.slippageBps} label="Slippage cap" />
        </Rule>
        <Rule title="Only copy newly opened positions" desc="Skips positions the trader already holds when the copy starts.">
          <Switch checked={!c.setup.copyExisting} onChange={(v) => c.patchSetup({ copyExisting: !v })} label="Only copy newly opened positions" />
        </Rule>
        <Rule title="Paper copy" desc="Follows the trader live and keeps the books, but sends nothing to SoDEX. No fee, no key.">
          <Switch checked={c.setup.paper} onChange={(v) => c.patchSetup({ paper: v })} label="Paper copy" />
        </Rule>
      </div>

      <details className="cpy-adv">
        <summary>Risk controls and markets</summary>
        <div className="cpy-rows">
          <Rule title="Stop loss" desc="Closes a copied position when it has lost this share of its margin. Empty = off.">
            <Num id={`${uid}-sl`} value={c.setup.stopLoss} onChange={set('stopLoss')} unit="%" placeholder="off" error={e.stopLoss} label="Stop loss" />
          </Rule>
          <Rule title="Take profit" desc="Closes a copied position at this gain on its margin. Empty = off.">
            <Num id={`${uid}-tp`} value={c.setup.takeProfit} onChange={set('takeProfit')} unit="%" placeholder="off" error={e.takeProfit} label="Take profit" />
          </Rule>
          <Rule title="Drawdown stop" desc="Closes everything and stops the copy when its equity falls this far from its peak.">
            <Num id={`${uid}-dd`} value={c.setup.drawdown} onChange={set('drawdown')} unit="%" placeholder="off" error={e.drawdown} label="Drawdown stop" />
          </Rule>
          <Rule title="Only copy these coins" desc="Comma separated, e.g. BTC, ETH. Empty = every coin.">
            <Text id={`${uid}-allow`} value={c.setup.allow} onChange={set('allow')} placeholder="all coins" error={e.allow} label="Only copy" />
          </Rule>
          <Rule title="Never copy these coins" desc="Comma separated.">
            <Text id={`${uid}-deny`} value={c.setup.deny} onChange={set('deny')} placeholder="none" error={e.deny} label="Never copy" />
          </Rule>
          <Rule title="Isolated margin" desc="Each copied position has its own margin, so one cannot drain the others.">
            <Switch checked={c.setup.marginMode === 'isolated'} onChange={(v) => c.patchSetup({ marginMode: v ? 'isolated' : 'cross' })} label="Isolated margin" />
          </Rule>
          {c.runOn === 'browser' && (
            <Rule title="Ask before each trade" desc="Every copied order waits for your yes in this tab (60 seconds). Browser copies only.">
              <Switch checked={c.setup.confirmEach} onChange={(v) => c.patchSetup({ confirmEach: v })} label="Ask before each trade" />
            </Rule>
          )}
        </div>
        <button type="button" className="fx-link cpy-reset" onClick={c.resetSetup}>Back to the default rules</button>
      </details>

      {errs.length > 0 && <p className="fx-note fx-note--err">{errs.join(' ')}</p>}
    </div>
  );
}

/** The backtest, small: your copy against the trader, scaled to your allocation. */
function Replay({ c }: { c: CopyContext }) {
  const r = c.sim.result;
  const windows = [{ v: '7d', label: '7D' }, { v: '30d', label: '30D' }] as const;
  const head = (
    <div className="cpy-replay__head">
      <span className="cpy-replay__k">{c.setup.direction === 'counter' ? 'Your counter-trade, replayed' : 'Your copy, replayed'}</span>
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
  else if (c.fills.error) body = c.fills.code === 'not_available' ? <p className="cpy-replay__note">{VENUE_LABEL[c.venue]} fills are not available here, so there is nothing to replay.</p> : <LoadFailed what="Fills" onRetry={c.fills.reload} />;
  else if (Object.keys(c.parsed.errors).length) body = <p className="cpy-replay__note">Fix the rules below to run the replay.</p>;
  else if (!r || r.copiedFills + r.skippedFills === 0) body = <p className="cpy-replay__note">No trades in this window to replay.</p>;
  else {
    body = (
      <>
        <div className="cpy-replay__fig">
          <span className={`cpy-replay__roi ${r.roi >= 0 ? 'pos' : 'neg'}`}>{fmtSignedPct(r.roi)}</span>
          <span className="cpy-replay__sub">
            {fmtSignedUsd(r.pnl)} on {fmtUsd(r.startEquity, 0)} · trader {fmtSignedPct(r.leaderRoi)} · {fmt(r.copiedFills, 0)} of {fmt(r.copiedFills + r.skippedFills, 0)} fills copied
          </span>
        </div>
        <div className="pf copy cpy-replay__chart">
          <EquityChart you={r.equityCurve} leader={r.leaderCurve} base={r.startEquity} />
        </div>
        <div className="cpy-replay__legend" aria-hidden="true">
          <span><i className="copy-swatch copy-swatch--you" />You</span>
          <span><i className="copy-swatch copy-swatch--leader" />Trader, scaled to you</span>
        </div>
      </>
    );
  }
  return (
    <section className="cpy-replay">
      {head}
      {body}
      <p className="cpy-replay__fine">A replay of past fills at their price plus your full slippage cap, with fees. Not a forecast.</p>
    </section>
  );
}

/* ============================================================ step 2 ====== */

function RunStep({ c }: { c: CopyContext }) {
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
  const fee = c.setup.paper ? 0 : COPY_FEE_MAX / 100_000;
  const chips = useMemo(() => [0.25, 0.5, 0.75, 1], []);

  return (
    <div className="cpy-step">
      <p className="cs-sub">Choose where the copier runs and how much it trades with.</p>

      <div className="cpy-modes" role="radiogroup" aria-label="Where the copier runs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={c.runOn === m.id}
            className={`cpy-mode${c.runOn === m.id ? ' is-on' : ''}`}
            onClick={() => c.setRunOn(m.id)}
          >
            <span className="cpy-mode__t">{MODE_LABEL[m.id]}</span>
            <span className="cpy-mode__b">{m.badge}</span>
            <span className="cpy-mode__d">{MODE_HINT[m.id]}</span>
          </button>
        ))}
      </div>

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

      <div className="cpy-alloc">
        <label className="cpy-alloc__k" htmlFor={`${uid}-alloc`}>Trade with</label>
        <span className={`cpy-alloc__box${c.parsed.errors.allocation ? ' is-bad' : ''}`}>
          <input
            id={`${uid}-alloc`}
            value={c.setup.allocation}
            onChange={(e) => c.patchSetup({ allocation: e.target.value })}
            inputMode="decimal"
            placeholder="1,000"
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
        <p className="fx-note">
          The copy sizes its positions against this amount. It stays in your SoDEX account: nothing is moved, and other trades can use the
          same balance.
        </p>
      </div>

      <h3 className="cpy-h">{c.setup.paper ? 'Paper copy: what it needs' : 'What it needs'}</h3>
      <CopySetupSteps mode={c.runOn} live={c.live} paper={c.setup.paper} />

      <dl className="cpy-fees">
        <div><dt>Copy fee</dt><dd>{c.setup.paper ? 'none (paper)' : `up to ${feePercent(COPY_FEE_MAX)} per copied order`}</dd></div>
        <div><dt>SoDEX taker fee</dt><dd>{fmtRate(taker)}</dd></div>
        <div><dt>Round trip, est.</dt><dd>{fmtRate(taker * 2 + fee * 2)} + slippage</dd></div>
      </dl>
      <p className="fx-note">
        You choose the trader and every rule; ValueDesk never holds your funds. Not investment advice: past results do not predict future
        ones. <a className="fx-link" href="/copy-terms" target="_blank" rel="noopener">Copy terms and risks</a>.
      </p>
    </div>
  );
}

/* ============================================================= parts ====== */

function Rule({ title, desc, children, wide }: { title: string; desc: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`cpy-rule${wide ? ' cpy-rule--wide' : ''}`}>
      <div className="cpy-rule__text">
        <span className="cpy-rule__t">{title}</span>
        <span className="cpy-rule__d">{desc}</span>
      </div>
      <div className="cpy-rule__ctl">{children}</div>
    </div>
  );
}

function Num({ id, value, onChange, unit, placeholder, error, label }: {
  id: string; value: string; onChange: (v: string) => void; unit: string; placeholder?: string; error?: string; label: string;
}) {
  return (
    <span className={`cpy-num${error ? ' is-bad' : ''}`} title={error}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder={placeholder} spellCheck={false} aria-label={label} aria-invalid={error ? true : undefined} />
      <span className="cpy-num__u">{unit}</span>
    </span>
  );
}

function Text({ id, value, onChange, placeholder, error, label }: {
  id: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string; label: string;
}) {
  return (
    <span className={`cpy-num cpy-num--text${error ? ' is-bad' : ''}`} title={error}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-label={label} aria-invalid={error ? true : undefined} />
    </span>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`cpy-switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}
