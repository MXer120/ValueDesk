/**
 * A bot's settings, short: size and limits up front, the rest under Advanced. Shared by New bot (step Size) and a
 * bot's own page (change settings, applied by a restart). Built from the Bots kit.
 */
import { useState, type ReactNode } from 'react';
import { fmtUsd } from '../../format';
import { GATE_DEFAULT, type BotDraft } from '../../bots/presets';
import { Field, Icon, NumberField, Segmented, Slider, Switch, TextInput } from './kit/kit';

const TARGETS = [null, 50_000, 250_000, 1_000_000] as const;
const tgtKey = (v: number | null): string => (v === null ? 'none' : TARGETS.includes(v as never) ? String(v) : 'custom');

function Row({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`bots-f${wide ? ' is-wide' : ''}`}>
      <div className="bots-f__l"><span>{label}</span></div>
      <div className="bots-f__c">{children}</div>
      {hint && <p className="bots-f__h">{hint}</p>}
    </div>
  );
}

export function BotSettings({ d, set, range, mark, liveAllowed, noLead, hidePractice }: {
  d: BotDraft;
  set: (p: Partial<BotDraft>) => void;
  range: { low: number; high: number } | null;
  mark: number | null;
  liveAllowed: boolean;
  /** This market has no Binance price: the market maker runs plain (no gate, no rest). */
  noLead?: boolean;
  hidePractice?: boolean;
  /** Kept for callers from before the restart flow. */
  running?: boolean;
}) {
  const [adv, setAdv] = useState(false);
  const [customTgt, setCustomTgt] = useState(tgtKey(d.volumeTargetUsd) === 'custom');
  const mm = d.strategy !== 'grid';
  const market = d.strategy === 'market' && !noLead;
  const holdX = d.orderUsd > 0 ? d.maxInventoryUsd / d.orderUsd : 3;
  return (
    <div className="bots-settings">
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
        <Row label="Stop if it loses">
          <NumberField label="Loss" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
        </Row>
        <Row label="Stop after trading" hint={d.volumeTargetUsd === null ? 'Runs until you stop it or it hits the loss limit.' : undefined}>
          <Segmented
            label="Stop after trading"
            value={customTgt ? 'custom' : tgtKey(d.volumeTargetUsd)}
            onChange={(v) => { if (v === 'custom') setCustomTgt(true); else { setCustomTgt(false); set({ volumeTargetUsd: v === 'none' ? null : Number(v) }); } }}
            options={[{ value: 'none', label: 'None' }, { value: '50000', label: '$50K' }, { value: '250000', label: '$250K' }, { value: '1000000', label: '$1M' }, { value: 'custom', label: 'Custom' }]}
          />
          {customTgt && <NumberField label="After" value={d.volumeTargetUsd} optional onChange={(v) => set({ volumeTargetUsd: v })} unit="USD" />}
        </Row>
      </div>

      <section className={`bots-adv${adv ? ' is-open' : ''}`}>
        <button type="button" className="bots-adv__t" aria-expanded={adv} onClick={() => setAdv(!adv)}>
          <span>Advanced settings</span>
          <Icon name="arrowRight" size={14} className="bots-adv__chev" />
        </button>
        {adv && (
          <div className="bots-adv__body">
            <div className="bots-fgrid">
              {mm && (
                <Row label="Max holding" hint={`${holdX.toFixed(1)}× the order size`}>
                  <div className="bots-sizeline">
                    <Slider label="Max holding slider" value={holdX} min={1} max={10} step={0.5} onChange={(x) => set({ maxInventoryUsd: Math.round(d.orderUsd * x) })} minLabel="1×" maxLabel="10×" />
                    <NumberField label="Max holding" hideLabel value={d.maxInventoryUsd} onChange={(v) => v !== null && set({ maxInventoryUsd: v })} unit="USD" className="bots-sizeline__n" />
                  </div>
                </Row>
              )}
              {market && (
                <Row label={<>Market gate {d.gate && <span className="bots-on">On</span>}</>} hint={`Pauses new quotes while Binance moves over ${d.gateBps} bp in ${d.gateWindowS} s.`}>
                  <Switch checked={d.gate} onChange={(on) => set({ gate: on, ...(on && !d.gateBps ? GATE_DEFAULT : {}) })} label="Market gate" hideLabel />
                  {d.gate && (
                    <div className="bots-pair">
                      <NumberField label="Moves" value={d.gateBps} onChange={(v) => set({ gateBps: Math.max(1, Math.min(500, v ?? GATE_DEFAULT.gateBps)) })} unit="bp" />
                      <NumberField label="Over" value={d.gateWindowS} onChange={(v) => set({ gateWindowS: Math.max(1, Math.min(120, Math.round(v ?? GATE_DEFAULT.gateWindowS))) })} unit="s" />
                    </div>
                  )}
                </Row>
              )}
              {market && (
                <Row label="Longest rest">
                  <Segmented label="Longest rest" value={[5, 10, 20].includes(d.restS) ? String(d.restS) : 'x'} onChange={(v) => v !== 'x' && set({ restS: Number(v) })} options={[{ value: '5', label: '5 s' }, { value: '10', label: '10 s' }, { value: '20', label: '20 s' }, ...([5, 10, 20].includes(d.restS) ? [] : [{ value: 'x', label: `${d.restS} s` }])]} />
                </Row>
              )}
              {mm && (
                <Row label="Quote at">
                  <Segmented label="Quote at" value={d.offsetTicks < 0 ? 'inside' : 'touch'} options={[{ value: 'touch', label: 'Best price' }, { value: 'inside', label: '1 tick inside' }]} onChange={(v) => set({ offsetTicks: v === 'inside' ? -1 : 0 })} />
                </Row>
              )}
              {market && (
                <Row label="Pause if spread over">
                  <Segmented label="Pause if spread over" value={d.maxSpreadBps === null ? 'off' : [5, 10, 20].includes(d.maxSpreadBps) ? String(d.maxSpreadBps) : 'x'} onChange={(v) => v !== 'x' && set({ maxSpreadBps: v === 'off' ? null : Number(v) })} options={[{ value: 'off', label: 'Off' }, { value: '5', label: '5 bp' }, { value: '10', label: '10 bp' }, { value: '20', label: '20 bp' }, ...(d.maxSpreadBps === null || [5, 10, 20].includes(d.maxSpreadBps) ? [] : [{ value: 'x', label: `${d.maxSpreadBps} bp` }])]} />
                </Row>
              )}
              {d.strategy === 'grid' && (
                <Row label="Out of range">
                  <Segmented label="Out of the range" value={d.outOfRange} options={[{ value: 'wait', label: 'Wait' }, { value: 'stop', label: 'Stop' }]} onChange={(v) => set({ outOfRange: v })} />
                </Row>
              )}
              <Row label="On stop">
                <Segmented label="When it stops" value={d.onStop} options={[{ value: 'close', label: 'Close position' }, { value: 'keep', label: 'Keep it' }]} onChange={(v) => set({ onStop: v })} />
              </Row>
            </div>
          </div>
        )}
      </section>

      {!hidePractice && (
        <div className="bots-practice">
          <div>
            <p className="bots-practice__t">Practice</p>
            <p className="bots-practice__h">{liveAllowed ? 'Real book, no orders sent.' : 'Real orders open soon for your wallet.'}</p>
          </div>
          <Switch checked={!liveAllowed || d.paper} disabled={!liveAllowed} onChange={(on) => set({ paper: on })} label="Practice" hideLabel />
        </div>
      )}
    </div>
  );
}

/** The bot's name (Review step, and a restart). */
export function NameField({ d, set }: { d: BotDraft; set: (p: Partial<BotDraft>) => void }) {
  return (
    <Field label="Bot name" htmlFor="bot-name">
      <TextInput id="bot-name" maxLength={40} placeholder={`${d.strategy === 'grid' ? 'Grid' : 'Market maker'} ${d.symbol.replace(/-USD$/, '')}`} value={d.label} onChange={(e) => set({ label: e.target.value })} aria-label="Name" />
    </Field>
  );
}
