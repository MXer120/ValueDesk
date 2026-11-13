/**
 * A bot's settings in three parts (owner 2026-11-07: "too simple for us settings wise"; 2026-11-08: three sub-steps
 * in New bot, quoting simple with advanced settings):
 *
 *   Size & risk   order size, max holding, loss limit, volume target, run time, on stop
 *   Quoting       rest, follow the oracle, quote at; Advanced: distance from oracle, pull distance, levels, re-price,
 *                 chase, skew, move guard
 *   Safeguards    volatility gate (oracle moves now), flow gate (uninformed flow away), trading hours (pause in or
 *                 trade only in set hours, over a chart of hourly moves: HoursGate), news gate (US releases), spread
 *
 * The oracle is the price the bot quotes off: Binance futures' mid, times SoDEX's gap to it.
 * New bot shows one part per sub-step (`part`); a bot's Settings tab shows them as tabs. R10's values are marked
 * and one press away. Built from the Bots kit.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Term } from './Term';
import { fmtUsd } from '../../format';
import { FLOW_DEFAULT, GATE_DEFAULT, NEWS_DEFAULT, QUIET_PRESETS, R10, botNeedUsd, type BotDraft } from '../../bots/presets';
import type { AlgoSpec } from '@copy-engine';
import { HoursGate } from './HoursGate';
import { RECIPE, recipeOfDraft } from '../../bots/recipes';
import type { BotLeverage } from '../../bots/leverage';
import { Button, Field, Icon, NumberField, Segmented, Slider, StatusPill, Switch, Tabs, TextInput } from './kit/kit';
import { useTickers } from '../../hooks';

const TARGETS = [null, 50_000, 250_000, 1_000_000] as const;
const tgtKey = (v: number | null): string => (v === null ? 'none' : TARGETS.includes(v as never) ? String(v) : 'custom');
export type Sec = 'size' | 'quote' | 'guard';
export const SEC_NAMES: Record<Sec, string> = { size: 'Size & risk', quote: 'Quoting', guard: 'Safeguards' };

function Row({ label, hint, children, wide, tag }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean; tag?: ReactNode }) {
  return (
    <div className={`bots-f${wide ? ' is-wide' : ''}`}>
      <div className="bots-f__l"><span>{label}</span>{tag}</div>
      <div className="bots-f__c">{children}</div>
      {hint && <p className="bots-f__h">{hint}</p>}
    </div>
  );
}

/** "Default" when a field holds the measured default, else a reset to it. */
function R10Tag({ on, reset }: { on: boolean; reset: () => void }) {
  return on ? <span className="bots-r10">Default</span> : <button type="button" className="bots-r10 is-off" onClick={reset} title="Back to the default">Reset</button>;
}

const SPREAD_PICKS = [10, 20, 50];

/** The spread limit: 10, 20 (the default) or 50 bp, or any whole number of bp typed in (owner 2026-11-08). */
function SpreadPick({ d, set, symbol }: { d: BotDraft; set: (p: Partial<BotDraft>) => void; symbol?: string | null }) {
  const v = d.maxSpreadBps ?? 20;
  const [custom, setCustom] = useState(!SPREAD_PICKS.includes(v));
  // The market's spread now, from SoDEX's book (owner 2026-11-09: KORU's ~29 bp book never quoted under a 20 bp
  // limit, and the bot said only "held"). The tickers poll is shared with the rest of the app.
  const tickers = useTickers('perps', { pollMs: 15_000, enabled: !!symbol });
  const t = symbol ? (tickers.data?.tickers ?? []).find((x) => x.symbol === symbol) : undefined;
  const bid = Number(t?.bidPx);
  const ask = Number(t?.askPx);
  const now = bid > 0 && ask > bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : null;
  const coin = symbol ? symbol.replace(/-USD$/, '') : '';
  return (
    <>
      <div className="bots-spreadpick">
        <Segmented label="Pause if the spread is over" value={custom ? 'custom' : String(v)} onChange={(x) => { if (x === 'custom') setCustom(true); else { setCustom(false); set({ maxSpreadBps: Number(x) }); } }} options={[...SPREAD_PICKS.map((b) => ({ value: String(b), label: `${b} bp` })), { value: 'custom', label: 'Custom' }]} />
        {custom && <NumberField label="Spread limit" hideLabel value={v} onChange={(x) => x !== null && x >= 1 && set({ maxSpreadBps: Math.round(x) })} unit="bp" />}
      </div>
      {now !== null && (
        <p className={`bots-note${now > v ? ' is-warn' : ''}`}>
          {coin}'s spread is {now.toFixed(1)} bp now
          {now > v ? `: over this limit, so the bot would wait. Raise it to at least ${Math.ceil((now * 1.2) / 5) * 5} bp, or turn the limit off.` : '.'}
        </p>
      )}
    </>
  );
}

/**
 * The leverage the bot sets on its market before its first order (owner 2026-11-08), and the margin that makes it set
 * aside. With a position open on the market SoDEX takes a higher leverage (verified live) but a lower one is not
 * verified: the row says so, and the position's own margin stays as it is.
 */
function LeverageRow({ d, set, lev, max }: { d: BotDraft; set: (p: Partial<BotDraft>) => void; lev: BotLeverage; max: number }) {
  // Before the account answered the bot has no leverage yet: the margin then counts 1x, as the executor does.
  const now = d.leverage === null ? null : Math.min(max, d.leverage);
  const shown = now ?? 1;
  // A hand-set leverage turns Auto off; Auto puts it back to what the sizing needs (autoLeverage).
  const pick = (x: number) => set({ leverage: Math.max(1, Math.min(max, Math.round(x))), leverageAuto: false });
  const picks = [1, 2, 3, 5, 10, 20].filter((x) => x <= max);
  const spec = (d.strategy === 'grid'
    ? { kind: 'grid', orderUsd: d.orderUsd, levels: d.levels, leverage: now }
    : { kind: 'mm', maxInventoryUsd: d.maxInventoryUsd, orderUsd: d.orderUsd, levels: d.ladder, leverage: now }) as unknown as AlgoSpec;
  const margin = botNeedUsd(spec);
  const lower = lev.open && lev.held !== null && now !== null && now < lev.held;
  return (
    <Row
      label={<Term t="margin">Leverage</Term>}
      wide
      tag={d.leverageAuto ? <span className="bots-r10">Auto</span> : <button type="button" className="bots-r10 is-off" onClick={() => set({ leverageAuto: true })} title="Back to the leverage the sizing needs">Auto</button>}
      hint={<>Sets aside about <b>{fmtUsd(margin, 0)}</b> of margin {now === null ? 'at 1× (reading your account)' : `at ${now}×`}. {d.leverageAuto ? 'Auto: the lowest leverage at which this fits your free margin.' : 'Set by you.'} Up to {max}× on this market.</>}
    >
      <div className="bots-sizeline">
        <Slider label="Leverage slider" value={shown} min={1} max={max} step={1} onChange={pick} minLabel="1×" maxLabel={`${max}×`} />
        <NumberField label="Leverage" hideLabel value={now} onChange={(x) => x !== null && pick(x)} unit="×" className="bots-sizeline__n" />
      </div>
      <div className="bots-levpicks">{picks.map((x) => <button key={x} type="button" className={`bots-levpick${now === x ? ' is-on' : ''}`} aria-pressed={now === x} onClick={() => pick(x)}>{x}×</button>)}</div>
      {lev.open && (
        <p className={`bots-note${lower ? ' is-warn' : ''}`} role="note">
          <Icon name="warning" size={13} />
          {lower
            ? `A position is open on this market at ${lev.held}×. SoDEX may refuse a lower leverage on it until it is closed; the bot then quotes at ${lev.held}×.`
            : `A position is open on this market${lev.held !== null ? ` at ${lev.held}×` : ''}. A higher leverage applies to it too (SoDEX takes it, its margin stays as it is).`}
        </p>
      )}
    </Row>
  );
}

/** A card for one safeguard: title, its switch, a line, and its settings when on. */
function Guard({ title, line, on, set, children, icon }: { title: string; line: string; on: boolean; set: (v: boolean) => void; children?: ReactNode; icon: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <section className={`bots-guard${on ? ' is-on' : ''}`}>
      <header className="bots-guard__h">
        <span className={`tf-tile${on ? ' is-positive' : ''}`}><Icon name={icon} size={16} /></span>
        <span className="bots-guard__t"><b>{title}</b><small>{line}</small></span>
        <Switch checked={on} onChange={set} label={title} hideLabel />
      </header>
      {on && children && <div className="bots-guard__b">{children}</div>}
    </section>
  );
}

/** Quick ranges around the price now (± this share). */
const RANGE_CHIPS = [0.01, 0.02, 0.05, 0.1];
const sig = (x: number): number => Number(x.toPrecision(6));
/** Which quick range the range is (±p around the mark, within 2% of p), else 'x'. */
function rangeKey(r: { low: number; high: number } | null, mark: number): string {
  if (!r) return 'x';
  const p = (r.high - r.low) / 2 / mark;
  const mid = (r.high + r.low) / 2;
  const hit = RANGE_CHIPS.find((c) => Math.abs(p - c) <= c * 0.02 && Math.abs(mid - mark) <= mark * c * 0.05);
  return hit !== undefined ? String(hit) : 'x';
}
const DIR_HINT: Record<'neutral' | 'long' | 'short', string> = {
  neutral: 'Buys below the price and sells above from the start: it may end up holding either way.',
  long: 'Buys as the price falls and sells each buy one level up. It never goes short; it holds coins while the price is low.',
  short: 'Sells as the price rises and buys each one back one level down. It never goes long; it is short while the price is high.',
};

/** What is wrong with a grid's range and stop prices (null: fine). */
export function gridProblems(d: Pick<BotDraft, 'strategy' | 'stopAbove' | 'stopBelow' | 'triggerPrice'>, range: { low: number; high: number } | null, mark: number | null): { range: string | null; stop: string | null } {
  if (d.strategy !== 'grid') return { range: null, stop: null };
  const rangeE = range && range.high <= range.low ? 'The high must be above the low.' : null;
  const ref = d.triggerPrice ?? mark;
  let stop: string | null = null;
  if (d.stopAbove !== null && d.stopBelow !== null && d.stopAbove <= d.stopBelow) stop = 'Stop above must be higher than stop below.';
  else if (ref !== null && d.stopAbove !== null && d.stopAbove <= ref) stop = `Stop above (${fmtUsd(d.stopAbove)}) is not above the ${d.triggerPrice ? 'start' : 'current'} price: it would stop at once.`;
  else if (ref !== null && d.stopBelow !== null && d.stopBelow >= ref) stop = `Stop below (${fmtUsd(d.stopBelow)}) is not below the ${d.triggerPrice ? 'start' : 'current'} price: it would stop at once.`;
  return { range: rangeE, stop };
}

export function BotSettings({ d, set, range, mark, liveAllowed, noLead, hidePractice, part, lev, sizeErrors = [], sizeNotes = [], cards = false, grid }: {
  /** A grid's step now (bp), what a round trip keeps after the fees, the step in units of the hourly volatility, the fee a fill. */
  grid?: { stepBps: number; netStepBps: number; k: number | null; feeBps: number };
  d: BotDraft;
  set: (p: Partial<BotDraft>) => void;
  range: { low: number; high: number } | null;
  mark: number | null;
  liveAllowed: boolean;
  /** This market has no oracle: the market maker runs plain (no gate, no rest, no oracle distances). */
  noLead?: boolean;
  hidePractice?: boolean;
  /** One part only, no tabs (New bot's sub-steps). */
  part?: Sec;
  /** A bot's page (owner 2026-11-10: "redesign so it matches the bot pages, way too big"): every section at once as a
   * compact card on a grid, no side menu. */
  cards?: boolean;
  /** Kept for callers from before the restart flow. */
  running?: boolean;
  /** The market's leverage facts (bots/leverage.ts), `max` already under the region's ceiling; absent or no max: no leverage row. */
  lev?: BotLeverage;
  /** The order size's problems on the lead market (checkSizes errors), shown at the field. */
  sizeErrors?: readonly string[];
  /** checkSizes notes: the quote goes out at SoDEX's minimum. */
  sizeNotes?: readonly string[];
}) {
  const [tab, setSec] = useState<Sec>('size');
  const [adv, setAdv] = useState(false);
  const sec = part ?? tab;
  const [customTgt, setCustomTgt] = useState(tgtKey(d.volumeTargetUsd) === 'custom');
  const mm = d.strategy !== 'grid';
  const market = d.strategy === 'market' && !noLead;
  const holdX = d.orderUsd > 0 ? d.maxInventoryUsd / d.orderUsd : 3;
  // Max holding as a multiple of the order, kept as it was set (audit B: re-derived from the rounded dollars on every
  // keystroke, it drifted while the order size was typed). It changes only when max holding itself is set, or the
  // draft changes from outside (a preset, a restart).
  const [ratio, setRatio] = useState(holdX);
  const ownInv = useRef<number | null>(null);
  useEffect(() => {
    if (ownInv.current !== null && ownInv.current === d.maxInventoryUsd) return;
    ownInv.current = null;
    if (d.orderUsd > 0) setRatio(d.maxInventoryUsd / d.orderUsd);
  }, [d.maxInventoryUsd, d.orderUsd]);
  const setOrder = (v: number) => {
    if (!mm) return set({ orderUsd: v });
    const inv = Math.max(v, Math.round(v * ratio));
    ownInv.current = inv;
    set({ orderUsd: v, maxInventoryUsd: inv });
  };
  const setHold = (inv: number) => {
    if (d.orderUsd > 0) setRatio(inv / d.orderUsd);
    ownInv.current = inv;
    set({ maxInventoryUsd: inv });
  };
  const { range: rangeErr, stop: stopErr } = gridProblems(d, range, mark);
  const guards = (market && d.gate ? 1 : 0) + (mm && d.flowOn ? 1 : 0) + (mm && d.quiet.length ? 1 : 0) + (mm && d.news ? 1 : 0) + (d.maxSpreadBps !== null ? 1 : 0);
  const advChanged = [d.refBps !== 0, d.pullBps !== 0, d.ladder !== 1, d.minRepriceMs !== R10.minRepriceMs, d.chaseTicks !== R10.chaseTicks, d.skewTicks !== R10.skewTicks, d.moveGuard !== 0].filter(Boolean).length;

  const SECS: Array<{ id: Sec; icon: 'wallet' | 'layers' | 'shield'; label: string; count?: number }> = [
    { id: 'size', icon: 'wallet', label: 'Size & risk' },
    ...(mm ? [{ id: 'quote' as const, icon: 'layers' as const, label: 'Quoting' }] : []),
    { id: 'guard', icon: 'shield', label: 'Safeguards', count: guards || undefined },
  ];
  const cur = SECS.find((x) => x.id === sec) ?? SECS[0]!;
  // The bot page: laid out as ValueDesk's own Settings (owner 2026-11-08): the sections down the left, the chosen
  // one on a glass pane, each setting a title over its line and its control, hairlines between.
  const bodyFor = (sec: Sec) => (
    <>

      {sec === 'size' && (
        <div className="bots-fgrid">
          {d.strategy === 'grid' && (
            <>
              <Row label="Direction" wide hint={DIR_HINT[d.gridDir]}>
                <Segmented label="Direction" value={d.gridDir} onChange={(v) => set({ gridDir: v })} options={[{ value: 'neutral', label: 'Neutral' }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
              </Row>
              <Row
                label="Price range"
                wide
                tag={d.low !== null && d.gridK !== null ? <button type="button" className="bots-link" onClick={() => set({ low: null, high: null })}>Follow the market</button> : undefined}
                hint={<>{mark ? `Now ${fmtUsd(mark)}. ` : ''}{d.low === null && d.gridK !== null ? `Set by the preset: steps ${d.gridK}× the hourly swing, around the price when it starts.` : 'It only trades between these two prices.'}</>}
              >
                <div className="bots-pair">
                  <NumberField label="Low" value={range?.low ?? null} onChange={(v) => set({ low: v, high: d.high ?? range?.high ?? null })} unit="USD" />
                  <NumberField label="High" value={range?.high ?? null} onChange={(v) => set({ high: v, low: d.low ?? range?.low ?? null })} unit="USD" />
                </div>
                {mark !== null && mark > 0 && (
                  <Segmented
                    label="Range around the price now"
                    value={rangeKey(range, mark)}
                    onChange={(v) => { const p = Number(v); if (p > 0) set({ low: sig(mark * (1 - p)), high: sig(mark * (1 + p)), gridK: null }); }}
                    options={[...RANGE_CHIPS.map((p) => ({ value: String(p), label: `±${p * 100}%` })), ...(rangeKey(range, mark) === 'x' ? [{ value: 'x', label: 'Own' }] : [])]}
                  />
                )}
                {rangeErr && <p className="bots-err" role="alert">{rangeErr}</p>}
              </Row>
              <Row
                label="Levels"
                hint={grid && grid.stepBps > 0 ? (
                  grid.netStepBps > 0
                    ? `Levels ${(grid.stepBps / 100).toFixed(2)}% apart: a buy and its sell keep ${(grid.netStepBps / 100).toFixed(2)}% after the two fees.`
                    : <span className="bots-err">Levels {(grid.stepBps / 100).toFixed(2)}% apart do not cover the two fees ({((2 * grid.feeBps) / 100).toFixed(3)}%): every round trip loses. Widen the range or use fewer levels.</span>
                ) : undefined}
              >
                <div className="bots-sizeline">
                  <Slider label="Levels slider" value={Math.min(60, Math.max(3, d.levels))} min={3} max={60} step={1} onChange={(v) => set({ levels: Math.round(v) })} minLabel="3" maxLabel="60" />
                  <NumberField label="Levels" hideLabel value={d.levels} onChange={(v) => v !== null && set({ levels: Math.min(60, Math.max(3, Math.round(v))) })} className="bots-sizeline__n" />
                </div>
              </Row>
              <Row label="Spacing" hint={d.spacing === 'geometric' ? 'Every level the same percent apart: the usual choice.' : 'Every level the same number of dollars apart.'}>
                <Segmented label="Spacing" value={d.spacing} onChange={(v) => set({ spacing: v })} options={[{ value: 'geometric', label: 'Equal %' }, { value: 'linear', label: 'Equal $' }]} />
              </Row>
              <Row label="Start at price" hint={d.triggerPrice ? `It places nothing until the price reaches ${fmtUsd(d.triggerPrice)}, then lays out the grid there.` : 'Optional: wait for a price before it starts. Empty: it starts at once.'}>
                <NumberField label="Start price" value={d.triggerPrice} optional onChange={(v) => set({ triggerPrice: v })} unit="USD" />
              </Row>
              <Row label="Stop at price" wide hint="Optional: it stops (and closes as On stop says) once the price goes above or below these.">
                <div className="bots-pair">
                  <NumberField label="Above" value={d.stopAbove} optional onChange={(v) => set({ stopAbove: v })} unit="USD" />
                  <NumberField label="Below" value={d.stopBelow} optional onChange={(v) => set({ stopBelow: v })} unit="USD" />
                </div>
                {stopErr && <p className="bots-err" role="alert">{stopErr}</p>}
              </Row>
              <Row label={<Term t="postOnly">Order type</Term>} tag={<R10Tag on={d.postOnly} reset={() => set({ postOnly: true })} />} hint={d.postOnly ? 'Post-only: every order rests in the book and pays the maker fee. One that would trade at once is refused by SoDEX and placed again.' : 'Limit: an order that crosses the book trades at once as a taker and pays the taker fee.'}>
                <Segmented label="Order type" value={d.postOnly ? 'post' : 'limit'} onChange={(v) => set({ postOnly: v === 'post' })} options={[{ value: 'post', label: 'Post-only' }, { value: 'limit', label: 'Limit (may take)' }]} />
              </Row>
            </>
          )}
          <Row label="Order size" hint={(mark && mark > 0) || sizeNotes.length ? <>{mark && mark > 0 ? `≈ ${(d.orderUsd / mark).toPrecision(3)} ${d.symbol.replace(/-USD$/, '')} per order.` : null}{sizeNotes.map((n) => <span key={n}> {n}</span>)}</> : undefined}>
            <div className="bots-sizeline">
              <Slider label="Order size slider" value={d.orderUsd} min={10} max={500} step={1} onChange={(v) => setOrder(v)} minLabel="$10" maxLabel="$500" />
              <NumberField label="Order size" hideLabel value={d.orderUsd} onChange={(v) => v !== null && setOrder(v)} error={sizeErrors[0] ?? null} unit="USD" className="bots-sizeline__n" />
            </div>
            {sizeErrors.slice(1).map((e) => <p key={e} className="bots-err" role="alert">{e}</p>)}
          </Row>
          {mm && (
            <Row label={<Term t="holding">Max holding</Term>} hint={`${holdX.toFixed(1)}× the order: the most it holds either way. At the cap it only unwinds.`}>
              <div className="bots-sizeline">
                <Slider label="Max holding slider" value={Math.min(10, Math.max(1, ratio))} min={1} max={10} step={0.5} onChange={(x) => setHold(Math.round(d.orderUsd * x))} minLabel="1×" maxLabel="10×" />
                <NumberField label="Max holding" hideLabel value={d.maxInventoryUsd} onChange={(v) => v !== null && setHold(v)} unit="USD" className="bots-sizeline__n" />
              </div>
            </Row>
          )}
          <Row label="Stop if it loses" hint="Net, after every fee. Then it stops as On stop says.">
            <NumberField label="Loss" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
          </Row>
          <Row label="Take profit" hint="Optional: it stops once its net PnL, after every fee, reaches this. Then it closes as On stop says.">
            <NumberField label="Profit" value={d.takeProfitUsd} optional onChange={(v) => set({ takeProfitUsd: v !== null && v > 0 ? v : null })} unit="USD" />
          </Row>
          {lev && lev.max !== null && <LeverageRow d={d} set={set} lev={lev} max={lev.max} />}
          <Row label="Stop after trading" wide hint="Stops once it has bought and sold this much in total.">
            <Segmented
              label="Stop after trading"
              value={customTgt ? 'custom' : tgtKey(d.volumeTargetUsd)}
              onChange={(v) => { if (v === 'custom') setCustomTgt(true); else { setCustomTgt(false); set({ volumeTargetUsd: v === 'none' ? null : Number(v) }); } }}
              options={[{ value: 'none', label: 'None' }, { value: '50000', label: '$50K' }, { value: '250000', label: '$250K' }, { value: '1000000', label: '$1M' }, { value: 'custom', label: 'Custom' }]}
            />
            {customTgt && <NumberField label="After" value={d.volumeTargetUsd} optional onChange={(v) => set({ volumeTargetUsd: v })} unit="USD" />}
          </Row>
          <Row label="Run for" hint="Stops by itself after this long.">
            <Segmented label="Run for" value={d.runHours === null ? 'open' : [1, 8, 24, 168].includes(d.runHours) ? String(d.runHours) : 'x'} onChange={(v) => v !== 'x' && set({ runHours: v === 'open' ? null : Number(v) })} options={[{ value: 'open', label: 'Until stopped' }, { value: '1', label: '1h' }, { value: '8', label: '8h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }, ...(d.runHours === null || [1, 8, 24, 168].includes(d.runHours) ? [] : [{ value: 'x', label: `${d.runHours}h` }])]} />
          </Row>
          <Row label={<Term t="ioc">On stop</Term>} hint={d.onStop === 'close' ? 'When it stops, it sells or buys back what it holds.' : 'When it stops, what it holds stays open in your account.'}>
            <Segmented label="When it stops" value={d.onStop} options={[{ value: 'close', label: 'Close position' }, { value: 'keep', label: 'Keep it' }]} onChange={(v) => set({ onStop: v })} />
          </Row>
          {d.strategy === 'grid' && (
            <Row label="Out of range" hint={d.outOfRange === 'wait' ? 'Trades only inside the range: if the price leaves it, nothing new trades until it comes back. What it holds stays.' : 'If the price leaves the range, it stops and closes as On stop says.'}>
              <Segmented label="Out of the range" value={d.outOfRange} options={[{ value: 'wait', label: 'Pause until back' }, { value: 'stop', label: 'Stop' }]} onChange={(v) => set({ outOfRange: v })} />
            </Row>
          )}
        </div>
      )}

      {sec === 'quote' && mm && (
        <div className="bots-quoting">
          <div className="bots-fgrid">
            {market && (
              <Row label={<Term t="oracle">Follow the oracle</Term>} tag={<R10Tag on={!d.noFair} reset={() => set({ noFair: false })} />} hint={d.noFair ? 'Rests at the best price; the oracle only feeds the market gate.' : 'Pulls a quote the oracle moved through.'}>
                <Segmented label="Follow the oracle" value={d.noFair ? 'touch' : 'oracle'} onChange={(v) => set({ noFair: v === 'touch' })} options={[{ value: 'oracle', label: 'Follow oracle' }, { value: 'touch', label: 'Touch only' }]} />
              </Row>
            )}
            {market && (
              <Row label="Longest rest" tag={<R10Tag on={d.restS === R10.restS} reset={() => set({ restS: R10.restS })} />} hint="Re-placed after this, filled or not.">
                <Segmented label="Longest rest" value={[5, 10, 20, 30].includes(d.restS) ? String(d.restS) : 'x'} onChange={(v) => v !== 'x' && set({ restS: Number(v) })} options={[{ value: '5', label: '5s' }, { value: '10', label: '10s' }, { value: '20', label: '20s' }, { value: '30', label: '30s' }, ...([5, 10, 20, 30].includes(d.restS) ? [] : [{ value: 'x', label: `${d.restS}s` }])]} />
              </Row>
            )}
            <Row label={<Term t="touch">Quote at</Term>} tag={<R10Tag on={d.offsetTicks === R10.offsetTicks} reset={() => set({ offsetTicks: R10.offsetTicks })} />} hint="A step is the smallest price move on this market (a tick).">
              <Segmented label="Quote at" value={d.offsetTicks < 0 ? 'inside' : d.offsetTicks > 0 ? 'back' : 'touch'} options={[{ value: 'inside', label: '1 step better' }, { value: 'touch', label: 'Best price' }, { value: 'back', label: '1 step back' }]} onChange={(v) => set({ offsetTicks: v === 'inside' ? -1 : v === 'back' ? 1 : 0 })} />
            </Row>
          </div>
          <button type="button" className={`bots-adv${adv ? ' is-open' : ''}`} aria-expanded={adv} onClick={() => setAdv((x) => !x)}>
            <Icon name="gear" size={14} />
            <b>Advanced settings</b>
            {advChanged > 0 && <StatusPill size="sm" tone="warning">{advChanged} changed</StatusPill>}
            <span className="bots-adv__sp" />
            <Icon name="down" size={14} />
          </button>
          {adv && (
            <div className="bots-fgrid bots-adv__body">
              {market && !d.noFair && (
                <Row label={<Term t="bp">Distance from oracle</Term>} tag={<R10Tag on={d.refBps === 0} reset={() => set({ refBps: 0 })} />} hint="Where the side that adds to what it holds rests, in bp (1 bp = 0.01%). 0: at SoDEX's best price.">
                  <NumberField label="Rest" value={d.refBps} onChange={(v) => set({ refBps: Math.max(0, Math.min(50, v ?? 0)) })} unit="bp" />
                </Row>
              )}
              {market && !d.noFair && (
                <Row label="Pull distance" tag={<R10Tag on={d.pullBps === 0} reset={() => set({ pullBps: 0 })} />} hint="Pulls that side when the oracle comes this close, in bp.">
                  <NumberField label="Pull within" value={d.pullBps} onChange={(v) => set({ pullBps: Math.max(0, Math.min(20, v ?? 0)) })} unit="bp" />
                </Row>
              )}
              <Row label="Levels per side" tag={<R10Tag on={d.ladder === 1} reset={() => set({ ladder: 1 })} />} hint="More levels keep queue places as the touch moves.">
                <Segmented label="Levels per side" value={String(d.ladder)} onChange={(v) => set({ ladder: Number(v) })} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
              </Row>
              <Row label="Re-price at most every" tag={<R10Tag on={d.minRepriceMs === R10.minRepriceMs} reset={() => set({ minRepriceMs: R10.minRepriceMs })} />}>
                <Segmented label="Re-price" value={[1000, 2000, 5000].includes(d.minRepriceMs) ? String(d.minRepriceMs) : 'x'} onChange={(v) => v !== 'x' && set({ minRepriceMs: Number(v) })} options={[{ value: '1000', label: '1s' }, { value: '2000', label: '2s' }, { value: '5000', label: '5s' }, ...([1000, 2000, 5000].includes(d.minRepriceMs) ? [] : [{ value: 'x', label: `${d.minRepriceMs / 1000}s` }])]} />
              </Row>
              <Row label={<Term t="tick">Re-quote after the price moves</Term>} tag={<R10Tag on={d.chaseTicks === R10.chaseTicks} reset={() => set({ chaseTicks: R10.chaseTicks })} />} hint="Moves its quotes once the best price moved this many steps.">
                <NumberField label="After" value={d.chaseTicks} onChange={(v) => set({ chaseTicks: Math.max(1, Math.min(1000, Math.round(v ?? 1))) })} unit="ticks" />
              </Row>
              <Row label={<Term t="skew">Step back when holding</Term>} tag={<R10Tag on={d.skewTicks === R10.skewTicks} reset={() => set({ skewTicks: R10.skewTicks })} />} hint="At the cap, the side that would add more steps back this many steps.">
                <NumberField label="Skew" value={d.skewTicks} onChange={(v) => set({ skewTicks: Math.max(0, Math.round(v ?? 0)) })} unit="ticks" />
              </Row>
              <Row label="Pause on fast moves" tag={<R10Tag on={d.moveGuard === 0} reset={() => set({ moveGuard: 0 })} />} hint="The side the price runs into waits once it moved this many steps in 2 seconds.">
                <NumberField label="Ticks" value={d.moveGuard} onChange={(v) => set({ moveGuard: Math.max(0, Math.min(100, v ?? 0)) })} unit="ticks" placeholder="Off" />
              </Row>
              <Row label={<Term t="postOnly">Order type</Term>} tag={<R10Tag on={d.postOnly} reset={() => set({ postOnly: true })} />} hint={d.postOnly ? 'Post-only: every order rests in the book and pays the maker fee. One that would trade at once is refused by SoDEX and placed again.' : 'Limit: an order that crosses the book trades at once as a taker and pays the taker fee.'}>
                <Segmented label="Order type" value={d.postOnly ? 'post' : 'limit'} onChange={(v) => set({ postOnly: v === 'post' })} options={[{ value: 'post', label: 'Post-only' }, { value: 'limit', label: 'Limit (may take)' }]} />
              </Row>
            </div>
          )}
        </div>
      )}

      {sec === 'guard' && (
        <div className="bots-guards">
          {market && (
            <Guard icon="pulse" title="Volatility gate" line="Pauses the moment the price moves fast, at any hour" on={d.gate} set={(on) => set({ gate: on, ...(on && !d.gateBps ? GATE_DEFAULT : {}) })}>
              <p className="bots-f__h">Pauses while the oracle moved more than this. bp: a hundredth of a percent (1 bp = 0.01%).</p>
              <div className="bots-pair">
                <NumberField label="Moves" value={d.gateBps} onChange={(v) => set({ gateBps: Math.max(1, Math.min(500, v ?? GATE_DEFAULT.gateBps)) })} unit="bp" />
                <NumberField label="Over" value={d.gateWindowS} onChange={(v) => set({ gateWindowS: Math.max(1, Math.min(120, Math.round(v ?? GATE_DEFAULT.gateWindowS))) })} unit="s" />
              </div>
            </Guard>
          )}
          {mm && (
            <Guard icon="robot" title="Flow gate" line="Pause when uninformed flow dries up" on={d.flowOn} set={(on) => set({ flowOn: on, ...(on && !d.flowMinUsd ? FLOW_DEFAULT : {}) })}>
              <div className="bots-fgrid is-2">
                <Row label={<Term t="uninformed">Uninformed flow under</Term>}>
                  <Segmented label="Flow threshold" value={[100_000, 250_000, 500_000, 1_000_000].includes(d.flowMinUsd) ? String(d.flowMinUsd) : 'x'} onChange={(v) => v !== 'x' && set({ flowMinUsd: Number(v) })} options={[{ value: '100000', label: '$100K' }, { value: '250000', label: '$250K' }, { value: '500000', label: '$500K' }, { value: '1000000', label: '$1M' }, ...([100_000, 250_000, 500_000, 1_000_000].includes(d.flowMinUsd) ? [] : [{ value: 'x', label: fmtUsd(d.flowMinUsd, 0) }])]} />
                </Row>
                <Row label="In the last">
                  <Segmented label="Flow window" value={String(d.flowWindowMin)} onChange={(v) => set({ flowWindowMin: Number(v) })} options={[{ value: '5', label: '5 min' }, { value: '10', label: '10 min' }, { value: '30', label: '30 min' }]} />
                </Row>
                <Row label="Then">
                  <Segmented label="Flow action" value={d.flowAction} onChange={(v) => set({ flowAction: v })} options={[{ value: 'pause', label: 'Pause' }, { value: 'shrink', label: 'Smaller orders' }]} />
                </Row>
                {d.flowAction === 'shrink' && (
                  <Row label="Order size while quiet">
                    <Segmented label="Shrink" value={String(d.flowShrink)} onChange={(v) => set({ flowShrink: Number(v) })} options={[{ value: '0.25', label: '25%' }, { value: '0.5', label: '50%' }, { value: '0.75', label: '75%' }]} />
                  </Row>
                )}
              </div>
            </Guard>
          )}
          {mm && <Guard icon="clock" title="Trading hours" line={d.quiet.length ? `${d.quiet.length} window${d.quiet.length === 1 ? '' : 's'}: ${d.quietOnly ? 'trades only in them' : 'paused in them'}` : 'Pause at set hours, or trade only in them'} on={d.quiet.length > 0} set={(on) => set({ quiet: on ? [QUIET_PRESETS[0]!.w] : [], quietOnly: false })}>
            <HoursGate d={d} set={set} />
          </Guard>}
          {mm && (
            <Guard icon="bolt" title="News gate" line={d.news ? `Off ${d.news.beforeMin} min before to ${d.news.afterMin} min after each ${d.news.level === 'high' ? 'major' : 'major or medium'} US release` : 'Pause around CPI, jobs, the Fed and other US releases'} on={d.news !== null} set={(on) => set({ news: on ? { ...NEWS_DEFAULT } : null })}>
              {d.news && (
                <div className="bots-fgrid is-2">
                  <Row label="Which releases" hint={d.news.level === 'high' ? 'CPI, jobs report, FOMC, GDP, PCE.' : 'Also PPI, JOLTS, ISM, retail sales.'}>
                    <Segmented label="Which releases" value={d.news.level} onChange={(v) => set({ news: { ...d.news!, level: v } })} options={[{ value: 'high', label: 'Major' }, { value: 'medium', label: 'Major and medium' }]} />
                  </Row>
                  <Row label="Pause from">
                    <Segmented label="Minutes before" value={String(d.news.beforeMin)} onChange={(v) => set({ news: { ...d.news!, beforeMin: Number(v) } })} options={[{ value: '0', label: 'At release' }, { value: '2', label: '2 min before' }, { value: '5', label: '5 min before' }, { value: '15', label: '15 min before' }]} />
                  </Row>
                  <Row label="Until">
                    <Segmented label="Minutes after" value={String(d.news.afterMin)} onChange={(v) => set({ news: { ...d.news!, afterMin: Number(v) } })} options={[{ value: '5', label: '5 min after' }, { value: '10', label: '10 min after' }, { value: '30', label: '30 min after' }, { value: '60', label: '1 h after' }]} />
                  </Row>
                </div>
              )}
            </Guard>
          )}
          <Guard icon="layers" title="Spread limit" line="Pauses while the gap between the best buy and sell is wider than this (1 bp = 0.01%)" on={d.maxSpreadBps !== null} set={(on) => set({ maxSpreadBps: on ? 20 : null })}>
            <SpreadPick d={d} set={set} symbol={d.symbol} />
          </Guard>
          {noLead && d.strategy === 'market' && <p className="bots-note"><StatusPill size="sm">no oracle</StatusPill> The volatility gate needs the oracle and is off here.</p>}
        </div>
      )}

      {!hidePractice && (
        <div className="bots-practice">
          <div>
            <p className="bots-practice__t">Practice</p>
            <p className="bots-practice__h">{liveAllowed ? 'Real book, no orders sent.' : 'Real orders open soon for your wallet.'}</p>
          </div>
          <Switch checked={!liveAllowed || d.paper} disabled={!liveAllowed} onChange={(on) => set({ paper: on })} label="Practice" hideLabel />
        </div>
      )}
    </>
  );
  const body = bodyFor(sec);
  if (part) return <div className="bots-settings">{body}</div>;
  if (cards) {
    return (
      <div className="bots-settings is-cards">
        {SECS.map((x) => (
          <section key={x.id} className="bots-setcard" aria-label={x.label}>
            <header className="bots-setcard__h">
              <span className="bots-setcard__i"><Icon name={x.icon} size={14} /></span>
              <b>{x.label}</b>
              {x.count ? <em className="bots-stg__n">{x.count} on</em> : null}
            </header>
            <div className="bots-setcard__b">{bodyFor(x.id)}</div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="bots-settings is-stg">
      <nav className="bots-stg__nav" aria-label="Settings sections">
        {SECS.map((x) => (
          <button key={x.id} type="button" className={`stg__tab${sec === x.id ? ' is-on' : ''}`} aria-current={sec === x.id ? 'page' : undefined} onClick={() => setSec(x.id)}>
            <Icon name={x.icon} size={16} /><span>{x.label}</span>{x.count ? <em className="bots-stg__n">{x.count}</em> : null}
          </button>
        ))}
      </nav>
      <div className="stg__pane bots-stg__pane" key={sec}>
        <div className="stg__panehead"><Icon name={cur.icon} size={20} /><h3>{cur.label}</h3></div>
        {body}
      </div>
    </div>
  );
}

/** The bot's name (Review step, and a restart). */
export function NameField({ d, set }: { d: BotDraft; set: (p: Partial<BotDraft>) => void }) {
  return (
    <Field label="Bot name" htmlFor="bot-name">
      <TextInput id="bot-name" maxLength={40} placeholder={`${RECIPE[recipeOfDraft(d)].name} ${d.symbol.replace(/-USD$/, '')}`} value={d.label} onChange={(e) => set({ label: e.target.value })} aria-label="Name" />
    </Field>
  );
}
