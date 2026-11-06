/**
 * Live market data: multi-market strip, symbol header, order book, public trades.
 *
 * All of them are seeded from REST (so they render immediately on load) and
 * then kept current over the hub WebSocket.
 *
 * TYPE DISCIPLINE (enforced in Market.css, stated here so it survives edits):
 * four sizes - 10 / 12 / 14 / 20 - and two weights, 400 and 500. Nothing in
 * this file or its sheet is 600 or 700 and nothing is uppercased. Hierarchy is
 * carried by COLOUR (--dim -> --muted -> --text) and by size. On a screen where
 * every cell is a number, weight is the one lever that makes the numbers
 * themselves harder to compare, so it is spent on the numbers and on nothing
 * else.
 *
 * DATA HONESTY
 * Every reading here comes from the feed or renders an em-dash. `fmt()` and
 * friends return an ASCII hyphen for "no value", which at 12px is
 * indistinguishable from a minus sign in a column of signed numbers, so
 * everything user-visible goes through `` below.
 */
import { fmtFixed, fmtNum } from '../numStyle';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLatched } from './motion';
import { createPortal, flushSync } from 'react-dom';
import { api, type Engine, type OrderBook, type Symbol, type Ticker } from '../api';
import { useAccountResource } from '../accountFeeds';
import { ownBookLevels } from '../chart/orderOverlays';
import { useAsync, useChannel, useSharedStored, useSodexOiExcluded, useStored, useTickers as useSharedTickers } from '../hooks';
import { displayedOi } from '../sodexOi';
import { hub } from '../ws';
import { pollEvery } from '../exchange/visibility';
import { shareBook } from '../exchange/bookShare';
import { DASH, coinLabel, fmt, fmtCountdown, fmtPct, fmtPrice, fmtQty, num, pick, precisionOf, signClass } from '../format';
import {
  AccountCell,
  KNOWN_MARKET_MAKER_IDS,
  TapeControls,
  TapeSettings,
  aggressorOf,
  concentrationOf,
  partitionByMute,
  useAliases,
  useMutedAccounts,
  type TapeTrade,
} from './TapeFilter';
import {
  aggregate,
  bucketOf,
  depthFiguresThrough,
  fmtNotional,
  mergeBookSide,
  rowFigures,
  withCumulative,
  type BookFormat,
  type BookLevel,
  type DepthFigures,
} from './bookDepth';
import { groupingSteps } from './bookGroup';
import { useOrderImpact } from '../orderImpact';
import type { RawTake } from '../orderImpact';
import { Sparkline as StableSparkline, useSampleRecorder } from './orderbook/Sparkline';
import { bpsMinSpan, fmtBps } from './orderbook/bpsPrecision';
import { useBpsDecimals } from './orderbook/useBpsDecimals';
import './Market.css';
import { CoinIcon } from './CoinIcon';
import { MENU_ICONS } from '../dashboard/tabExtras';
import { usePrivacy } from '../privacy';
import { logger } from '../log';

/**
 * The order book's log namespace. warn/error always print; `?debug=book`
 * (or `__vs.enable('book')`) adds the info and debug lines. See log.ts.
 */
const log = logger('book');

// --- missing values ----------------------------------------------------------
/**
 * The single gate every rendered value passes through.
 *
 * The formatters in format.ts answer "no reading" with `'-'`. That is fine in
 * prose and wrong in a table: at 12px, in a right-aligned column that also
 * holds negative numbers, an ASCII hyphen reads as a minus sign with the digits
 * clipped. An em-dash is unmistakably "nothing here", which is the whole point
 * of showing it rather than a zero.
 */

/**
 * Compact notional, matching how depth is read rather than how it is stored.
 *
 * A 395px book has room for about seven characters per column. `$171,242,255`
 * does not fit and, more to the point, nobody compares nine significant digits
 * across twenty rows - they compare magnitudes. Two decimals keeps `922.47K`
 * and `2.11M` distinguishable, which is the resolution the eye actually uses.
 * The unit lives in the column head, so no currency glyph is repeated per cell.
 * The order book's own cells (and its hover popup) do NOT: they print the full
 * figure to the dollar through `fmtNotional` in bookDepth.ts (owner's call).
 */
function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmtFixed(v / 1e9, 2)}B`;
  if (a >= 1e6) return `${fmtFixed(v / 1e6, 2)}M`;
  if (a >= 1e3) return `${fmtFixed(v / 1e3, 2)}K`;
  return fmtFixed(v, 2);
}

// --- drawn glyphs ------------------------------------------------------------

/**
 * A stroked disclosure chevron, in two sizes.
 *
 * Drawn rather than typed. `▾` is a solid wedge whose width, weight and
 * vertical placement are decided by whichever font the platform resolves for
 * that codepoint - measured, ours came out 4px wide against a 10px stroked V,
 * and it sat off the text's centreline. Two line segments have none of those
 * problems, cost no font subset, and take `currentColor` so the one hover rule
 * this app has still reaches them.
 *
 * TWO SIZES because the two carets do different jobs. The header's opens the
 * market picker - the page's primary navigation, sitting beside a 20px name -
 * and renders 12x7 of ink; it used to render 12x5, a shallower angle than the
 * measured one, which read as a wide flat mark rather than as a caret. The
 * book's opens a settings menu attached to a 12px compound label, and at the
 * same size it was the loudest thing in that control; `sm` takes it to the
 * measured 8x4.
 */
const Chevron = ({ size = 'md' }: { size?: 'md' | 'sm' }) =>
  size === 'sm' ? (
    <svg className="mkt-chev" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true" focusable="false">
      <path
        d="M1 1.2 4 3.9l3-2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg className="mkt-chev" width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" focusable="false">
      <path
        d="M1 1.5 6 7l5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

/**
 * The watchlist star.
 *
 * Drawn for the same reason the chevron is, and more urgently: U+2605/U+2606 are
 * not in IBM Plex Sans, so `★` fell through to whatever symbol font the platform
 * happened to resolve. Measured, that arrived as 9x8 of ink inside a 24px chip -
 * a mark adrift in an empty box, at a size and weight nobody in this codebase
 * chose, and different on every OS.
 *
 * IT IS SOLID IN BOTH STATES, and that is the fix this glyph needed for three
 * rounds. The off state used to be a 1.2px OUTLINE, which is a shape made
 * entirely of edges: at 12px an outline star is ~30 lit pixels spread over two
 * antialiased columns each, so it composites to roughly half its token value and
 * lands at about the contrast of the 1px border framing it - a control whose
 * frame is as visible as its contents. Measured against the reference's star
 * (13x12 of solid ink) ours read as an empty box with a scratch in it.
 * Filled, the same 13x12 footprint carries ~110 lit pixels at full token value.
 *
 * So STATE IS CARRIED BY COLOUR, which is the one lever this whole design uses
 * for rank: --muted for "not on your watchlist", --accent (amber) for on. That
 * is the same single-property distinction the hover system makes (see HOVER -
 * hovering changes `color` and nothing else), and it means the two states differ
 * by hue rather than by one of them being 50% legible. `aria-pressed` on the
 * button carries the state for assistive tech, so nothing depends on the colour
 * alone.
 *
 * The geometry is a five-point star on a 6.2/2.9 outer/inner radius - measured
 * off the reference, whose arms are stubby rather than spindly - centred at
 * (6.5, 6.6) so the 0.8px round-join stroke that softens the tips lands the ink
 * at exactly 13 wide x 12 tall, the reference's own footprint. The stroke is the
 * same colour as the fill; it exists only to round the points, which the
 * reference's are.
 */
const Star = ({ size = 13 }: { size?: number } = {}) => (
  <svg
    className="mkt-fav-star"
    width={size}
    height={Math.round((size * 12) / 13)}
    viewBox="0 0 13 12"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M6.5 .4 8.21 4.25 12.4 4.68 9.26 7.5 10.14 11.62 6.5 9.5 2.86 11.62 3.74 7.5 .6 4.68 4.79 4.25Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="0.8"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The mid row's tick-direction arrow.
 *
 * Also drawn, also because the typed version (`↑`/`↓` at 14px) resolved to a
 * fallback font and measured 7x10 against the reference's 10x12 - noticeably
 * smaller than the price it qualifies and floating away from it. A real shaft
 * and head at 10x12 sits at the price's own cap height and reads as part of the
 * number rather than as a symbol next to it.
 */
const TickArrow = ({ dir }: { dir: 'up' | 'down' }) => (
  <svg className="mkt-mid-arrow" width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" focusable="false">
    <path
      d={dir === 'up' ? 'M5 11.3V1.2M1.2 5 5 1.2 8.8 5' : 'M5 .7v10.1M1.2 7 5 10.8 8.8 7'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The spread mark that closes the order book's mid row: two end bars with a
 * double-headed arrow between them. It replaces a whole line of text that used
 * to say the same thing in words - see `.mkt-mid-icon` in Market.css for why
 * that line is gone and where the figure itself went.
 *
 * EVERY STRAIGHT STROKE IS ON A HALF-PIXEL, which is the whole reason the
 * coordinates look off-by-a-half. A 1px stroke centred on an integer covers
 * half of each neighbouring pixel and renders as two rows at ~50% - measured,
 * the end bars came out 2px tall and visibly softer than every other hairline
 * on the page, where the reference draws them as one full-value row. Centring
 * them on `.5` puts the stroke inside a single device pixel. The 8px box (down
 * from 9) is the measured cap width; the arrowheads are diagonal and antialias
 * either way, so only the bars and the shaft are pinned.
 */
const SpreadMark = () => (
  <svg className="mkt-mid-icon" width="8" height="12" viewBox="0 0 8 12" aria-hidden="true" focusable="false">
    <path
      d="M.5 .5h7M.5 11.5h7M4.5 3v6M2.9 4.6 4.5 3l1.6 1.6M2.9 7.4 4.5 9l1.6-1.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The tick that marks a shown stat in the header's configuration menu.
 *
 * Drawn, for the third time in this file and for the same reason: `✓` (U+2713)
 * is not in IBM Plex Sans, so it resolves to a platform fallback at a size and
 * weight nobody here chose. Two strokes on a 10x8 box sit on the 12px label's
 * own x-height and take `currentColor`, so the one hover rule this app has
 * still reaches them.
 *
 * It sits in the row's box (styles.css `.menu-box`), which is always drawn,
 * ticked or not, at the row's end, so nothing shifts as you tick through them.
 */
const Tick = () => (
  <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true" focusable="false">
    <path
      d="M1 4.3 3.7 7 9 1.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);


// --- popover dismissal -------------------------------------------------------

/**
 * Close a popover on an outside press or Escape.
 *
 * Deliberately the same shape as `useDismiss` in OrderEntry.tsx, and for the
 * same two reasons: `pointerdown` in the CAPTURE phase rather than `click`, so
 * a drag that begins inside the popup and ends outside it does not slam the
 * popup shut on release; and the close callback held in a ref, so an inline
 * arrow at the call site does not re-bind two document listeners every render.
 * It is duplicated rather than imported because OrderEntry does not export it
 * and that file belongs to another surface - a shared hook is a `hooks.ts` edit,
 * not a Market.tsx one.
 */
function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
  /** A portalled list is not inside `ref`. A press there is still inside. */
  also?: React.RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || also?.current?.contains(t)) return;
      if (ref.current || also?.current) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, also]);
}

/**
 * The currency glyph to prefix a quote-denominated price with, or nothing.
 *
 * `$` is only correct for a dollar-quoted market. Printing it unconditionally
 * would put a dollar sign in front of a BTC-EUR mark price, which is exactly
 * the class of invented detail the em-dash rule exists to prevent - so a quote
 * asset we cannot recognise as a dollar simply gets no glyph, and the column
 * head continues to name the unit.
 */
const quoteGlyph = (sym?: Symbol): string =>
  /^(v?usd|usdt|usdc|busd|dai|pyusd)/i.test(sym?.quoteCoin ?? '') ? '$' : '';

/** Signed absolute change, e.g. "+266.57". Em-dash when the feed has none. */
function fmtSigned(v: unknown, dp: number): string {
  if (v === undefined || v === null || v === '') return DASH;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return DASH;
  return `${n >= 0 ? '+' : ''}${fmtNum(n, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

// --- shared /tickers snapshot ------------------------------------------------

/**
 * ONE poll of `/tickers` per engine, shared by every consumer on the page.
 *
 * The symbol header, the market strip and the order book's mid-price anchor
 * all want the same REST snapshot - and so do the positions table's mark seed,
 * the market search and the explore boards. They all read hooks.ts
 * `useTickers`: one refcounted, visibility-aware timer per engine at the
 * shortest interval any of them asks for (sharedPoll.ts), so the second
 * consumer costs nothing and a newcomer paints the cached snapshot at once.
 * The snapshot is kept after the last consumer leaves (a few KB of public
 * market data): switching back to a panel repaints instantly.
 */
const TICKERS_POLL_MS = 30_000;

/** Subscribe to the shared `/tickers` snapshot for this engine. */
function useTickers(engine: Engine): Ticker[] | null {
  return useSharedTickers(engine, { pollMs: TICKERS_POLL_MS }).data?.tickers ?? null;
}

/**
 * Direction of the last price tick, LATCHED.
 *
 * It keeps saying "the last trade was an uptick" until the next print
 * disagrees, which is what a direction arrow means. There is deliberately no
 * transient flash any more: the symbol header now carries the 24h direction as
 * a permanent colour, and a second, faster colour signal on the same number
 * would make the header strobe between two different meanings of green.
 */
function useTickDirection(last: unknown): 'up' | 'down' | null {
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef<number | null>(null);

  useEffect(() => {
    const n = num(last);
    // num() returns 0 for junk as well as for a genuine zero; a zero price is
    // not a real market, so treating both as "no reading" is correct here.
    if (!n) return;
    const before = prev.current;
    prev.current = n;
    if (before === null || before === n) return;
    setDir(n > before ? 'up' : 'down');
  }, [last]);

  return dir;
}

// --- market strip ------------------------------------------------------------

/** Chip label: the market's display name, falling back to its raw key. */
const chipLabel = (name: string, byName?: Map<string, Symbol>): string =>
  byName?.get(name)?.displayName ?? name;

/**
 * The favourites bar, after the owner's reference: one chip per starred market
 * of this book - its coin in a dark square, the market and its last price, an
 * x to unpin it - and the market on screen first when it is not starred (with a
 * star to pin it instead of the x). A + at the end opens the market search.
 *
 * Hiding favourites (privacy) leaves only the market on screen: which markets
 * someone starred is itself information.
 */
export function MarketStrip({
  engine, symbol, favorites = [], byName, onSelect, onToggleFavorite, onAdd,
}: {
  engine: Engine;
  /** Currently active market; its chip is marked selected. */
  symbol: string;
  /** Watchlist keys, `${engine}:${symbol}` - the same array TickerBar takes. */
  favorites?: string[];
  /** Symbol metadata: a chip's label, coin and price precision. */
  byName?: Map<string, Symbol>;
  onSelect?: (symbol: string) => void;
  onToggleFavorite?: (key: string) => void;
  /** The + at the end: find a market to add. */
  onAdd?: () => void;
}) {
  // Shares TickerBar's poll - see useTickers. No second request is made.
  const rows = useTickers(engine);
  const hideFavs = usePrivacy().isHidden('favorites');

  const chips = useMemo(() => {
    const favs = hideFavs
      ? []
      : favorites.filter((k) => k.startsWith(`${engine}:`)).map((k) => k.slice(engine.length + 1));
    const list = favs.includes(symbol) ? favs : [symbol, ...favs];
    const bySym = new Map((rows ?? []).map((t) => [t.symbol, t]));
    return list.map((s) => ({ s, t: bySym.get(s), fav: favs.includes(s) }));
  }, [rows, favorites, engine, symbol, hideFavs]);

  /* `group`, not `tablist`: these chips change the app's market and there is no
     tabpanel behind them. */
  return (
    <div className="mkt-favs" role="group" aria-label="Favourite markets">
      {chips.map(({ s, t, fav }) => {
        const meta = byName?.get(s);
        const label = chipLabel(s, byName);
        const last = t?.lastPx;
        return (
          <div key={s} className={`mkt-favchip${s === symbol ? ' is-active' : ''}`}>
            <button type="button" className="mkt-favchip__open" aria-pressed={s === symbol} onClick={() => onSelect?.(s)} title={label}>
              <span className="mkt-favchip__ic"><CoinIcon coin={meta?.baseCoin ?? s} size={20} /></span>
              <span className="mkt-favchip__t">
                <b>{label}</b>
                <small>{last ? `${quoteGlyph(meta)}${fmtPrice(last, meta?.tickSize)}` : DASH}</small>
              </span>
            </button>
            {fav ? (
              <button type="button" className="mkt-favchip__x" aria-label={`Remove ${label} from favourites`} title="Remove from favourites" onClick={() => onToggleFavorite?.(`${engine}:${s}`)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            ) : (
              <button type="button" className="mkt-favchip__x mkt-favchip__pin" aria-label={`Add ${label} to favourites`} title="Add to favourites" onClick={() => onToggleFavorite?.(`${engine}:${s}`)}>
                <Star size={13} />
              </button>
            )}
          </div>
        );
      })}
      {onAdd && (
        <button type="button" className="mkt-favs__add" aria-label="Add a market" title="Add a market" onClick={onAdd}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}

// --- which stats the header shows -------------------------------------------

/**
 * THE CATALOGUE IS EXACTLY WHAT THE FEED CARRIES, AND NOTHING ELSE.
 *
 * Every id below is backed by a field this app already receives on both
 * surfaces - the REST `/tickers` row and the terse WebSocket push - and the
 * pairs were read off live frames rather than assumed:
 *
 *   ticker    c=last  o=open  h=high  l=low  v=base vol  q=quote vol
 *             w=vwap  p=24h change  P=24h change %  a/b=best ask/bid
 *   markPrice p=mark  i=index (oracle)  r=funding rate  oi=open interest
 *             T=next funding time
 *
 * A stat with no source is NOT offered, because a menu entry is a promise that
 * ticking it shows you something. That is also why `perps` exists on four of
 * them: oracle, mark, funding and open interest are perp-only CONCEPTS, not
 * perp-only values, so on a spot pair they are absent from the menu entirely
 * rather than present and permanently em-dashed.
 *
 * Best bid and best ask ARE here even though the order book two panels away
 * shows the same touch. They are real readings, the brief for this menu is
 * "every stat the ticker has real data for", and they are off by default - so
 * the redundancy costs nothing to anyone who does not ask for it.
 *
 * THE ARRAY ORDER IS THE RENDER ORDER. Selection is stored as a set of ids and
 * the header walks this list, so toggling a stat on never re-orders the row -
 * it reappears where it always sat.
 */
type StatId =
  | 'last' | 'mark' | 'index' | 'oracle' | 'change' | 'hilo' | 'funding8' | 'open' | 'high' | 'low'
  | 'qvol' | 'bvol' | 'vwap' | 'oi' | 'funding' | 'bid' | 'ask';

interface StatDef {
  id: StatId;
  /** Perp-only concept: not offered, and not rendered, on a spot pair. */
  perps?: boolean;
}

const HEADER_STATS: readonly StatDef[] = [
  { id: 'last' },
  { id: 'mark', perps: true },
  { id: 'index', perps: true },
  { id: 'change' },
  { id: 'hilo' },
  { id: 'funding8', perps: true },
  { id: 'open' },
  { id: 'high' },
  { id: 'low' },
  { id: 'qvol' },
  { id: 'bvol' },
  { id: 'vwap' },
  { id: 'oi', perps: true },
  { id: 'funding', perps: true },
  { id: 'bid' },
  { id: 'ask' },
];

/**
 * The default row: mark, index, the day's change, volume, open interest, funding.
 *
 * 24h High and 24h Low are deliberately NOT in it any more. The chart directly
 * below the header draws the day's range continuously and with context, so two
 * more columns restating its two endpoints spent ~110px of the busiest row on
 * the page on something the picture already says. They remain one right-click
 * away for anyone who reads the numbers rather than the shape.
 */
const DEFAULT_HEADER_STATS: readonly StatId[] = ['mark', 'index', 'change', 'qvol', 'oi', 'funding'];
/**
 * Rows the default used to be. A saved copy of exactly one of these is moved to the
 * default: the first is the original row; the second is the reference's three-stat row
 * from 2026-10-23, which the owner sent back the same day for the row above. Its two
 * stats (24H High / Low, Est. 8H Funding) stay in the right-click menu.
 */
const PREVIOUS_HEADER_STATS: readonly (readonly string[])[] = [
  ['last', 'oracle', 'qvol', 'oi', 'funding'],
  ['change', 'hilo', 'funding8', 'qvol', 'oi'],
];

/** Guard for whatever localStorage hands back - it is user-writable. */
const HEADER_STAT_IDS = new Set<string>(HEADER_STATS.map((s) => s.id));

/**
 * The one place a stat is named, so the header column and its menu entry can
 * never disagree. The two volume rows name their actual unit rather than saying
 * "quote" and "base", because "24h Volume (USD)" and "24h Volume (BTC)" are the
 * question the user is really asking.
 */
function statLabel(id: StatId, sym?: Symbol): string {
  switch (id) {
    case 'last': return 'Last Price';
    case 'mark': return 'Mark Price';
    case 'index':
    case 'oracle': return 'Index Price';
    case 'change': return '24h Change';
    case 'hilo': return '24H High / Low';
    case 'funding8': return 'Est. 8H Funding (L/S)';
    case 'open': return '24h Open';
    case 'high': return '24h High';
    case 'low': return '24h Low';
    // No parenthetical unit here (there used to be one, naming the RAW quote
    // coin - "24h Volume (vUSDC)" on every USD-quoted market on this venue,
    // since none of them are actually quoted in the plain "USDC" a reader
    // would recognise). The value itself now carries the same `$` glyph
    // `quoteGlyph` prints beside every other quote-currency figure on this
    // card, which is the reading a "24h Volume" label next to a bare number
    // already implies without spelling out an internal token symbol.
    case 'qvol': return '24h Volume';
    case 'bvol': return `24h Volume (${coinLabel(sym?.baseCoin) || 'base'})`;
    case 'vwap': return '24h VWAP';
    case 'oi': return 'Open Interest';
    case 'funding': return 'Funding / Countdown';
    case 'bid': return 'Best Bid';
    case 'ask': return 'Best Ask';
  }
}

export function TickerBar({
  engine, symbol, sym, onLast, onSymbolClick, aside,
}: {
  /** At the row's end, outside the stats' scroll (the chart card's tabs). */
  aside?: ReactNode;
  engine: Engine; symbol: string; sym?: Symbol;
  /** Reports the live last price so order entry can value market orders. */
  onLast?: (p: string) => void;
  onSymbolClick?: () => void;
  /** Starring moved to the favourites bar (MarketStrip); still accepted, unused here. */
  favorites?: string[];
  onToggleFavorite?: (key: string) => void;
}) {
  const rows = useTickers(engine);
  const [live, setLive] = useState<any>(null);
  const [mark, setMark] = useState<any>(null);
  /** Viewport point the stat menu was summoned at, or null when it is closed. */
  const [statAt, setStatAt] = useState<{ x: number; y: number } | null>(null);
  const statFx = useLatched(statAt);
  const headerRef = useRef<HTMLDivElement>(null);
  const [storedStats, setStoredStats] = useStored<StatId[]>(
    'ot.headerstats',
    DEFAULT_HEADER_STATS as StatId[],
  );
  const headerStats = useMemo(() => {
    const raw = Array.isArray(storedStats) ? storedStats : [];
    const sameAsBefore = PREVIOUS_HEADER_STATS.some((p) => raw.length === p.length && raw.every((id, i) => id === p[i]));
    const ids = (sameAsBefore ? DEFAULT_HEADER_STATS : raw).map((id) => (id === 'oracle' ? 'index' : id));
    return ids.filter((id) => HEADER_STAT_IDS.has(id));
  }, [storedStats]);

  useChannel(engine, { channel: 'ticker', symbols: [symbol] }, (d) => {
    const row = Array.isArray(d) ? d.find((e: any) => e.s === symbol) : d;
    if (row) setLive(row);
  });

  useChannel(engine === 'perps' ? 'perps' : 'spot', engine === 'perps' ? { channel: 'markPrice', symbols: [symbol] } : null, (d) => {
    const row = Array.isArray(d) ? d.find((e: any) => e.s === symbol) : d;
    if (row) setMark(row);
  });

  const oiExcluded = useSodexOiExcluded(engine === 'perps' && headerStats.includes('oi'));

  const rest: Ticker | undefined = rows?.find((t) => t.symbol === symbol);
  // WebSocket keys are terse and REST keys are verbose, so every reading is
  // "live if the socket published it, otherwise the REST snapshot". `pick`
  // returns undefined for a key the payload does not carry, which is what makes
  // the fallback safe: an absent terse key can never mask a present REST one.
  const last = live?.c ?? rest?.lastPx;
  const changePct = live?.P ?? rest?.changePct;
  const changeAbs = pick(live, 'p') ?? rest?.change;
  const quoteVol = pick(live, 'q') ?? rest?.quoteVolume;
  const high = pick(live, 'h') ?? rest?.highPx;
  const low = pick(live, 'l') ?? rest?.lowPx;
  const indexPx = mark?.i ?? rest?.indexPrice;
  const funding = mark?.r ?? rest?.fundingRate;
  const oi = mark?.oi ?? rest?.openInterest;
  const nextFunding = mark?.T ?? rest?.nextFundingTime;
  // The rest of the catalogue, same live-then-REST discipline. The terse keys
  // were read off real frames, not guessed - see the HEADER_STATS comment - and
  // `pick` returning undefined for an absent key is what keeps the REST value
  // reachable when a push omits one.
  const openPx = pick(live, 'o') ?? rest?.openPx;
  const baseVol = pick(live, 'v') ?? rest?.volume;
  const bidPx = pick(live, 'b') ?? rest?.bidPx;
  const askPx = pick(live, 'a') ?? rest?.askPx;
  const markPx = pick(mark, 'p') ?? rest?.markPrice;
  // `vwap` is on the wire (`w` live, `vwap` over REST) but not on the declared
  // Ticker shape, which lives in api.ts. Narrowed here rather than widened
  // there, so this stays one component's edit.
  const vwap = pick(live, 'w') ?? (rest as (Ticker & { vwap?: string }) | undefined)?.vwap;

  useEffect(() => {
    if (last !== undefined && last !== null && last !== '') onLast?.(String(last));
  }, [last, onLast]);

  /**
   * THE WHOLE VISIBLE BAR IS RIGHT-CLICKABLE, including the parts of it another
   * element is sitting on top of.
   *
   * An `onContextMenu` on `.mkt-header` only fires when the event's TARGET is
   * the header or a descendant of it, and two elements overlap this card
   * without being inside it: react-grid-layout's south-east resize grip, a ~25px
   * box pinned to the panel's bottom-right corner - which on a card this short
   * covers the full height of the last stat column - and the 6px drag strip
   * along the top edge, live whenever the panel is hovered. Right-clicking
   * either landed on them, so a VISIBLE stat column had no context menu and the
   * top row of the bar had none either. Nothing was "swallowing" the event; the
   * handler simply was not on the path.
   *
   * So the listener moves to the window, in the CAPTURE phase, and decides by
   * GEOMETRY - is the pointer inside the header's own rectangle - rather than by
   * DOM ancestry, which is the question actually being asked. The grips keep
   * every pointer event they need for dragging and resizing: `contextmenu` is
   * not one of them, and nothing here touches `pointerdown`.
   *
   * Two things it deliberately does not do. It never claims a right-click
   * inside an open `.menu-popup` - a menu that reopens itself under the cursor
   * instead of offering the browser's own menu is a trap. And it prevents the
   * default menu only for points inside this one card, so every other surface in
   * the app keeps "copy", which is the same contract the inline handler had.
   */
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = headerRef.current;
      if (!el) return;
      if (e.target instanceof Element && (e.target.closest('.menu-popup') || e.target.closest('.mkt-aside'))) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return;
      e.preventDefault();
      setStatAt({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('contextmenu', onMenu, true);
    return () => window.removeEventListener('contextmenu', onMenu, true);
  }, []);

  const perps = engine === 'perps';
  // TWO DIRECTIONS, TWO PLACES. The 20px price takes the last TICK's direction
  // and the line under it takes the 24h sign, so the pair can disagree - and
  // when it does, that disagreement is the reading: up on the day, last print
  // down. Painting both from the 24h sign (which is what this did) spent the
  // loudest number on the page restating what the line beneath it already says
  // with a sign and a percentage.
  //
  // This is not a strobe: useTickDirection LATCHES, so the colour holds until
  // a print contradicts it rather than flashing on every push.
  const tickDir = useTickDirection(last);

  /** Stats this MARKET can answer for - the menu never offers the others. */
  const available = useMemo(() => HEADER_STATS.filter((s) => !s.perps || perps), [perps]);
  /** Stored selection, filtered to ids this build still knows about. */
  const selected = useMemo(() => new Set<StatId>(headerStats), [headerStats]);

  /**
   * Toggle one stat, walking the CATALOGUE rather than the stored array, so the
   * persisted list is always in render order and a stat toggled back on returns
   * to its own place instead of the end of the row.
   *
   * A perp-only id already in the set survives a toggle made while a SPOT market
   * is loaded: `available` filters what is offered, this filters what is stored,
   * and they are deliberately different lists. Switching back to a perp restores
   * the funding column you had.
   */
  const toggleStat = useCallback(
    (id: StatId) => {
      setStoredStats(
        HEADER_STATS.filter((s) => (s.id === id ? !selected.has(id) : selected.has(s.id))).map((s) => s.id),
      );
    },
    [selected, setStoredStats],
  );
  const resetStats = useCallback(
    () => setStoredStats(DEFAULT_HEADER_STATS as StatId[]),
    [setStoredStats],
  );

  /** One stat's rendered column. Every value goes through ``. */
  const statNode = (id: StatId) => {
    const label = statLabel(id, sym);
    const price = (v: unknown) => fmtPrice(v as string | number | undefined, sym?.tickSize);
    switch (id) {
      case 'last': return <Stat key={id} label={label} value={price(last)} />;
      case 'mark': return <Stat key={id} label={label} value={price(markPx)} />;
      case 'index':
      case 'oracle': return <Stat key={id} label={label} value={price(indexPx)} />;
      case 'open': return <Stat key={id} label={label} value={price(openPx)} />;
      case 'high': return <Stat key={id} label={label} value={price(high)} />;
      case 'low': return <Stat key={id} label={label} value={price(low)} />;
      case 'vwap': return <Stat key={id} label={label} value={price(vwap)} />;
      case 'bid': return <Stat key={id} label={label} value={price(bidPx)} />;
      case 'ask': return <Stat key={id} label={label} value={price(askPx)} />;
      case 'change':
        /* The move stated twice - in the quote currency and as a proportion -
           on the stat row's own two-part line, in the colour of the move. */
        return (
          <Stat
            key={id}
            label={label}
            value={fmtSigned(changeAbs, precisionOf(sym?.tickSize))}
            sub={fmtPct(changePct)}
            tone={signClass(changePct)}
          />
        );
      case 'hilo':
        return <Stat key={id} label={label} value={`${high ? quoteGlyph(sym) : ''}${price(high)} / ${low ? quoteGlyph(sym) : ''}${price(low)}`} />;
      case 'funding8': {
        /* What a long pays and a short receives over 8 hours at the current
           rate (the venue states it per funding interval; an hour when it does
           not say). Unsigned when positive, like the reference. */
        const rate = funding !== undefined && funding !== null && funding !== '' ? num(funding) : NaN;
        const per8h = rate * ((8 * 3600) / (sym?.fundingInterval && sym.fundingInterval > 0 ? sym.fundingInterval : 3600));
        const pct4 = (v: number) => `${v < 0 ? '-' : ''}${fmtFixed(Math.abs(v * 100), 4)}%`;
        return (
          <Stat
            key={id}
            label={label}
            hint={`Next funding in ${fmtCountdown(nextFunding)}. Longs pay the first rate; shorts the second.`}
            value={Number.isFinite(per8h) ? `${pct4(per8h)} / ${pct4(-per8h)}` : DASH}
          />
        );
      }
      /* Quote volume, so the number is comparable across markets without first
         knowing what a unit of the base asset is worth. Base volume is offered
         beside it for the reading that is about units traded. */
      case 'qvol': return <Stat key={id} label={label} value={quoteVol ? `${quoteGlyph(sym)}${fmtCompact(num(quoteVol))}` : DASH} />;
      case 'bvol': return <Stat key={id} label={label} value={baseVol ? fmtCompact(num(baseVol)) : DASH} />;
      /* The gateway reports open interest in BASE units (contracts, not
         notional) - confirmed against this venue's own numbers, not the
         earlier guess this comment used to make. Printed raw, that reads as
         a dollar figure a full order of magnitude (or more) off, since a
         reader has no reason to expect "158.46" under a header stat to mean
         158.46 BTC. Converted to the market's quote currency with the same
         mark price the rest of this card already reads, then given the same
         `$` glyph every other quote-currency figure here gets. */
      case 'oi': {
        /*
         * THE PRICE HAS TO BE GUARDED, NOT JUST THE SIZE.
         *
         * `num()` returns 0 for anything unparseable, so with `oi` present and
         * neither `markPx` nor `last` arrived yet - the first seconds after a
         * market switch - this computed `oi * 0 = 0`, which is finite, and the
         * card printed a confident `$0.00` of open interest. A fabricated zero
         * on a liquidity figure is worse than a dash: it reads as "nobody is
         * positioned here".
         */
        const px = num(markPx ?? last);
        const size = displayedOi(symbol, oi, oiExcluded) ?? NaN;
        const oiUsd = Number.isFinite(size) && px > 0 ? size * px : NaN;
        return (
          <Stat
            key={id}
            label={label}
            /* The venue publishes CONTRACTS, and counts SoDEX's own internal pair
               in them. This figure is ours, not theirs, and the title says so
               rather than letting a currency glyph imply a venue reading. */
            hint="Contracts x mark price, leaving out SoDEX's internal pair, so it can differ from SoDEX's own page."
            value={Number.isFinite(oiUsd) ? `${quoteGlyph(sym)}${fmtCompact(oiUsd)}` : DASH}
          />
        );
      }
      case 'funding':
        /* No sign colour on the rate. Funding is the one stat that invites it
           and the reference deliberately withholds it - measured, a NEGATIVE
           reference rate still renders in the same white as Last Price. The
           minus sign already carries the sign, and it MUST: negative funding
           means shorts pay longs, so stripping it would misreport who pays. */
        return (
          <Stat
            key={id}
            label={label}
            value={funding !== undefined && funding !== null ? fmtPct(num(funding) * 100, 4) : DASH}
            sub={fmtCountdown(nextFunding)}
          />
        );
    }
  };

  return (
    /* RIGHT-CLICK ANYWHERE ON THE BAR configures which stats it carries - and
       "anywhere" means the whole visible rectangle, grips included. The listener
       is on the window and tests the pointer against this element's box; see the
       effect above for why ancestry was the wrong test. */
    <div className="mkt-header mkt-header--info" ref={headerRef}>
      {/* The owner's reference: the coin in a square, the price large, a
          divider, then the stats. The market's name is on its favourites chip;
          the coin opens the market search. Starring is on the chip too. */}
      <button
        type="button"
        className="mkt-info__coin"
        onClick={onSymbolClick}
        aria-label={`${sym?.displayName ?? symbol} ${perps ? 'futures' : 'spot'}: change market`}
        title={`${sym?.displayName ?? symbol} · ${perps ? 'Futures' : 'Spot'} · change market`}
      >
        <CoinIcon coin={sym?.baseCoin ?? symbol} size={30} />
      </button>

      <div className="mkt-price">
        <span className={`mkt-price-v ${tickDir ?? ''}`}>{last ? quoteGlyph(sym) : ''}{fmtPrice(last, sym?.tickSize)}</span>
      </div>
      <span className="mkt-info__div" aria-hidden="true" />

      {/* Which columns these are is the user's, and it persists - see
          HEADER_STATS. Oracle, mark, funding and open interest are perp-only
          CONCEPTS, so `available` drops them on a spot pair rather than
          rendering an em-dash that would read as a missing feed. */}
      <div className="mkt-stats">
        {available.filter((s) => selected.has(s.id)).map((s) => statNode(s.id))}
      </div>
      {aside ? <div className="mkt-aside">{aside}</div> : null}


      {statFx.value && (
        <StatMenu
          at={statFx.value}
          closing={statFx.closing}
          onExit={statFx.onExit}
          sym={sym}
          available={available}
          selected={selected}
          onToggle={toggleStat}
          onReset={resetStats}
          onClose={() => setStatAt(null)}
        />
      )}
    </div>
  );
}

/**
 * The symbol header's right-click configuration menu.
 *
 * PORTALLED TO <body>, which is not a style choice. `.mkt-header` is
 * `overflow-y: hidden` so it clips its own children, and the grid item wrapping
 * it is positioned with a CSS `transform` - which makes that item the
 * containing block for `position: fixed` as well. Rendered in place the menu
 * would be both clipped and mis-placed; portalled it is neither, and the
 * dismissal below still works because `ref.contains()` reads the real DOM node
 * wherever it now lives.
 *
 * KEYBOARD. Arrow keys move a roving focus, Home/End jump to the ends, Enter
 * and Space toggle (native button activation - nothing is re-implemented), and
 * Escape closes via the shared dismissal. The menu stays OPEN across a toggle
 * on purpose: picking which columns you want is a several-decisions job, and
 * the header behind it updates as you go, which is the feedback that makes it
 * one job rather than several trips.
 */
function StatMenu({
  at, sym, available, selected, onToggle, onReset, onClose, closing = false, onExit,
}: {
  closing?: boolean;
  onExit?: (e: { animationName: string }) => void;
  at: { x: number; y: number };
  sym?: Symbol;
  available: readonly StatDef[];
  selected: Set<StatId>;
  onToggle: (id: StatId) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [idx, setIdx] = useState(0);
  /** Placed after measuring, so the menu can never hang off a screen edge. */
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useDismiss(true, ref, onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlace({
      left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at]);

  // Roving focus. Runs after placement so the first focus does not scroll a
  // still-unpositioned box into view.
  useEffect(() => {
    if (place) items.current[idx]?.focus();
  }, [idx, place]);

  const count = available.length + 1; // + "Reset to defaults"
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + count) % count); }
    else if (e.key === 'Home') { e.preventDefault(); setIdx(0); }
    else if (e.key === 'End') { e.preventDefault(); setIdx(count - 1); }
  };

  return createPortal(
    <div
      ref={ref}
      className={`menu-popup mkt-statmenu${closing ? ' is-closing' : ''}`}
      onAnimationEnd={onExit}
      role="menu"
      aria-label="Header stats"
      onKeyDown={onKeyDown}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        // Hidden for exactly one commit: the layout effect that measures it
        // runs before the browser paints, so this is never a visible frame - it
        // only stops a box appearing at 0,0.
        visibility: place ? undefined : 'hidden',
      }}
    >
      <div className="menu-group-label">Header stats</div>
      <div className="mkt-statmenu-list">
        {available.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => { items.current[i] = el; }}
            type="button"
            role="menuitemcheckbox"
            aria-checked={selected.has(s.id)}
            tabIndex={i === idx ? 0 : -1}
            className={`menu-row${selected.has(s.id) ? '' : ' is-off'}`}
            onFocus={() => setIdx(i)}
            onClick={() => onToggle(s.id)}
          >
            <span className="menu-row__label">{statLabel(s.id, sym)}</span>
            <span className="menu-box" aria-hidden="true">{selected.has(s.id) && <Tick />}</span>
          </button>
        ))}
      </div>
      <span className="menu-sep" role="separator" />
      <button
        ref={(el) => { items.current[available.length] = el; }}
        type="button"
        role="menuitem"
        tabIndex={idx === available.length ? 0 : -1}
        className="menu-row"
        onFocus={() => setIdx(available.length)}
        onClick={onReset}
      >
        <span className="menu-row__ic">{MENU_ICONS.reset}</span>
        <span className="menu-row__label">Reset to defaults</span>
      </button>
    </div>,
    document.body,
  );
}

/** Label above value. The label is the quietest thing in the header; the value is not. */
const Stat = ({ label, value, sub, hint, tone = '' }: {
  label: string; value: string; sub?: string;
  /** `pos` / `neg`: the value in the colour of its sign (the day's change). */
  tone?: string;
  /** Why this number is what it is. Used where a figure is DERIVED and would
   *  otherwise be indistinguishable from a venue reading. */
  hint?: string;
}) => (
  <div className="mkt-stat" title={hint}>
    <span className="mkt-stat-l">{label}</span>
    <span className={`mkt-stat-v${tone ? ` ${tone}` : ''}`}>
      {value}
      {sub && <span className="mkt-stat-sub">{sub}</span>}
    </span>
  </div>
);

// --- inline recordings --------------------------------------------------------

// The spread and buy/sell charts, and the always-on recorder behind them, live
// in ./orderbook/Sparkline.tsx (drawing) and ./orderbook/sparkSampler.ts (what
// gets drawn) - a point, once drawn, never moves again; see those files.

// --- order book --------------------------------------------------------------

/**
 * Grouping steps live in `groupingSteps` (./bookGroup.ts): SoDEX's own menu,
 * tick * [1, 10, 100]. BTC-USD's gateway tickSize is "1", so that menu is
 * exactly 1, 10, 100.
 *
 * The rows are aggregated client-side from the merged deep book, not fetched
 * already grouped. REST /orderbook has no scale that changes the ladder, and
 * the l2Book `tickSize` that does group still only pushes 20 levels a side.
 * Pointing the feed at it would undo `mergeBookSide` below — REST holds the
 * deep ladder and WS only refreshes its near end, at the symbol tick.
 */
/** Matches the 20px row height in Market.css; used to fit rows to the panel without scrolling. */
const BOOK_ROW_H = 20;
/**
 * Bootstrap guess for the mid-price anchor's height, in the same spirit as
 * BOOK_ROW_H: only the very first paint uses it, every recompute measures the
 * real element. It has to exist as a number because the anchor is taller than
 * a data row, and the row-fitting maths reserves space for it in ROW units - a
 * hardcoded `reserve = 1` would over-claim a level of depth.
 */
const BOOK_MID_H = 38;

/**
 * How many raw levels to ask REST for, and how often.
 *
 * EMPIRICALLY, NOT ASSUMED: the l2Book WEBSOCKET push always carries exactly
 * 20 levels a side no matter what `level` is requested - verified live
 * against the gateway with level 5, 20, 50, 200 and 500, all of which came
 * back 20/20. REST has no such ceiling; the same market at the same moment
 * returned 77 bids and 64 asks. So the deep book this panel needs to show a
 * true reading at a coarse grouping can only come from REST, polled - the
 * WS channel is a fast top-of-book refresh and nothing more, see the l2Book
 * handler below for how the two are combined.
 *
 * 500 is this venue's own documented ceiling (MAX_BOOK_DEPTH on the server) and
 * costs no more request weight than any other depth over 100 - the gateway
 * doubles the cost past that line and stops charging further, so there is no
 * reason to ask for less. 5s keeps the tail reasonably fresh between REST
 * polls without competing for weight budget against the account feeds.
 */
const BOOK_REST_DEPTH = 500;
const BOOK_POLL_MS = 5_000;

/**
 * One mouse notch, in wheel-delta units - the threshold the scroll-to-zoom
 * handler accumulates against before it steps a grouping index. See the
 * wheel effect in Book() for why this is an accumulator and not a
 * per-event step.
 */
const ZOOM_WHEEL_STEP = 120;

/**
 * The hover popup's hold-off before it hides, in ms, once the pointer has LEFT
 * the rows area. The popup is ONE element that stays mounted and only moves;
 * this grace only covers a moment outside the book, e.g. a pointer grazing its
 * edge. It is also the LONGEST the previous level stays focused once the
 * pointer has gone. Inside the rows area it is the DWELL below that decides.
 */
const BOOK_HOVER_GRACE_MS = 80;
/**
 * THE DWELL: on something in the rows area that is not a level - the mid row,
 * the column heads, a seam - the focused level is held while the pointer is on
 * its way somewhere, and dropped once it comes to rest there: when it has moved
 * less than BOOK_DWELL_PX in BOOK_DWELL_MS. A crossing at 100 px/s covers 16px
 * in 160ms and holds; anything slower, or a stop, drops the focus 160ms after
 * the pointer last made 16px of progress, and the book un-dims with its normal
 * fade.
 *
 * Why progress and not time-on-the-row: the mid row is 38px, so an ordinary
 * 200 px/s crossing spends 190ms on it - any plain timer short enough to feel
 * responsive when the pointer STOPS would also fire on a normal crossing, which
 * was the pulse. Measured against the pointer's progress, a crossing at any
 * normal hand speed never trips it, however tall the row.
 */
const BOOK_DWELL_MS = 160;
const BOOK_DWELL_PX = 16;
/** Space between the popup and the book's left edge, and the viewport inset it clamps to. */
const BOOK_POP_GAP = 6;
const BOOK_POP_EDGE = 8;
/**
 * The popup follows the pointer's Y with a light exponential ease: each frame
 * closes `1 - e^(-dt/TAU)` of the gap (about half of it per 60Hz frame, ~95%
 * in 70ms), and it may never trail the pointer by more than MAX_LAG px, so a
 * fast sweep moves it at pointer speed instead of leaving it behind.
 * `prefers-reduced-motion` follows exactly, with no easing at all.
 */
const BOOK_POP_TAU_MS = 24;
const BOOK_POP_MAX_LAG = 14;
/** How long a hidden popup keeps its place to ease from, rather than snapping, when it re-shows. */
const BOOK_POP_RESUME_MS = 250;
/** Vertical offset from the pointer when the popup has to sit inside the book (no room beside it). */
const BOOK_POP_INSET_OFFSET = 14;

let reducedMotionMq: MediaQueryList | null = null;
/** Read per frame, not cached as a value: the OS setting can change while the page is open. */
function prefersReducedMotion(): boolean {
  try {
    reducedMotionMq ??= window.matchMedia('(prefers-reduced-motion: reduce)');
    return reducedMotionMq.matches;
  } catch {
    return false;
  }
}

/**
 * Which row the pointer is on: a side and that side's RANK - rows counted out
 * from the touch, the best level being 0. A place on screen, NOT a price: the
 * focus belongs to the row under the pointer, whatever level the book has
 * just moved into it (see the hover section in Book()).
 */
interface BookSlot {
  side: 'bid' | 'ask';
  rank: number;
}
const sameSlot = (a: BookSlot | null, b: BookSlot | null): boolean =>
  a === b || (!!a && !!b && a.side === b.side && a.rank === b.rank);
/** The slot a rendered row stands for - read back from the attributes BookRow writes. */
function slotOfRow(row: HTMLElement): BookSlot | null {
  const rank = Number(row.dataset.rank);
  const side = row.dataset.side;
  if (!Number.isInteger(rank) || rank < 0 || (side !== 'bid' && side !== 'ask')) return null;
  return { side, rank };
}

/**
 * How many 1s-averaged samples a spread/ratio recording keeps - 1 minute.
 *
 * Was 3 (180 samples). Two things fell out of that number being too big for
 * what is a ~150-250px inline chart, not a full panel: freshly started, the
 * "anchor to capacity, grow from the right" track (see Sparkline) spends its
 * first ~2.5 minutes as a sliver hugging the right edge, which read as the
 * chart being cut off rather than as a recording that had only just begun;
 * and once actually full, 180 points across that same width is under 1.5px
 * a sample - denser than the line is legible at, especially on the buy/sell
 * chart's narrower footer-row box. 60 reaches "visibly full" in a much more
 * reasonable time and, paired with Sparkline's own point decimation for
 * whatever width it actually renders into, stays readable either way.
 */
const HISTORY_CAP = 60;

/**
 * The buy/sell chart's y-band (see sparkSampler.ts): 25% headroom a side on a
 * refit, never narrower than 2 percentage points (a share that barely moves is
 * drawn flat, not magnified into noise), refitted smaller only once it is 2.5x
 * too loose, and never outside 0-100.
 */
const BS_BAND = { pad: 0.25, minSpan: 2, loose: 2.5, floor: 0, ceil: 100 } as const;
/** The sell line is the other side of the same share. */
const sellShare = (v: number): number => 100 - v;


const fmtIncrement = (v: number, tickSize?: string): string => (v >= 1 ? fmt(v, 0) : fmt(v, precisionOf(tickSize)));

// `mergeBookSide` lives in ./bookDepth with the rest of the book's pure maths: the order ticket merges its
// pushes the same way (OrderEntry.tsx), so its walk never sees a side a one-sided push left out.

// `BookLevel`, `aggregate` and `withCumulative` live in ./bookDepth - pure and
// unit-tested there, and shared with the hover popup's cumulative maths so the
// popup and the rows are always bucketed by the same function.

/**
 * The deep, continuously-merged order book for one market - REST for real
 * depth, WS for a fast top-of-book refresh, combined by `mergeBookSide`. See
 * BOOK_REST_DEPTH above for why this is not simply "subscribe to l2Book".
 *
 * ONE SHARED FEED PER (engine, symbol), refcounted by subscriber - the same
 * pattern useTickers already uses for its REST poll, extended to own a WS
 * subscription too. This used to be a per-component REST poll and WS
 * subscription: the WS half cost nothing extra (the hub already dedupes
 * identical upstream subscriptions), but the REST poll did not - the Order
 * Book panel and the chart's Depth view, both mounted at once, were each
 * running their own independent 5s poll of the same 500-level snapshot,
 * doubling real request weight for no reason. A shared feed means the
 * SECOND consumer of a market's depth costs nothing at all, matching this
 * app's standing rule that a feed already being paid for is free to share.
 */
interface BookFeed {
  book: OrderBook | null;
  subs: Set<(book: OrderBook | null) => void>;
  /** Stops the (visibility-aware) REST poll. */
  pollTimer?: () => void;
  unsubscribeWs?: () => void;
  // Health, for the log only: when the last l2Book push arrived and its update
  // id, whether the feed is currently flagged stale, and the hub state seen last.
  lastPushAt?: number;
  lastU?: number;
  stale?: boolean;
  staleTimer?: number;
  conn?: string;
  unsubscribeState?: () => void;
}

/**
 * l2Book pushes arrive about twice a second (measured: every ~0.5s). A feed
 * silent for this long while subscribed is STALE - the book on screen is then
 * only as fresh as the 5s REST poll - and is logged once until it recovers.
 */
const BOOK_WS_STALE_MS = 5_000;
const bookFeeds = new Map<string, BookFeed>();
const bookFeedKey = (engine: Engine, symbol: string): string => `${engine}:${symbol}`;

function publishBook(feed: BookFeed, engine: Engine, symbol: string): void {
  // The ticket's depth takes this copy instead of a REST read of its own (bookShare.ts).
  shareBook(engine, symbol, feed.book);
  for (const s of feed.subs) s(feed.book);
}

function pumpBookRest(key: string, engine: Engine, symbol: string): void {
  api
    .orderbook(engine, symbol, BOOK_REST_DEPTH)
    .then((r) => {
      const feed = bookFeeds.get(key);
      if (!feed) return;
      feed.book = r.book;
      publishBook(feed, engine, symbol);
    })
    .catch((e) => {
      // Transient; the next poll retries - same discipline as useTickers.
      log.warn('book REST poll failed, retrying on the next poll', { engine, symbol, error: e });
    });
}

export function useOrderBook(engine: Engine, symbol: string): OrderBook | null {
  const key = bookFeedKey(engine, symbol);
  // The book is held TOGETHER WITH the market it was published for - see the
  // return below.
  const [held, setHeld] = useState<{ key: string; book: OrderBook | null }>(() => ({
    key,
    book: bookFeeds.get(key)?.book ?? null,
  }));

  useEffect(() => {
    let feed = bookFeeds.get(key);
    const isNewFeed = !feed;
    if (!feed) {
      feed = { book: null, subs: new Set() };
      bookFeeds.set(key, feed);
    }
    const sub = (next: OrderBook | null) => setHeld({ key, book: next });
    feed.subs.add(sub);
    // Drop the old market's depth the instant a NEW feed is created rather
    // than waiting for the REST seed or the first l2Book push to replace it
    // - showing one market's levels under another's name is worse than
    // showing nothing, because every row is click-to-fill into the order
    // ticket (and, in the Depth view, a level someone could click to trade
    // against). An EXISTING feed's current book is correct as-is.
    setHeld({ key, book: feed.book });

    // First subscriber owns the poll timer and the WS subscription; the
    // rest ride along for free - see the doc comment above.
    if (isNewFeed) {
      const k = key;
      log.info('book feed opened', { engine, symbol });
      pumpBookRest(k, engine, symbol);
      feed.pollTimer = pollEvery(BOOK_POLL_MS, () => pumpBookRest(k, engine, symbol));
      // `level` is omitted from the subscription: it was always ignored by
      // the gateway (verified live), so asking for one was a claim this
      // channel cannot honour. mergeBookSide keeps whatever the last REST
      // poll fetched beyond what this shallow push can see.
      feed.unsubscribeWs = hub.subscribe(engine, { channel: 'l2Book', symbol }, (d: any) => {
        if (!d?.b && !d?.a) return;
        const f = bookFeeds.get(k);
        if (!f) return;
        // Each push is a full top-of-book snapshot, so a skipped id loses
        // nothing; one that goes BACKWARDS is an out-of-order (stale) push.
        if (typeof d.u === 'number' && f.lastU !== undefined && d.u < f.lastU) {
          log.warn('book WS push out of order: update id went backwards', { engine, symbol, prev: f.lastU, u: d.u });
        }
        if (typeof d.u === 'number') f.lastU = d.u;
        f.lastPushAt = Date.now();
        if (f.stale) {
          f.stale = false;
          log.info('book WS feed live again', { engine, symbol });
        }
        f.book = {
          bids: d.b ? mergeBookSide(f.book?.bids ?? [], d.b, 'bid') : (f.book?.bids ?? []),
          asks: d.a ? mergeBookSide(f.book?.asks ?? [], d.a, 'ask') : (f.book?.asks ?? []),
          updateID: d.u,
          blockTime: d.E,
        };
        publishBook(f, engine, symbol);
      });
      // STALE: pushes stopped while subscribed (logged once per episode).
      feed.staleTimer = window.setInterval(() => {
        const f = bookFeeds.get(k);
        if (!f || f.stale || f.lastPushAt === undefined) return;
        const silentMs = Date.now() - f.lastPushAt;
        if (silentMs > BOOK_WS_STALE_MS) {
          f.stale = true;
          log.warn('book WS stale: no l2Book push; the REST poll is carrying the book', { engine, symbol, silentMs });
        }
      }, 1_000);
      // RESUBSCRIBE: the hub re-arms every subscription after a reconnect.
      feed.unsubscribeState = hub.onState((st) => {
        const f = bookFeeds.get(k);
        if (!f || st === f.conn) return;
        const was = f.conn;
        f.conn = st;
        if (st === 'reconnecting') log.warn('book WS disconnected, reconnecting', { engine, symbol });
        else if (st === 'open' && was === 'reconnecting') log.info('book WS reconnected and resubscribed', { engine, symbol });
      });
    }

    return () => {
      const f = bookFeeds.get(key);
      if (!f) return;
      f.subs.delete(sub);
      if (f.subs.size === 0) {
        f.pollTimer?.();
        if (f.staleTimer) clearInterval(f.staleTimer);
        f.unsubscribeWs?.();
        f.unsubscribeState?.();
        bookFeeds.delete(key);
        shareBook(engine, symbol, null);
        log.info('book feed closed', { engine, symbol });
      }
    };
  }, [key, engine, symbol]);

  /*
   * NEVER THE OLD MARKET'S BOOK UNDER THE NEW NAME - not even for the first
   * render after a switch, before the effect above has run. That render used
   * to return the previous symbol's depth: one painted frame of the wrong
   * levels (each of them click-to-fill), a spread computed from the wrong book,
   * and the new market's bps precision seeded from it.
   */
  return held.key === key ? held.book : (bookFeeds.get(key)?.book ?? null);
}

/**
 * The share (0..1) of each rendered level the ticket's market order would take.
 *
 * PER LEVEL, NOT CUMULATIVE. The depth bar is cumulative, and the hatch used to
 * be the cumulative size eaten through the row: the row the order stops in then
 * counted every level above it as filled, so a 51k buy into 50k + 2k showed the
 * second row ~98% eaten when it takes half of it. The hatch now covers the
 * fraction of THAT row's own level the order takes - a level swept whole is
 * fully hatched, the last one exactly as far as the order reaches into it.
 */
export function takenShareByLevel(
  ladder: readonly { price: number; qty: number }[],
  takes: readonly RawTake[],
  increment: number,
  side: 'bid' | 'ask',
): Map<number, number> {
  const map = new Map<number, number>();
  for (const level of ladder) {
    if (!(level.qty > 0)) continue;
    let taken = 0;
    for (const t of takes) {
      if (!(t.taken > 0) || bucketOf(t.price, increment, side) !== level.price) continue;
      taken += Math.min(t.taken, t.qty);
    }
    if (taken > 0) map.set(level.price, Math.min(1, taken / level.qty));
  }
  return map;
}

export function Book({
  engine, symbol, sym, onPick, showTitle = true, address = null,
}: {
  engine: Engine; symbol: string; sym?: Symbol; onPick: (price: string) => void; showTitle?: boolean;
  /** The connected wallet: its resting orders are marked on their rows. */
  address?: string | null;
}) {
  const book = useOrderBook(engine, symbol);
  // The feed the chart and Open orders already share (accountFeeds.ts): no further request.
  const ownOrders = useAccountResource(address ? `orders:${engine}:${address}` : null, () => api.openOrders(engine, address!), 10_000);
  /** One market: what the recordings and the charts' visibility belong to. */
  const marketKey = `${engine}:${symbol}`;
  const [view, setView] = useState<'both' | 'bids' | 'asks'>('both');
  // Shared, not local: the chart's Depth view reads and can set this same
  // key (see useSharedStored in hooks.ts), so switching units here is what
  // "the hover/Y line needs to change if we have usd/BTC selected above the
  // OB" means - one setting, live across both panels.
  const [unit, setUnit] = useSharedStored<'quote' | 'base'>('ot.bookunit', 'quote');
  // Independent per side, not one shared step - see the wheel effect below
  // for why: scrolling over the bid rows zooms only the bid ladder. The
  // manual dropdown still sets both at once; only the wheel can split them.
  const [bidGroupIdx, setBidGroupIdx] = useState(0);
  const [askGroupIdx, setAskGroupIdx] = useState(0);
  // SoDEX's menu for this tick. A missing tick falls back to one step of the
  // same stand-in the increment lookup uses, so the menu is never empty.
  const tick = num(sym?.tickSize) || 0.01;
  const groupOptions = useMemo(() => {
    const steps = groupingSteps(tick);
    return steps.length ? steps : [tick];
  }, [tick]);
  // The wheel listener is bound once per view and reads this, so a shorter
  // ladder cannot scroll the index past its last step.
  const groupLenRef = useRef(groupOptions.length);
  groupLenRef.current = groupOptions.length;
  const [menuOpen, setMenuOpen] = useState(false);
  /** Whether the spread/buy-sell CHARTS are shown - see useSampleRecorder for why
   *  this no longer gates whether their history is collected. Held as the MARKET
   *  they were opened on, so a symbol switch closes them in its first render
   *  rather than one effect later. */
  const [recordingOn, setRecordingOn] = useState<string | null>(null);
  const [bsRecordingOn, setBsRecordingOn] = useState<string | null>(null);
  const recording = recordingOn === marketKey;
  const bsRecording = bsRecordingOn === marketKey;
  /** Wheel-to-zoom's own accumulator - see the effect below. */
  const wheelAcc = useRef({ bid: 0, ask: 0 });
  /**
   * The panel's DATA-ROW BUDGET - how many level rows fit in total, across
   * however many sides are on screen, with the mid anchor's space already taken
   * out. It is a total rather than a per-side count because the two sides do
   * not always get the same share: see the allocation below, where a thin side
   * hands what it cannot use to the deep one.
   * 16 is the first-paint guess (8 a side), replaced by measurement on the very
   * next frame - see recomputeRows.
   */
  const [rowCap, setRowCap] = useState(16);
  const rowsWrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  /*
   * HOVER POPUP STATE - see the hover section further down for the behaviour.
   * `hover` is the FOCUSED ROW (side + rank from the touch). It is re-derived
   * from the pointer's last client position, by the rows' geometry, after every
   * pointer move AND after every render, so it is always the row physically
   * under the pointer now. A book update that moves a different level into
   * that row changes the row's figures, not which row is lit.
   */
  const [hover, setHover] = useState<BookSlot | null>(null);
  const hoverRef = useRef<BookSlot | null>(null);
  hoverRef.current = hover;
  /**
   * THE DWELL (see BOOK_DWELL_MS): where the pointer last made real progress
   * while on a non-level inside the rows area, and the timer that drops the
   * focus if it makes none for that long. See armDwell.
   */
  const dwellAt = useRef<{ x: number; y: number } | null>(null);
  const dwellTimer = useRef<number | undefined>(undefined);
  /**
   * The row lit LAST. When the focus goes (a dwell, or the pointer leaving),
   * that row keeps full strength while the rest of the book fades back up to
   * it - rather than dropping to the dimmed level for a frame first; see
   * `is-lit` in Market.css.
   */
  const lastLit = useRef<BookSlot | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Last pointer position over the rows, CLIENT coords; null once it has left. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  /** A pointer move is waiting for the next frame's hit-test. */
  const pointerDirty = useRef(false);
  /** ONE rAF drives both the hit-test and the popup's follow motion. */
  const frameRaf = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);
  /** The popup's current (eased) position, and when it last hid - see stepPop. */
  const popPos = useRef<{ x: number; y: number; t: number; hiddenAt: number } | null>(null);
  /** What the popup showed last, so it fades out WITH its content instead of blanking first. */
  const lastPop = useRef<{ side: 'bid' | 'ask'; price: number; stats: DepthFigures } | null>(null);

  // Values for the mid-price anchor. All three sources are ones the page
  // already pays for: the REST /tickers snapshot is the module-level feed
  // TickerBar shares (see useTickers - no second request), and the two
  // channels below are refcounted in ws.ts, so when the symbol header is
  // mounted these subscriptions are free. Nothing here is a new field.
  const tickerRows = useTickers(engine);
  const restTicker = tickerRows?.find((t) => t.symbol === symbol);
  const [liveTicker, setLiveTicker] = useState<any>(null);
  const [liveMark, setLiveMark] = useState<any>(null);

  useChannel(engine, { channel: 'ticker', symbols: [symbol] }, (d) => {
    const row = Array.isArray(d) ? d.find((e: any) => e.s === symbol) : d;
    if (row) setLiveTicker(row);
  });
  useChannel(
    engine === 'perps' ? 'perps' : 'spot',
    engine === 'perps' ? { channel: 'markPrice', symbols: [symbol] } : null,
    (d) => {
      const row = Array.isArray(d) ? d.find((e: any) => e.s === symbol) : d;
      if (row) setLiveMark(row);
    },
  );

  // A stale price under a new symbol's depth is the same class of error the
  // book itself guards against below, so clear these on a market change too.
  useEffect(() => { setLiveTicker(null); setLiveMark(null); }, [engine, symbol]);

  const lastPx = liveTicker?.c ?? restTicker?.lastPx;
  const markPx = liveMark?.p ?? restTicker?.markPrice;
  // No funding rate here any more. It is a perp-wide fact about the next
  // settlement, the symbol header names it and counts it down, and reading it
  // off the mid row - where it sat next to the spread mark - made the one glyph
  // that means "gap between the two sides" label a number that is not that.
  const dir = useTickDirection(lastPx);

  // A coarse step on BTC is a different price carried over to a $0.01
  // altcoin: the ladder is tick-RELATIVE, so the same index is a different
  // price step in every market. Keyed on the engine too - the same ticker can
  // list on both sides of the venue with different tick sizes. (The two charts
  // close by themselves on a new market: their visibility is keyed by it.)
  useEffect(() => {
    setBidGroupIdx(0);
    setAskGroupIdx(0);
  }, [engine, symbol]);

  // A symbol change already resets both indexes to 0. This is the other
  // case: the ladder itself got shorter (a coarser tick, fewer steps) and a
  // leftover index must not sit past the last option.
  useEffect(() => {
    const max = Math.max(0, groupOptions.length - 1);
    setBidGroupIdx((i) => (i > max ? max : i));
    setAskGroupIdx((i) => (i > max ? max : i));
  }, [groupOptions.length]);

  // Fit rows to the panel's actual height instead of ever scrolling it - both
  // sides must stay visible at once. BOOK_ROW_H is only a bootstrap guess for
  // the very first paint; every recompute after that measures a real rendered
  // row, so it's exact regardless of font/zoom/platform rendering differences.
  const measuredRowH = useRef(BOOK_ROW_H);
  const measuredMidH = useRef(BOOK_MID_H);
  const recomputeRows = () => {
    const el = rowsWrap.current;
    if (!el) return;
    // `tbody tr:not(.mkt-midrow)`, not `tbody tr` - the first row in the body
    // is an ask level today, but the mid anchor is also a <tr> and is twice as
    // tall. Sampling it as "the row height" would halve the visible depth.
    const sampleRow = el.querySelector('tbody tr:not(.mkt-midrow)');
    const h = sampleRow?.getBoundingClientRect().height;
    if (h) measuredRowH.current = h;
    const midH = el.querySelector('.mkt-midrow')?.getBoundingClientRect().height;
    if (midH) measuredMidH.current = midH;

    // clientHeight covers the WHOLE scroll container, which also holds the
    // sticky column header. Dividing that by the row height without first
    // removing the header claims space the rows cannot use, so one row too
    // many was rendered and then clipped by `overflow: hidden` - visible as a
    // sliver of a row cut off at the bottom of the book.
    const headH = el.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const usable = Math.max(0, el.clientHeight - headH);

    // Reserve, expressed in ROWS, for the mid-price anchor between the sides -
    // measured rather than assumed, same discipline as measuredRowH, and the
    // reason a taller anchor cannot silently clip a level off the bottom.
    const reserve = view === 'both' ? measuredMidH.current / measuredRowH.current : 0;
    // A TOTAL, not a per-side count. `floor(floor(x)/2) === floor(x/2)`, so the
    // balanced case still resolves to exactly the same number of rows a side it
    // did when this divided by `sides` here - the difference is only that the
    // split is now made where the two sides' real depths are known.
    const next = Math.max(1, Math.floor(usable / measuredRowH.current - reserve));
    setRowCap((prev) => (prev === next ? prev : next));
  };

  useEffect(() => {
    const el = rowsWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(recomputeRows);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Re-measure once real rows exist (first load, grouping change) - the
  // ResizeObserver above only fires when the container itself resizes, not
  // when content inside a fixed-size container changes.
  useLayoutEffect(() => {
    recomputeRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, view, bidGroupIdx, askGroupIdx]);

  /**
   * Wheel-to-zoom. Scrolling precisely over a side's own row steps THAT
   * side's grouping and nothing else; scrolling near the touch, or anywhere
   * that is not precisely over a row, steps both.
   *
   * "NEAR THE TOUCH" IS A BAND, NOT JUST THE MID ROW'S OWN ~38PX. Rows sit
   * directly against the mid row with no gap, so testing DOM ancestry alone
   * (`closest('.mkt-bookrow...')`) made the effective both-sides target only
   * as tall as the mid row itself - one row of margin for error either way.
   * The geometric check below expands that to the mid row's own rect plus
   * two full row-heights of slack on each side, and it runs FIRST: inside
   * that band, scrolling zooms both regardless of which row element the
   * pointer technically lands on. Only outside it does row ancestry decide
   * bid-only vs ask-only - and only when the pointer is precisely over a
   * REAL row, not the blank space a shallow book leaves or the column
   * header, both of which fall through to "both" the same as the touch does.
   *
   * A NATIVE listener, not React's `onWheel`: React has attached wheel as a
   * PASSIVE root listener since v17 (it is one of the events React trades
   * `preventDefault` support away from, for scroll performance), so calling
   * it from a synthetic handler is silently ignored and the dashboard behind
   * the panel scrolls along with every zoom gesture.
   *
   * DELTAS ACCUMULATE rather than stepping on every event: a mouse sends one
   * ~100-120-unit tick per notch, but a trackpad sends a stream of much
   * smaller continuous ones, and stepping on each would fly through five
   * groupings in one gesture. ZOOM_WHEEL_STEP is one mouse notch; the
   * accumulator only fires once that much has built up, in either device's
   * units, and the remainder carries over rather than being discarded so a
   * string of small trackpad deltas still adds up correctly.
   */
  /**
   * Which side(s) a pointer event over the rows targets - shared by the
   * wheel handler below and the double-click reset, so the two can never
   * quietly disagree about what "over the bid side" means.
   */
  const sidesAt = useCallback(
    (el: HTMLElement, clientY: number, target: Element): Array<'bid' | 'ask'> => {
      const midEl = view === 'both' ? el.querySelector<HTMLElement>('.mkt-midrow') : null;
      const midRect = midEl?.getBoundingClientRect();
      const midMargin = measuredRowH.current * 2;
      const nearMid = !!midRect && clientY >= midRect.top - midMargin && clientY <= midRect.bottom + midMargin;
      if (nearMid) return ['bid', 'ask'];
      const overBid = view !== 'asks' && !!target.closest?.('.mkt-bookrow.bid');
      const overAsk = view !== 'bids' && !!target.closest?.('.mkt-bookrow.ask');
      return overBid
        ? ['bid']
        : overAsk
          ? ['ask']
          : view === 'bids'
            ? ['bid']
            : view === 'asks'
              ? ['ask']
              : ['bid', 'ask'];
    },
    [view],
  );

  useEffect(() => {
    const el = rowsWrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sides = sidesAt(el, e.clientY, e.target as Element);
      e.preventDefault();
      if (sides.includes('bid')) wheelAcc.current.bid += e.deltaY;
      if (sides.includes('ask')) wheelAcc.current.ask += e.deltaY;
      const step = (key: 'bid' | 'ask', set: (fn: (i: number) => number) => void) => {
        while (wheelAcc.current[key] >= ZOOM_WHEEL_STEP) {
          wheelAcc.current[key] -= ZOOM_WHEEL_STEP;
          set((i) => Math.min(groupLenRef.current - 1, i + 1)); // scroll down = zoom out
        }
        while (wheelAcc.current[key] <= -ZOOM_WHEEL_STEP) {
          wheelAcc.current[key] += ZOOM_WHEEL_STEP;
          set((i) => Math.max(0, i - 1)); // scroll up = zoom in
        }
      };
      step('bid', setBidGroupIdx);
      step('ask', setAskGroupIdx);
    };
    // Double-click resets whichever side(s) the SAME targeting the wheel
    // uses would zoom - the finest grouping, matching what a fresh symbol
    // starts at (see the engine/symbol reset effect above).
    const onDblClick = (e: MouseEvent) => {
      const sides = sidesAt(el, e.clientY, e.target as Element);
      if (sides.includes('bid')) setBidGroupIdx(0);
      if (sides.includes('ask')) setAskGroupIdx(0);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [view, sidesAt]);

  // Same dismissal the header's stat menu and the ticket's popovers use: outside
  // pointerdown in the capture phase, plus Escape - which this menu did not have
  // when it rolled its own `mousedown` listener.
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const unitPopRef = useRef<HTMLDivElement>(null);
  // Portalled, so the blur samples the page. Inside the book panel the grid
  // item's transform would make the glass blur only that opaque card.
  const [unitBox, setUnitBox] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const r = menuRef.current?.getBoundingClientRect();
      if (!r) return;
      const edge = 8;
      const width = Math.max(190, r.width);
      const left = Math.max(edge, Math.min(r.right - width, window.innerWidth - width - edge));
      setUnitBox({ left, top: r.bottom + 4, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuOpen]);
  useDismiss(menuOpen, menuRef, closeMenu, unitPopRef);

  // Clamped, not just defaulted: a stale index from a longer ladder must not
  // fall through to the finest step while the button still reads the old one.
  // The effect above also writes the index back down, so the highlight and
  // the rows agree.
  const askIncrement = groupOptions[Math.min(askGroupIdx, groupOptions.length - 1)] ?? tick;
  const bidIncrement = groupOptions[Math.min(bidGroupIdx, groupOptions.length - 1)] ?? tick;
  const own = useMemo(
    () => ownBookLevels(ownOrders.data?.orders ?? [], symbol, askIncrement, bidIncrement),
    [ownOrders.data, symbol, askIncrement, bidIncrement],
  );
  /** The unit-menu button's own label - one figure when both sides agree,
   *  bid/ask when a wheel-zoom has split them, since no single number would
   *  be true at that point. */
  const groupLabel =
    bidGroupIdx === askGroupIdx
      ? fmtIncrement(bidIncrement, sym?.tickSize)
      : `${fmtIncrement(bidIncrement, sym?.tickSize)}/${fmtIncrement(askIncrement, sym?.tickSize)}`;

  const asksAsc = withCumulative(aggregate(book?.asks ?? [], askIncrement, 'ask')); // best (lowest) first
  const bidsDesc = withCumulative(aggregate(book?.bids ?? [], bidIncrement, 'bid')); // best (highest) first

  /**
   * HOW MANY ROWS EACH SIDE GETS.
   *
   * `rowCap` is the whole panel's data-row budget, measured (see recomputeRows).
   * `half` is the balanced share - and a balanced pair of ladders IS the point
   * of the both-sides view, so it is where the allocation starts.
   *
   * WHAT THIS REPLACES: `Math.min(rowCap/2, asks.length, bids.length)` applied
   * to BOTH sides, which clamped the deep side to the thin side's bucket count.
   * On a book with 30 asks and 3 bids it drew 3 rows of asks and threw the other
   * 27 away with the panel half empty, and on a ONE-SIDED book it clamped both
   * sides to zero and rendered nothing at all - the one case where the surviving
   * side is the only thing a trader has left to look at.
   *
   * So: each side takes its half, and whatever its partner could not use it may
   * take as well, up to its own real depth. Consequences, in order:
   *
   *  - both ladders deep  -> `half` each, exactly as before. Symmetric.
   *  - one side thin      -> the deep side grows into the space the thin one
   *                          left, up to the full panel.
   *  - one side EMPTY     -> the other side gets the whole budget.
   *
   * The odd row (an odd `rowCap` cannot be halved evenly) is spent ONLY on a
   * side whose partner is already exhausted. Two deep ladders therefore stay
   * exactly equal rather than one of them permanently standing a row taller
   * than the other, which is the balance the both-sides view is for; the row is
   * not "hidden depth" in that case because it is depth both sides have.
   */
  const half = view === 'both' ? Math.max(1, Math.floor(rowCap / 2)) : rowCap;
  let nAsks = view === 'bids' ? 0 : Math.min(half, asksAsc.length);
  let nBids = view === 'asks' ? 0 : Math.min(half, bidsDesc.length);
  if (view === 'both') {
    // `half * 2` rather than rowCap when rowCap is 1: the floor above already
    // promised each side a row, and the budget must not contradict it.
    const spare = Math.max(rowCap, half * 2) - nAsks - nBids;
    if (spare > 0) {
      if (nBids < half) nAsks = Math.min(asksAsc.length, nAsks + spare);
      else if (nAsks < half) nBids = Math.min(bidsDesc.length, nBids + spare);
    }
  }

  // The RENDERED ladders. `askLadder` is the asks on screen BEST FIRST (the
  // touch at index 0) - the order the hover popup accumulates in - and
  // `shownAsks` is the same array reversed into the top-down order the rows are
  // drawn in. Bids are drawn best first already.
  const askLadder = asksAsc.slice(0, nAsks);
  const shownAsks = [...askLadder].reverse(); // worst-to-best, top-to-bottom
  const shownBids = bidsDesc.slice(0, nBids);

  // The ticket's order, painted onto the rows it would trade. A buy eats asks,
  // a sell eats bids. `takenCum` is in the same unit as the depth bar.
  const impact = useOrderImpact();
  const impactTakes = impact && impact.symbol === symbol ? impact.takes : null;
  const askTaken = impactTakes && impact?.side === 'buy'
    ? takenShareByLevel(askLadder, impactTakes, askIncrement, 'ask')
    : null;
  const bidTaken = impactTakes && impact?.side === 'sell'
    ? takenShareByLevel(shownBids, impactTakes, bidIncrement, 'bid')
    : null;
  // What a limit leaves resting joins one price on its OWN side only - a buy on
  // the bids, a sell on the asks. A limit through the far touch takes those
  // levels first (`takes`, drawn as a market's) and never rests over there:
  // OrderEntry publishes only the part that would really rest.
  const rest = impact && impact.symbol === symbol ? impact.rest : null;
  const restHit = (() => {
    if (!rest || !(rest.qty > 0)) return null;
    const s: 'bid' | 'ask' = impact!.side === 'buy' ? 'bid' : 'ask';
    const inc = s === 'ask' ? askIncrement : bidIncrement;
    const ladder = s === 'ask' ? askLadder : shownBids;
    if (!(inc > 0)) return null;
    const bucket = bucketOf(rest.price, inc, s);
    if (ladder.some((l) => l.price === bucket)) return { side: s, price: bucket, qty: rest.qty };
    // Inside the spread (a price between the best bid and ask, e.g. a resting order at the mid): it
    // would become the new best on its side, so it is drawn on that side's best row.
    const best = ladder[0]; // both ladders start at the touch (asks ascending, bids descending)
    const inside = best && (s === 'bid' ? rest.price > best.price : rest.price < best.price);
    return inside ? { side: s, price: best!.price, qty: rest.qty } : null;
  })();
  const impactLive = Boolean(
    (askTaken && askTaken.size > 0) || (bidTaken && bidTaken.size > 0) || restHit,
  );

  // The deepest cumulative on screen, IN THE DISPLAYED UNIT - the bar behind a
  // row tracks the same running total the Sum column prints, so its edge and
  // that number cannot tell different stories.
  const cumOf = (r: BookLevel) => (unit === 'quote' ? r.cumQuote : r.cum);
  // `|| 1` only ever fires when there are no rows at all, so it cannot distort
  // a book whose base quantities are all smaller than one unit.
  const maxCum =
    Math.max(
      shownAsks[0] ? cumOf(shownAsks[0]) : 0,
      shownBids.length ? cumOf(shownBids[shownBids.length - 1]!) : 0,
    ) || 1;

  /**
   * THE SPREAD, AND THE THREE WAYS THERE ISN'T ONE.
   *
   * A spread is `bestAsk - bestBid` and it is never negative. A book where the
   * ask sits below the bid is CROSSED - stale, or mid-update, or two sides that
   * arrived from different snapshots - and a crossed book is missing
   * information, not information about a negative gap. Same for a one-sided
   * book: no touch, no spread. Both render an em-dash, because the alternative
   * is printing a fabricated 0.00% that says "this market is infinitely liquid"
   * at precisely the moment the feed is least trustworthy.
   *
   * `Math.max(0, ...)` is belt and braces on top of the crossed check: it
   * guarantees no minus sign can ever reach the glyph even if a future edit
   * loosens the guard.
   *
   * Note what this is NOT. The funding rate keeps its sign everywhere it is
   * shown, because a negative funding rate is real and means shorts pay longs.
   * Only the SPREAD is clamped, and only because a negative one is not a
   * reading at all.
   */
  const bestAsk = book?.asks?.[0]?.[0];
  const bestBid = book?.bids?.[0]?.[0];
  const askN = num(bestAsk);
  const bidN = num(bestBid);
  const haveTouch =
    bestAsk !== undefined && bestBid !== undefined && askN > 0 && bidN > 0 && askN >= bidN;
  const spread = haveTouch ? Math.max(0, askN - bidN) : null;
  /*
   * AGAINST THE MID, NOT THE BID.
   *
   * Every venue and every desk quotes a spread as a fraction of the mid. This
   * divided by the best bid, which reads high by half a spread - immaterial on
   * a tight book and very much not on a wide one, which is exactly when someone
   * looks at this number.
   */
  const midN = haveTouch ? (askN + bidN) / 2 : 0;
  /** Percent to three places, unsigned - a spread has no direction to report. */
  const spreadPctStr = spread === null || midN <= 0
    ? DASH
    : `${fmtFixed((spread / midN) * 100, 3)}%`;
  // BASIS POINTS, NOT PERCENT: the mid row's standing figure. bps is the raw
  // L1 spread's own conventional unit (a tenth of what the header shows in
  // the tooltip), and using it here means the recorded history and the live
  // readout beside it are always in the same unit rather than related by a
  // hidden x100.
  const spreadBps = spread === null || midN <= 0 ? null : (spread / midN) * 10_000;

  // ALWAYS recording - see useSampleRecorder - so opening the chart shows the
  // last minute immediately. `null` while there is no real touch, never the
  // clamped `spread` of 0: an unavailable reading is not a zero one.
  const spreadRec = useSampleRecorder(spreadBps, HISTORY_CAP, marketKey);
  /*
   * ADAPTIVE DECIMALS, 1 TO 4. A fixed two places printed BTC's one-tick
   * spread as "0.12 bps" on every tick and every point of the chart, while the
   * chart's own scale showed the value moving. Three significant figures of the
   * smallest reading in the recorder's minute - "0.119" on BTC, "1.03" on DOGE -
   * held steady by a dead band at decade edges; see bpsPrecision.ts. The chart's
   * tooltip prints with the same number.
   */
  const spreadDp = useBpsDecimals(spreadRec, spreadBps, marketKey);
  const spreadBpsStr = spreadBps === null ? DASH : fmtBps(spreadBps, spreadDp);
  const spreadTitle =
    spread === null
      ? 'Spread unavailable — the book is one-sided or crossed'
      : `Spread ${fmtPrice(spread, sym?.tickSize)} (${spreadPctStr})`;
  /**
   * The spread symbol doubles as the chart's show/hide toggle. Showing it
   * also snaps both sides to the finest grouping: the chart tracks the REAL
   * L1 spread, and a ladder folded into wide buckets is the one view of the
   * book that cannot show you why it is moving.
   */
  const toggleRecording = useCallback(() => {
    if (recordingOn === marketKey) {
      setRecordingOn(null);
      return;
    }
    setRecordingOn(marketKey);
    setBidGroupIdx(0);
    setAskGroupIdx(0);
  }, [recordingOn, marketKey]);

  /**
   * Buy/sell pressure, over AN EQUAL NUMBER OF BUCKETS FROM EACH SIDE.
   *
   * The two ladders no longer always show the same row count - a thin side
   * hands its unused rows to the deep one - and summing whatever happens to be
   * on screen would then compare, say, 21 ask buckets against 3 bid buckets and
   * report 87% sell pressure when what actually happened is that the bid side's
   * published depth ran out. That is a fabricated reading of a real asymmetry,
   * so the comparison is taken over `min(asks, bids)` buckets counted out from
   * the touch: like against like, at the same distance from the mid.
   *
   * The one exception is a side with NO rows at all, where there is no
   * overlapping window to take. 0% / 100% is then the correct and useful
   * statement - all the visible depth is on one side - so the sums fall back to
   * everything shown rather than blanking to an em-dash.
   */
  const pairDepth = Math.min(shownAsks.length, shownBids.length);
  const askSlice = pairDepth ? shownAsks.slice(-pairDepth) : shownAsks; // asks render worst-first
  const bidSlice = pairDepth ? shownBids.slice(0, pairDepth) : shownBids;
  /*
   * WEIGHTED IN THE UNIT ON SCREEN. The sizes, the sums and the depth bars
   * behind the rows all follow `unit`; this bar summed base quantity whatever
   * was selected, so in quote mode it answered a different question from
   * everything around it - and on a market where price varies across the book,
   * a different answer.
   */
  const weigh = (r: { price: number; qty: number }) => (unit === 'quote' ? r.price * r.qty : r.qty);
  const bidSum = bidSlice.reduce((s, r) => s + weigh(r), 0);
  const askSum = askSlice.reduce((s, r) => s + weigh(r), 0);
  const haveRatio = bidSum + askSum > 0;
  const bidPct = haveRatio ? (bidSum / (bidSum + askSum)) * 100 : 50;

  // Same always-on pattern as the spread above, over the same bid-share
  // reading the live bar already shows. `null` while there is no real ratio
  // to read - `haveRatio` false means the fallback 50 the live bar shows is
  // a neutral DISPLAY default, not a reading worth recording.
  const bsRec = useSampleRecorder(haveRatio ? bidPct : null, HISTORY_CAP, marketKey);
  const toggleBsRecording = useCallback(
    () => setBsRecordingOn((was) => (was === marketKey ? null : marketKey)),
    [marketKey],
  );

  // Both recordings are keyed to the market like everything else here - a
  // spread history from the last symbol is not a reading about this one - and
  // restart from the first render of a new one (see useSampleRecorder).
  useEffect(() => {
    if (log.debugEnabled) log.debug('spread and B/S recorders restarted for a new market', { engine, symbol });
  }, [engine, symbol]);

  /*
   * A BOOK THAT CANNOT BE READ AS ONE: crossed (best ask below best bid - stale
   * or mid-update), one-sided, or empty once loaded. Logged on the transition
   * into each state, not per push; the mid row already shows an em-dash for
   * the spread in all three.
   */
  const bookHealth = !book
    ? 'loading'
    : !book.asks?.length && !book.bids?.length
      ? 'empty'
      : !book.asks?.length || !book.bids?.length
        ? 'one-sided'
        : askN < bidN
          ? 'crossed'
          : 'ok';
  useEffect(() => {
    if (bookHealth === 'crossed' || bookHealth === 'empty' || bookHealth === 'one-sided') {
      log.warn(`order book is ${bookHealth}`, { engine, symbol, bestBid: bestBid ?? null, bestAsk: bestAsk ?? null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookHealth, engine, symbol]);

  // The settlement token is shown by its own name when the user asks for base
  // units and generically as USD for the quote, matching every other
  // quote-currency label in this app.
  /*
   * NOT 'USD'. The quote coin is whatever this market settles in, and
   * `quoteGlyph`/`coinLabel` exist in this same file precisely because it is
   * routinely not a dollar. Hardcoding USD put the wrong currency on the book's
   * column heads, the unit menu and the tape's Size menu at once.
   */
  const baseLabel = coinLabel(sym?.baseCoin) || 'Base';
  const unitLabel = unit === 'quote' ? (coinLabel(sym?.quoteCoin) || 'Quote') : baseLabel;
  const quoteLabel = coinLabel(sym?.quoteCoin) || 'Quote';

  /*
   * THE HOVER POPUP - the focused level's price, and sum base / sum quote from
   * the touch through it, left of the book, with every other level dimmed.
   *
   * WHICH ROW: always the row PHYSICALLY UNDER THE POINTER NOW, found by
   * GEOMETRY - the pointer's last client position against the rows' own rects,
   * as laid out at that moment. It is tested on every pointer move (once per
   * frame however many moves the frame carried) AND after every render, in a
   * layout effect, so the rows and the highlight are always decided on the same
   * layout, before that frame is painted. Over something in the rows area that
   * is not a level (the mid row, the column heads) the previous focus is held
   * while the pointer keeps moving - a crossing switches straight to the level
   * on the far side, with no pulse - and dropped once it comes to rest there
   * (BOOK_DWELL_MS). Leaving the rows area starts BOOK_HOVER_GRACE_MS.
   *
   * WHY IT NEVER JUMPS WHEN THE BOOK MOVES. The focus is a ROW (side + rank from
   * the touch), not a price, and each row is keyed by that same rank, so a
   * resting pointer stays over one DOM node for as long as the layout holds -
   * a push only rewrites that node's figures. It used to be the other way round:
   * rows keyed by price and the focus kept as a price, so every push that shifted
   * the ladder MOVED the lit node one row or more away from the pointer, where it
   * kept fading out for 80ms beside the newly lit row (two rows lit, the light
   * appearing to jump to a neighbour and back); and a push that took the focused
   * price off the ladder undimmed the whole book for one commit, which every new
   * row then faded back from. When a push or a regroup does re-lay the rows
   * under a resting pointer (a thin side's row count changing, say), the layout
   * effect re-tests EXACTLY as a pointer move would - no stickiness to the row
   * the pointer was on, which kept a neighbour lit for as long as the pointer
   * then rested a pixel or two past its edge. Row-to-row handovers are always
   * instant: only the book-wide dim fades (see Market.css).
   *
   * WHERE: the popup's Y follows the POINTER, not the row - continuously, with
   * a light ease (see stepPop) - clamped inside the book's vertical extent and
   * the viewport. Horizontally it sits left of the book column.
   *
   * NO FLICKER: one element, mounted for the life of the book and portalled to
   * <body>; between levels only its figures and its transform change. Hiding is
   * only ever SCHEDULED - after the dwell or the grace - and any level the
   * pointer reaches first cancels it. A fade already under way reverses from
   * wherever it has got to (CSS transitions do), so re-entering never snaps.
   *
   * Mouse and pen only. A touch has no hover: a tap still fills the ticket's
   * price through the row's own onClick, and no popup is left stuck behind it.
   */
  const clearHide = useCallback(() => {
    if (hideTimer.current !== undefined) {
      clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
    }
  }, []);

  /**
   * The row under the last pointer position, BY GEOMETRY: each row's rect as
   * laid out now, half-open `[top, bottom)` so a pointer exactly on a border
   * belongs to exactly one row - the same answer for a pointer move and for a
   * re-test after a book push, so the lit row is always the one under the
   * pointer. `elementFromPoint` is only the occlusion check - anything painted
   * over the book at that point (a menu, a dialog) takes the pointer - never
   * the answer, so a pixel gap or a border between rows cannot drop or shift
   * the focus.
   */
  const levelAtPointer = useCallback((): BookSlot | null => {
    const el = rowsWrap.current;
    const p = pointerAt.current;
    if (!el || !p) return null;
    const top = document.elementFromPoint(p.x, p.y);
    if (!top || !el.contains(top)) return null;
    for (const row of el.querySelectorAll<HTMLElement>('tr.mkt-bookrow')) {
      const r = row.getBoundingClientRect();
      if (p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom) continue;
      const slot = slotOfRow(row);
      if (slot) return slot;
    }
    return null;
  }, []);

  /**
   * Whether the pointer is over the ROWS AREA at all - a level, the mid row,
   * the column heads, a sub-pixel seam, a shallow book's blank - and not under
   * something painted over it (a menu takes the pointer, as in levelAtPointer).
   * Inside it a focused level is held under the dwell rule: see armDwell.
   */
  const pointerInRows = useCallback((): boolean => {
    const el = rowsWrap.current;
    const p = pointerAt.current;
    if (!el || !p) return false;
    const top = document.elementFromPoint(p.x, p.y);
    return !!top && el.contains(top);
  }, []);

  /** KEYBOARD: the row holding `:focus-visible` focus - rows are real controls. */
  const levelAtFocus = useCallback((): BookSlot | null => {
    const el = rowsWrap.current;
    const row = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('tr.mkt-bookrow');
    if (!el || !row || !el.contains(row) || !row.matches(':focus-visible')) return null;
    return slotOfRow(row);
  }, []);

  /** Where focus belongs right now: the pointer's row while it is over the book, else a keyboard-focused row. */
  const levelNow = useCallback(
    (): BookSlot | null => (pointerAt.current ? levelAtPointer() : levelAtFocus()),
    [levelAtPointer, levelAtFocus],
  );

  /**
   * Sets the focused row. From a layout effect a plain setState already
   * re-renders before paint; from a rAF it is flushed, so the row emphasis,
   * the dimming and the popup's figures all land in the frame of the move.
   */
  const commitHover = useCallback((next: BookSlot | null, inLayout: boolean) => {
    if (sameSlot(hoverRef.current, next)) return;
    hoverRef.current = next;
    if (inLayout) setHover(next);
    else flushSync(() => setHover(next));
  }, []);

  const clearDwell = useCallback(() => {
    if (dwellTimer.current !== undefined) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = undefined;
    }
    dwellAt.current = null;
  }, []);

  /**
   * The pointer is on a non-level inside the rows area with a level focused:
   * hold it, but only while the pointer is getting somewhere. Every
   * BOOK_DWELL_PX of progress restarts the clock; BOOK_DWELL_MS without that
   * much progress drops the focus - the popup fades out and the book un-dims.
   * A book push re-running this on a still pointer is no progress, so it never
   * holds a resting pointer's focus open.
   */
  const armDwell = useCallback(() => {
    const p = pointerAt.current;
    if (!p) return;
    const a = dwellAt.current;
    if (a && Math.hypot(p.x - a.x, p.y - a.y) < BOOK_DWELL_PX) return; // no progress yet: the clock runs on
    dwellAt.current = { x: p.x, y: p.y };
    if (dwellTimer.current !== undefined) clearTimeout(dwellTimer.current);
    dwellTimer.current = window.setTimeout(() => {
      dwellTimer.current = undefined;
      dwellAt.current = null;
      // A level reached in the same instant wins (its frame commits it); a
      // pointer that has left is the grace's business.
      if (levelNow() || !pointerInRows() || !hoverRef.current) return;
      hoverRef.current = null;
      setHover(null);
    }, BOOK_DWELL_MS);
  }, [levelNow, pointerInRows]);

  /** Whether the focused slot is still a row on screen (a push can shorten a side under a held focus). */
  const slotOnScreen = useCallback((slot: BookSlot): boolean => {
    const el = rowsWrap.current;
    return !!el?.querySelector(`tr.mkt-bookrow[data-side="${slot.side}"][data-rank="${slot.rank}"]`);
  }, []);

  const scheduleHide = useCallback(() => {
    // An earlier, pending hide stands - rescheduling on every event would let a
    // pointer resting on the mid row hold a stale level forever.
    if (hideTimer.current !== undefined) return;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined;
      // Re-read before hiding: the pointer may have reached a level in the
      // same instant, ahead of that move's frame - or come back into the rows
      // area, where the dwell rule decides instead.
      const next = levelNow();
      if (!next && hoverRef.current && pointerInRows()) {
        armDwell();
        return;
      }
      if (!sameSlot(hoverRef.current, next)) {
        hoverRef.current = next;
        setHover(next);
      }
    }, BOOK_HOVER_GRACE_MS);
  }, [levelNow, pointerInRows, armDwell]);

  /** Re-derives the focused row from where the pointer (or keyboard focus) is NOW. */
  const resolveHover = useCallback((inLayout: boolean) => {
    const hit = levelNow();
    if (hit) {
      clearHide();
      clearDwell();
      commitHover(hit, inLayout);
      return;
    }
    /*
     * Not on a level but STILL IN THE ROWS AREA - the mid row, the column
     * heads, a seam, a shallow book's blank. A pointer passing through holds
     * the focused level: the popup keeps its figures and follows the pointer,
     * the book stays dimmed, and the first level on the far side takes over in
     * the frame it is reached - no pulse. A pointer that STOPS here, or crawls,
     * lets it go after the dwell (armDwell). A held level that a push has taken
     * off the screen is let go at once: the popup never describes a row that
     * is not there.
     */
    if (hoverRef.current && pointerInRows()) {
      clearHide();
      if (!slotOnScreen(hoverRef.current)) {
        clearDwell();
        commitHover(null, inLayout);
        return;
      }
      armDwell();
      return;
    }
    // The pointer has left the rows area (or a keyboard focus moved off the
    // rows): hold the last level for the grace, then hide with the normal fade.
    clearDwell();
    if (hoverRef.current) scheduleHide();
  }, [levelNow, pointerInRows, slotOnScreen, clearHide, clearDwell, commitHover, armDwell, scheduleHide]);

  /**
   * Moves the popup one frame toward where it belongs; true while it is still
   * on its way. Y tracks the POINTER (for keyboard focus, the focused row's
   * centre) and X sits left of the book column.
   *
   * THE EASE: `1 - e^(-dt/TAU)` of the remaining gap per frame and never more
   * than MAX_LAG px behind, so it glides on slow moves and keeps pace on fast
   * ones. Appearing - or reappearing after more than RESUME hidden - places it
   * exactly rather than easing in from a stale spot. Reduced motion: exact.
   */
  const stepPop = useCallback((): boolean => {
    const pop = popRef.current;
    const sec = sectionRef.current;
    const wrap = rowsWrap.current;
    const now = performance.now();
    if (!pop || !sec || !wrap) return false;
    if (!hoverRef.current) {
      // Hidden or fading out: hold still where it is, and note since when.
      if (popPos.current && !popPos.current.hiddenAt) popPos.current.hiddenAt = now;
      return false;
    }
    let anchorY: number;
    const p = pointerAt.current;
    if (p) {
      anchorY = p.y;
    } else {
      const row = wrap.querySelector<HTMLElement>('tr.mkt-bookrow.is-hover');
      if (!row) return false;
      const rr = row.getBoundingClientRect();
      anchorY = rr.top + rr.height / 2;
    }
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const sr = sec.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    // Left of the book, centred on the pointer, inside the book's own vertical
    // extent. A book flush against the viewport's left edge flips it to the
    // right; a book as wide as the viewport (the narrow, tabbed layout) has room
    // on neither side, so it rides just above the pointer (below, near the top)
    // and never covers the level it describes.
    let x = sr.left - BOOK_POP_GAP - pw;
    let y = anchorY - ph / 2;
    let lo = wr.top;
    let hi = wr.bottom - ph;
    if (x < BOOK_POP_EDGE) {
      const right = sr.right + BOOK_POP_GAP;
      if (right + pw <= vw - BOOK_POP_EDGE) {
        x = right;
      } else {
        x = sr.left + BOOK_POP_EDGE;
        y = anchorY - BOOK_POP_INSET_OFFSET - ph;
        if (y < BOOK_POP_EDGE) y = anchorY + BOOK_POP_INSET_OFFSET;
        lo = -Infinity;
        hi = Infinity;
      }
    }
    y = Math.min(Math.max(y, lo), Math.max(lo, hi));
    y = Math.min(Math.max(y, BOOK_POP_EDGE), Math.max(BOOK_POP_EDGE, vh - BOOK_POP_EDGE - ph));
    x = Math.min(Math.max(x, BOOK_POP_EDGE), Math.max(BOOK_POP_EDGE, vw - BOOK_POP_EDGE - pw));

    const prev = popPos.current;
    let cy = y;
    const resume =
      !!prev && !(prev.hiddenAt && now - prev.hiddenAt > BOOK_POP_RESUME_MS) && Math.abs(prev.x - x) < 1;
    if (prev && resume && !prefersReducedMotion()) {
      // dt capped at two frames: an idle popup starting to move again must not
      // treat the whole idle time as one step.
      const dt = Math.min(34, Math.max(0, now - prev.t));
      cy = prev.y + (y - prev.y) * (1 - Math.exp(-dt / BOOK_POP_TAU_MS));
      cy = Math.min(y + BOOK_POP_MAX_LAG, Math.max(y - BOOK_POP_MAX_LAG, cy));
      if (Math.abs(y - cy) < 0.5) cy = y;
    }
    popPos.current = { x, y: cy, t: now, hiddenAt: 0 };
    pop.style.transform = `translate3d(${Math.round(x)}px, ${cy.toFixed(1)}px, 0)`;
    return cy !== y;
  }, []);

  /**
   * The one animation frame: hit-test a pending pointer move, then step the
   * popup. It re-arms itself only while the popup is still easing, so a resting
   * pointer costs nothing.
   */
  const kickFrame = useCallback(() => {
    if (frameRaf.current) return;
    const run = () => {
      frameRaf.current = 0;
      if (pointerDirty.current) {
        pointerDirty.current = false;
        resolveHover(false);
      }
      if (stepPop() && !frameRaf.current) frameRaf.current = requestAnimationFrame(run);
    };
    frameRaf.current = requestAnimationFrame(run);
  }, [resolveHover, stepPop]);

  useEffect(() => {
    const el = rowsWrap.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      pointerAt.current = { x: e.clientX, y: e.clientY };
      pointerDirty.current = true;
      kickFrame();
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      pointerAt.current = null;
      pointerDirty.current = false;
      clearDwell();
      if (hoverRef.current) scheduleHide();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointerAt.current = null;
      pointerDirty.current = false;
      clearHide();
      clearDwell();
      hoverRef.current = null;
      setHover(null);
    };
    // KEYBOARD: a keyboard focus shows the same popup a pointer would.
    // `:focus-visible` only - a mouse click also focuses the row it fills from,
    // and that must not pin the popup after the pointer has gone.
    const onFocusIn = (e: FocusEvent) => {
      if (pointerAt.current) return; // the pointer decides while it is over the book
      const row = (e.target as Element | null)?.closest?.<HTMLElement>('tr.mkt-bookrow');
      if (!row || !row.matches(':focus-visible')) return;
      const hit = slotOfRow(row);
      if (!hit) return;
      clearHide();
      hoverRef.current = hit;
      setHover(hit);
    };
    const onFocusOut = () => {
      if (!pointerAt.current && hoverRef.current) scheduleHide();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      if (frameRaf.current) cancelAnimationFrame(frameRaf.current);
      frameRaf.current = 0;
      clearHide();
      clearDwell();
    };
  }, [kickFrame, scheduleHide, clearHide, clearDwell]);

  // A different market is a different book: never carry a hover across.
  useEffect(() => {
    hoverRef.current = null;
    clearDwell();
    setHover(null);
    lastPop.current = null;
    lastLit.current = null;
  }, [engine, symbol, clearDwell]);

  /*
   * The focused row's figures, from EXACTLY the ladder the rows are drawn from -
   * the grouped buckets on screen, best first, with the prices and base sizes
   * the rows print - in this same render, so the popup and the lit row are one
   * snapshot and change in the same frame when the book moves under a still
   * pointer.
   *
   * PRICE IS THE FOCUSED LEVEL'S OWN PRICE: the row's Price cell, character for
   * character, and the price a click on that row puts in the ticket. It used to
   * be "Avg. Price" - the VWAP from the touch through the level, rounded to the
   * tick - which lands BETWEEN rows (it is never the hovered row's price past
   * the first level) and barely moves when the book shifts under a still
   * cursor, so it read as a wrong price that did not update. The two sums stay
   * cumulative from the touch through the focused level. Each figure goes
   * through its column's own formatter (fmtPrice, fmtQty, fmtNotional - the
   * calls BookRow makes). See depthFiguresThrough in bookDepth.ts.
   */
  const bookFmt: BookFormat = { tickSize: sym?.tickSize, stepSize: sym?.stepSize };
  const hoverLadder = hover ? (hover.side === 'ask' ? askLadder : shownBids) : null;
  const hoverStats = hover && hoverLadder ? depthFiguresThrough(hoverLadder, hover.rank, bookFmt) : null;
  const popNow =
    hover && hoverLadder && hoverStats
      ? { side: hover.side, price: hoverLadder[hover.rank]!.price, stats: hoverStats }
      : null;
  if (popNow) lastPop.current = popNow;
  const popView = popNow ?? lastPop.current;
  /*
   * ON while a row is focused, even for the one commit in which a push has left
   * the focused rank off a shorter ladder (the layout effect below refocuses -
   * or, on a held focus, lets go - before that frame is painted): the popup and
   * the dimming never blink for it.
   */
  const popOn = hover !== null && popView !== null;
  // The row the book fades back up to when the focus goes: see `lastLit`.
  // While the ticket is painting a take or a resting level, that hold reads as
  // a level stuck highlighted after the pointer leaves the book. Drop it.
  if (impactLive) lastLit.current = null;
  else if (hover) lastLit.current = hover;
  const litSlot = hover || impactLive ? null : lastLit.current;

  /*
   * AFTER EVERY RENDER, BEFORE PAINT: re-test the pointer against the rows as
   * they are laid out NOW (a book push, a regroup or a refit may have re-laid
   * them), then place the popup. If the focus changes here the state update
   * re-renders synchronously and this runs again, so the highlight and the
   * popup's figures are decided on the very layout that frame paints, never a
   * frame apart.
   */
  useLayoutEffect(() => {
    if (pointerAt.current || hoverRef.current) {
      const before = hoverRef.current;
      resolveHover(true);
      if (hoverRef.current !== before) return;
    }
    if (stepPop()) kickFrame();
    assertPopupMatchesRow();
  });

  /*
   * RUNTIME ASSERTION, on the committed DOM of this very frame: while the popup
   * is on, its Price is the lit row's Price cell and its Sum in the displayed
   * unit is the lit row's Sum cell. Both are built from one snapshot in one
   * render, so a mismatch is a bug - logged as an error with what was on screen.
   */
  function assertPopupMatchesRow(): void {
    const pop = popRef.current;
    if (!hoverRef.current || !pop?.classList.contains('is-on')) return;
    const row = rowsWrap.current?.querySelector<HTMLElement>('tr.mkt-bookrow.is-hover');
    if (!row) return;
    const dd = pop.querySelectorAll('dd');
    const cells = row.querySelectorAll('td');
    const popPrice = dd[0]?.textContent ?? '';
    const rowPrice = cells[0]?.textContent ?? '';
    const popSum = (unit === 'quote' ? dd[2] : dd[1])?.textContent ?? '';
    const rowSum = cells[2]?.textContent ?? '';
    if (popPrice !== rowPrice || popSum !== rowSum) {
      log.error('book popup does not match the lit row', {
        engine,
        symbol,
        side: row.dataset.side,
        rank: row.dataset.rank,
        level: row.dataset.price,
        unit,
        popup: { price: popPrice, sum: popSum },
        row: { price: rowPrice, sum: rowSum },
      });
    }
  }

  // The page or a panel scrolling, or the window resizing, moves the rows
  // under a pointer that did not move: hit-test again on the next frame,
  // exactly as a pointer move would, and re-place the popup.
  const hovering = hover !== null;
  useEffect(() => {
    if (!hovering) return;
    const onShift = () => {
      if (pointerAt.current) pointerDirty.current = true;
      kickFrame();
    };
    window.addEventListener('scroll', onShift, { capture: true, passive: true });
    window.addEventListener('resize', onShift);
    return () => {
      window.removeEventListener('scroll', onShift, { capture: true });
      window.removeEventListener('resize', onShift);
    };
  }, [hovering, kickFrame]);

  return (
    <section className="mkt-book" ref={sectionRef}>
      {showTitle && <h2 className="mkt-title">Order book</h2>}

      <div className="mkt-book-ctl">
        {/* Three swatches, not three labelled buttons. The control says which
            sides are drawn, and a coloured square IS that statement - the
            green/red split reads faster than the words "both sides" and costs
            42px of a 395px panel instead of 160. */}
        <div className="mkt-views" role="group" aria-label="Order book sides">
          <button
            className={`mkt-view ${view === 'both' ? 'is-on' : ''}`}
            onClick={() => setView('both')}
            aria-pressed={view === 'both'}
            aria-label="Show both sides"
            title="Both sides"
          >
            <span className="mkt-view-sw both" />
          </button>
          <button
            className={`mkt-view ${view === 'bids' ? 'is-on' : ''}`}
            onClick={() => setView('bids')}
            aria-pressed={view === 'bids'}
            aria-label="Show bids only"
            title="Bids only"
          >
            <span className="mkt-view-sw bids" />
          </button>
          <button
            className={`mkt-view ${view === 'asks' ? 'is-on' : ''}`}
            onClick={() => setView('asks')}
            aria-pressed={view === 'asks'}
            aria-label="Show asks only"
            title="Asks only"
          >
            <span className="mkt-view-sw asks" />
          </button>
        </div>

        <div className="menu mkt-unit" ref={menuRef}>
          <button
            className="mkt-unitbtn"
            onClick={() => setMenuOpen((m) => !m)}
            aria-expanded={menuOpen}
            aria-label="Display unit and price grouping"
          >
            <span>{unitLabel}</span>
            <span className="mkt-unitsep" aria-hidden="true" />
            <span>{groupLabel}</span>
            <Chevron size="sm" />
          </button>
          {menuOpen && createPortal(
            /* TWO COLUMNS, EACH ONE A VERTICAL LIST. Portalled so the glass
               blurs the page, not the book's own card. */
            <div
              ref={unitPopRef}
              className="menu-popup mkt-unitmenu"
              style={unitBox ? {
                position: 'fixed',
                left: unitBox.left,
                top: unitBox.top,
                width: unitBox.width,
                right: 'auto',
                zIndex: 70,
                transformOrigin: 'top right',
              } : { position: 'fixed', visibility: 'hidden' }}
            >
              <div className="mkt-unitmenu-cols">
                <div className="menu-group">
                  <div className="menu-group-label">Display</div>
                  <div className="menu-grid">
                    <button className={unit === 'quote' ? 'active' : ''} onClick={() => setUnit('quote')}>{coinLabel(sym?.quoteCoin) || 'Quote'}</button>
                    <button className={unit === 'base' ? 'active' : ''} onClick={() => setUnit('base')}>{baseLabel}</button>
                  </div>
                </div>
                <div className="menu-group">
                  {/* Tooltip, not a third visible row: the hint only needs to
                      reach someone who is already looking at this menu, and a
                      permanent line of text here would outweigh the grouping
                      buttons it is annotating. */}
                  <div
                    className="menu-group-label"
                    title="Scroll over the book to zoom bid or ask independently - this menu sets both at once"
                  >
                    Grouping
                  </div>
                  <div className="menu-grid">
                    {groupOptions.map((g, i) => (
                      <button
                        key={g}
                        // Active only when BOTH sides sit on this step: a
                        // wheel-zoom can split them, and highlighting one
                        // option when no single option is true would be a
                        // fabricated reading of the state, the same failure
                        // class this file's em-dash rule exists to prevent.
                        className={i === bidGroupIdx && i === askGroupIdx ? 'active' : ''}
                        onClick={() => { setBidGroupIdx(i); setAskGroupIdx(i); setMenuOpen(false); }}
                      >
                        {fmtIncrement(g, sym?.tickSize)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}
        </div>
      </div>

      <div
        className={`mkt-book-rows ${popOn ? 'is-hovering' : ''}`}
        ref={rowsWrap}
      >
        {!book && <p className="mkt-note">Loading depth…</p>}
        {book && (
          <table className="mkt-booktable">
            <thead>
              <tr>
                <th>Price</th>
                <th>Size ({unitLabel})</th>
                <th>Sum ({unitLabel})</th>
              </tr>
            </thead>
            <tbody>
              {/* KEYED BY RANK, NOT PRICE: row `a0` is always the best ask,
                  one DOM node that stays put while the levels move through
                  it - see the hover section for why the focus depends on it. */}
              {shownAsks.map((r, i) => {
                const rank = shownAsks.length - 1 - i; // drawn worst-first
                return (
                  <BookRow
                    key={`a${rank}`}
                    level={r}
                    rank={rank}
                    max={maxCum}
                    side="ask"
                    mine={own.ask.has(r.price)}
                    sym={sym}
                    unit={unit}
                    onPick={onPick}
                    hovered={hover?.side === 'ask' && hover.rank === rank}
                    lit={litSlot?.side === 'ask' && litSlot.rank === rank}
                    takenShare={askTaken?.get(r.price) ?? null}
                    quiet={Boolean(askTaken && askTaken.size > 0)}
                    restAdd={restHit?.side === 'ask' && restHit.price === r.price
                      ? (unit === 'quote' ? restHit.qty * r.price : restHit.qty)
                      : null}
                  />
                );
              })}
              {view === 'both' && (
                /* THE ANCHOR, ON ONE LINE. Everything above is what you can
                   sell into and everything below is what you can buy into;
                   this is where the market actually is, so it is the one thing
                   in the panel allowed to be large. The last price holds the
                   direction of the most recent tick (that is what the arrow
                   says), the mark sits beside it because it is the number your
                   margin is valued at rather than the one you trade, and
                   funding is right-aligned.

                   The spread used to have a second line here. It cost the
                   anchor an extra 12px, and the row-fitting maths reserves this
                   height in ROW units, so that line was being paid for out of a
                   level of depth on EACH side. It is not lost: the percentage
                   sits beside the measure mark that closes the row, and the
                   absolute figure is on this row's tooltip. */
                <tr className="mkt-midrow" title={spreadTitle}>
                  <td colSpan={3} className="mkt-midcell">
                    <div className="mkt-mid">
                      <div className="mkt-mid-top">
                        {/* RECORDING REPLACES THE PRICE, NOT JOINS IT. The mid
                            row has room for one large reading at a time - see
                            the file header on this row's whole history - and
                            while a spread recording is running, that reading
                            IS the chart: the last price and mark are exactly
                            what "the whitespace" in the brief meant, freed up
                            for a line that would not otherwise fit. */}
                        {!recording && (
                          <span className={`mkt-mid-last ${dir ?? ''}`}>
                            {fmtPrice(lastPx, sym?.tickSize)}
                            {dir && <TickArrow dir={dir} />}
                          </span>
                        )}
                        {/* No glyph on the mark. It sat here and not on the
                            LAST price eight pixels to its left, so the anchor
                            printed `79,240.50  $79,238.00` - one currency mark
                            across two figures in the same unit, which reads as a
                            rendering fault. The column head names both. */}
                        {!recording && engine === 'perps' && (
                          <span className="mkt-mid-mark" title="Mark price - what your margin is valued at">
                            {fmtPrice(markPx, sym?.tickSize)}
                          </span>
                        )}
                        {/* 24px: the last price's own line box, so swapping
                            one for the other changes no box in this row. The
                            band never zooms finer than the readout prints
                            (bpsMinSpan), and never below zero. */}
                        {recording && (
                          <StableSparkline
                            className="mkt-mid-chart"
                            height={24}
                            capacity={HISTORY_CAP}
                            rec={spreadRec}
                            lines={[{ color: 'var(--text)', label: 'Spread' }]}
                            band={{ pad: 0.25, minSpan: bpsMinSpan(spreadDp), loose: 2.5, floor: 0 }}
                            valueLabel={(v) => fmtBps(v, spreadDp)}
                            empty="Recording the spread…"
                          />
                        )}
                        {/* THE SPREAD, BESIDE THE MARK THAT MEANS SPREAD - and
                            now the chart's show/hide toggle too. Clicking it
                            reveals or hides the chart above (see
                            toggleRecording); the figure itself stays live
                            throughout, in bps, which is the RAW L1 reading
                            and is not affected by either side's grouping. */}
                        <button
                          type="button"
                          className={`mkt-mid-spreadbtn ${recording ? 'is-recording' : ''}`}
                          onClick={toggleRecording}
                          title={
                            recording
                              ? 'Recording the spread — click to stop and show the last price again'
                              : `${spreadTitle}. Click to record it over time and snap the grouping to the finest step.`
                          }
                        >
                          <span className="mkt-mid-spread">{spreadBpsStr}</span>
                          <SpreadMark />
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              {shownBids.map((r, rank) => (
                <BookRow
                  key={`b${rank}`}
                  level={r}
                  rank={rank}
                  max={maxCum}
                  side="bid"
                  mine={own.bid.has(r.price)}
                  sym={sym}
                  unit={unit}
                  onPick={onPick}
                  hovered={hover?.side === 'bid' && hover.rank === rank}
                  lit={litSlot?.side === 'bid' && litSlot.rank === rank}
                  takenShare={bidTaken?.get(r.price) ?? null}
                  quiet={Boolean(bidTaken && bidTaken.size > 0)}
                  restAdd={restHit?.side === 'bid' && restHit.price === r.price
                    ? (unit === 'quote' ? restHit.qty * r.price : restHit.qty)
                    : null}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {book && (
        // The bar doubles as the record button - see toggleBsRecording. The
        // B/S labels stay put in both states; only the reading between them
        // swaps from the live bar to the recorded history, the same contract
        // the spread control above uses.
        <button
          type="button"
          className={`mkt-ratio ${bsRecording ? 'is-recording' : ''}`}
          onClick={toggleBsRecording}
          title={
            bsRecording
              ? 'Recording the buy/sell share — click to stop and show the live bar again'
              : 'Click to record the buy/sell share over time'
          }
        >
          {/* The B and the S are the AXIS, not the reading - they say which end
              of the bar is which and they say it identically every frame. Only
              the percentages move, so only the percentages are coloured. */}
          <span className="mkt-ratio-l">
            <span className="mkt-ratio-k">B</span>
            <span className="mkt-ratio-v bid">{haveRatio ? `${fmtFixed(bidPct, 2)}%` : DASH}</span>
          </span>
          {bsRecording ? (
            // Not a fixed [0, 100] axis: real bid share moves in a narrow band
            // around 50%, so the chart scales to THAT band (BS_BAND - a stable
            // band, not a per-frame fit). Ask is derived, not stored - it is
            // always exactly 100 - bid. 20px: the row's own height, so the
            // chart replaces the bar without resizing anything around it.
            <StableSparkline
              className="mkt-ratio-chart"
              height={20}
              capacity={HISTORY_CAP}
              rec={bsRec}
              lines={[
                { color: 'var(--pos)', label: 'Buy' },
                { color: 'var(--neg)', label: 'Sell', map: sellShare },
              ]}
              band={BS_BAND}
              valueLabel={(v) => `${fmtFixed(v, 2)}%`}
              empty="Recording the buy/sell share…"
            />
          ) : (
            <span className="mkt-ratio-bar">
              {/* Driven by transform, not width. Animating width relayouts the
                  bar on every book push (~2/s); a scaleX on a full-width element
                  is composited and never touches layout. */}
              <span
                className="mkt-ratio-fill"
                style={{ transform: `scaleX(${haveRatio ? bidPct / 100 : 0.5})` }}
              />
            </span>
          )}
          <span className="mkt-ratio-l">
            <span className="mkt-ratio-v ask">{haveRatio ? `${fmtFixed(100 - bidPct, 2)}%` : DASH}</span>
            <span className="mkt-ratio-k">S</span>
          </span>
        </button>
      )}

      {/* THE HOVER POPUP - one persistent element, portalled so no panel's
          overflow or stacking can clip it; see the hover section above. It is
          never unmounted between levels: `is-on` fades it in and out, and
          stepPop moves it with the pointer. The last figures stay in it while
          it fades out, so it never blanks before it disappears. `data-side` /
          `data-price` name the level the figures describe. Every figure is
          printed by its book column's own formatter - see depthFiguresThrough. */}
      {createPortal(
        <div
          ref={popRef}
          className={`mkt-bookpop ${popOn ? 'is-on' : ''}`}
          role="tooltip"
          aria-hidden={!popOn}
          data-side={popView?.side}
          data-price={popView?.price}
        >
          {popView && (
            <dl className="mkt-bookpop-kv">
              <div>
                <dt><CoinIcon coin={sym?.quoteCoin} size={14} />Price</dt>
                <dd className={popView.side === 'ask' ? 'neg' : 'pos'}>
                  {popView.stats.text.price}
                </dd>
              </div>
              <div>
                <dt><CoinIcon coin={sym?.baseCoin} size={14} />Sum {baseLabel}</dt>
                <dd>{popView.stats.text.sumBase}</dd>
              </div>
              <div>
                <dt><CoinIcon coin={sym?.quoteCoin} size={14} />Sum {quoteLabel}</dt>
                <dd>{popView.stats.text.sumQuote}</dd>
              </div>
            </dl>
          )}
        </div>,
        document.body,
      )}
    </section>
  );
}

function BookRow({
  level, rank, max, side, sym, unit, onPick, hovered = false, lit = false, takenShare = null, quiet = false, restAdd = null,
  mine,
}: {
  level: BookLevel; max: number; side: 'bid' | 'ask'; sym?: Symbol; unit: 'quote' | 'base'; onPick: (p: string) => void;
  /** Rows from the touch on this side, best = 0: the row's place, and its React key. */
  rank: number;
  /** The row the book's hover popup is describing - see Book(). */
  hovered?: boolean;
  /** The row lit last, held at full strength while the book fades back up after the focus has gone. */
  lit?: boolean;
  /** Share (0..1) of this level's own size the ticket's market order takes. */
  takenShare?: number | null;
  /** This side is being eaten by the ticket. Rows without a visible take dim. */
  quiet?: boolean;
  /** Size, in the bar's unit, a limit would add at this level. The bar grows by it; the new slice is dotted. */
  restAdd?: number | null;
  /** The wallet has a resting order on this row. */
  mine?: boolean;
}) {
  const { price } = level;
  // Both columns are read in the SAME unit, and so is the depth bar behind
  // them. `rowFigures` (bookDepth.ts) is the one definition of what a row
  // prints in each unit, shared with the hover popup's tests - see
  // `withCumulative` for why the quote Sum is not `price * cum`.
  const { size, total } = rowFigures(level, unit);
  const pct = Math.min(100, max > 0 ? (total / max) * 100 : 0);
  const priceStr = price.toFixed(Math.max(precisionOf(sym?.tickSize), 0));
  // The bar fills from the RIGHT. A market take hatches the right-hand slice
  // it would fill. A limit grows the bar leftward; that new slice is dotted.
  // The hatch is that share of the row's bar: a level half taken reads half hatched.
  const takePct = takenShare != null && takenShare > 0 ? pct * Math.min(1, takenShare) : 0;
  const eaten = takePct > 0.05;
  const add = !eaten && restAdd != null && restAdd > 0 ? restAdd : 0;
  let solidLeft = 100 - pct;
  let dotPct = 0;
  if (add > 0 && max > 0) {
    const grownPct = Math.min(100, ((total + add) / max) * 100);
    if (grownPct > pct + 0.05) {
      dotPct = grownPct - pct;
    } else if (total + add > 0) {
      // The bar is already at the scale cap, so the added share is dotted
      // inside it instead of past the row edge.
      dotPct = Math.min(pct, (add / (total + add)) * pct);
      solidLeft = 100 - pct + dotPct;
    }
  }
  const dotLeft = solidLeft - dotPct;
  const pctOf = (n: number) => `${Math.max(0, Math.min(100, n)).toFixed(2)}%`;

  return (
    <tr
      className={`mkt-bookrow ${side}${hovered ? ' is-hover' : ''}${lit ? ' is-lit' : ''}${eaten ? ' is-take' : ''}${dotPct > 0.05 ? ' is-rest' : ''}${quiet && !eaten && dotPct <= 0.05 ? ' is-quiet' : ''}`}
      // Read back by the book's pointer tracking to name the hovered ROW - see
      // slotOfRow. `data-price` names the level in it right now (the bucket
      // key itself, not a formatted rendering of it).
      data-side={side}
      data-rank={rank}
      data-price={price}
      onClick={() => onPick(priceStr)}
      /*
       * REACHABLE WITHOUT A MOUSE. This is the primary price-entry control on a
       * trading terminal and it was a bare `<tr onClick>`: no role, no tab stop,
       * no key handler, no focus ring. The pointer path is untouched.
       */
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(priceStr);
        }
      }}
      /* No `title`. The hover popup now sits beside every hovered level, and a
         native tooltip arriving a second later on top of it was a second,
         competing box saying less. Click-to-fill is still announced by the
         pointer cursor and by `role="button"`. */
      /* THE DEPTH BAR IS A RAMP, NOT A TINT.
         It spans all three columns and fills from the RIGHT. The stops are
         custom properties so the hatch and the dotted limit slice can ease
         when the size slider moves; the paint itself is in Market.css.
         A table row cannot host an absolutely positioned child without leaving
         the table's own sizing algorithm, so the bar stays a background. */
      style={{
        '--bar-start': pctOf(solidLeft),
        '--solid-end': pctOf(100 - (eaten ? takePct : 0)),
        '--take-w': pctOf(eaten ? takePct : 0),
        '--rest-start': pctOf(dotLeft),
        '--rest-w': pctOf(dotPct),
      } as CSSProperties}
    >
      {/* The popup prints its figures through these same three formatters -
          see depthFiguresThrough - so it can never show more or fewer places. */}
      <td className="p">
        <span className="mkt-bookrow__rest" aria-hidden="true" />
        {fmtPrice(price, sym?.tickSize)}
        {mine && <span className="mkt-bookrow__mine" role="img" aria-label="Your order at this price" />}
      </td>
      <td>{unit === 'quote' ? fmtNotional(size) : fmtQty(size, sym?.stepSize)}</td>
      <td>{unit === 'quote' ? fmtNotional(total) : fmtQty(total, sym?.stepSize)}</td>
    </tr>
  );
}

// --- public trades -----------------------------------------------------------

export function Trades({
  engine, symbol, sym, showTitle = true, onOpenScan,
}: {
  engine: Engine; symbol: string; sym?: Symbol; showTitle?: boolean;
  /** A trade print carries only the numeric account id (`bi`/`si`), never a
   *  wallet address - the Scan page resolves the rest, or says plainly that
   *  it could not. Optional so this component still renders standalone (e.g.
   *  in a story or a future non-dashboard context) without a scan page to
   *  send anything to. */
  onOpenScan?: (accountId: number) => void;
}) {
  // TapeTrade, not PublicTrade: the live `trade` channel publishes buyer and
  // seller account ids (bi/si) that the REST seed does not. See TapeFilter.tsx
  // for the verified shapes and for why the maker/taker roles are derivable.
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const rootRef = useRef<HTMLElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const prevScrollHeight = useRef<number | null>(null);
  const mutes = useMutedAccounts();
  const aliases = useAliases();
  const [barH, setBarH] = useState(0);
  const mutedKey = mutes.muted.join(',');
  const prevMutedKey = useRef(mutedKey);

  // Shared with the Order Book's own unit toggle (see Book()) - one reading
  // for "is size shown in USD or in the coin" across every panel that shows
  // a size, not a second setting that can silently disagree with the first.
  const [unit, setUnit] = useSharedStored<'quote' | 'base'>('ot.bookunit', 'quote');
  const [hideMakers, setHideMakers] = useStored('ot.tape.hideKnownMakers', false);
  // WS is a genuine live push; REST here is a poll, not a one-time seed - the
  // same `useAsync` call does both jobs, since REST mode is what happens when
  // `pollMs` stops being undefined. 5s, not this app's usual 15-45s polls
  // (see App.tsx/Account.tsx/Money.tsx): those are for slow-moving account
  // data, this is standing in for a feed that is otherwise realtime. But not
  // faster than 5s either - server/src/sodex/rest.ts costs a `trades` call at
  // 20 + limit/20 against a SHARED upstream budget (1200/min then; SoDEX's
  // reported limit now) every other request on this venue draws from too; at
  // limit 50 that is 22 units/call,
  // and a 2s interval was measured pulling a 429 by burning ~660 units/min,
  // over half that whole shared budget, on this one poll alone.
  const [dataSource, setDataSource] = useStored<'ws' | 'rest'>('ot.tape.datasource', 'ws');
  // REST is ONLY fetched in REST mode - not as a one-time seed under WS too.
  // A hybrid tape (recent history from REST, everything after from WS) reads
  // as "the WS feed" while quietly containing rows the selected source never
  // actually carried; the account column even shows it, since a REST-seeded
  // row's "-" sits in a list otherwise full of attributed WS prints. Picking
  // a source is a statement about what you are looking at, not a one-time
  // warm start.
  const { data, loading } = useAsync(
    () => api.publicTrades(engine, symbol, 50),
    [engine, symbol, dataSource],
    { enabled: dataSource === 'rest', pollMs: dataSource === 'rest' ? 5000 : undefined },
  );

  // Cleared on every source switch, not just left to drain - the moment WS is
  // chosen, only WS prints should be on screen, not the REST rows the tape
  // happened to be showing a second ago.
  useEffect(() => setTrades([]), [dataSource]);
  useEffect(() => {
    if (dataSource === 'rest') setTrades(data?.trades ?? []);
  }, [data, dataSource]);

  // REST prints carry no account ids (see AccountCell/isAttributed in
  // TapeFilter.tsx) - switching to REST here does not just change the
  // transport, it also drops Account/alias attribution and the known-maker
  // filter for every row, which is disclosed on the option itself in
  // TapeSettings rather than only in this comment.
  useChannel(engine, dataSource === 'ws' ? { channel: 'trade', symbols: [symbol] } : null, (d) => {
    const incoming: TapeTrade[] = Array.isArray(d) ? d : [d];
    setTrades((prev) => [...incoming.filter((t) => t?.p), ...prev].slice(0, 100));
  });

  const { shown: mutedShown } = partitionByMute(trades, mutes.isMuted);
  // A KNOWN market maker can appear on EITHER side of a print, not only as
  // the aggressor - hiding "this account's activity" has to check both bi
  // and si, unlike muting, which only ever acts on the taker (see
  // partitionByMute's own comment on why that is the right scope for it).
  const isKnownMaker = (id: number | undefined) => id !== undefined && KNOWN_MARKET_MAKER_IDS.has(id);
  const shown = hideMakers
    ? mutedShown.filter((t) => !isKnownMaker(t.bi) && !isKnownMaker(t.si))
    : mutedShown;
  /*
   * COUNTED FROM WHAT IS ACTUALLY ON SCREEN.
   *
   * `partitionByMute` only knows about mutes, so its `suppressed` ignored every
   * row removed by `hideMakers` above. The bar read "0 prints hidden of 100"
   * while the table showed 40 rows, and the empty state below contradicted it
   * outright by saying all 100 were hidden. Buffered minus shown cannot
   * disagree with the table, whatever filters are added later.
   */
  const hidden = trades.length - shown.length;
  const concentration = concentrationOf(trades);

  // New trades prepend to the top. Without this, that shifts every row the
  // user is looking at downward out from under their scroll position — the
  // list appears to "jump" and rows show up above the (correctly pinned)
  // header. Compensate scrollTop by exactly the height that was inserted.
  //
  // Changing the mute set also changes the rendered height, but by REMOVING
  // rows from throughout the list rather than inserting at the top, so the
  // prepend compensation does not apply to it. It still has to re-baseline,
  // or the next print would be measured against a scrollHeight that no longer
  // exists and yank the list by the full size of the filtered-out block.
  useLayoutEffect(() => {
    if (!scrollElRef.current && rootRef.current) {
      let el: HTMLElement | null = rootRef.current.parentElement;
      while (el && !['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) el = el.parentElement;
      scrollElRef.current = el;
    }
    const muteChanged = prevMutedKey.current !== mutedKey;
    prevMutedKey.current = mutedKey;
    const scrollEl = scrollElRef.current;
    if (scrollEl) {
      if (!muteChanged && prevScrollHeight.current !== null && scrollEl.scrollTop > 0) {
        scrollEl.scrollTop += scrollEl.scrollHeight - prevScrollHeight.current;
      }
      prevScrollHeight.current = scrollEl.scrollHeight;
    }
  }, [trades, mutedKey]);

  /* The tape's own copy: the book's `unitLabel` is in another component. */
  const unitLabel = unit === 'quote'
    ? (coinLabel(sym?.quoteCoin) || 'Quote')
    : (coinLabel(sym?.baseCoin) || 'Base');
  const fmtSize = (t: TapeTrade) => (unit === 'quote' ? fmtCompact(num(t.p) * num(t.q)) : fmtQty(t.q, sym?.stepSize));

  return (
    // --tape-bar-h offsets the table's sticky header below the sticky tape bar.
    <section className="mkt-tape" ref={rootRef} style={{ '--tape-bar-h': `${barH}px` } as React.CSSProperties}>
      <div className="mkt-tape-head">
        {showTitle && <h2 className="mkt-title">Trades</h2>}
        <TapeSettings
          unit={unit}
          onUnit={setUnit}
          baseLabel={sym?.baseCoin ?? 'Qty'}
          hideMakers={hideMakers}
          onHideMakers={setHideMakers}
          dataSource={dataSource}
          onDataSource={setDataSource}
        />
      </div>
      <TapeControls
        mutes={mutes}
        suppressed={hidden}
        buffered={trades.length}
        concentration={concentration}
        onHeight={setBarH}
      />
      <table className="mkt-tapetable">
        <thead>
          <tr>
            <th>Price</th>
            {/* The unit is switchable, so the head has to carry it: a bare
                "1.2K" is $1,200 or 1,200 BTC and the table never said which. */}
            <th>Size ({unitLabel})</th>
            <th>Account</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 && (
            <tr><td colSpan={4} className="mkt-note">{loading ? 'Loading trades…' : 'No recent trades.'}</td></tr>
          )}
          {/* A muted account (or, with "hide known market makers" on, a known
              one) that is very active can hide the entire buffer. Say so
              explicitly - an empty tape otherwise reads as a dead feed. */}
          {trades.length > 0 && shown.length === 0 && (
            <tr>
              <td colSpan={4} className="mkt-note">
                All {trades.length} recent prints are hidden by your filters.
              </td>
            </tr>
          )}
          {shown.map((t) => {
            const agg = aggressorOf(t);
            const buy = String(t.S).toUpperCase() === 'BUY';
            return (
              <tr key={t.t} className="mkt-taperow">
                <td className={buy ? 'pos' : 'neg'}>{fmtPrice(t.p, sym?.tickSize)}</td>
                <td className="mkt-tape-size">{fmtSize(t)}</td>
                <AccountCell
                  trade={t}
                  aliasFor={aliases.aliasFor}
                  onSetAlias={aliases.setAlias}
                  onSearch={(id) => onOpenScan?.(id)}
                />
                {/* The time column doubles as the mute control: the id
                    appears in place of the timestamp on hover, on the rows
                    that carry one (the Account column shows the same id at
                    all times - this is the quick "mute without leaving the
                    row" path, not a second source of truth). Rows from the
                    REST seed have no id and so reveal nothing, which is the
                    same fact the Account column's own "—" states. */}
                <td className="mkt-tape-time">
                  <span className="mkt-tape-t">{new Date(t.T).toLocaleTimeString()}</span>
                  {agg !== undefined && (
                    <button
                      className="mkt-tape-mute"
                      onClick={() => mutes.mute(agg)}
                      title={`Account ${agg} crossed the spread on this print (${buy ? 'buying' : 'selling'}). Click to hide its prints.`}
                    >
                      mute {agg}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
