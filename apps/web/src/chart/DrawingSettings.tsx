/**
 * A drawing's settings, TradingView's dialog as one of the app's sheets (the
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
import { Fragment, useState } from 'react';
import { Modal } from '../components/Modal';
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
      className="fx-input"
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
  const tabs: Array<[Tab, string]> = [['style', 'Style'], ...(hasText ? [['text', 'Text'] as [Tab, string]] : []), ['coords', 'Coordinates']];
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
        <div className="kc-set-foot">
          <div className="kc-set-actions">
            <button type="button" className="fx-cta fx-cta--ghost" onClick={() => onClose(false)}>
              Cancel
            </button>
            <button type="button" className="fx-cta" onClick={() => onClose(true)}>
              OK
            </button>
          </div>
        </div>
      }
    >
      <div className="kc-set-tabs" role="tablist" aria-label="Settings">
        {tabs.map(([id, text]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {text}
          </button>
        ))}
      </div>

      {tab === 'style' && (
        <div className="kc-set-body" role="tabpanel">
          <div className="kc-set-line">
            <span className="kc-set-line__name">Line</span>
            <Well value={draft.color} label="Line" open={palette} onToggle={() => setPalette((p) => !p)} />
            <Widths value={draft.size} label="Line" onPick={(size) => set({ size })} />
            <span className="kc-set-seg" role="group" aria-label="Line style">
              <button type="button" className={draft.dashed ? '' : 'on'} aria-label="Solid line" aria-pressed={!draft.dashed} title="Solid" onClick={() => set({ dashed: false })}>
                {lineIcon(1.5)}
              </button>
              <button type="button" className={draft.dashed ? 'on' : ''} aria-label="Dashed line" aria-pressed={draft.dashed} title="Dashed" onClick={() => set({ dashed: true })}>
                {lineIcon(1.5, true)}
              </button>
            </span>
          </div>
          {palette && <Palette value={draft.color} label="Line" onPick={(color) => set({ color })} />}
          <div className={`kc-set-line${draft.visible ? '' : ' is-off'}`}>
            <input type="checkbox" role="switch" aria-label="Show on the chart" checked={draft.visible} onChange={(e) => set({ visible: e.target.checked })} />
            <span className="kc-set-line__name">Show on the chart</span>
          </div>
          <div className={`kc-set-line${draft.lock ? '' : ' is-off'}`}>
            <input type="checkbox" role="switch" aria-label="Locked" checked={draft.lock} onChange={(e) => set({ lock: e.target.checked })} />
            <span className="kc-set-line__name">Locked - cannot be moved</span>
          </div>
        </div>
      )}

      {tab === 'text' && hasText && (
        <div className="kc-set-body" role="tabpanel">
          <label className="kc-set-field">
            <span className="fx-lbl">Text</span>
            <textarea
              className="fx-input kc-set-text"
              rows={4}
              maxLength={200}
              value={draft.text ?? ''}
              // Delete and Backspace edit the words, never the drawing.
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => set({ text: e.target.value })}
              autoFocus
            />
          </label>
          {name === 'simpleTag' && <p className="kc-set-note">Left empty, the tag shows its price.</p>}
        </div>
      )}

      {tab === 'coords' && (
        <div className="kc-set-body kc-set-coords" role="tabpanel">
          {draft.points.map((p, i) => (
            <Fragment key={i}>
              <span className="kc-set-coords__n">{draft.points.length > 1 ? `Point ${i + 1}` : 'Anchor'}</span>
              <div className="kc-set-grid">
                {showPrice && (
                  <label className="kc-set-field">
                    <span className="fx-lbl">Price</span>
                    <PriceField value={p.value} precision={precision} step={step} onValue={(value) => setPoint(i, { value })} />
                  </label>
                )}
                {showTime && (
                  <label className="kc-set-field">
                    <span className="fx-lbl">Bar time{tz === 'utc' ? ' (UTC)' : ''}</span>
                    <input
                      className="fx-input"
                      type="datetime-local"
                      step={60}
                      value={inputTime(p.timestamp, tz)}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const ts = parseInputTime(e.target.value, tz, intervalMs);
                        if (ts !== null) setPoint(i, { timestamp: ts });
                      }}
                    />
                  </label>
                )}
              </div>
            </Fragment>
          ))}
          {draft.points.length === 0 && <p className="kc-set-note">This drawing has no anchors yet.</p>}
        </div>
      )}
    </Modal>
  );
}
