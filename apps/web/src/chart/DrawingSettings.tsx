/**
 * A drawing's settings, TradingView's dialog in the Settings language (the
 * indicator settings' `.modal.fx.kc-set`, IndicatorSettings.tsx):
 *
 *   Style        line colour, width and solid / dashed; shown and locked.
 *   Text         the words of a text tool (Text, Note, Tag, Price label).
 *   Coordinates  every anchor's price and bar time, on the chart's clock;
 *                a time snaps to the bar it falls in.
 *
 * Opened from the drawing's right-click menu, the style bar's gear and a
 * double click on the drawing. Changes apply to the chart as they are made;
 * Cancel puts back what was there when it opened, OK keeps it.
 */
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { DlgFoot, DlgRow, DlgSection, DlgSeg, DlgSwitch } from '../components/dialogParts';
import { Palette, Well, Widths } from './IndicatorSettings';
import { lineIcon } from './chartIcons';
import { inputTime, parseInputTime, type TimeZoneMode } from './timeAxis';

/** Everything the dialog edits on one drawing. */
export interface DrawingDraft {
  color: string;
  size: number;
  dashed: boolean;
  /** The drawing's words, or null for a tool that carries none. */
  text: string | null;
  points: Array<{ timestamp: number; value: number }>;
  lock: boolean;
  visible: boolean;
}

export interface DrawingSettingsProps {
  /** The tool's display name ("Trend line"). */
  label: string;
  /** Its overlay name, for which coordinates it has. */
  name: string;
  draft: DrawingDraft;
  tz: TimeZoneMode;
  intervalMs: number;
  /** Decimals of the market's price. */
  precision: number;
  onChange: (next: DrawingDraft) => void;
  onClose: (keep: boolean) => void;
}

/** Tools anchored on a price alone, and on a time alone. */
const PRICE_ONLY = new Set(['horizontalStraightLine', 'priceLine', 'simpleTag']);
const TIME_ONLY = new Set(['verticalStraightLine']);

type Tab = 'style' | 'text' | 'coords';

/** A price as typed: half-typed text ("79 4", "79.") stays in the field and
 *  only a number reaches the drawing; leaving the field shows the price again. */
function PriceField({ value, precision, step, onValue }: { value: number; precision: number; step: number; onValue: (v: number) => void }) {
  const shown = value.toFixed(Math.max(0, precision));
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      aria-label="Price"
      type="number"
      inputMode="decimal"
      step={step}
      value={text ?? shown}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(v) && v > 0) onValue(v);
      }}
      onBlur={() => setText(null)}
    />
  );
}

export function DrawingSettings({ label, name, draft, tz, intervalMs, precision, onChange, onClose }: DrawingSettingsProps) {
  const hasText = draft.text !== null;
  const [tab, setTab] = useState<Tab>(hasText ? 'text' : 'style');
  const [palette, setPalette] = useState(false);
  const set = (patch: Partial<DrawingDraft>) => onChange({ ...draft, ...patch });
  const setPoint = (i: number, patch: Partial<{ timestamp: number; value: number }>) =>
    set({ points: draft.points.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'style', label: 'Style' },
    ...(hasText ? [{ value: 'text' as Tab, label: 'Text' }] : []),
    { value: 'coords', label: 'Coordinates' },
  ];
  const step = 10 ** -Math.max(0, Math.min(10, precision));
  const showTime = !PRICE_ONLY.has(name);
  const showPrice = !TIME_ONLY.has(name);

  return (
    <Modal
      open
      title={label}
      onClose={() => onClose(false)}
      className="fx kc-set"
      footer={
        <DlgFoot>
          <button type="button" className="dlg-btn" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button type="button" className="dlg-btn is-go" onClick={() => onClose(true)}>
            OK
          </button>
        </DlgFoot>
      }
    >
      <div className="dlg">
        <DlgSeg tabs label="Settings" value={tab} onChange={setTab} options={tabs} />

        {tab === 'style' && (
          <div role="tabpanel">
            <DlgSection label="Line">
              <DlgRow title="Colour" line="The drawing's line and its fill.">
                <Well value={draft.color} label="Line" open={palette} onToggle={() => setPalette((p) => !p)} />
              </DlgRow>
              {palette && <Palette value={draft.color} label="Line" onPick={(color) => set({ color })} />}
              <DlgRow title="Width" line="How thick the line is drawn.">
                <Widths value={draft.size} label="Line" onPick={(size) => set({ size })} />
              </DlgRow>
              <DlgRow title="Style" line="A solid or a dashed line.">
                <DlgSeg
                  label="Line style"
                  value={draft.dashed ? 'dashed' : 'solid'}
                  onChange={(v) => set({ dashed: v === 'dashed' })}
                  options={[
                    { value: 'solid', label: <>{lineIcon(1.5)} Solid</>, aria: 'Solid line' },
                    { value: 'dashed', label: <>{lineIcon(1.5, true)} Dashed</>, aria: 'Dashed line' },
                  ]}
                />
              </DlgRow>
            </DlgSection>
            <DlgSection label="On the chart">
              <DlgRow title="Visibility" line="Hidden drawings stay saved and come back when shown." off={!draft.visible}>
                <DlgSwitch label="Show on the chart" on={draft.visible} onWord="Shown" offWord="Hidden" onChange={(visible) => set({ visible })} />
              </DlgRow>
              <DlgRow title="Lock" line="A locked drawing cannot be moved or reshaped." off={!draft.lock}>
                <DlgSwitch label="Locked" on={draft.lock} onWord="Locked" offWord="Movable" onChange={(lock) => set({ lock })} />
              </DlgRow>
            </DlgSection>
          </div>
        )}

        {tab === 'text' && hasText && (
          <div role="tabpanel">
            <DlgSection label="Text">
              <div className="dlg-row is-full">
                <span className="dlg-field is-wide is-text">
                  <textarea
                    rows={4}
                    maxLength={200}
                    aria-label="Text"
                    placeholder="What the drawing says"
                    value={draft.text ?? ''}
                    // Delete and Backspace edit the words, never the drawing.
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => set({ text: e.target.value })}
                    autoFocus
                  />
                </span>
              </div>
            </DlgSection>
            <p className="dlg-note">
              {(draft.text ?? '').length} of 200 characters.{name === 'simpleTag' ? ' Left empty, the tag shows its price.' : ''}
            </p>
          </div>
        )}

        {tab === 'coords' && (
          <div role="tabpanel" className="kc-set-coords">
            {draft.points.map((p, i) => (
              <DlgSection key={i} label={draft.points.length > 1 ? `Point ${i + 1}` : 'Anchor'}>
                {showPrice && (
                  <DlgRow title="Price" line={i === 0 ? 'Where the point sits on the price scale.' : undefined}>
                    <span className="dlg-field">
                      <PriceField value={p.value} precision={precision} step={step} onValue={(value) => setPoint(i, { value })} />
                    </span>
                  </DlgRow>
                )}
                {showTime && (
                  <DlgRow title="Bar time" line={i === 0 ? `Snaps to the bar it falls in${tz === 'utc' ? ', in UTC' : ', on your clock'}.` : undefined}>
                    <span className="dlg-field is-time">
                      <input
                        type="datetime-local"
                        aria-label={`Point ${i + 1} bar time`}
                        step={60}
                        value={inputTime(p.timestamp, tz)}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const ts = parseInputTime(e.target.value, tz, intervalMs);
                          if (ts !== null) setPoint(i, { timestamp: ts });
                        }}
                      />
                    </span>
                  </DlgRow>
                )}
              </DlgSection>
            ))}
            {draft.points.length === 0 && <p className="dlg-note">This drawing has no anchors yet.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
