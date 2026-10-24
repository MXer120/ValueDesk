/**
 * An indicator's settings, TradingView's two tabs:
 *
 *   Inputs  the calculation parameters, named (Length, Std dev, Fast length…)
 *           rather than "param 1"; for the list-shaped studies (MA, EMA, RSI,
 *           WR, BIAS, and the moving averages on Volume) lengths can be added
 *           and removed, each one its own line.
 *   Style   every line's colour, width and visibility, and the up / down bar
 *           colours where the study draws bars.
 *
 * Changes apply to the chart as they are made, so the effect is visible
 * behind the dialog; Cancel puts back what was there when it opened, OK keeps
 * it, Defaults resets to what a fresh copy of the study would have.
 */
import { Fragment, useState } from 'react';
import { Modal } from '../components/Modal';
import {
  BAR_DOWN,
  BAR_UP,
  INDICATOR_INFO,
  LINE_COLORS,
  SOURCES,
  SOURCE_LABEL,
  SWATCHES,
  indicatorTitle,
  type PriceSource,
  type IndicatorLineSpec,
  type IndicatorSpec,
} from './indicators';

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
function Well({ value, label, open, onToggle }: { value: string; label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`kc-swatch${open ? ' on' : ''}`}
      style={{ background: value }}
      aria-label={`${label} colour`}
      aria-expanded={open}
      onClick={onToggle}
    />
  );
}

/** The palette, full width under the row it belongs to (a popover would be
 *  clipped by the dialog's scrolling body). */
function Palette({ value, label, onPick }: { value: string; label: string; onPick: (c: string) => void }) {
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
  const paramInput = (label: string, i: number) => (
    <label className="kc-set-row" key={i}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
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
    </label>
  );

  return (
    <Modal
      open
      title={indicatorTitle(spec.name)}
      onClose={() => onClose(false)}
      className="kc-set"
      footer={
        <div className="kc-set-foot">
          <button
            type="button"
           
            onClick={() =>
              onChange({ name: spec.name, visible: spec.visible, height: spec.height, pane: spec.pane, calcParams: [...defaults] })
            }
          >
            Defaults
          </button>
          <span className="kc-set-gap" />
          <button type="button" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => onClose(true)}>
            OK
          </button>
        </div>
      }
    >
      <div className="kc-set-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'inputs'} className={tab === 'inputs' ? 'on' : ''} onClick={() => setTab('inputs')}>
          Inputs
        </button>
        <button type="button" role="tab" aria-selected={tab === 'style'} className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
          Style
        </button>
      </div>

      {tab === 'inputs' && (
        <div className="kc-set-body">
          {info?.source && (
            <label className="kc-set-row">
              <span>Source</span>
              <select
                aria-label="Source"
                value={spec.source ?? 'close'}
                onChange={(e) => onChange({ ...spec, source: e.target.value as PriceSource })}
              >
                {SOURCES.map((src) => (
                  <option key={src} value={src}>
                    {SOURCE_LABEL[src]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {info?.list ? (
            <>
              {params.map((_, i) => (
                <div className="kc-set-line" key={i}>
                  {paramInput(`${info.list!.label} ${i + 1}`, i)}
                  <button
                    type="button"
                    className="kc-set-x"
                    aria-label={`Remove ${inSentence(info.list!.label)} ${i + 1}`}
                    disabled={params.length <= info.list!.min}
                    onClick={() => setParams(params.filter((__, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {params.length === 0 && <p className="kc-set-note">No moving averages - just the bars.</p>}
              <button
                type="button"
                className="kc-set-add"
                disabled={params.length >= info.list.max}
                onClick={() => setParams([...params, params.length ? Math.min(1000, params[params.length - 1]! * 2) : 20])}
              >
                + Add {inSentence(info.list.label)}
              </button>
            </>
          ) : (info?.params.length ?? params.length) > 0 ? (
            (info?.params.length ? info.params : params.map((_, i) => `Input ${i + 1}`)).map((label, i) => paramInput(label, i))
          ) : (
            <p className="kc-set-note">This study has no inputs.</p>
          )}
        </div>
      )}

      {tab === 'style' && (
        <div className="kc-set-body">
          {titles.map((title, i) => {
            const o = spec.lines?.[i] ?? {};
            const color = o.color ?? LINE_COLORS[i % LINE_COLORS.length]!;
            return (
              <Fragment key={`${title}-${i}`}>
              <div className="kc-set-row kc-set-style">
                <label className="kc-set-check">
                  <input type="checkbox" checked={!o.hidden} onChange={(e) => setLine(i, { hidden: !e.target.checked })} />
                  <span>{title}</span>
                </label>
                <Well value={color} label={title} open={pick === i} onToggle={() => toggle(i)} />
                <select
                  aria-label={`${title} width`}
                  value={o.size ?? 1}
                  onChange={(e) => setLine(i, { size: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4].map((w) => (
                    <option key={w} value={w}>
                      {w}px
                    </option>
                  ))}
                </select>
              </div>
              {pick === i && <Palette value={color} label={title} onPick={(c) => setLine(i, { color: c })} />}
              </Fragment>
            );
          })}
          {hasBars && (
            <>
              <div className="kc-set-row kc-set-style">
                <span>Up bars</span>
                <Well value={spec.up ?? BAR_UP} label="Up bars" open={pick === 'up'} onToggle={() => toggle('up')} />
              </div>
              {pick === 'up' && <Palette value={spec.up ?? BAR_UP} label="Up bars" onPick={(c) => onChange({ ...spec, up: c })} />}
              <div className="kc-set-row kc-set-style">
                <span>Down bars</span>
                <Well value={spec.down ?? BAR_DOWN} label="Down bars" open={pick === 'down'} onToggle={() => toggle('down')} />
              </div>
              {pick === 'down' && <Palette value={spec.down ?? BAR_DOWN} label="Down bars" onPick={(c) => onChange({ ...spec, down: c })} />}
            </>
          )}
          {titles.length === 0 && !hasBars && <p className="kc-set-note">Nothing to style.</p>}
        </div>
      )}
    </Modal>
  );
}
