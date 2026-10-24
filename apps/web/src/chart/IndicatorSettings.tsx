/**
 * An indicator's settings, TradingView's two tabs, drawn as one of the app's
 * sheets (the Deposit / Withdraw / Connect family: `.modal.fx`, a glass sheet
 * with a centred title, labelled 42px wells, the FxSelect picker, one
 * full-width primary action):
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
import { FxSelect } from '../components/funds/ui';
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
    <span className="kc-set-seg" role="group" aria-label={`${label} width`}>
      {[1, 2, 3, 4].map((w) => (
        <button
          key={w}
          type="button"
          className={value === w ? 'on' : ''}
          aria-label={`${w} pixel line`}
          aria-pressed={value === w}
          title={`${w}px`}
          onClick={() => onPick(w)}
        >
          {lineIcon(w)}
        </button>
      ))}
    </span>
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
  const number = (label: string, i: number, aside?: JSX.Element) => (
    <div className="kc-set-field" key={i}>
      <span className="fx-lbl">{label}</span>
      <span className="kc-set-input">
        <input
          className="fx-input"
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
        {aside}
      </span>
    </div>
  );

  return (
    <Modal
      open
      title={indicatorTitle(spec.name)}
      onClose={() => onClose(false)}
      className="fx kc-set"
      footer={
        <div className="kc-set-foot">
          <button
            type="button"
            className="fx-link"
            onClick={() =>
              onChange({ name: spec.name, visible: spec.visible, height: spec.height, pane: spec.pane, calcParams: [...defaults] })
            }
          >
            Reset to defaults
          </button>
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
        <button type="button" role="tab" aria-selected={tab === 'inputs'} className={tab === 'inputs' ? 'on' : ''} onClick={() => setTab('inputs')}>
          Inputs
        </button>
        <button type="button" role="tab" aria-selected={tab === 'style'} className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
          Style
        </button>
      </div>

      {tab === 'inputs' && (
        <div className="kc-set-body" role="tabpanel">
          {info?.source && (
            <div className="kc-set-field">
              <span className="fx-lbl">Source</span>
              <FxSelect
                label="Source"
                value={spec.source ?? 'close'}
                options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
                onChange={(v) => onChange({ ...spec, source: v as PriceSource })}
                searchable={false}
              />
            </div>
          )}
          {info?.list ? (
            <>
              {params.map((_, i) =>
                number(
                  `${info.list!.label} ${i + 1}`,
                  i,
                  <button
                    type="button"
                    className="kc-set-x"
                    title="Remove"
                    aria-label={`Remove ${inSentence(info.list!.label)} ${i + 1}`}
                    disabled={params.length <= info.list!.min}
                    onClick={() => setParams(params.filter((__, j) => j !== i))}
                  >
                    {MENU_ICONS.remove}
                  </button>,
                ),
              )}
              {params.length === 0 && <p className="kc-set-note">No moving averages - just the bars.</p>}
              <button
                type="button"
                className="fx-cta fx-cta--ghost kc-set-add"
                disabled={params.length >= info.list.max}
                onClick={() => setParams([...params, params.length ? Math.min(1000, params[params.length - 1]! * 2) : 20])}
              >
                + Add {inSentence(info.list.label)}
              </button>
            </>
          ) : (info?.params.length ?? params.length) > 0 ? (
            <div className="kc-set-grid">
              {(info?.params.length ? info.params : params.map((_, i) => `Input ${i + 1}`)).map((label, i) => number(label, i))}
            </div>
          ) : (
            !info?.source && <p className="kc-set-note">This study has no inputs.</p>
          )}
        </div>
      )}

      {tab === 'style' && (
        <div className="kc-set-body" role="tabpanel">
          {titles.map((title, i) => {
            const o = spec.lines?.[i] ?? {};
            const color = o.color ?? LINE_COLORS[i % LINE_COLORS.length]!;
            return (
              <Fragment key={`${title}-${i}`}>
                <div className={`kc-set-line${o.hidden ? ' is-off' : ''}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Show ${title}`}
                    checked={!o.hidden}
                    onChange={(e) => setLine(i, { hidden: !e.target.checked })}
                  />
                  <span className="kc-set-line__name">{title}</span>
                  <Well value={color} label={title} open={pick === i} onToggle={() => toggle(i)} />
                  <Widths value={o.size ?? 1} label={title} onPick={(w) => setLine(i, { size: w })} />
                </div>
                {pick === i && <Palette value={color} label={title} onPick={(c) => setLine(i, { color: c })} />}
              </Fragment>
            );
          })}
          {hasBars && (
            <>
              <div className="kc-set-line">
                <span className="kc-set-line__name">Up bars</span>
                <Well value={spec.up ?? BAR_UP} label="Up bars" open={pick === 'up'} onToggle={() => toggle('up')} />
              </div>
              {pick === 'up' && <Palette value={spec.up ?? BAR_UP} label="Up bars" onPick={(c) => onChange({ ...spec, up: c })} />}
              <div className="kc-set-line">
                <span className="kc-set-line__name">Down bars</span>
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
