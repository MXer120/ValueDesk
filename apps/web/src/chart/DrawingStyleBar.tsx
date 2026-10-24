/**
 * The floating bar over a selected drawing, TradingView's: colour, line width,
 * solid or dashed, the words of a text tool, lock, delete. It floats at the
 * top centre of the plot rather than chasing the drawing, so it never covers
 * the thing being styled and never jumps while the drawing is dragged.
 *
 * Everything applies at once and is saved with the drawing (Chart.tsx).
 */
import { useEffect, useRef, useState } from 'react';
import { SWATCHES } from './indicators';

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
}

const G = {
  viewBox: '-0.5 -0.5 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
} as const;

const LockIcon = (
  <svg {...G}>
    <path d="M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
const UnlockIcon = (
  <svg {...G}>
    <path d="M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 4.9-.6" />
  </svg>
);
const TrashIcon = (
  <svg {...G}>
    <path d="M2 4h12M6 4V2.5h4V4M3.5 4l.7 10h7.6l.7-10M6.5 7v4.5M9.5 7v4.5" />
  </svg>
);
const CloseIcon = (
  <svg {...G}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export function DrawingStyleBar({
  label, color, size, dashed, locked, text, focusText,
  onColor, onSize, onDashed, onText, onLock, onDelete, onClose,
}: DrawingStyleBarProps) {
  const [palette, setPalette] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusText) field.current?.select();
  }, [focusText]);

  return (
    <div
      className="kc-stylebar"
      role="toolbar"
      aria-label={`${label} style`}
      // The canvas would take this press as a click on the chart and deselect.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="kc-stylebar-name">{label}</span>
      <span className="kc-stylebar-sep" />
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
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
              <path d="M2 8h12" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
            </svg>
          </button>
        ))}
      </span>
      <span className="kc-stylebar-group" role="group" aria-label="Line style">
        <button type="button" className={dashed ? '' : 'on'} title="Solid" aria-label="Solid line" aria-pressed={!dashed} onClick={() => onDashed(false)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
            <path d="M2 8h12" stroke="currentColor" strokeWidth={1.5} />
          </svg>
        </button>
        <button type="button" className={dashed ? 'on' : ''} title="Dashed" aria-label="Dashed line" aria-pressed={dashed} onClick={() => onDashed(true)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
            <path d="M2 8h12" stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 2" />
          </svg>
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
      <button type="button" className={locked ? 'on' : ''} title={locked ? 'Unlock' : 'Lock'} aria-label={locked ? 'Unlock drawing' : 'Lock drawing'} aria-pressed={locked} onClick={() => onLock(!locked)}>
        {locked ? LockIcon : UnlockIcon}
      </button>
      <button type="button" className="kc-stylebar-del" title="Delete (Del)" aria-label="Delete drawing" onClick={onDelete}>
        {TrashIcon}
      </button>
      <button type="button" title="Close" aria-label="Close style bar" onClick={onClose}>
        {CloseIcon}
      </button>
    </div>
  );
}
