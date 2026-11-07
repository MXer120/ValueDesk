/**
 * The Bots section's UI kit: TUFFUI (https://tuffui.com, MIT, (c) 2026 TUFFUI contributors) ported to this app's
 * plain CSS (kit.css), no Tailwind, no motion library, no icon package. The owner picked TUFFUI for this section
 * (2026-11-07). Same parts and behaviour as the originals:
 *
 *   Shell / Panel / Inset / IconTile / ShellHeader   depth by background only, no borders (surface)
 *   Button / IconButton                               silver primary, secondary, quiet, danger (action-button)
 *   StatusPill / Tag                                  tinted pills in five tones, always with text (status-pill)
 *   Segmented                                         radio group with a sliding pill (segmented-control)
 *   Tabs                                              the same pill for tab lists (tab-panels)
 *   ProgressBar / SegmentedBar                        clip-path fill, stripes, stacked shares (progress-bar)
 *   RollingNumber                                     odometer digits (rolling-number)
 *   Switch / Checkbox                                 (choice-controls)
 *   Field / NumberField / SearchField                 borderless fields with label, hint, error (text-field)
 *   EmptyState, Skeleton                              (empty-state, loading-skeleton)
 *   StatCard + Sparkline                              KPI card (stat-grid)
 *
 * Colours come from the app's tokens (kit.css maps them), so dark and light both work.
 */
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { toInputText } from '../../../numStyle';
import { decimalInput } from '../../numberInput';
import './kit.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/* ----------------------------------------------------------------- icons ----- */

const PATHS = {
  robot: <><rect x="4" y="6.5" width="12" height="9" rx="3" /><path d="M10 3.5v3M7.6 10.6h.01M12.4 10.6h.01M8 13.2h4" /></>,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  compass: <><circle cx="10" cy="10" r="6.5" /><path d="m12.7 7.3-1.8 3.6-3.6 1.8 1.8-3.6z" /></>,
  piggy: <><path d="M4 14.5 8 10.5l2.6 2.6L16 7.5" /><path d="M12.5 7.5H16V11" /></>,
  gauge: <><path d="M3.8 13.5a6.2 6.2 0 1 1 12.4 0" /><path d="m10 13.5 3-3.4" /></>,
  pulse: <path d="M3 10.5h3l1.8-4 3 8 1.8-4H17" />,
  chart: <><path d="M4 15.5h12" /><path d="M6 12.5v-3M10 12.5v-6M14 12.5v-4.5" /></>,
  coins: <><ellipse cx="8.5" cy="7" rx="4.5" ry="2.2" /><path d="M4 7v3.2c0 1.2 2 2.2 4.5 2.2M13 7v1" /><ellipse cx="12" cy="12" rx="4.5" ry="2.2" /><path d="M7.5 12v2.2c0 1.2 2 2.2 4.5 2.2s4.5-1 4.5-2.2V12" /></>,
  warning: <><path d="M10 3.6 17 15.6H3z" /><path d="M10 8.6v3M10 13.6h.01" /></>,
  check: <path d="m5 10.4 3.2 3.1L15 6.7" />,
  pause: <path d="M7.5 5.5v9M12.5 5.5v9" />,
  play: <path d="M7 5.2v9.6l7.6-4.8z" />,
  stop: <rect x="5.8" y="5.8" width="8.4" height="8.4" rx="1.6" />,
  trash: <><path d="M4.5 6.5h11M8 6.5V4.8h4v1.7M6 6.5l.7 9h6.6l.7-9" /></>,
  search: <><circle cx="9" cy="9" r="5.2" /><path d="m13 13 3.2 3.2" /></>,
  x: <path d="m6 6 8 8M14 6l-8 8" />,
  up: <path d="M6.5 13.5 13.5 6.5M8 6.5h5.5V12" />,
  down: <path d="M6.5 6.5 13.5 13.5M13.5 8v5.5H8" />,
  flat: <path d="M5.5 10h9" />,
  gear: <><circle cx="10" cy="10" r="2.4" /><path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4" /></>,
  list: <path d="M5 6h10M5 10h10M5 14h10" />,
  clock: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.4 1.5" /></>,
  bolt: <path d="M11 3.5 5.5 11H10l-1 5.5L14.5 9H10z" />,
  shield: <path d="M10 3.5 15.5 5.6v4.1c0 3.2-2.3 5.7-5.5 6.8-3.2-1.1-5.5-3.6-5.5-6.8V5.6z" />,
  layers: <><path d="m10 3.8 6.5 3.5L10 10.8 3.5 7.3z" /><path d="m3.5 10.5 6.5 3.5 6.5-3.5M3.5 13.5 10 17l6.5-3.5" /></>,
  arrowLeft: <path d="M12 4.5 6.5 10l5.5 5.5" />,
  arrowRight: <path d="M8 4.5 13.5 10 8 15.5" />,
  star: <path d="m10 3.8 1.9 3.9 4.2.6-3 3 .7 4.2L10 13.5l-3.8 2 .7-4.2-3-3 4.2-.6z" />,
  wallet: <><rect x="3" y="5.5" width="14" height="10" rx="2.4" /><path d="M3 8.5h10.5M13 12h1.5" /></>,
  expand: <path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" />,
  grid: <><path d="M4 7h12M4 10h12M4 13h12" /><circle cx="7" cy="7" r="1" /><circle cx="12" cy="10" r="1" /><circle cx="9" cy="13" r="1" /></>,
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}

/* --------------------------------------------------------------- surface ----- */

export const Shell = forwardRef<HTMLElement, ComponentProps<'section'>>(function Shell({ className, ...p }, ref) {
  return <section ref={ref} className={cx('tf-shell', className)} {...p} />;
});
export function Panel({ className, ...p }: ComponentProps<'div'>) {
  return <div className={cx('tf-panel', className)} {...p} />;
}
export function Inset({ className, ...p }: ComponentProps<'div'>) {
  return <div className={cx('tf-inset', className)} {...p} />;
}
export type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning';
export function IconTile({ icon, tone = 'neutral', className, children }: { icon?: IconName; tone?: Tone; className?: string; children?: ReactNode }) {
  return <span aria-hidden="true" className={cx('tf-tile', `is-${tone}`, className)}>{icon ? <Icon name={icon} size={16} /> : children}</span>;
}
export function ShellHeader({ icon, tile, title, subtitle, aside, as: H = 'h3', className }: {
  icon?: IconName;
  /** Anything for the tile instead of an icon (a coin logo). */
  tile?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  as?: 'h2' | 'h3' | 'h4';
  className?: string;
}) {
  const hasTile = !!icon || !!tile;
  return (
    <div className={cx('tf-shellhead', className)}>
      {hasTile && <IconTile icon={icon}>{tile}</IconTile>}
      <div className={cx('tf-shellhead__t', !hasTile && 'is-bare')}>
        <H className="tf-shellhead__title">{title}</H>
        {subtitle && <p className="tf-shellhead__sub">{subtitle}</p>}
      </div>
      {aside && <div className="tf-shellhead__aside">{aside}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- buttons ----- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export function Button({ variant = 'secondary', size = 'sm', icon, loading, disabled, className, children, type = 'button', ...p }: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
}) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx('tf-btn', `is-${variant}`, `is-${size}`, className)} {...p}>
      {loading ? <span className="tf-spin" aria-hidden="true" /> : icon && <Icon name={icon} size={size === 'md' ? 16 : 14} />}
      {children}
    </button>
  );
}
export function IconButton({ icon, label, variant = 'quiet', size = 'sm', className, ...p }: Omit<ComponentProps<'button'>, 'children'> & { icon: IconName; label: string; variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('tf-btn', 'is-icon', `is-${variant}`, `is-${size}`, className)} {...p}>
      <Icon name={icon} size={size === 'md' ? 16 : 14} />
    </button>
  );
}

/* ------------------------------------------------------------------ pills ----- */

export function StatusPill({ tone = 'neutral', size = 'md', icon, dot, className, children, ...p }: ComponentProps<'span'> & { tone?: Tone; size?: 'sm' | 'md'; icon?: IconName; dot?: boolean; pulse?: boolean }) {
  const { pulse, ...rest } = p as { pulse?: boolean };
  return (
    <span className={cx('tf-pill', `is-${tone}`, `is-${size}`, className)} {...(rest as ComponentProps<'span'>)}>
      {dot && <i className={cx('tf-pill__dot', pulse && 'is-pulse')} aria-hidden="true" />}
      {icon && <Icon name={icon} size={size === 'sm' ? 11 : 13} />}
      {children}
    </span>
  );
}
export function Tag({ className, ...p }: ComponentProps<'span'>) {
  return <span className={cx('tf-tag', className)} {...p} />;
}

/* -------------------------------------------------------- segmented, tabs ----- */

/** The sliding pill under the active option: measured, so it travels between options of any width. */
function usePill(ref: React.RefObject<HTMLElement | null>, active: string) {
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  const [instant, setInstant] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(active)}"]`);
    if (!el) return setBox(null);
    setBox({ x: el.offsetLeft, w: el.offsetWidth });
  }, [ref, active]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const a = el.querySelector<HTMLElement>('[data-on="1"]');
      if (a) setBox({ x: a.offsetLeft, w: a.offsetWidth });
    });
    ro.observe(el);
    // First paint: no slide in from the left.
    const t = setTimeout(() => setInstant(false), 50);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [ref]);
  return { box, instant, setInstant };
}

export interface SegOption<T extends string> { value: T; label: ReactNode; disabled?: boolean; count?: number }

export function Segmented<T extends string>({ options, value, onChange, label, size = 'sm', className }: {
  options: Array<SegOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { box, instant, setInstant } = usePill(ref, value);
  const onKey = (e: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const on = options.filter((o) => !o.disabled);
    const at = on.findIndex((o) => o.value === value);
    const next = on[(at + step + on.length) % on.length];
    if (!next) return;
    setInstant(true);
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
    setTimeout(() => setInstant(false), 30);
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} onKeyDown={onKey} className={cx('tf-seg', `is-${size}`, className)}>
      {box && <span className={cx('tf-seg__pill', instant && 'is-instant')} style={{ transform: `translateX(${box.x}px)`, width: box.w }} aria-hidden="true" />}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            data-on={on ? '1' : undefined}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            className={cx('tf-seg__opt', on && 'is-on')}
            onClick={() => onChange(o.value)}
          >
            {o.label}
            {o.count !== undefined && <span className="tf-seg__count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label, className }: {
  tabs: Array<SegOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { box, instant } = usePill(ref, value);
  const onKey = (e: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.value === value);
    const next = tabs[(at + step + tabs.length) % tabs.length]!;
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} onKeyDown={onKey} className={cx('tf-seg', 'tf-tabs', className)}>
      {box && <span className={cx('tf-seg__pill', instant && 'is-instant')} style={{ transform: `translateX(${box.x}px)`, width: box.w }} aria-hidden="true" />}
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" aria-selected={on} data-value={t.value} data-on={on ? '1' : undefined} tabIndex={on ? 0 : -1} className={cx('tf-seg__opt', on && 'is-on')} onClick={() => onChange(t.value)}>
            {t.label}
            {t.count !== undefined && <span className="tf-seg__count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- progress ----- */

export function ProgressBar({ value, max = 100, tone = 'brand', color, size = 'md', striped, kind = 'progress', label, valueText, className }: {
  value: number; max?: number; tone?: Tone; color?: string; size?: 'sm' | 'md' | 'lg'; striped?: boolean; kind?: 'progress' | 'meter'; label: string; valueText?: string; className?: string;
}) {
  const r = Math.min(Math.max(max > 0 ? value / max : 0, 0), 1);
  return (
    <div role={kind === 'meter' ? 'meter' : 'progressbar'} aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText ?? `${Math.round(r * 100)}%`} className={cx('tf-bar', `is-${size}`, className)}>
      <span className={cx('tf-bar__fill', !color && `is-${tone}`, striped && 'is-striped')} style={{ backgroundColor: color, clipPath: `inset(0 ${(1 - r) * 100}% 0 0 round 9999px)` }} />
    </div>
  );
}

export function SegmentedBar({ segments, max, size = 'md', label, className }: {
  segments: Array<{ id: string; value: number; label: string; color: string }>; max: number; size?: 'sm' | 'md' | 'lg'; label: string; className?: string;
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={total} aria-valuetext={segments.map((s) => `${s.label} ${Math.round((s.value / (max || 1)) * 100)}%`).join(', ')} className={cx('tf-segbar', `is-${size}`, className)}>
      {segments.filter((s) => s.value > 0).map((s) => (
        <span key={s.id} title={`${s.label} · ${Math.round((s.value / (max || 1)) * 100)}%`} style={{ width: `${(s.value / (max || 1)) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

/* --------------------------------------------------------- rolling number ----- */

/** Odometer: each digit rolls to its new value; units, signs and separators stay put. */
export function RollingNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cx('tf-roll', className)}>
      <span className="tf-sr">{value}</span>
      <span aria-hidden="true" className="tf-roll__v">
        {[...value].map((ch, i) => (/\d/.test(ch)
          ? (
            <span key={`${value.length - i}`} className="tf-roll__d">
              <span className="tf-roll__ghost">0</span>
              <span className="tf-roll__col" style={{ transform: `translateY(${-Number(ch) * 10}%)` }}>
                {'0123456789'.split('').map((n) => <span key={n}>{n}</span>)}
              </span>
            </span>
          )
          : <span key={`${value.length - i}-${ch}`} className="tf-roll__s">{ch}</span>))}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------- choice controls ----- */

export function Switch({ checked, onChange, label, description, disabled, hideLabel, className }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean; hideLabel?: boolean; className?: string;
}) {
  const id = useId();
  const sw = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      disabled={disabled}
      className={cx('tf-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="tf-switch__thumb" />
    </button>
  );
  if (hideLabel) return sw;
  return (
    <span className={cx('tf-choice', disabled && 'is-off', className)}>
      {sw}
      <label htmlFor={id} className="tf-choice__t">
        <span className="tf-choice__l">{label}</span>
        {description && <span className="tf-choice__d">{description}</span>}
      </label>
    </span>
  );
}

export function Checkbox({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; className?: string }) {
  return (
    <label className={cx('tf-check', className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx('tf-check__box', checked && 'is-on')} aria-hidden="true">{checked && <Icon name="check" size={12} />}</span>
      <span className="tf-check__l">{label}</span>
    </label>
  );
}

/* ----------------------------------------------------------------- fields ----- */

export function Field({ label, description, error, className, children, htmlFor }: { label?: ReactNode; description?: ReactNode; error?: string | null; className?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={cx('tf-field', className)}>
      {label && <label htmlFor={htmlFor} className="tf-field__l">{label}</label>}
      {children}
      {error ? <p className="tf-field__e" role="alert">{error}</p> : description && <p className="tf-field__d">{description}</p>}
    </div>
  );
}

export function TextInput({ className, ...p }: ComponentProps<'input'>) {
  return <input className={cx('tf-input', className)} {...p} />;
}

/** A number in a borderless pill: the label inside on the left, the unit on the right (the app's decimal input rules). */
export function NumberField({ label, value, onChange, unit, placeholder, disabled, error, optional, className, hideLabel }: {
  label: string; value: number | null; onChange: (v: number | null) => void; unit?: string; placeholder?: string; disabled?: boolean; error?: string | null; optional?: boolean; className?: string;
  /** Named for screen readers only (a field beside its own slider). */
  hideLabel?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    if (value === null ? text !== '' : Number(text) !== value) setText(value === null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cx('tf-num', error && 'is-bad', disabled && 'is-off', className)}>
      <label htmlFor={id} className={hideLabel ? 'tf-sr' : 'tf-num__l'}>{label}</label>
      {hideLabel && unit === 'USD' && <span className="tf-num__l">$</span>}
      <input
        id={id}
        autoComplete="off"
        inputMode="decimal"
        disabled={disabled}
        value={toInputText(text)}
        placeholder={placeholder ?? (optional ? 'Off' : '')}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const t = decimalInput(e.target.value, { prev: text });
          setText(t);
          if (t === '' && optional) onChange(null);
          else if (Number.isFinite(Number(t)) && t !== '') onChange(Number(t));
        }}
      />
      {unit && !(hideLabel && unit === 'USD') && <span className="tf-num__u">{unit}</span>}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; className?: string }) {
  return (
    <div className={cx('tf-search', className)}>
      <Icon name="search" size={14} className="tf-search__ic" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
      {value && <button type="button" className="tf-search__x" aria-label="Clear" onClick={() => onChange('')}><Icon name="x" size={12} /></button>}
    </div>
  );
}

/* ------------------------------------------------------ empty and loading ----- */

export function EmptyState({ icon = 'robot', title, description, actions, compact, tone, className }: {
  icon?: IconName; title: ReactNode; description?: ReactNode; actions?: ReactNode; compact?: boolean; tone?: 'error'; className?: string;
}) {
  return (
    <div className={cx('tf-empty', compact && 'is-compact', className)} role={tone === 'error' ? 'alert' : undefined}>
      <span className={cx('tf-empty__ic', tone === 'error' && 'is-error')} aria-hidden="true"><Icon name={icon} size={compact ? 16 : 20} /></span>
      <div className="tf-empty__t">
        <p className="tf-empty__title">{title}</p>
        {description && <p className="tf-empty__d">{description}</p>}
      </div>
      {actions && <div className="tf-empty__a">{actions}</div>}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cx('tf-skel', className)} style={style} aria-hidden="true" />;
}

/* ------------------------------------------------------------------- stats ----- */

export function Sparkline({ values, tone = 'neutral', w = 72, h = 28 }: { values: number[]; tone?: 'positive' | 'negative' | 'neutral'; w?: number; h?: number }) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 3 - ((v - min) / span) * (h - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const [lx, ly] = pts[pts.length - 1]!;
  return (
    <svg width={w} height={h} aria-hidden="true" className={cx('tf-spark', `is-${tone}`)}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${pts.at(-1)![0]},${h}L${pts[0]![0]},${h}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="tf-spark__line" />
      <circle cx={lx} cy={ly} r={2.5} fill="currentColor" />
    </svg>
  );
}

/** One KPI card (stat-grid's StatCard): label, a rolling value, an optional sparkline, delta pill, hint and goal. */
export function StatCard({ label, value, valueTone, trend, trendTone, hint, goal, pill, className, index = 0 }: {
  label: ReactNode;
  value: string;
  valueTone?: 'positive' | 'negative';
  trend?: number[];
  trendTone?: 'positive' | 'negative' | 'neutral';
  hint?: ReactNode;
  goal?: { ratio: number; label: string };
  pill?: ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <Panel className={cx('tf-stat', className)} data-i={index}>
      <p className="tf-stat__l">{label}</p>
      <div className="tf-stat__row">
        <RollingNumber value={value} className={cx('tf-stat__v', valueTone && `is-${valueTone}`)} />
        {trend && trend.length > 1 && <Sparkline values={trend} tone={trendTone} />}
      </div>
      {(pill || hint) && <div className="tf-stat__meta">{pill}{hint && <span className="tf-stat__hint">{hint}</span>}</div>}
      {goal && (
        <div className="tf-stat__goal">
          <ProgressBar value={goal.ratio} max={1} size="sm" striped tone={goal.ratio >= 1 ? 'positive' : 'brand'} label={`${typeof label === 'string' ? label : 'Goal'}: ${goal.label}`} />
          <p><span>{goal.label}</span><span>{Math.round(goal.ratio * 100)}%</span></p>
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------- settings ----- */

/** A setting: what it is and does on the left, its control on the right (stacked under on a phone). */
export function SettingRow({ title, line, children, stack }: { title: ReactNode; line?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cx('tf-setrow', stack && 'is-stack')}>
      <div className="tf-setrow__t">
        <p className="tf-setrow__title">{title}</p>
        {line && <p className="tf-setrow__line">{line}</p>}
      </div>
      <div className="tf-setrow__c">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ slider ----- */

/** A single slider (TUFFUI range-slider): the filled track to the thumb, min and max under it. */
export function Slider({ value, min, max, step = 1, onChange, label, minLabel, maxLabel, className }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; minLabel?: string; maxLabel?: string; className?: string;
}) {
  const r = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  return (
    <div className={cx('tf-slider', className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        aria-label={label}
        style={{ '--tf-fill': `${r * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {(minLabel || maxLabel) && <div className="tf-slider__ends"><span>{minLabel}</span><span>{maxLabel}</span></div>}
    </div>
  );
}
