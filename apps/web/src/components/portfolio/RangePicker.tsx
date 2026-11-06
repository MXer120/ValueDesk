/**
 * A timeframe, as a dropdown: the app's own `Picker` (explore/cohorts/parts.tsx, the one DESIGN.md
 * names for dropdowns). A timeframe always has a value, so nothing is "set" to clear: the choice
 * stands in the Picker's empty slot, which also leaves its clear button out.
 */
import { Picker } from '../explore/cohorts/parts';

export function RangePicker<T extends string>({ value, options, onChange }: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  const shown = options.find(([k]) => k === value)?.[1] ?? value;
  return (
    <Picker label="Timeframe" value={null} empty={shown} onClear={() => {}} align="right">
      {(close) => (
        <div className="coh-pick__list">
          {options.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={k === value}
              className={`coh-pick__opt${k === value ? ' is-on' : ''}`}
              onClick={() => { onChange(k); close(); }}
            >
              <span className="coh-pick__label">{label}</span>
            </button>
          ))}
        </div>
      )}
    </Picker>
  );
}
