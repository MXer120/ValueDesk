/**
 * The floating bar over a selected drawing, TradingView's: colour, line width,
 * solid or dashed, the words of a text tool, lock, delete - icons only, no
 * words over the chart (the drawing's name is its aria-label). It floats at the
 * top centre of the plot rather than chasing the drawing - at the foot of the
 * price pane when the drawing's handles are up there (Chart.tsx places it) -
 * and steps aside while the drawing is dragged, so it never covers a handle.
 * The gear opens the full settings (DrawingSettings.tsx).
 *
 * Everything applies at once and is saved with the drawing (Chart.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import { SWATCHES } from './indicators';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { lineIcon } from './chartIcons';

export interface DrawingStyleBarProps {
  /** The tool's display name ("Trend line"). */
  label: string;
  color: string;
  size: number;
  dashed: boolean;
  locked: boolean;
  /** The drawing's text, or null for a tool that carries none. */
  text: string | null;
  /** Focus the text field on open (a text tool that was just placed). */
  focusText: boolean;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
  onDashed: (dashed: boolean) => void;
  onText: (text: string) => void;
  onLock: (locked: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  onSettings: () => void;
  /** While the drawing is dragged: out of the way, and no pointer. */
  hidden?: boolean;
  /** Its top in the plot, when not the default (the top of the plot). */
  top?: number;
}

export function DrawingStyleBar({
  label, color, size, dashed, locked, text, focusText,
  onColor, onSize, onDashed, onText, onLock, onDelete, onClose, onSettings, hidden = false, top,
}: DrawingStyleBarProps) {
  const [palette, setPalette] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusText) field.current?.select();
  }, [focusText]);

  return (
    <div
      className={`kc-stylebar${hidden ? ' is-hidden' : ''}`}
      style={top !== undefined ? { top } : undefined}
      role="toolbar"
      aria-hidden={hidden || undefined}
      aria-label={`${label} style`}
      // The canvas would take this press as a click on the chart and deselect.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="kc-stylebar-color">
        <button
          type="button"
          className="kc-swatch"
          style={{ background: color }}
          title="Colour"
          aria-label="Colour"
          aria-expanded={palette}
          onClick={() => setPalette((p) => !p)}
        />
        {palette && (
          <span className="kc-stylebar-palette" role="group" aria-label="Colour">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`kc-swatch${c.toLowerCase() === color.toLowerCase() ? ' on' : ''}`}
                style={{ background: c }}
                aria-label={c}
                onClick={() => {
                  onColor(c);
                  setPalette(false);
                }}
              />
            ))}
            <label className="kc-swatch-custom" title="Custom colour">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#ffb547'} onChange={(e) => onColor(e.target.value)} />
              Custom
            </label>
          </span>
        )}
      </span>
      <span className="kc-stylebar-group" role="group" aria-label="Line width">
        {[1, 2, 3, 4].map((w) => (
          <button
            key={w}
            type="button"
            className={size === w ? 'on' : ''}
            title={`${w}px`}
            aria-label={`${w} pixel line`}
            aria-pressed={size === w}
            onClick={() => onSize(w)}
          >
            {lineIcon(w)}
          </button>
        ))}
      </span>
      <span className="kc-stylebar-group" role="group" aria-label="Line style">
        <button type="button" className={dashed ? '' : 'on'} title="Solid" aria-label="Solid line" aria-pressed={!dashed} onClick={() => onDashed(false)}>
          {lineIcon(1.5)}
        </button>
        <button type="button" className={dashed ? 'on' : ''} title="Dashed" aria-label="Dashed line" aria-pressed={dashed} onClick={() => onDashed(true)}>
          {lineIcon(1.5, true)}
        </button>
      </span>
      {text !== null && (
        <input
          ref={field}
          className="kc-stylebar-text"
          type="text"
          aria-label="Text"
          placeholder="Text"
          value={text}
          maxLength={200}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            // Delete and Backspace edit the text, never the drawing.
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      )}
      <span className="kc-stylebar-sep" />
      <button type="button" title="Settings" aria-label="Drawing settings" onClick={onSettings}>
        {MENU_ICONS.settings}
      </button>
      <button type="button" className={locked ? 'on' : ''} title={locked ? 'Unlock' : 'Lock'} aria-label={locked ? 'Unlock drawing' : 'Lock drawing'} aria-pressed={locked} onClick={() => onLock(!locked)}>
        {locked ? MENU_ICONS.lock : MENU_ICONS.unlock}
      </button>
      <button type="button" className="kc-stylebar-del" title="Delete (Del)" aria-label="Delete drawing" onClick={onDelete}>
        {MENU_ICONS.remove}
      </button>
      <button type="button" title="Close" aria-label="Close style bar" onClick={onClose}>
        {MENU_ICONS.close}
      </button>
    </div>
  );
}
