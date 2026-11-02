/**
 * Create a bot, or change one that runs: the strategy, the market, a preset, the few settings that matter in
 * plain words, its limits, practice or live, and what it costs per $1M before it starts. The same window
 * edits a running bot: only what the executor lets change (runtime BOT_UPDATABLE) is open there.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { checkSizes, type AlgoView, type MarketInfo } from '@copy-engine';
import { fmtUsd } from '../../format';
import { useSymbols } from '../../hooks';
import { toInputText } from '../../numStyle';
import { decimalInput } from '../numberInput';
import { Modal } from '../Modal';
import { DlgFoot, DlgRow, DlgSection, DlgSeg, DlgSwitch } from '../dialogParts';
import { MarketSelect } from '../algo/MarketSelect';
import { marketOf } from '../algo/draft';
import { useHistory } from '../algo/liveData';
import { BotIcon } from './BotIcon';
import {
  PRESETS,
  PRESET_NAMES,
  PRESET_VALUES,
  STRATEGIES,
  STRATEGY_INFO,
  costPerMillion,
  draftFor,
  draftOfSpec,
  gridRange,
  patchOf,
  presetOf,
  specOf,
  type BotDraft,
  type PresetId,
  type Strategy,
} from '../../bots/presets';
import { parseAlgoSpec } from '@copy-engine';

const HOUR = 3_600_000;
const EVERY: Array<{ value: number; label: string }> = [
  { value: HOUR, label: '1h' },
  { value: 4 * HOUR, label: '4h' },
  { value: 12 * HOUR, label: '12h' },
  { value: 24 * HOUR, label: '1d' },
];

/** One number, drawn like the ticket's Price and Amount boxes (AlgoTicket's Field): name left, value right, unit. */
function NumField({ label, value, onChange, unit, placeholder, disabled, err, optional }: {
  label: string; value: number | null; onChange: (v: number | null) => void; unit?: string; placeholder?: string; disabled?: boolean; err?: string | null;
  /** Empty means none (a limit that is off). */
  optional?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  // Follow the value when it changes from outside (a preset), not while it is being typed.
  useEffect(() => {
    if (value === null ? text !== '' : Number(text) !== value) setText(value === null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <>
      <div className={`oe-inputrow algo-in${err ? ' is-bad' : ''}${disabled ? ' is-off' : ''}`}>
        <label className="oe-inlabel" htmlFor={id}>{label}</label>
        <input
          id={id}
          className="oe-input"
          autoComplete="off"
          inputMode="decimal"
          disabled={disabled}
          value={toInputText(text)}
          placeholder={placeholder ?? (optional ? 'Off' : '')}
          aria-invalid={err ? true : undefined}
          onChange={(e) => {
            const t = decimalInput(e.target.value, { prev: text });
            setText(t);
            if (t === '' && optional) onChange(null);
            else if (Number.isFinite(Number(t)) && t !== '') onChange(Number(t));
          }}
        />
        {unit && <span className="oe-suffix">{unit}</span>}
      </div>
      {err && <p className="oe-hint algo-ferr">{err}</p>}
    </>
  );
}

/** The strategy chooser: one card each, with what it does, what it costs and what it is best for. */
export function StrategyCards({ onPick, compact }: { onPick: (s: Strategy) => void; compact?: boolean }) {
  const cost = costPerMillion(draftFor('maker'), null, null);
  return (
    <div className={`bots-strats${compact ? ' is-compact' : ''}`}>
      {STRATEGIES.map((s) => {
        const info = STRATEGY_INFO[s];
        return (
          <button key={s} type="button" className="bots-strat" onClick={() => onPick(s)}>
            <span className="bots-strat__top">
              <BotIcon strategy={s} size={20} />
              <b>{info.name}</b>
              {s === 'maker' && <span className="bots-tag">Most volume</span>}
            </span>
            <span className="bots-strat__line">{info.line}</span>
            {!compact && (
              <ul className="bots-strat__how">
                {info.how.map((h) => <li key={h}>{h}</li>)}
              </ul>
            )}
            <span className="bots-strat__foot">
              <span className="bots-strat__k">Fees per $1M</span>
              <span className="bots-strat__v">{fmtUsd(cost.fees, 0)}</span>
              <span className="bots-strat__k">Best for</span>
              <span className="bots-strat__best">{info.best}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** What the bot will do, in one sentence. */
export function describe(d: BotDraft, range: { low: number; high: number } | null): string {
  const m = d.symbol;
  const stop = [d.maxLossUsd !== null ? `stops at a loss of ${fmtUsd(d.maxLossUsd, 0)}` : null, d.volumeTargetUsd !== null ? `stops after ${fmtUsd(d.volumeTargetUsd, 0)} traded` : null].filter(Boolean).join(' or ');
  if (d.strategy === 'maker') return `Quotes ${fmtUsd(d.orderUsd, 0)} on each side of ${m} at the best price, holds at most ${fmtUsd(d.maxInventoryUsd, 0)} either way${stop ? ` and ${stop}` : ''}.`;
  if (d.strategy === 'grid') return `Rests ${fmtUsd(d.orderUsd, 0)} orders on ${d.levels} levels of ${m} between ${range ? `${fmtUsd(range.low)} and ${fmtUsd(range.high)}` : 'two prices'}${stop ? ` and ${stop}` : ''}.`;
  return `${d.side === 'buy' ? 'Buys' : 'Sells'} ${fmtUsd(d.perOrderUsd, 0)} of ${m} every ${EVERY.find((e) => e.value === d.intervalMs)?.label ?? `${Math.round(d.intervalMs / HOUR)}h`}, ${d.orders} times, resting only (${fmtUsd(d.perOrderUsd * d.orders, 0)} in all).`;
}

export function BotForm({ open, onClose, strategy: initial, editing, liveAllowed, botFeeTenths, onStart, onSave, setupWhy, onSetup }: {
  open: boolean;
  onClose: () => void;
  /** The strategy to open on; null: choose one first. */
  strategy: Strategy | null;
  /** A running bot to change (Edit), or null to create one. */
  editing: AlgoView | null;
  /** Real orders may start for this wallet (liveAlgos.ts). */
  liveAllowed: boolean;
  botFeeTenths: number;
  onStart: (spec: Record<string, unknown>) => Promise<void>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  /** The step of the executor setup still missing, in words, for practice or live. */
  setupWhy: (paper: boolean) => string | null;
  onSetup: () => void;
}) {
  const before = useMemo(() => (editing ? draftOfSpec(editing.algo.spec) : null), [editing]);
  const [strategy, setStrategy] = useState<Strategy | null>(initial);
  const [d, setD] = useState<BotDraft>(() => before ?? draftFor(initial ?? 'maker'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setStrategy(editing ? before!.strategy : initial);
    setD(before ?? draftFor(initial ?? 'maker'));
    setError(null);
  }, [open, initial, editing, before]);

  const { byName } = useSymbols('perps');
  const sym = byName.get(d.symbol);
  const market: MarketInfo | null = sym ? marketOf(sym) : null;
  const hist = useHistory(open && strategy ? d.symbol : null, open, 10);
  const mark = hist?.length ? hist[hist.length - 1]!.p : null;
  const range = d.strategy === 'grid' ? gridRange(d, mark) : null;
  const cost = costPerMillion(d, market, mark, botFeeTenths);
  const preset = presetOf(d);
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));

  // The spec the wallet will sign, checked as the executor checks it: the parser, then SoDEX's sizes at the mark.
  const check = useMemo(() => {
    if (editing) return { errors: [] as string[] };
    try {
      const spec = parseAlgoSpec(specOf(d, mark));
      if (!market) return { errors: [] };
      return { errors: checkSizes(spec, market, { price: mark, seed: 1, now: Date.now() }).errors };
    } catch (e) {
      return { errors: [e instanceof Error ? e.message : String(e)] };
    }
  }, [d, mark, market, editing]);

  const paper = editing ? editing.algo.spec.paper : !liveAllowed || d.paper;
  const why = setupWhy(paper);
  const patch = before ? patchOf(before, d) : null;
  const can = editing ? !!patch && Object.keys(patch).length > 0 : !check.errors.length && !why && (d.strategy !== 'grid' || !!range);
  const locked = !!editing;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await onSave(patch!);
      else await onStart(specOf({ ...d, paper }, mark));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${STRATEGY_INFO[d.strategy].name.toLowerCase()}` : strategy ? `New ${STRATEGY_INFO[strategy].name.toLowerCase()}` : 'New bot';

  let body: ReactNode;
  if (!strategy) {
    body = (
      <>
        <p className="bots-sub">Pick a strategy. Every one rests its orders on the book, so you pay the maker fee and never the spread.</p>
        <StrategyCards compact onPick={(s) => { setStrategy(s); setD(draftFor(s, 'balanced', d.symbol)); }} />
      </>
    );
  } else {
    const info = STRATEGY_INFO[d.strategy];
    body = (
      <>
        <div className="bots-formhead">
          <BotIcon strategy={d.strategy} size={22} />
          <span>
            <b>{info.name}</b>
            <small>{info.line}</small>
          </span>
          {!editing && <button type="button" className="bots-link" onClick={() => setStrategy(null)}>Change</button>}
        </div>

        <DlgSection label="Market">
          <DlgRow title="Market" line={locked ? 'A running bot keeps its market.' : info.best}>
            {locked ? <span className="bots-fixed">{d.symbol}</span> : <MarketSelect value={d.symbol} onChange={(v) => set({ symbol: v, low: null, high: null })} compact />}
          </DlgRow>
          {!locked && (
            <DlgRow title="Preset" line={preset ? 'Change any setting below to make it your own.' : 'Your own settings.'}>
              <DlgSeg<PresetId | 'custom'>
                label="Preset"
                value={preset ?? 'custom'}
                options={[...PRESETS.map((p) => ({ value: p as PresetId | 'custom', label: PRESET_NAMES[p] })), ...(preset ? [] : [{ value: 'custom' as const, label: 'Custom' }])]}
                onChange={(p) => p !== 'custom' && set({ ...PRESET_VALUES[d.strategy][p], low: null, high: null })}
              />
            </DlgRow>
          )}
        </DlgSection>

        <DlgSection label="How it trades">
          {d.strategy === 'maker' && (
            <>
              <DlgRow title="Order size" line="Each buy and each sell it keeps resting." stack>
                <NumField label="Each side" value={d.orderUsd} onChange={(v) => v !== null && set({ orderUsd: v })} unit="USD" />
              </DlgRow>
              <DlgRow title="Inventory cap" line="The most it holds either way. At the cap it only unwinds." stack>
                <NumField label="Up to" value={d.maxInventoryUsd} onChange={(v) => v !== null && set({ maxInventoryUsd: v })} unit="USD" />
              </DlgRow>
              <DlgRow title="Distance from the mid" line="Each quote rests at least this far from the mid. At 1.7 bp every round trip pays its own fees: fewer fills, lower cost. 0: at the best price." stack>
                <NumField label="At least" value={d.edgeBps} onChange={(v) => set({ edgeBps: v ?? 0 })} unit="bp" />
              </DlgRow>
              <DlgRow title="Unwind first" line="While it holds, the side that would add more steps back this many ticks at the cap." stack>
                <NumField label="Skew" value={d.skewTicks} onChange={(v) => v !== null && set({ skewTicks: Math.round(v) })} unit="ticks" />
              </DlgRow>
              <DlgRow title="Follow the price" line="Moves a quote once the best price is this far away, at most every few seconds." stack>
                <div className="bots-pair">
                  <NumField label="After" value={d.chaseTicks} onChange={(v) => v !== null && set({ chaseTicks: Math.max(1, Math.round(v)) })} unit="ticks" />
                  <NumField label="Every" value={d.minRepriceMs / 1000} onChange={(v) => v !== null && set({ minRepriceMs: Math.round(v * 1000) })} unit="s" />
                </div>
              </DlgRow>
            </>
          )}
          {d.strategy === 'grid' && (
            <>
              <DlgRow title="Range" line={locked ? 'A running grid keeps its range.' : `±${(d.rangePct * 100).toFixed(1)}% around the price now${mark ? ` (${fmtUsd(mark)})` : ''}, or your own prices.`} stack>
                <div className="bots-pair">
                  <NumField label="Low" value={range?.low ?? null} disabled={locked} onChange={(v) => set({ low: v, high: d.high ?? range?.high ?? null })} unit="USD" />
                  <NumField label="High" value={range?.high ?? null} disabled={locked} onChange={(v) => set({ high: v, low: d.low ?? range?.low ?? null })} unit="USD" />
                </div>
              </DlgRow>
              <DlgRow title="Levels" line="More levels: smaller steps, more round trips." stack>
                <NumField label="Levels" value={d.levels} disabled={locked} onChange={(v) => v !== null && set({ levels: Math.round(v) })} />
              </DlgRow>
              <DlgRow title="Order size" line="Each level's order." stack>
                <NumField label="Each level" value={d.orderUsd} onChange={(v) => v !== null && set({ orderUsd: v })} unit="USD" />
              </DlgRow>
              <DlgRow title="Out of the range" line="Keep its orders and wait for the price to come back, or stop.">
                <DlgSeg label="Out of the range" value={d.outOfRange} options={[{ value: 'wait', label: 'Wait' }, { value: 'stop', label: 'Stop' }]} onChange={(v) => set({ outOfRange: v })} />
              </DlgRow>
            </>
          )}
          {d.strategy === 'dca' && (
            <>
              <DlgRow title="Side" line={locked ? 'A running DCA keeps its schedule; only its name changes.' : 'Build a long (buy) or a short (sell).'}>
                <DlgSeg label="Side" value={d.side} disabled={locked} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} onChange={(v) => set({ side: v })} />
              </DlgRow>
              <DlgRow title="Every" line="How often it places an order.">
                <DlgSeg label="Every" value={d.intervalMs} disabled={locked} options={EVERY} onChange={(v) => set({ intervalMs: v })} />
              </DlgRow>
              <DlgRow title="Amount" line="Each order, and how many." stack>
                <div className="bots-pair">
                  <NumField label="Each" value={d.perOrderUsd} disabled={locked} onChange={(v) => v !== null && set({ perOrderUsd: v })} unit="USD" />
                  <NumField label="Orders" value={d.orders} disabled={locked} onChange={(v) => v !== null && set({ orders: Math.round(v) })} />
                </div>
              </DlgRow>
            </>
          )}
        </DlgSection>

        {d.strategy !== 'dca' && (
          <DlgSection label="Limits">
            <DlgRow title="Loss limit" line="Stops once its net PnL, after every fee, is this far below zero." stack>
              <NumField label="Stop at" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
            </DlgRow>
            <DlgRow title="Volume target" line="Stops once it traded this much. Empty: runs until you stop it." stack>
              <NumField label="Stop after" value={d.volumeTargetUsd} optional onChange={(v) => set({ volumeTargetUsd: v })} unit="USD" />
            </DlgRow>
            <DlgRow title="When it stops" line="Close what it holds (resting first, a capped taker after a minute), or keep it.">
              <DlgSeg label="When it stops" value={d.onStop} options={[{ value: 'close', label: 'Close' }, { value: 'keep', label: 'Keep' }]} onChange={(v) => set({ onStop: v })} />
            </DlgRow>
          </DlgSection>
        )}

        <DlgSection label="Run">
          <DlgRow title="Name" line="Optional." stack>
            <div className="oe-inputrow algo-in">
              <input className="oe-input bots-name" maxLength={40} placeholder={info.name} value={d.label} onChange={(e) => set({ label: e.target.value })} aria-label="Name" />
            </div>
          </DlgRow>
          {!editing && (
            <DlgRow
              title="Practice"
              line={liveAllowed ? 'Runs against the real book and sends nothing. Turn off to trade with real orders.' : 'Live bots open soon. A practice bot runs against the real book and sends nothing.'}
            >
              <DlgSwitch on={paper} disabled={!liveAllowed} onChange={(on) => set({ paper: on })} label="Practice" />
            </DlgRow>
          )}
        </DlgSection>

        <div className="bots-cost" aria-label="What it costs per $1M traded">
          <div className="bots-cost__row"><span>SoDEX maker fee</span><span>{fmtUsd(cost.trade, 0)}</span></div>
          <div className="bots-cost__row"><span>ValueDesk fee ({(botFeeTenths / 10).toFixed(1)} bp)</span><span>{fmtUsd(cost.builder, 0)}</span></div>
          <div className="bots-cost__row"><span>Spread</span><span>{fmtUsd(0, 0)} <small>never paid: every order rests</small></span></div>
          {cost.edge !== null && <div className="bots-cost__row is-pos"><span>Grid steps earn</span><span>−{fmtUsd(cost.edge, 0)}</span></div>}
          <div className="bots-cost__row is-total"><span>Per $1M traded{cost.edge !== null ? ', before price moves' : ', before price moves and spread earned'}</span><span className={cost.net < 0 ? 'pos' : ''}>{cost.net < 0 ? `earns ${fmtUsd(-cost.net, 0)}` : fmtUsd(cost.net, 0)}</span></div>
        </div>

        <p className="bots-summary">{describe(d, range)}</p>
        {check.errors.map((e) => <p key={e} className="fx-note fx-note--err" role="alert">{e}</p>)}
        {why && (
          <p className="fx-note">
            {why} <button type="button" className="bots-link" onClick={onSetup}>Set up</button>
          </p>
        )}
        {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      className="fx bots-form"
      dismissOnBackdrop={!busy}
      footer={
        <DlgFoot left={strategy && !editing ? <span className="bots-foot-note">One wallet signature. Stop it any time.</span> : undefined}>
          <button type="button" className="dlg-btn" disabled={busy} onClick={onClose}>Cancel</button>
          {strategy && (
            <button type="button" className="dlg-btn is-go" disabled={!can || busy} onClick={() => void submit()}>
              {busy ? (editing ? 'Saving…' : 'Starting…') : editing ? 'Save changes' : paper ? 'Start practice bot' : 'Start bot'}
            </button>
          )}
        </DlgFoot>
      }
    >
      <div className="dlg bots-dlg">{body}</div>
    </Modal>
  );
}

