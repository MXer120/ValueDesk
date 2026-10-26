/**
 * The Settings window's pieces for every other dialog (dialog.css): a
 * labelled section, a setting row (title, one line, control), a switch that
 * names its state, a segmented control and the dialog foot.
 */
import type { ReactNode } from 'react';
import './dialog.css';

export function DlgSection({ label, aside, children }: { label: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="dlg-label">
        <span>{label}</span>
        {aside}
      </div>
      <div className="dlg-card">{children}</div>
    </>
  );
}

export function DlgRow({
  title, line, children, off, stack, className,
}: {
  title: ReactNode;
  line?: ReactNode;
  children?: ReactNode;
  /** Dims the words (the thing it sets is hidden or off). */
  off?: boolean;
  /** The control under the words even when there is room beside them. */
  stack?: boolean;
  className?: string;
}) {
  return (
    <div className={`dlg-row${off ? ' is-off' : ''}${stack ? ' is-stack' : ''}${className ? ` ${className}` : ''}`}>
      <div className="dlg-rowtext">
        <b>{title}</b>
        {line && <small>{line}</small>}
      </div>
      {children !== undefined && <div className="dlg-ctl">{children}</div>}
    </div>
  );
}

export function DlgSwitch({
  on, onChange, label, onWord = 'On', offWord = 'Off', disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** What it switches, for screen readers. */
  label: string;
  onWord?: string;
  offWord?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`dlg-switch${on ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="dlg-track"><i /></span>
      <span>{on ? onWord : offWord}</span>
    </button>
  );
}

export function DlgSeg<T extends string | number>({
  value, options, onChange, label, tabs, disabled,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string; aria?: string }>;
  onChange: (v: T) => void;
  label: string;
  /** Full-width, as a dialog's tab bar. */
  tabs?: boolean;
  disabled?: boolean;
}) {
  return (
    <span className={`dlg-seg${tabs ? ' is-tabs' : ''}`} role={tabs ? 'tablist' : 'group'} aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role={tabs ? 'tab' : undefined}
          aria-selected={tabs ? value === o.value : undefined}
          aria-pressed={tabs ? undefined : value === o.value}
          aria-label={o.aria}
          title={o.title}
          className={value === o.value ? 'is-on' : ''}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** Cancel and the primary action on the right, an optional quiet link on the left. */
export function DlgFoot({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="dlg-foot">
      {left ?? <span />}
      <div className="dlg-actions">{children}</div>
    </div>
  );
}
