/**
 * An indicator's settings, TradingView's two tabs, in the Settings window's
 * language (dialogParts.tsx: labelled sections, a row per input with its
 * title, one line, a 40px field and its unit; switches that say Shown or
 * Hidden; OK the one primary action):
 *
 *   Inputs  the calculation parameters, named (Length, Std dev, Fast length…)
 *           rather than "param 1", and the price the study reads (Close, Open,
 *           High, Low, hl2…); for the list-shaped studies (MA, EMA, RSI, WR,
 *           BIAS, and the moving averages on Volume) lengths can be added and
 *           removed, each one its own line.
 *   Style   every line's visibility, colour and width, and the up / down bar
 *           colours where the study draws bars.
 *
 * Changes apply to the chart as they are made, so the effect is visible
 * behind the sheet; Cancel puts back what was there when it opened, OK keeps
 * it, Defaults resets to what a fresh copy of the study would have.
 */
import { Fragment, useState } from 'react';
import { Modal } from '../components/Modal';
import { DlgFoot, DlgRow, DlgSection, DlgSeg, DlgSwitch } from '../components/dialogParts';
import {
  BAR_DOWN,
  BAR_UP,
  INDICATOR_INFO,
  LINE_COLORS,
  SOURCES,
  SOURCE_LABEL,
  SWATCHES,
  indicatorTitle,
  type IndicatorLineSpec,
  type IndicatorSpec,
  type PriceSource,
} from './indicators';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { lineIcon } from './chartIcons';

export interface IndicatorSettingsProps {
  spec: IndicatorSpec;
  /** What a fresh copy of the study computes with. */
  defaults: number[];
  /** Line titles as the library names them ("MA5", "DIF"), for the Style tab. */
  lineTitles: (params: number[]) => string[];
  hasBars: boolean;
  onChange: (next: IndicatorSpec) => void;
  onClose: (keep: boolean) => void;
}

/** A colour well: the current colour; a click opens the palette under the row. */
export function Well({ value, label, open, onToggle }: { value: string; label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`kc-well${open ? ' is-open' : ''}`}
      aria-label={`${label} colour`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="kc-well__chip" style={{ background: value }} />
    </button>
  );
}

/** The palette, full width under the row it belongs to (a popover would be
 *  clipped by the sheet's scrolling body). */
export function Palette({ value, label, onPick }: { value: string; label: string; onPick: (c: string) => void }) {
  return (
    <div className="kc-palette" role="group" aria-label={`${label} colour`}>
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={`kc-swatch${c.toLowerCase() === value.toLowerCase() ? ' on' : ''}`}
          style={{ background: c }}
          aria-label={c}
          onClick={() => onPick(c)}
        />
      ))}
      <label className="kc-swatch-custom" title="Custom colour">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffb547'}
          onChange={(e) => onPick(e.target.value)}
        />
        Custom
      </label>
    </div>
  );
}

/** Line width as four line glyphs, the style bar's picker. */
export function Widths({ value, label, onPick }: { value: number; label: string; onPick: (w: number) => void }) {
  return (
    <DlgSeg
      label={`${label} width`}
      value={value}
      onChange={onPick}
      options={[1, 2, 3, 4].map((w) => ({ value: w, label: lineIcon(w), title: `${w}px`, aria: `${w} pixel line` }))}
    />
  );
}

/** A calculation input's unit, and one plain line about it. */
function paramMeta(label: string): { name: string; unit: string; line: string } {
  if (/\(%\)/.test(label)) {
    const name = label.replace(/\s*\(%\)/, '');
    const line = /start/i.test(name)
      ? 'Where the acceleration starts.'
      : /step/i.test(name)
        ? 'How much it speeds up each new extreme.'
        : 'The fastest it can get.';
    return { name, unit: '%', line };
  }
  if (/std/i.test(label)) return { name: 'Standard deviations', unit: 'SD', line: 'How far the bands sit from the middle line.' };
  if (/smoothing/i.test(label)) return { name: label, unit: 'bars', line: 'Bars used to smooth the line.' };
  if (/weight/i.test(label)) return { name: label, unit: '', line: 'How much the newest bar counts.' };
  if (/^MA\b/.test(label)) return { name: label, unit: 'bars', line: 'Bars in the average drawn over the study.' };
  return { name: label, unit: 'bars', line: 'Bars the study looks back over.' };
}

export function IndicatorSettings({ spec, defaults, lineTitles, hasBars, onChange, onClose }: IndicatorSettingsProps) {
  const [tab, setTab] = useState<'inputs' | 'style'>('inputs');
  /** Which colour well's palette is open: a line index, 'up' or 'down'. */
  const [pick, setPick] = useState<number | 'up' | 'down' | null>(null);
  const toggle = (k: number | 'up' | 'down') => setPick((p) => (p === k ? null : k));
  const info = INDICATOR_INFO[spec.name];
  const params = spec.calcParams ?? defaults;
  const titles = lineTitles(params);

  const setParams = (next: number[]) => onChange({ ...spec, calcParams: next });
  const setLine = (i: number, patch: IndicatorLineSpec) => {
    const lines = [...(spec.lines ?? [])];
    while (lines.length <= i) lines.push({});
    lines[i] = { ...lines[i], ...patch };
    onChange({ ...spec, lines });
  };

  const decimalParam = (label: string) => /std|%/i.test(label);
  /** 'Length' -> 'length', but 'MA length' stays 'MA length'. */
  const inSentence = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);
  const numberInput = (label: string, i: number, unit: string) => (
    <span className="dlg-field">
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={decimalParam(label) ? 0.1 : 1}
        max={1000}
        step={decimalParam(label) ? 0.1 : 1}
        value={params[i] ?? ''}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v) || v <= 0) return;
          const next = [...params];
          next[i] = decimalParam(label) ? v : Math.round(v);
          setParams(next);
        }}
      />
      {unit && <span className="dlg-unit">{unit}</span>}
    </span>
  );

  const paramLabels = info?.params.length ? info.params : params.map((_, i) => `Input ${i + 1}`);

  return (
    <Modal
      open
      title={indicatorTitle(spec.name)}
      onClose={() => onClose(false)}
      className="fx kc-set"
      footer={
        <DlgFoot
          left={
            <button
              type="button"
              className="dlg-link"
              onClick={() =>
                onChange({ name: spec.name, visible: spec.visible, height: spec.height, pane: spec.pane, calcParams: [...defaults] })
              }
            >
              Reset to defaults
            </button>
          }
        >
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
        <DlgSeg
          tabs
          label="Settings"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'inputs', label: 'Inputs' },
            { value: 'style', label: 'Style' },
          ]}
        />

        {tab === 'inputs' && (
          <div role="tabpanel">
            {info?.source && (
              <DlgSection label="Price">
                <DlgRow title="Source" line="The price of each bar the study reads.">
                  <select
                    className="dlg-select"
                    aria-label="Source"
                    value={spec.source ?? 'close'}
                    onChange={(e) => onChange({ ...spec, source: e.target.value as PriceSource })}
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </DlgRow>
              </DlgSection>
            )}
            {info?.list ? (
              <DlgSection label={`${info.list.label}s`} aside={<span>{params.length} of {info.list.max}</span>}>
                {params.map((_, i) => {
                  const label = `${info.list!.label} ${i + 1}`;
                  return (
                    <DlgRow key={i} title={label} line={i === 0 ? 'Bars each line averages over.' : undefined}>
                      {numberInput(label, i, 'bars')}
                      <button
                        type="button"
                        className="dlg-iconbtn is-danger"
                        title="Remove"
                        aria-label={`Remove ${inSentence(info.list!.label)} ${i + 1}`}
                        disabled={params.length <= info.list!.min}
                        onClick={() => setParams(params.filter((__, j) => j !== i))}
                      >
                        {MENU_ICONS.remove}
                      </button>
                    </DlgRow>
                  );
                })}
                {params.length === 0 && <p className="dlg-note">No moving averages - just the bars.</p>}
                <div className="dlg-row">
                  <button
                    type="button"
                    className="dlg-btn is-small"
                    disabled={params.length >= info.list.max}
                    onClick={() => setParams([...params, params.length ? Math.min(1000, params[params.length - 1]! * 2) : 20])}
                  >
                    + Add {inSentence(info.list.label)}
                  </button>
                </div>
              </DlgSection>
            ) : paramLabels.length > 0 ? (
              <DlgSection label="Calculation">
                {paramLabels.map((label, i) => {
                  const m = paramMeta(label);
                  return (
                    <DlgRow key={i} title={m.name} line={m.line}>
                      {numberInput(label, i, m.unit)}
                    </DlgRow>
                  );
                })}
              </DlgSection>
            ) : (
              !info?.source && <p className="dlg-note">This study has no inputs.</p>
            )}
          </div>
        )}

        {tab === 'style' && (
          <div role="tabpanel">
            {titles.length > 0 && (
              <DlgSection label="Lines">
                {titles.map((title, i) => {
                  const o = spec.lines?.[i] ?? {};
                  const color = o.color ?? LINE_COLORS[i % LINE_COLORS.length]!;
                  return (
                    <Fragment key={`${title}-${i}`}>
                      <DlgRow title={title} line="Shown, colour and width." off={o.hidden}>
                        <DlgSwitch
                          label={`Show ${title}`}
                          on={!o.hidden}
                          onWord="Shown"
                          offWord="Hidden"
                          onChange={(on) => setLine(i, { hidden: !on })}
                        />
                        <Well value={color} label={title} open={pick === i} onToggle={() => toggle(i)} />
                        <Widths value={o.size ?? 1} label={title} onPick={(w) => setLine(i, { size: w })} />
                      </DlgRow>
                      {pick === i && <Palette value={color} label={title} onPick={(c) => setLine(i, { color: c })} />}
                    </Fragment>
                  );
                })}
              </DlgSection>
            )}
            {hasBars && (
              <DlgSection label="Bars">
                <DlgRow title="Up bars" line="Bars that closed higher.">
                  <Well value={spec.up ?? BAR_UP} label="Up bars" open={pick === 'up'} onToggle={() => toggle('up')} />
                </DlgRow>
                {pick === 'up' && <Palette value={spec.up ?? BAR_UP} label="Up bars" onPick={(c) => onChange({ ...spec, up: c })} />}
                <DlgRow title="Down bars" line="Bars that closed lower.">
                  <Well value={spec.down ?? BAR_DOWN} label="Down bars" open={pick === 'down'} onToggle={() => toggle('down')} />
                </DlgRow>
                {pick === 'down' && <Palette value={spec.down ?? BAR_DOWN} label="Down bars" onPick={(c) => onChange({ ...spec, down: c })} />}
              </DlgSection>
            )}
            {titles.length === 0 && !hasBars && <p className="dlg-note">Nothing to style.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
