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
import { useState, type ReactNode } from 'react';
import { fmtUsd } from '../../format';
import { FLOW_DEFAULT, GATE_DEFAULT, NEWS_DEFAULT, QUIET_PRESETS, R10, type BotDraft } from '../../bots/presets';
import { HoursGate } from './HoursGate';
import { RECIPE, recipeOfDraft } from '../../bots/recipes';
import { Button, Field, Icon, NumberField, Segmented, Slider, StatusPill, Switch, Tabs, TextInput } from './kit/kit';

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

export function BotSettings({ d, set, range, mark, liveAllowed, noLead, hidePractice, part }: {
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
  /** Kept for callers from before the restart flow. */
  running?: boolean;
}) {
  const [tab, setSec] = useState<Sec>('size');
  const [adv, setAdv] = useState(false);
  const sec = part ?? tab;
  const [customTgt, setCustomTgt] = useState(tgtKey(d.volumeTargetUsd) === 'custom');
  const mm = d.strategy !== 'grid';
  const market = d.strategy === 'market' && !noLead;
  const holdX = d.orderUsd > 0 ? d.maxInventoryUsd / d.orderUsd : 3;
  const guards = (market && d.gate ? 1 : 0) + (mm && d.flowOn ? 1 : 0) + (d.quiet.length ? 1 : 0) + (d.news ? 1 : 0) + (d.maxSpreadBps !== null ? 1 : 0);
  const advChanged = [d.refBps !== 0, d.pullBps !== 0, d.ladder !== 1, d.minRepriceMs !== R10.minRepriceMs, d.chaseTicks !== R10.chaseTicks, d.skewTicks !== R10.skewTicks, d.moveGuard !== 0].filter(Boolean).length;

  const SECS: Array<{ id: Sec; icon: 'wallet' | 'layers' | 'shield'; label: string; count?: number }> = [
    { id: 'size', icon: 'wallet', label: 'Size & risk' },
    ...(mm ? [{ id: 'quote' as const, icon: 'layers' as const, label: 'Quoting' }] : []),
    { id: 'guard', icon: 'shield', label: 'Safeguards', count: guards || undefined },
  ];
  const cur = SECS.find((x) => x.id === sec) ?? SECS[0]!;
  // The bot page: laid out as ValueDesk's own Settings (owner 2026-11-08): the sections down the left, the chosen
  // one on a glass pane, each setting a title over its line and its control, hairlines between.
  const body = (
    <>

      {sec === 'size' && (
        <div className="bots-fgrid">
          {d.strategy === 'grid' && (
            <>
              <Row label="Price range" hint={mark ? `Now ${fmtUsd(mark)}` : undefined} wide>
                <div className="bots-pair">
                  <NumberField label="Low" value={range?.low ?? null} onChange={(v) => set({ low: v, high: d.high ?? range?.high ?? null })} unit="USD" />
                  <NumberField label="High" value={range?.high ?? null} onChange={(v) => set({ high: v, low: d.low ?? range?.low ?? null })} unit="USD" />
                </div>
              </Row>
              <Row label="Levels">
                <Segmented label="Levels" value={[5, 10, 20].includes(d.levels) ? String(d.levels) : 'x'} onChange={(v) => v !== 'x' && set({ levels: Number(v) })} options={[{ value: '5', label: '5' }, { value: '10', label: '10' }, { value: '20', label: '20' }, ...([5, 10, 20].includes(d.levels) ? [] : [{ value: 'x', label: String(d.levels) }])]} />
              </Row>
            </>
          )}
          <Row label="Order size" hint={mark && mark > 0 ? `≈ ${(d.orderUsd / mark).toPrecision(3)} ${d.symbol.replace(/-USD$/, '')} per order` : undefined}>
            <div className="bots-sizeline">
              <Slider label="Order size slider" value={d.orderUsd} min={10} max={500} step={1} onChange={(v) => set({ orderUsd: v, ...(mm ? { maxInventoryUsd: Math.round(v * holdX) } : {}) })} minLabel="$10" maxLabel="$500" />
              <NumberField label="Order size" hideLabel value={d.orderUsd} onChange={(v) => v !== null && set({ orderUsd: v, ...(mm ? { maxInventoryUsd: Math.round(v * holdX) } : {}) })} unit="USD" className="bots-sizeline__n" />
            </div>
          </Row>
          {mm && (
            <Row label="Max holding" hint={`${holdX.toFixed(1)}× the order. At the cap it only unwinds.`}>
              <div className="bots-sizeline">
                <Slider label="Max holding slider" value={holdX} min={1} max={10} step={0.5} onChange={(x) => set({ maxInventoryUsd: Math.round(d.orderUsd * x) })} minLabel="1×" maxLabel="10×" />
                <NumberField label="Max holding" hideLabel value={d.maxInventoryUsd} onChange={(v) => v !== null && set({ maxInventoryUsd: v })} unit="USD" className="bots-sizeline__n" />
              </div>
            </Row>
          )}
          <Row label="Stop if it loses" hint="Net, after every fee.">
            <NumberField label="Loss" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
          </Row>
          <Row label="Stop after trading">
            <Segmented
              label="Stop after trading"
              value={customTgt ? 'custom' : tgtKey(d.volumeTargetUsd)}
              onChange={(v) => { if (v === 'custom') setCustomTgt(true); else { setCustomTgt(false); set({ volumeTargetUsd: v === 'none' ? null : Number(v) }); } }}
              options={[{ value: 'none', label: 'None' }, { value: '50000', label: '$50K' }, { value: '250000', label: '$250K' }, { value: '1000000', label: '$1M' }, { value: 'custom', label: 'Custom' }]}
            />
            {customTgt && <NumberField label="After" value={d.volumeTargetUsd} optional onChange={(v) => set({ volumeTargetUsd: v })} unit="USD" />}
          </Row>
          <Row label="Run for">
            <Segmented label="Run for" value={d.runHours === null ? 'open' : [1, 8, 24, 168].includes(d.runHours) ? String(d.runHours) : 'x'} onChange={(v) => v !== 'x' && set({ runHours: v === 'open' ? null : Number(v) })} options={[{ value: 'open', label: 'Until stopped' }, { value: '1', label: '1h' }, { value: '8', label: '8h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }, ...(d.runHours === null || [1, 8, 24, 168].includes(d.runHours) ? [] : [{ value: 'x', label: `${d.runHours}h` }])]} />
          </Row>
          <Row label="On stop">
            <Segmented label="When it stops" value={d.onStop} options={[{ value: 'close', label: 'Close position' }, { value: 'keep', label: 'Keep it' }]} onChange={(v) => set({ onStop: v })} />
          </Row>
          {d.strategy === 'grid' && (
            <Row label="Out of range">
              <Segmented label="Out of the range" value={d.outOfRange} options={[{ value: 'wait', label: 'Wait' }, { value: 'stop', label: 'Stop' }]} onChange={(v) => set({ outOfRange: v })} />
            </Row>
          )}
        </div>
      )}

      {sec === 'quote' && mm && (
        <div className="bots-quoting">
          <div className="bots-fgrid">
            {market && (
              <Row label="Follow the oracle" tag={<R10Tag on={!d.noFair} reset={() => set({ noFair: false })} />} hint={d.noFair ? 'Rests at the best price; the oracle only feeds the market gate.' : 'Pulls a quote the oracle moved through.'}>
                <Segmented label="Follow the oracle" value={d.noFair ? 'touch' : 'oracle'} onChange={(v) => set({ noFair: v === 'touch' })} options={[{ value: 'oracle', label: 'Follow oracle' }, { value: 'touch', label: 'Touch only' }]} />
              </Row>
            )}
            {market && (
              <Row label="Longest rest" tag={<R10Tag on={d.restS === R10.restS} reset={() => set({ restS: R10.restS })} />} hint="Re-placed after this, filled or not.">
                <Segmented label="Longest rest" value={[5, 10, 20, 30].includes(d.restS) ? String(d.restS) : 'x'} onChange={(v) => v !== 'x' && set({ restS: Number(v) })} options={[{ value: '5', label: '5s' }, { value: '10', label: '10s' }, { value: '20', label: '20s' }, { value: '30', label: '30s' }, ...([5, 10, 20, 30].includes(d.restS) ? [] : [{ value: 'x', label: `${d.restS}s` }])]} />
              </Row>
            )}
            <Row label="Quote at" tag={<R10Tag on={d.offsetTicks === R10.offsetTicks} reset={() => set({ offsetTicks: R10.offsetTicks })} />}>
              <Segmented label="Quote at" value={d.offsetTicks < 0 ? 'inside' : d.offsetTicks > 0 ? 'back' : 'touch'} options={[{ value: 'inside', label: '1 tick inside' }, { value: 'touch', label: 'Best price' }, { value: 'back', label: '1 tick back' }]} onChange={(v) => set({ offsetTicks: v === 'inside' ? -1 : v === 'back' ? 1 : 0 })} />
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
                <Row label="Distance from oracle" tag={<R10Tag on={d.refBps === 0} reset={() => set({ refBps: 0 })} />} hint="Where the adding side rests. 0: at SoDEX's best price.">
                  <NumberField label="Rest" value={d.refBps} onChange={(v) => set({ refBps: Math.max(0, Math.min(50, v ?? 0)) })} unit="bp" />
                </Row>
              )}
              {market && !d.noFair && (
                <Row label="Pull distance" tag={<R10Tag on={d.pullBps === 0} reset={() => set({ pullBps: 0 })} />} hint="Pulls the adding side this close to the oracle.">
                  <NumberField label="Pull within" value={d.pullBps} onChange={(v) => set({ pullBps: Math.max(0, Math.min(20, v ?? 0)) })} unit="bp" />
                </Row>
              )}
              <Row label="Levels per side" tag={<R10Tag on={d.ladder === 1} reset={() => set({ ladder: 1 })} />} hint="More levels keep queue places as the touch moves.">
                <Segmented label="Levels per side" value={String(d.ladder)} onChange={(v) => set({ ladder: Number(v) })} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
              </Row>
              <Row label="Re-price at most every" tag={<R10Tag on={d.minRepriceMs === R10.minRepriceMs} reset={() => set({ minRepriceMs: R10.minRepriceMs })} />}>
                <Segmented label="Re-price" value={[1000, 2000, 5000].includes(d.minRepriceMs) ? String(d.minRepriceMs) : 'x'} onChange={(v) => v !== 'x' && set({ minRepriceMs: Number(v) })} options={[{ value: '1000', label: '1s' }, { value: '2000', label: '2s' }, { value: '5000', label: '5s' }, ...([1000, 2000, 5000].includes(d.minRepriceMs) ? [] : [{ value: 'x', label: `${d.minRepriceMs / 1000}s` }])]} />
              </Row>
              <Row label="Follow the touch" tag={<R10Tag on={d.chaseTicks === R10.chaseTicks} reset={() => set({ chaseTicks: R10.chaseTicks })} />} hint="Re-quote once the best price moved this far.">
                <NumberField label="After" value={d.chaseTicks} onChange={(v) => set({ chaseTicks: Math.max(1, Math.min(1000, Math.round(v ?? 1))) })} unit="ticks" />
              </Row>
              <Row label="Inventory skew" tag={<R10Tag on={d.skewTicks === R10.skewTicks} reset={() => set({ skewTicks: R10.skewTicks })} />} hint="At the cap, the adding side steps back this far.">
                <NumberField label="Skew" value={d.skewTicks} onChange={(v) => set({ skewTicks: Math.max(0, Math.round(v ?? 0)) })} unit="ticks" />
              </Row>
              <Row label="Move guard" tag={<R10Tag on={d.moveGuard === 0} reset={() => set({ moveGuard: 0 })} />} hint="The side the mid runs into waits after this many ticks in 2 s.">
                <NumberField label="Ticks" value={d.moveGuard} onChange={(v) => set({ moveGuard: Math.max(0, Math.min(100, v ?? 0)) })} unit="ticks" placeholder="Off" />
              </Row>
            </div>
          )}
        </div>
      )}

      {sec === 'guard' && (
        <div className="bots-guards">
          {market && (
            <Guard icon="pulse" title="Volatility gate" line="Pauses the moment the price moves fast, at any hour" on={d.gate} set={(on) => set({ gate: on, ...(on && !d.gateBps ? GATE_DEFAULT : {}) })}>
              <div className="bots-pair">
                <NumberField label="Moves" value={d.gateBps} onChange={(v) => set({ gateBps: Math.max(1, Math.min(500, v ?? GATE_DEFAULT.gateBps)) })} unit="bp" />
                <NumberField label="Over" value={d.gateWindowS} onChange={(v) => set({ gateWindowS: Math.max(1, Math.min(120, Math.round(v ?? GATE_DEFAULT.gateWindowS))) })} unit="s" />
              </div>
            </Guard>
          )}
          {mm && (
            <Guard icon="robot" title="Flow gate" line="Pause when uninformed flow dries up" on={d.flowOn} set={(on) => set({ flowOn: on, ...(on && !d.flowMinUsd ? FLOW_DEFAULT : {}) })}>
              <div className="bots-fgrid is-2">
                <Row label="Uninformed flow under">
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
          <Guard icon="clock" title="Trading hours" line={d.quiet.length ? `${d.quiet.length} window${d.quiet.length === 1 ? '' : 's'}: ${d.quietOnly ? 'trades only in them' : 'paused in them'}` : 'Pause at set hours, or trade only in them'} on={d.quiet.length > 0} set={(on) => set({ quiet: on ? [QUIET_PRESETS[0]!.w] : [], quietOnly: false })}>
            <HoursGate d={d} set={set} />
          </Guard>
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
          {market && (
            <Guard icon="layers" title="Spread limit" line="Pause on a wide spread" on={d.maxSpreadBps !== null} set={(on) => set({ maxSpreadBps: on ? 10 : null })}>
              <Segmented label="Pause if spread over" value={d.maxSpreadBps === null ? '10' : [5, 10, 20].includes(d.maxSpreadBps) ? String(d.maxSpreadBps) : 'x'} onChange={(v) => v !== 'x' && set({ maxSpreadBps: Number(v) })} options={[{ value: '5', label: '5 bp' }, { value: '10', label: '10 bp' }, { value: '20', label: '20 bp' }, ...(d.maxSpreadBps === null || [5, 10, 20].includes(d.maxSpreadBps) ? [] : [{ value: 'x', label: `${d.maxSpreadBps} bp` }])]} />
            </Guard>
          )}
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
  if (part) return <div className="bots-settings">{body}</div>;
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
