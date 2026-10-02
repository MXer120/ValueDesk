/**
 * The cells every account table shares: the market cell (coin logo, name, side
 * pill - image 16), the pills themselves (the funds sheets' `.fx-badge`: a 16%
 * tint of the colour, no border), the status cell, and the signed-money
 * formatting the Position History card uses (image 15).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Symbol as MarketSymbol } from '../../api';
import { DASH, MINUS, fmt, marketName, pick } from '../../format';
import { CoinIcon } from '../CoinIcon';
import type { Direction, OrderSource } from './filters';
import { StatusIcon } from './StatusIcon';
import { formatPct, orderStatusInfo, statusTitle, type StatusInput } from './orderStatus';
import { formatNumber } from '../../intlCache';
import { AUTO_LOAD_START, onEndSeen, type AutoLoadState } from './autoLoad';

export type PillTone = 'pos' | 'neg' | 'accent' | 'warn' | 'muted';

export function Pill({ tone, children, title }: { tone: PillTone; children: ReactNode; title?: string }) {
  return <span className={`acct-pill acct-pill--${tone}`} title={title}>{children}</span>;
}

/** Long / Short on perps, Buy / Sell on spot. */
export function SidePill({ dir, spot = false, prefix }: { dir: Direction | null; spot?: boolean; prefix?: string }) {
  if (!dir) return null;
  const word = spot ? (dir === 'long' ? 'Buy' : 'Sell') : dir === 'long' ? 'Long' : 'Short';
  return <Pill tone={dir === 'long' ? 'pos' : 'neg'}>{prefix ? `${prefix} ${word}` : word}</Pill>;
}

export function SourcePill({ source }: { source: OrderSource | null | undefined }) {
  if (source === 'copy') return <Pill tone="accent" title="Placed by Valuescan copy trading">Copy</Pill>;
  if (source === 'liquidation') return <Pill tone="warn" title="SoDEX took this position over (liquidation)">Liquidation</Pill>;
  return null;
}

/**
 * The name a row shows. Perps markets drop the "-USD" every one of them
 * carries (image 16: "UNI"); spot keeps its pair, which is the information.
 */
export function shortName(symbol: string, sym: MarketSymbol | undefined, engine: 'spot' | 'perps'): string {
  const name = sym?.displayName ?? symbol;
  return engine === 'perps' ? name.replace(/-USDC?$/i, '') : name;
}

export function MarketCell({
  symbol, sym, engine, children, full = false,
}: {
  symbol: string;
  sym: MarketSymbol | undefined;
  engine: 'spot' | 'perps';
  /** Pills after the name. */
  children?: ReactNode;
  /** Show the full display name (BTC-USD) rather than the short one (BTC). */
  full?: boolean;
}) {
  const name = full ? sym?.displayName ?? marketName(symbol) : shortName(symbol, sym, engine);
  return (
    <span className="acct-mkt" title={sym?.displayName ?? symbol}>
      <CoinIcon coin={sym?.baseCoin ?? symbol} size={18} />
      <span className="acct-mkt__n">{name || DASH}</span>
      {children}
    </span>
  );
}

/** A figure with its unit in --muted after it: "0.37 SOL". */
export function Unit({ value, unit }: { value: string; unit?: string | null }) {
  if (!unit || value === DASH) return <>{value}</>;
  return <>{value}<span className="acct-unit"> {unit}</span></>;
}

/** The status cell: icon + label, the tooltip saying how much filled. */
export function StatusCell({
  o, qtyText, unit, priceText,
}: {
  o: StatusInput;
  /** Formats a quantity to the market's step. */
  qtyText: (v: unknown) => string;
  unit?: string;
  /** The (average) fill price, formatted - "0.37 SOL @ 113.17" on hover. */
  priceText?: string | null;
}) {
  const info = orderStatusInfo(o);
  const exec = o.executedQty === undefined ? null : qtyText(o.executedQty);
  const orig = o.origQty === undefined ? null : qtyText(o.origQty);
  const title = statusTitle(info, exec, orig, unit);
  const u = unit ? ` ${unit}` : '';
  const anyFilled = info.filled !== null && info.filled > 0;
  return (
    <HoverCard
      className="acct-status"
      label={title}
      card={
        <>
          <div className="acct-hc__t">
            <StatusIcon info={info} />
            <span>{info.label}</span>
          </div>
          {anyFilled && exec !== null && (
            <div className="acct-hc__main">
              {exec}{u}{priceText ? <> <span className="acct-hc__at">@</span> {priceText}</> : null}
            </div>
          )}
          {info.filled !== null && orig !== null && (
            <>
              <div className="acct-hc__bar" aria-hidden="true"><span style={{ width: `${Math.min(100, info.filled * 100)}%` }} /></div>
              <div className="acct-hc__row">
                <span>{formatPct(info.filled)} filled</span>
                <span>{exec ?? '0'} / {orig}{u}</span>
              </div>
            </>
          )}
        </>
      }
    >
      <StatusIcon info={info} />
      <span className={`acct-status__l${info.kind === 'cancelled' || info.kind === 'expired' || info.kind === 'rejected' ? ' is-dead' : ''}`}>{info.label}</span>
    </HoverCard>
  );
}

/**
 * A small glass card on hover (the funds sheets' dropdown surface), portalled
 * to the body so the table's scroll box cannot clip it, fading in and out.
 */
export function HoverCard({ children, card, className, label }: { children: ReactNode; card: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    window.clearTimeout(timer.current);
    const below = r.top < 150;
    setAt({ x: Math.min(r.left, window.innerWidth - 250), y: below ? r.bottom + 6 : r.top - 6, below });
    requestAnimationFrame(() => setShown(true));
  };
  const close = () => {
    setShown(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt(null), 160);
  };
  return (
    <span ref={ref} className={className} aria-label={label} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close} tabIndex={0}>
      {children}
      {at && createPortal(
        <div
          className={`acct-hc${shown ? ' is-on' : ''}${at.below ? ' is-below' : ''}`}
          style={{ left: at.x, top: at.y }}
          role="tooltip"
        >
          {card}
        </div>,
        document.body,
      )}
    </span>
  );
}

// --- signed money (image 15: "-$1.91", "+$0.045", "-23.75%") -------------------

/** Places for a small dollar figure: two, or three/four when it would read as $0.00. */
function usdPlaces(a: number): number {
  if (a === 0 || a >= 0.1) return 2;
  if (a >= 0.001) return 3;
  return 4;
}

/** "$1.91" / "−$1.91" / "+$0.045" (plus only when `plus`). */
export function signedUsd(v: number | null | undefined, plus = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  const s = v < 0 ? MINUS : v > 0 && plus ? '+' : '';
  return `${s}$${formatNumber(a, 'en-US', { minimumFractionDigits: usdPlaces(a), maximumFractionDigits: usdPlaces(a) })}`;
}

/** "+23.75%" / "−23.75%". */
export function signedPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = v < 0 ? MINUS : v > 0 ? '+' : '';
  return `${s}${Math.abs(v * 100).toFixed(dp)}%`;
}

/** A plain amount, to its own precision (up to 8 places). */
export const amount = (v: unknown, dp?: number): string => {
  const s = fmt(v as string | number | undefined, dp);
  return s === '-' ? DASH : s;
};

export const toneOf = (v: number | null | undefined): '' | 'pos' | 'neg' =>
  v === null || v === undefined || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg';

// --- the quiet lines -------------------------------------------------------------

/** The one quiet line an empty panel shows; "Loading…" gets the sheets' spinner. */
export function Note({ children }: { children: ReactNode }) {
  return children === 'Loading…'
    ? <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />{children}</p>
    : <p className="acct-empty">{children}</p>;
}

/** Rows exist, the view hides all of them - say so, with the way back. */
export function FilteredEmpty({ onReset }: { onReset?: () => void }) {
  return (
    <p className="acct-empty">
      Nothing in this view.
      {onReset && <>{' '}<button type="button" className="acct-link" onClick={onReset}>Reset view</button></>}
    </p>
  );
}

/**
 * "Showing 1 of 100 - Reset view" under a table whose View filter (remembered
 * across pages and reloads) hides rows: a narrowed list never passes for the
 * whole history.
 */
export function FilteredHint({ shown, total, onReset }: { shown: number; total: number; onReset?: () => void }) {
  if (shown >= total) return null;
  return (
    <p className="acct-hint">
      Showing {shown} of {total} loaded
      {onReset && <>{' · '}<button type="button" className="acct-link" onClick={onReset}>Reset view</button></>}
    </p>
  );
}

/** How far before the end of its scroller the next page is asked for. */
const PRELOAD_PX = 160;

/** The nearest ancestor that scrolls vertically, or null for the page itself. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'overlay') return p;
  }
  return null;
}

/**
 * The end of a paged table. Reaching it loads the next page - there is no
 * button to press: this marker asks for more as it comes into view (a little
 * before, inside the table's own scroller), and shows the Withdraw sheet's pill
 * with the spinner while the page is on its way.
 *
 * The button only comes back when the end never left the screen for a few
 * pages in a row (autoLoad.ts: a filter hiding most rows, a very tall panel),
 * or in a browser without IntersectionObserver.
 */
export function LoadMore({ onMore, loading, note }: { onMore: () => void; loading: boolean; note?: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  const auto = useRef<AutoLoadState>(AUTO_LOAD_START);
  const [manual, setManual] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = end.current;
    if (!el || loading || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting ?? false;
      const next = onEndSeen(auto.current, visible);
      auto.current = next.state;
      setManual(next.state.stalled);
      if (next.load) more.current();
    }, { root: scrollParent(el), rootMargin: `0px 0px ${PRELOAD_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [loading]);

  const press = () => {
    auto.current = AUTO_LOAD_START;
    setManual(false);
    onMore();
  };
  // Nothing loading and nothing to press: only the marker (and its note) remains.
  const idle = !loading && !manual;
  return (
    <div ref={end} className={`acct-more${idle ? ' is-idle' : ''}`}>
      {note && <span className="acct-more__note">{note}</span>}
      {!idle && (
        <button type="button" className="acct-morebtn" onClick={press} disabled={loading}>
          {loading && <span className="acct-spin" aria-hidden="true" />}
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// --- order words -----------------------------------------------------------------

/** Limit / Market / Stop loss / Take profit, for an order row. */
export function orderTypeText(o: any): string {
  const t = String(pick(o, 'type', 'o') ?? '').toUpperCase();
  const base = t === 'MARKET' || t === '2' ? 'Market' : t === 'LIMIT' || t === '1' ? 'Limit' : t ? t.charAt(0) + t.slice(1).toLowerCase() : DASH;
  const st = String(pick(o, 'stopType') ?? '').toUpperCase();
  if (st === 'STOP_LOSS' || st === '1') return base === 'Market' ? 'Stop market' : 'Stop limit';
  if (st === 'TAKE_PROFIT' || st === '2') return base === 'Market' ? 'Take profit' : 'TP limit';
  return base;
}

/** GTC is the default and says nothing; IOC / FOK / Post-only are worth a word. */
export function tifText(v: unknown): string | null {
  const s = String(v ?? '').toUpperCase();
  return s === 'IOC' || s === '3' ? 'IOC' : s === 'FOK' || s === '2' ? 'FOK' : s === 'GTX' || s === '4' ? 'Post-only' : null;
}
