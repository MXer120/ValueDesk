/**
 * The right-hand end of the account band's tab bar:
 *
 *   [Updated 12 min ago]  [card | list]  [☐ BTC-USD]  [View ②]
 *
 * "View" opens ONE popover in the funds sheets' glass (`.fx-list`: --bg-elevated
 * at 88% over an 18px blur, --line hairline, 10px radius, the modal shadow),
 * portalled to <body> and placed against its button so the panel's own
 * overflow cannot clip it - on the trade page the band is the bottom row, so it
 * opens UPWARDS when there is no room below. Its sections are the Withdraw
 * sheet's source tiles at control size (`.fx-srct`: a hairline, --muted until
 * chosen, then a --text ring over a 7% --text fill); only the sections that can
 * narrow the active tab are drawn, plus the IDs switch where rows carry ids.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { usePresence } from '../motion';
import { createPortal } from 'react-dom';
import {
  DEFAULT_FILTER, activeCount, dayEnd, dayStart, sliderDomain, timeWindow, ymd,
  type MarginFilter, type Preset, type SideFilter, type SourceFilter, type TabCaps, type TableFilter,
} from './filters';
import { useShowIds } from './IdCell';

/** What the active table tells the bar about its rows. */
export interface BandMeta {
  /** Oldest row time loaded (ms), for the slider's span. */
  oldest: number | null;
  /** When the backend served an older copy because SoDEX refused (ms), else null. */
  staleAt: number | null;
  /** More history exists beyond what is loaded. */
  more: boolean;
}

export const NO_META: BandMeta = { oldest: null, staleAt: null, more: false };

export type CardView = 'card' | 'list';

export interface FilterBarProps {
  caps: TabCaps;
  filter: TableFilter;
  onFilter: (f: TableFilter) => void;
  /** The market the checkbox narrows to (display name), or null for no checkbox. */
  marketLabel: string | null;
  marketCoin?: string | null;
  currentOnly: boolean;
  onCurrentOnly: (v: boolean) => void;
  meta: BandMeta;
  /** Spot tables say Buy / Sell rather than Long / Short. */
  spot?: boolean;
  /** The card / list switch, where the tab has both. */
  view?: CardView;
  onView?: (v: CardView) => void;
  /** Spot or Perps, for a table that exists on both (the portfolio's): the first View section. */
  engineChoice?: { value: 'spot' | 'perps'; onChange: (e: 'spot' | 'perps') => void };
  /** The tab's rows carry SoDEX ids: the View pop-up offers the IDs column (IdCell.tsx). */
  ids?: boolean;
}

export function FilterBar({
  caps, filter, onFilter, marketLabel, currentOnly, onCurrentOnly, meta, spot = false, view, onView, engineChoice, ids = false,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const pres = usePresence(open);
  const btn = useRef<HTMLButtonElement>(null);
  const n = activeCount(filter, caps);
  const showView = !!engineChoice || ids || caps.margin || caps.side || caps.source || caps.time;

  return (
    <div className="acctf">
      {meta.staleAt !== null && <StaleNote at={meta.staleAt} />}
      {view && onView && (
        <div className="acctf-vt" role="group" aria-label="Layout">
          <button type="button" className={view === 'card' ? 'is-on' : ''} aria-pressed={view === 'card'} title="Cards" onClick={() => onView('card')}>
            <CardsIcon />
          </button>
          <button type="button" className={view === 'list' ? 'is-on' : ''} aria-pressed={view === 'list'} title="List" onClick={() => onView('list')}>
            <ListIcon />
          </button>
        </div>
      )}
      {caps.market && marketLabel && (
        <label className="acctf-mkt" title={`Only ${marketLabel} - the market open on the trade page`}>
          <input type="checkbox" checked={currentOnly} onChange={(e) => onCurrentOnly(e.target.checked)} />
          <span>{marketLabel}</span>
        </label>
      )}
      {showView && (
        <button
          ref={btn}
          type="button"
          className={`acctf-view${open ? ' is-open' : ''}${n > 0 ? ' is-active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <SlidersIcon />
          <span>View</span>
          {n > 0 && <span className="acctf-count" aria-label={`${n} filter${n === 1 ? '' : 's'} on`}>{n}</span>}
        </button>
      )}
      {pres.mounted && (
        <ViewPanel
          engineChoice={engineChoice}
          ids={ids}
          closing={pres.closing}
          onExited={pres.done}
          anchor={btn}
          caps={caps}
          filter={filter}
          onFilter={onFilter}
          meta={meta}
          spot={spot}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** "Updated 12 min ago" while the history on screen is a copy the backend kept. */
function StaleNote({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      className="acctf-stale"
      title={`Updated ${ago(now - at)} - SoDEX is not answering right now, so this is the copy read ${new Date(at).toLocaleString()}.`}
    >
      <ClockIcon />
      <span>{agoShort(now - at)}</span>
    </span>
  );
}

/** "12m", "3h", "2d" - the compact form for the crowded tab bar. */
export function agoShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// --- the popover ---------------------------------------------------------------

interface Pos { left: number; top?: number; bottom?: number; maxHeight: number }
const W = 316;
const GAP = 6;

function ViewPanel({
  anchor, caps, filter, onFilter, meta, spot, onClose, closing = false, onExited, engineChoice, ids,
}: {
  engineChoice?: FilterBarProps['engineChoice'];
  ids: boolean;
  closing?: boolean;
  onExited?: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
  caps: TabCaps;
  filter: TableFilter;
  onFilter: (f: TableFilter) => void;
  meta: BandMeta;
  spot: boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const place = useCallback(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(vw - W - 8, r.right - W));
    const below = vh - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const want = panel.current?.scrollHeight ?? 420;
    if (below >= Math.min(want, 360) || below >= above) setPos({ left, top: r.bottom + GAP, maxHeight: below });
    else setPos({ left, bottom: vh - r.top + GAP, maxHeight: above });
  }, [anchor]);

  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    const on = () => place();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [place]);

  // Outside press / Escape close it, as the settings menu does.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [anchor, onClose]);

  const set = (patch: Partial<TableFilter>) => onFilter({ ...filter, ...patch });
  const n = activeCount(filter, caps);
  const [showIds, setShowIds] = useShowIds();

  return createPortal(
    <div
      ref={panel}
      className={`acctf-pop${closing ? ' is-closing' : ''}`}
      onAnimationEnd={(e) => { if (closing && e.animationName === 'mo-pop-out') onExited?.(); }}
      role="dialog"
      aria-label="View options"
      style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight, width: W, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="acctf-head">
        <span>View</span>
        <button type="button" className="acctf-reset" disabled={n === 0} onClick={() => onFilter({ ...DEFAULT_FILTER })}>
          Reset
        </button>
      </div>

      {engineChoice && (
        <Section label="Market">
          <Seg<'spot' | 'perps'>
            value={engineChoice.value}
            onChange={engineChoice.onChange}
            options={[['spot', 'Spot'], ['perps', 'Futures']]}
          />
        </Section>
      )}
      {caps.margin && (
        <Section label="Margin">
          <Seg<MarginFilter>
            value={filter.margin}
            onChange={(margin) => set({ margin })}
            options={[['all', 'All'], ['cross', 'Cross'], ['isolated', 'Isolated']]}
          />
        </Section>
      )}
      {caps.side && (
        <Section label="Side">
          <Seg<SideFilter>
            value={filter.side}
            onChange={(side) => set({ side })}
            options={[['all', 'All'], ['long', spot ? 'Buy' : 'Long'], ['short', spot ? 'Sell' : 'Short']]}
            tones={{ long: 'pos', short: 'neg' }}
          />
        </Section>
      )}
      {caps.source && (
        <Section label="Source">
          <Seg<SourceFilter>
            value={filter.source}
            onChange={(source) => set({ source })}
            options={[['all', 'All'], ['manual', 'Manual'], ['copy', 'Copy']]}
          />
        </Section>
      )}
      {caps.time && <Timeframe filter={filter} onFilter={onFilter} meta={meta} />}
      {/* Not a filter: it hides no row, so Reset and the badge leave it alone. */}
      {ids && (
        <Section label="IDs">
          <Seg<'hide' | 'show'>
            value={showIds ? 'show' : 'hide'}
            onChange={(v) => setShowIds(v === 'show')}
            options={[['hide', 'Hidden'], ['show', 'Shown']]}
          />
        </Section>
      )}
    </div>,
    document.body,
  );
}

/** A titled block of a View pop-up; named by its label, so a choice inside it (Seg's "All") says which "All" it is. */
export function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="acctf-sec" role="group" aria-label={label}>
      <div className="acctf-lbl"><span>{label}</span>{aside}</div>
      {children}
    </div>
  );
}

export function Seg<T extends string>({
  value, onChange, options, tones, cols,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<[T, string]>;
  tones?: Partial<Record<T, 'pos' | 'neg'>>;
  /** Columns before the choices wrap to a second row (default: all on one row). */
  cols?: number;
}) {
  return (
    <div className="acctf-seg" role="radiogroup" style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`${value === v ? 'is-on' : ''}${tones?.[v] ? ` acctf-seg--${tones[v]}` : ''}`}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// --- timeframe -------------------------------------------------------------------

const PRESETS: Array<[Preset, string]> = [['24H', '24H'], ['7D', '7D'], ['30D', '30D'], ['90D', '90D'], ['all', 'All']];
const HOUR = 3_600_000;

function Timeframe({ filter, onFilter, meta }: { filter: TableFilter; onFilter: (f: TableFilter) => void; meta: BandMeta }) {
  const [now] = useState(() => Math.ceil(Date.now() / HOUR) * HOUR);
  const w = timeWindow(filter, now);
  const [lo, hi] = sliderDomain(meta.oldest, w.from, now);
  const from = w.from === null ? lo : Math.max(lo, w.from);
  const to = w.to === null ? hi : Math.min(hi, w.to);
  const pct = (t: number) => ((t - lo) / (hi - lo)) * 100;

  const custom = (f: number | null, t: number | null) =>
    onFilter({ ...filter, preset: f === null && t === null ? 'all' : 'custom', from: f, to: t });
  // A thumb at an end of the track is that end left open: "since the start", "until now".
  const moveFrom = (v: number) => { const a = Math.min(v, to - HOUR); custom(a <= lo + HOUR / 2 ? null : a, w.to); };
  const moveTo = (v: number) => { const b = Math.max(v, from + HOUR); custom(w.from, b >= hi - HOUR / 2 ? null : b); };

  return (
    <Section
      label="Timeframe"
      aside={meta.oldest !== null ? <span className="acctf-lbl__aside">loaded since {new Date(meta.oldest).toLocaleDateString()}</span> : undefined}
    >
      <div className="acctf-seg acctf-seg--presets" role="radiogroup" style={{ gridTemplateColumns: `repeat(${PRESETS.length}, minmax(0, 1fr))` }}>
        {PRESETS.map(([p, label]) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={filter.preset === p}
            className={filter.preset === p ? 'is-on' : ''}
            onClick={() => onFilter({ ...filter, preset: p, from: null, to: null })}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="acctf-range"
        style={{ ['--a' as string]: `${pct(from)}%`, ['--b' as string]: `${pct(to)}%` }}
      >
        <div className="acctf-range__track" aria-hidden="true"><span /></div>
        <input
          type="range"
          aria-label="Start"
          min={lo}
          max={hi}
          step={HOUR}
          value={from}
          onChange={(e) => moveFrom(Number(e.target.value))}
        />
        <input
          type="range"
          aria-label="End"
          min={lo}
          max={hi}
          step={HOUR}
          value={to}
          onChange={(e) => moveTo(Number(e.target.value))}
        />
      </div>

      <div className="acctf-dates">
        <label>
          <span>From</span>
          <input
            type="date"
            value={ymd(from)}
            max={ymd(to)}
            onChange={(e) => { const s = dayStart(e.target.value); if (s !== null) onFilter({ ...filter, preset: 'custom', from: s, to: w.to }); }}
          />
        </label>
        <span className="acctf-dates__arrow" aria-hidden="true">→</span>
        <label>
          <span>To</span>
          <input
            type="date"
            value={ymd(to)}
            min={ymd(from)}
            max={ymd(now)}
            onChange={(e) => { const t = dayEnd(e.target.value); if (t !== null) onFilter({ ...filter, preset: 'custom', from: w.from, to: t >= now ? null : t }); }}
          />
        </label>
      </div>
    </Section>
  );
}

// --- icons (the sheets' 1.5px line set) ------------------------------------------

const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.8V8l2.2 1.4" />
  </svg>
);
const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.6" />
    <circle cx="6" cy="11.5" r="1.6" />
  </svg>
);
const CardsIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" />
  </svg>
);
const ListIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </svg>
);
