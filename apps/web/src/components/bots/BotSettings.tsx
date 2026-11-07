/**
 * The market maker's and the grid's settings, shared by New bot (everything open) and a bot's own page (only what
 * the executor lets change while it runs: runtime BOT_UPDATABLE; the market, the Binance lead and a grid's range
 * stay what it started with).
 */
import type { ReactNode } from 'react';
import { fmtUsd } from '../../format';
import { DlgRow, DlgSection, DlgSeg, DlgSwitch } from '../dialogParts';
import { NumField } from './BotForm';
import { GATE_DEFAULT, PRESETS, PRESET_NAMES, PRESET_VALUES, presetOf, type BotDraft, type PresetId } from '../../bots/presets';

export function BotSettings({ d, set, running, range, mark, liveAllowed, extraRun }: {
  d: BotDraft;
  set: (p: Partial<BotDraft>) => void;
  /** A running bot: what cannot change is shown, not editable. */
  running: boolean;
  range: { low: number; high: number } | null;
  mark: number | null;
  liveAllowed: boolean;
  extraRun?: ReactNode;
}) {
  const preset = presetOf(d);
  const mm = d.strategy !== 'grid';
  return (
    <>
      {!running && (
        <DlgSection label="Size">
          <DlgRow title="Preset" line={preset ? 'A starting point: change any setting below to make it your own.' : 'Your own settings.'}>
            <DlgSeg<PresetId | 'custom'>
              label="Preset"
              value={preset ?? 'custom'}
              options={[...PRESETS.map((p) => ({ value: p as PresetId | 'custom', label: PRESET_NAMES[p] })), ...(preset ? [] : [{ value: 'custom' as const, label: 'Custom' }])]}
              onChange={(p) => p !== 'custom' && set({ ...PRESET_VALUES[d.strategy][p], low: null, high: null })}
            />
          </DlgRow>
        </DlgSection>
      )}

      {mm && (
        <DlgSection label="How it trades">
          <DlgRow title="Order size" line="Each buy and each sell it keeps resting. Bigger orders fill more of each trade that reaches them." stack>
            <NumField label="Each side" value={d.orderUsd} onChange={(v) => v !== null && set({ orderUsd: v })} unit="USD" />
          </DlgRow>
          <DlgRow title="Inventory cap" line="The most it holds either way. At the cap it only quotes the side that unwinds." stack>
            <NumField label="Up to" value={d.maxInventoryUsd} onChange={(v) => v !== null && set({ maxInventoryUsd: v })} unit="USD" />
          </DlgRow>
          {d.strategy === 'market' && (
            <DlgRow
              title="Market gate"
              line={`No new quote while Binance has moved more than ${d.gateBps} bp over the last ${d.gateWindowS} s: the minutes where fast traders pick small makers off. Fewer fills, cheaper ones.`}
            >
              <DlgSwitch on={d.gate} onChange={(on) => set({ gate: on, ...(on && !d.gateBps ? GATE_DEFAULT : {}) })} label="Market gate" />
            </DlgRow>
          )}
          {d.strategy === 'market' && d.gate && (
            <DlgRow title="Gate" line="How much Binance may move, and over how long, before it stops adding quotes. 12 bp over 60 s is what the backtest kept." stack>
              <div className="bots-pair">
                <NumField label="Moved over" value={d.gateBps} onChange={(v) => set({ gateBps: Math.max(1, Math.min(500, v ?? GATE_DEFAULT.gateBps)) })} unit="bp" />
                <NumField label="In" value={d.gateWindowS} onChange={(v) => set({ gateWindowS: Math.max(1, Math.min(120, Math.round(v ?? GATE_DEFAULT.gateWindowS))) })} unit="s" />
              </div>
            </DlgRow>
          )}
        </DlgSection>
      )}

      {d.strategy === 'grid' && (
        <DlgSection label="How it trades">
          <DlgRow title="Range" line={running ? 'A running grid keeps its range.' : `±${(d.rangePct * 100).toFixed(1)}% around the price now${mark ? ` (${fmtUsd(mark)})` : ''}, or your own prices.`} stack>
            <div className="bots-pair">
              <NumField label="Low" value={range?.low ?? null} disabled={running} onChange={(v) => set({ low: v, high: d.high ?? range?.high ?? null })} unit="USD" />
              <NumField label="High" value={range?.high ?? null} disabled={running} onChange={(v) => set({ high: v, low: d.low ?? range?.low ?? null })} unit="USD" />
            </div>
          </DlgRow>
          <DlgRow title="Levels" line="More levels: smaller steps, more round trips." stack>
            <NumField label="Levels" value={d.levels} disabled={running} onChange={(v) => v !== null && set({ levels: Math.round(v) })} />
          </DlgRow>
          <DlgRow title="Order size" line="Each level's order." stack>
            <NumField label="Each level" value={d.orderUsd} onChange={(v) => v !== null && set({ orderUsd: v })} unit="USD" />
          </DlgRow>
          <DlgRow title="Out of the range" line="Keep its orders and wait for the price to come back, or stop.">
            <DlgSeg label="Out of the range" value={d.outOfRange} options={[{ value: 'wait', label: 'Wait' }, { value: 'stop', label: 'Stop' }]} onChange={(v) => set({ outOfRange: v })} />
          </DlgRow>
        </DlgSection>
      )}

      {d.strategy === 'market' && (
        <details className="bots-adv">
          <summary>Advanced</summary>
          <DlgSection label="Advanced">
            <DlgRow title="Rest" line="The longest a quote rests before it is placed again. 10 s kept the most fills from the patient taker and the fewest from the fast one in our live tests." stack>
              <NumField label="Up to" value={d.restS} onChange={(v) => set({ restS: Math.max(0.5, Math.min(120, v ?? 10)) })} unit="s" />
            </DlgRow>
            <DlgRow title="Where it quotes" line="At the best price, or one tick inside it where the spread has room (first in the queue, and first to be picked off).">
              <DlgSeg label="Where it quotes" value={d.offsetTicks < 0 ? 'inside' : 'touch'} options={[{ value: 'touch', label: 'Best price' }, { value: 'inside', label: 'One tick inside' }]} onChange={(v) => set({ offsetTicks: v === 'inside' ? -1 : 0 })} />
            </DlgRow>
            <DlgRow title="Unwind first" line="While it holds, the side that would add more steps back this many ticks at the cap. 0: both sides stay at the best price." stack>
              <NumField label="Skew" value={d.skewTicks} onChange={(v) => set({ skewTicks: Math.max(0, Math.round(v ?? 0)) })} unit="ticks" />
            </DlgRow>
            <DlgRow title="Spread limit" line="No quote while SoDEX's spread is wider than this: a book that thin is about to move. Empty: no limit." stack>
              <NumField label="Above" value={d.maxSpreadBps} optional onChange={(v) => set({ maxSpreadBps: v === null ? null : Math.max(1, v) })} unit="bp" />
            </DlgRow>
          </DlgSection>
        </details>
      )}

      <DlgSection label="Limits">
        <DlgRow title="Loss limit" line="Stops once its net PnL, after every fee, is this far below zero. Empty: no limit." stack>
          <NumField label="Stop at" value={d.maxLossUsd} optional onChange={(v) => set({ maxLossUsd: v })} unit="USD" />
        </DlgRow>
        <DlgRow title="Volume target" line="Stops once it traded this much. Empty: runs until you stop it." stack>
          <NumField label="Stop after" value={d.volumeTargetUsd} optional onChange={(v) => set({ volumeTargetUsd: v })} unit="USD" />
        </DlgRow>
        <DlgRow title="When it stops" line="Close what it holds (resting first, a capped taker after a minute), or keep it.">
          <DlgSeg label="When it stops" value={d.onStop} options={[{ value: 'close', label: 'Close' }, { value: 'keep', label: 'Keep' }]} onChange={(v) => set({ onStop: v })} />
        </DlgRow>
      </DlgSection>

      <DlgSection label="Run">
        <DlgRow title="Name" line="Optional: how it shows in your list." stack>
          <div className="oe-inputrow algo-in">
            <input className="oe-input bots-name" maxLength={40} placeholder="Market maker" value={d.label} onChange={(e) => set({ label: e.target.value })} aria-label="Name" />
          </div>
        </DlgRow>
        {!running && (
          <DlgRow title="Practice" line={liveAllowed ? 'Runs against the real book and sends nothing. Turn off to trade with real orders.' : 'Real orders open soon for your wallet. A practice bot runs against the real book and sends nothing.'}>
            <DlgSwitch on={!liveAllowed || d.paper} disabled={!liveAllowed} onChange={(on) => set({ paper: on })} label="Practice" />
          </DlgRow>
        )}
        {extraRun}
      </DlgSection>
    </>
  );
}
