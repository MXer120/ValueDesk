/**
 * The palette's building blocks, drawn after the reference surfaces
 * (docs/DESIGN.md): the leaderboard's trader marks and venue chips, the
 * execution panel's slider and number fields, the account View panel's glass
 * pop-over, the wallet pop-up's sections, the cohort pages' sliding ink.
 *
 *   - hooks: usePresence, useVisualViewportBox, useBoxSize, useInk;
 *   - controls: VenueChip (the leaderboard's `.lbp-chip`), Seg (one of N, with a
 *     sliding ink), FilterPop (a titled glass pop-over with Reset) and its
 *     fields RangeField / AmountField / QuickOptions, Kbd, Dropdown;
 *   - marks: TraderAvatar (the leaderboard's person well, venue badge),
 *     VenueMarks, AssetMark, CohortTag, VenueNote;
 *   - rows: NavRow, TraderListRow, ScreenerTableRow, LongShortBar, WinRateCell;
 *   - frames: Panel (a hairline section with a 42px head), EmptyState, SkeletonRows.
 *
 * Every row has a leading mark (DESIGN.md section 7), so rows align.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { COHORT_BY_ID } from '@sign/valuescan/cohorts/model.js';
import { VENUE_LABEL, type TraderRow, type Venue } from '../../vsApi';
import { VENUE_BRAND } from '../venueBrand';
import { VenueLogo } from '../VenueLogo';
import { CoinIcon } from '../CoinIcon';
import { DraftInput, integerInput } from '../numberInput';
import { CohortIcon } from '../explore/cohorts/CohortIcon';
import { IconCheck, IconChevronDown, IconPlus } from './icons';
import { winRateView, type WinRateFields } from '../../winRateView';
import {
  amountInput,
  fmtAmountInput,
  fmtFracPct,
  fmtUsdCompact,
  fmtUsdSigned,
  fmtWinRate,
  isMissing,
  lastActiveLabel,
  parseAmount,
  shortAddress,
  signOf,
  traderSizeCohort,
  visibleViewportBox,
  winRateTint,
  type AssetRow,
  type ScreenerRow,
  type ViewportBox,
} from './model';

/** The palette's layer: pop-overs are portalled into it (beside the dialog) and placed against it. */
export const HostContext = createContext<HTMLElement | null>(null);

/** A row from the screener, or a bare leaderboard row. */
export type AnyTrader = TraderRow & Partial<Omit<ScreenerRow, keyof TraderRow>>;

/** A row's name for plain-text uses (aria labels): the short address. A row's `label` is never shown. */
export const traderName = (r: { address: string }): string => shortAddress(r.address);

/** A figure's class: --dim when it prints as missing, else its sign's colour (if signed). */
const figClass = (text: string, v?: number | null): string => (isMissing(text) ? 'cp-na' : v === undefined ? '' : signOf(v));

/* ---------------------------------------------------------------------------
 * Hooks.
 * ------------------------------------------------------------------------ */

/**
 * Keeps something mounted while it animates out. `mounted` turns true with
 * `open` in the same render and false only when `done` is called - from the
 * exit animation's `animationend` - or after `fallbackMs`.
 */
export function usePresence(open: boolean, fallbackMs: number): { mounted: boolean; closing: boolean; done: () => void } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const closing = mounted && !open;
  const done = useCallback(() => setMounted(false), []);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(done, fallbackMs);
    return () => window.clearTimeout(t);
  }, [closing, done, fallbackMs]);
  return { mounted: mounted || open, closing, done };
}

/** The part of the window the user can actually see (phones: keyboard up), or null when it is all of it. */
export function useVisualViewportBox(active: boolean): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) return;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1';
    document.body.appendChild(probe);
    const read = () => {
      const fixed = probe.getBoundingClientRect();
      const next = visibleViewportBox(vv, { width: fixed.width, height: fixed.height });
      setBox((b) =>
        b === next || (b && next && b.top === next.top && b.left === next.left && b.width === next.width && b.height === next.height)
          ? b
          : next,
      );
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    window.addEventListener('resize', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
      probe.remove();
    };
  }, [active]);
  return active ? box : null;
}

/** An element's content-box size, kept current (ResizeObserver). */
export function useBoxSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const read = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    read();
    if (typeof ResizeObserver !== 'undefined') {
      obs.current = new ResizeObserver(read);
      obs.current.observe(el);
    }
  }, []);
  useEffect(() => () => obs.current?.disconnect(), []);
  return [ref, size];
}

/**
 * The cohort pages' sliding ink: where the chosen `.is-on` child of `ref` sits,
 * re-measured on resize. `ready` turns true after the first placement, so the
 * ink appears in place and only slides on later changes.
 */
export function useInk(ref: RefObject<HTMLElement>, key: string): { left: number; width: number; ready: boolean } | null {
  const [ink, setInk] = useState<{ left: number; width: number; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>(':scope > .is-on');
      if (!el) return setInk(null);
      setInk((cur) => {
        const next = { left: el.offsetLeft, width: el.offsetWidth, ready: cur !== null };
        return cur && cur.left === next.left && cur.width === next.width && cur.ready === next.ready ? cur : next;
      });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [ref, key]);
  return ink;
}

export function Ink({ ink }: { ink: { left: number; width: number; ready: boolean } | null }) {
  if (!ink) return null;
  return (
    <span
      className={`cp-ink${ink.ready ? ' is-ready' : ''}`}
      style={{ transform: `translateX(${ink.left}px)`, width: ink.width }}
      aria-hidden="true"
    />
  );
}

/* ---------------------------------------------------------------------------
 * Pop-overs (glass, pop set), portalled into the layer.
 * ------------------------------------------------------------------------ */

/** Longest a pop-over may take to animate out before it is removed anyway. */
const POP_EXIT_MS = 200;

interface PopPos { top: number; left: number; maxHeight: number; originX: number }

/** Open state, placement under the trigger, outside-click and scroll dismissal. */
function usePop(onOpen?: (menu: HTMLDivElement) => void) {
  const host = useContext(HostContext);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, POP_EXIT_MS);
  const [pos, setPos] = useState<PopPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Placed against the layer (its containing block), below the trigger, kept
  // inside the dialog's edges and never taller than the room left under it.
  useLayoutEffect(() => {
    if (!open || !host || !triggerRef.current) return;
    const c = triggerRef.current.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const d = (triggerRef.current.closest('.cp') ?? host).getBoundingClientRect();
    const w = popRef.current?.offsetWidth ?? 200;
    const top = c.bottom - h.top + 6;
    const minLeft = d.left - h.left + 8;
    const left = Math.max(minLeft, Math.min(c.left - h.left, d.right - h.left - w - 8));
    setPos({
      top,
      left,
      maxHeight: Math.max(140, d.bottom - h.top - top - 8),
      originX: Math.max(0, Math.min(w, c.left - h.left - left + c.width / 2)),
    });
  }, [open, host]);

  useEffect(() => {
    if (!presence.mounted) setPos(null);
  }, [presence.mounted]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    host?.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      host?.removeEventListener('scroll', onScroll, true);
    };
  }, [open, host]);

  const placed = pos !== null;
  useEffect(() => {
    if (open && placed && popRef.current) onOpen?.(popRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placed]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const style: CSSProperties = pos
    ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight, transformOrigin: `${pos.originX}px 0` }
    : { visibility: 'hidden', top: 0, left: 0 };
  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (presence.closing && e.target === e.currentTarget) presence.done();
  };
  return { host, open, setOpen, presence, triggerRef, popRef, close, style, onAnimationEnd };
}

export interface Option<T> {
  value: T;
  label: string;
}

/** A plain choice list in a glass menu (kept for single-choice filters). */
export function Dropdown<T extends string | number | null>({
  label, options, value, onChange, id,
}: {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (v: T) => void;
  id: string;
}) {
  const pop = usePop((menu) => {
    const sel = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLButtonElement>('button');
    sel?.focus({ preventScroll: true });
  });
  const current = options.find((o) => o.value === value) ?? options[0]!;
  const isSet = value !== options[0]?.value;
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const items = Array.from(pop.popRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      pop.close(true);
    }
  };
  return (
    <>
      <button
        ref={pop.triggerRef}
        type="button"
        className={`cp-pick${isSet ? ' is-set' : ''}${pop.open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? `${id}-menu` : undefined}
        onClick={() => (pop.open ? pop.close(false) : pop.setOpen(true))}
      >
        <span className="cp-pick__k">{label}</span>
        <span className="cp-pick__v">{current.label}</span>
        <span className="cp-pick__chev"><IconChevronDown /></span>
      </button>
      {pop.presence.mounted && pop.host && createPortal(
        <div
          ref={pop.popRef}
          id={`${id}-menu`}
          role="menu"
          aria-label={label}
          className={`cp-menu${pop.presence.closing ? ' is-closing' : ''}`}
          style={pop.style}
          onKeyDown={onKey}
          onAnimationEnd={pop.onAnimationEnd}
        >
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                tabIndex={pop.presence.closing ? -1 : undefined}
                className={`cp-menu__item${on ? ' is-on' : ''}`}
                onClick={() => {
                  if (pop.presence.closing) return;
                  onChange(o.value);
                  pop.close(true);
                }}
              >
                <span className="cp-menu__check">{on && <IconCheck size={14} />}</span>
                {o.label}
              </button>
            );
          })}
        </div>,
        pop.host,
      )}
    </>
  );
}

/**
 * A filter as a trigger ("Win rate  ≥ 60%") and a titled glass pop-over (the
 * account View panel's shape): a title, a Reset, and the fields. The pop-over
 * keeps every key to itself - digits typed into its fields must never reach
 * App's page shortcuts - and Escape returns to the trigger.
 */
export function FilterPop({
  id, label, value, active, title, onReset, children, width = 280,
}: {
  id: string;
  label: string;
  /** The trigger's value: the active setting, or "Any". */
  value: string;
  active: boolean;
  title: string;
  onReset: () => void;
  children: ReactNode;
  width?: number;
}) {
  const pop = usePop((el) => {
    const first = el.querySelector<HTMLElement>('input:not([type="range"]), .cp-quick > button.is-on, .cp-quick > button');
    first?.focus({ preventScroll: true });
  });
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      pop.close(true);
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      pop.close(true);
    } else if (e.key === 'Tab') {
      // Cycle inside the pop-over: it sits outside the dialog's focus trap.
      const els = Array.from(pop.popRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? []);
      if (!els.length) return;
      const i = els.indexOf(document.activeElement as HTMLElement);
      const next = els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length];
      e.preventDefault();
      next?.focus();
    }
  };
  return (
    <>
      <button
        ref={pop.triggerRef}
        type="button"
        className={`cp-pick${active ? ' is-set' : ''}${pop.open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? `${id}-pop` : undefined}
        onClick={() => (pop.open ? pop.close(false) : pop.setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            pop.setOpen(true);
          }
        }}
      >
        <span className="cp-pick__k">{label}</span>
        <span className="cp-pick__v cp-num">{value}</span>
        <span className="cp-pick__chev"><IconChevronDown /></span>
      </button>
      {pop.presence.mounted && pop.host && createPortal(
        <div
          ref={pop.popRef}
          id={`${id}-pop`}
          role="dialog"
          aria-label={title}
          className={`cp-fpop${pop.presence.closing ? ' is-closing' : ''}`}
          style={{ ...pop.style, width }}
          onKeyDown={onKey}
          onAnimationEnd={pop.onAnimationEnd}
        >
          <div className="cp-fpop__head">
            <span className="cp-fpop__title">{title}</span>
            <button type="button" className="cp-fpop__reset" disabled={!active} onClick={onReset}>Reset</button>
          </div>
          {children}
        </div>,
        pop.host,
      )}
    </>
  );
}

/** A label over a field inside a pop-over. */
export function FieldLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="cp-flbl">
      <span>{children}</span>
      {aside != null && <span className="cp-flbl__aside">{aside}</span>}
    </div>
  );
}

/**
 * The execution panel's percentage control (OrderEntry's `.oe-slider`): the
 * striped rail with its fill, the white thumb, and a number field beside it -
 * one control with two grips. `tint` colours the fill.
 */
export function RangeField({
  value, onChange, min = 0, max = 100, step = 1, suffix = '%', label, tint,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  label: string;
  tint?: string;
}) {
  const v = value ?? min;
  const p = max > min ? (v - min) / (max - min) : 0;
  return (
    <div className="cp-slider" style={{ '--cp-p': p, '--cp-tint': tint ?? 'var(--muted)' } as CSSProperties}>
      <div className="cp-slider__rail">
        <div className="cp-slider__fill" />
        <input
          className="cp-slider__input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          aria-label={label}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(n <= min ? null : n);
          }}
        />
      </div>
      <label className="cp-numbox">
        <DraftInput
          className="cp-numbox__in cp-num"
          value={value === null ? '' : String(value)}
          onDraft={(t) => onChange(t === '' ? null : Math.min(max, Math.max(min, Number(t))) || null)}
          sanitize={(raw) => integerInput(raw, String(max).length)}
          inputMode="numeric"
          aria-label={label}
          placeholder="Any"
        />
        <span className="cp-numbox__suf">{suffix}</span>
      </label>
    </div>
  );
}

/** An amount ("$" · 250k): typed shorthand (k / m / b) in, the compact figure back at rest. */
export function AmountField({
  value, onChange, label, prefix = '$', suffix,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <label className="cp-numbox cp-numbox--wide">
      {prefix && <span className="cp-numbox__pre">{prefix}</span>}
      <DraftInput
        className="cp-numbox__in cp-num"
        value={fmtAmountInput(value)}
        onDraft={(t) => onChange(parseAmount(t))}
        sanitize={amountInput}
        inputMode="decimal"
        aria-label={label}
        placeholder="Any"
      />
      {suffix && <span className="cp-numbox__suf">{suffix}</span>}
    </label>
  );
}

export interface QuickOption<T> {
  value: T;
  label: string;
  /** A win rate this option stands for: tints it toward --neg / --pos. */
  winRate?: number;
  title?: string;
}

/** A tint as a colour-mix, from winRateTint: at most a 16% wash. */
export function winTintColor(pct: number, max = 16): string | undefined {
  const t = winRateTint(pct);
  if (!t.side) return undefined;
  return `color-mix(in srgb, var(--${t.side}) ${Math.round(4 + t.strength * (max - 4))}%, transparent)`;
}

/** Quick choices as a row of chips; the chosen one is lit. */
export function QuickOptions<T extends string | number | null>({
  options, value, onChange, label, columns,
}: {
  options: readonly QuickOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  columns?: number;
}) {
  return (
    <div className="cp-quick" role="group" aria-label={label} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((o) => {
        const on = o.value === value;
        const tint = typeof o.winRate === 'number' ? winTintColor(o.winRate) : undefined;
        return (
          <button
            key={String(o.value)}
            type="button"
            className={on ? 'is-on' : ''}
            aria-pressed={on}
            title={o.title}
            style={tint ? ({ '--cp-qt': tint } as CSSProperties) : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A venue on/off chip - the leaderboard bar's `.lbp-chip`: the venue's mark and name, brand border + 11% fill when on. */
export function VenueChip({ venue, on, last = false, onToggle }: { venue: Venue; on: boolean; last?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`cp-vchip${on ? ' is-on' : ''}`}
      style={{ '--brand': VENUE_BRAND[venue] } as CSSProperties}
      aria-pressed={on}
      aria-label={VENUE_LABEL[venue]}
      onClick={onToggle}
      title={on && last ? 'At least one venue stays selected' : VENUE_LABEL[venue]}
    >
      <VenueLogo venue={venue} size={14} />
      <span className="cp-vchip__t">{VENUE_LABEL[venue]}</span>
    </button>
  );
}

export interface SegOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A count after the label ("Watchlist 3"); null hides it. */
  count?: number | null;
  title?: string;
}

/** One of N (DESIGN.md section 5, `.lbp-seg`): a bordered well, the chosen one under a sliding ink. */
export function Seg<T extends string>({
  options, value, onChange, label, size = 'md',
}: {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const ink = useInk(ref, `${value}|${options.map((o) => `${o.id}:${o.label}:${o.count ?? ''}`).join(',')}`);
  return (
    <span ref={ref} className={`cp-seg cp-seg--${size}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" className={on ? 'is-on' : ''} aria-pressed={on} title={o.title} onClick={() => onChange(o.id)}>
            {o.icon}
            <span>{o.label}</span>
            {typeof o.count === 'number' && o.count > 0 && <span className="cp-seg__n cp-num">{o.count}</span>}
          </button>
        );
      })}
      <Ink ink={ink} />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cp-kbd">{children}</kbd>;
}

/* ---------------------------------------------------------------------------
 * Marks.
 * ------------------------------------------------------------------------ */

/** The leaderboard's person glyph. */
function Person({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="3.1" fill="currentColor" />
      <path d="M5.2 19.4c1.3-3.3 3.6-4.8 6.8-4.8s5.5 1.5 6.8 4.8" fill="currentColor" />
    </svg>
  );
}

/**
 * Every trader's avatar: the leaderboard's round well with its person glyph,
 * and - when the row shows no venue marks elsewhere - the venue as a badge
 * (the wallet pop-up's coin-with-chain shape).
 */
export function TraderAvatar({ venue, size = 32 }: { venue?: Venue; size?: number }) {
  const badge = Math.max(12, Math.round(size * 0.44));
  const glyph = <Person size={Math.round(size * 0.58)} />;
  return (
    <span className="cp-av" style={{ width: size, height: size }} aria-hidden="true">
      {glyph}
      {venue && (
        <span className="cp-av__badge cp-vlogo" style={{ width: badge, height: badge }}>
          <VenueLogo venue={venue} size={badge} />
        </span>
      )}
    </span>
  );
}

/** A trader's venues, overlapped (the leaderboard's venue marks). */
export function VenueMarks({ venues, size = 16 }: { venues: readonly Venue[]; size?: number }) {
  const uniq = [...new Set(venues)];
  return (
    <span className="cp-vmarks" title={uniq.map((v) => VENUE_LABEL[v]).join(' · ')}>
      {uniq.map((v) => (
        <span key={v} className="cp-vlogo"><VenueLogo venue={v} size={size} /></span>
      ))}
    </span>
  );
}

/** A market's mark: its coin (every market is SoDEX's, so no venue badge). */
export function AssetMark({ a, size = 28 }: { a: Pick<AssetRow, 'coin' | 'base'> & Partial<Pick<AssetRow, 'venue'>>; size?: number }) {
  return (
    <span className="cp-av cp-av--coin" style={{ width: size, height: size }} aria-hidden="true">
      <CoinIcon coin={a.coin ?? a.base} size={size} />
    </span>
  );
}

/** A trader's account-size cohort as the cohort pages draw it: icon + name. */
export function CohortTag({ accountValue }: { accountValue: number | null | undefined }) {
  const id = traderSizeCohort(accountValue);
  if (!id) return <span className="cp-cohort cp-cohort--none" aria-hidden="true" />;
  const c = COHORT_BY_ID[id];
  return (
    <span className="cp-cohort" title={`${c.name}: ${c.range}`}>
      <CohortIcon id={id} size={14} />
      <span className="cp-cohort__n">{c.name}</span>
    </span>
  );
}

/** One honest line about a venue's data: its mark and a sentence. */
export function VenueNote({ venues, children }: { venues: readonly Venue[]; children: ReactNode }) {
  return (
    <p className="cp-vnote">
      <VenueMarks venues={venues} size={14} />
      <span>{children}</span>
    </p>
  );
}

/* ---------------------------------------------------------------------------
 * Rows.
 * ------------------------------------------------------------------------ */

export interface NavProps {
  navId: string;
  active: boolean;
  onHover: (id: string) => void;
  onRun: () => void;
}

/** Row container: option semantics, hover-to-highlight on real pointer movement only. */
export function NavRow({
  navId, active, onHover, onRun, className, role = 'option', children, title,
}: NavProps & { className: string; role?: 'option' | 'row'; children: ReactNode; title?: string }) {
  return (
    <div
      id={`cp-opt-${navId}`}
      role={role}
      aria-selected={active}
      data-nav-id={navId}
      className={`${className}${active ? ' is-active' : ''}`}
      onMouseMove={() => {
        if (!active) onHover(navId);
      }}
      onClick={onRun}
      title={title}
    >
      {children}
    </div>
  );
}

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

const STYLE_LABEL: Record<string, string> = {
  scalper: 'Scalper',
  intraday: 'Intraday',
  swing: 'Swing',
  position: 'Position',
  'high-leverage': 'High leverage',
  whale: 'Whale',
  vault: 'Vault',
};

export const strategyLabel = (s: string): string => STYLE_LABEL[s] ?? s;

/** "SoDEX · Swing · Whale" */
export function tagsLine(r: AnyTrader): string {
  const parts = [VENUE_LABEL[r.venue], ...(r.traits ?? []).map(strategyLabel)];
  if (r.strategy) parts.push(strategyLabel(r.strategy));
  return [...new Set(parts)].join(' · ');
}

const WINDOW_WORD: Record<string, string> = { '1d': '24h', '7d': '7D', '30d': '30D', all: 'All-time' };

/** A figure over its caption, right-aligned in a fixed column. */
export function Fig({ text, caption, v, className = '', title, approx = false }: { text: string; caption: string; v?: number | null; className?: string; title?: string; approx?: boolean }) {
  return (
    <span className={`cp-fig ${className}`} title={title}>
      <span className={`cp-fig__v cp-num ${figClass(text, v)}`}>{approx && <span className="cp-approx" aria-label="about">≈</span>}{text}</span>
      <span className="cp-fig__k">{caption}</span>
    </span>
  );
}

/**
 * One trader in a list: avatar, name (venue marks when on several venues) over
 * "venue · strategy · positions", then the size cohort, the PnL of the window
 * and the win rate in fixed right-aligned columns, and the watch toggle, which
 * shows on the lit row only (its space stays reserved).
 */
export function TraderListRow({
  row, nav, watched, onToggleWatch, window = '30d', subtitle,
}: {
  row: AnyTrader;
  nav: NavProps;
  watched: boolean;
  onToggleWatch: () => void;
  window?: '1d' | '7d' | '30d';
  subtitle?: ReactNode;
}) {
  const pnl = row.pnl?.[window] ?? null;
  const venues = [row.venue, ...(row.alsoOn ?? [])];
  const multi = new Set(venues).size > 1;
  const positions = typeof row.positions === 'number' ? `${row.positions} position${row.positions === 1 ? '' : 's'}` : null;
  const win = winRateView(row as WinRateFields, { dp: 0 });
  const short = shortAddress(row.address);
  const who = short;
  return (
    <NavRow {...nav} className="cp-row cp-row--trader">
      <TraderAvatar venue={multi ? undefined : row.venue} />
      <div className="cp-row__main">
        <div className="cp-row__title">
          <span className="cp-row__name">{short}</span>
          {multi && <VenueMarks venues={venues} size={14} />}
        </div>
        <div className="cp-row__sub">
          {subtitle ?? (
            <>
              <span>{VENUE_LABEL[row.venue]}</span>
              {row.strategy && <><span className="cp-dot">·</span><span>{strategyLabel(row.strategy)}</span></>}
              {positions && <><span className="cp-dot">·</span><span className="cp-num">{positions}</span></>}
            </>
          )}
        </div>
      </div>
      <CohortTag accountValue={row.accountValue} />
      <Fig text={fmtUsdSigned(pnl)} v={pnl} caption={`PnL ${WINDOW_WORD[window]}`} className="cp-fig--pnl" />
      <Fig text={win.text} approx={win.approx} caption="Win rate" className="cp-fig--win" title={win.title ?? (win.approx || typeof row.winRate === 'number' ? undefined : 'No win rate yet')} />
      <button
        type="button"
        className={`cp-iconbtn${watched ? ' is-on' : ''}`}
        aria-label={watched ? `Remove ${who} from watchlist` : `Add ${who} to watchlist`}
        aria-pressed={watched}
        title={watched ? 'Watching - click to remove' : 'Add to watchlist'}
        onClick={stop(onToggleWatch)}
      >
        {watched ? <IconCheck size={16} /> : <IconPlus />}
      </button>
    </NavRow>
  );
}

/** A win rate and its bar: exact as a plain %, an estimate with a muted "≈" (winRateView). */
export function WinRateCell({ row }: { row: WinRateFields }) {
  const v = row.winRate;
  const known = typeof v === 'number' && Number.isFinite(v);
  const view = winRateView(row, { dp: 0 });
  return (
    <div className="cp-win" title={view.title ?? (known ? undefined : 'No win rate yet')}>
      <span className={`cp-num ${figClass(view.text)}`}>{view.approx && <span className="cp-approx" aria-label="about">≈</span>}{view.text}</span>
      <span className="cp-bar" aria-hidden="true">
        {known && <span className="cp-bar__fill" style={{ width: `${Math.max(2, Math.min(100, v * 100))}%` }} />}
      </span>
    </div>
  );
}

/** One trader in the Screener's table. */
export function ScreenerTableRow({
  row, nav, now, window, volWindow,
}: {
  row: AnyTrader;
  nav: NavProps;
  now: number;
  window: string;
  volWindow: string;
}) {
  const pnl = row.pnl?.[window as '30d'] ?? null;
  const roi = row.roi?.[window as '30d'] ?? null;
  const vol = fmtUsdCompact(row.volume?.[volWindow as '1d']);
  const av = fmtUsdCompact(row.accountValue);
  const roiText = fmtFracPct(roi);
  const active = row.lastActive !== undefined || row.activeWithin !== undefined ? lastActiveLabel(row as ScreenerRow, now) : '—';
  return (
    <NavRow {...nav} className="cp-grow" role="row">
      <div role="gridcell" className="cp-gcell cp-gcell--lead">
        <TraderAvatar venue={row.venue} size={30} />
        <div className="cp-gcell__text">
          <div className="cp-row__title"><span className="cp-row__name">{shortAddress(row.address)}</span></div>
          <div className="cp-row__sub">{tagsLine(row)}</div>
        </div>
      </div>
      <div role="gridcell" className="cp-gcell cp-gcell--win"><WinRateCell row={row as WinRateFields} /></div>
      <div role="gridcell" className={`cp-gcell cp-num cp-gcell--vol ${figClass(vol)}`}>{vol}</div>
      <div role="gridcell" className={`cp-gcell cp-num cp-gcell--av ${figClass(av)}`}>{av}</div>
      <div role="gridcell" className="cp-gcell cp-gcell--pnl" title={`ROI ${roiText} · PnL ${fmtUsdSigned(pnl)} (${WINDOW_WORD[window] ?? window})`}>
        <span className={`cp-num ${figClass(roiText, roi)}`}>{roiText}</span>
        {typeof pnl === 'number' && Number.isFinite(pnl) && <span className={`cp-sub cp-num ${signOf(pnl)}`}>{fmtUsdSigned(pnl)}</span>}
      </div>
      <div role="gridcell" className={`cp-gcell cp-gcell--active ${figClass(active)}`}>{active}</div>
    </NavRow>
  );
}

/** Long share of the tracked top traders as a split bar (`.pf-split`: --pos over --neg). */
export function LongShortBar({ share, traders }: { share: number | null; traders: number | null }) {
  if (share === null) return <span className="cp-na">—</span>;
  const pct = Math.round(share * 100);
  return (
    <span className="cp-ls" title={`${pct}% of the tracked top traders' notional is long${traders ? ` (${traders} positions)` : ''}`}>
      <span className={`cp-ls__txt cp-num ${pct >= 50 ? 'pos' : 'neg'}`}>{pct >= 50 ? `${pct}% L` : `${100 - pct}% S`}</span>
      <span className="cp-ls__bar" aria-hidden="true">
        <span className="cp-ls__long" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Frames and states.
 * ------------------------------------------------------------------------ */

/**
 * A section of the dialog (the wallet pop-up's hairline sections): a 42px head
 * strip (glyph, title, a quiet meta line, controls on the right) over a body.
 * With `scroll` the body is the one part that scrolls; the head stays put.
 */
export function Panel({
  title, icon, meta, right, className = '', scroll = false, children, bodyClass = '',
}: {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  className?: string;
  scroll?: boolean;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <section className={`cp-panel ${className}`} aria-label={title}>
      <header className="cp-panel__head">
        {icon && <span className="cp-panel__icon">{icon}</span>}
        <h3 className="cp-panel__title">{title}</h3>
        {meta != null && <span className="cp-panel__meta">{meta}</span>}
        {right && <span className="cp-panel__right">{right}</span>}
      </header>
      <div className={`cp-panel__body${scroll ? ' cp-scroll' : ''} ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** Empty (DESIGN.md section 8): a one-line title and one muted sentence. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cp-empty">
      <p className="cp-empty__t">{title}</p>
      {children && <p className="cp-empty__d">{children}</p>}
      {action}
    </div>
  );
}

/** Loading rows: the list's own shape, shimmering. */
export function SkeletonRows({ n, mark = 'round' }: { n: number; mark?: 'round' | 'square' }) {
  return (
    <div className="cp-skel" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="cp-skel__row">
          <span className={`cp-skel__av cp-shimmer${mark === 'square' ? ' is-square' : ''}`} />
          <span className="cp-skel__lines"><span className="cp-shimmer" /><span className="cp-shimmer" /></span>
        </div>
      ))}
    </div>
  );
}
