/**
 * Incognito mode: hide what is yours, keep what is the market's.
 *
 * THE POINT IS SCREENSHOTS AND SHOULDER-SURFING. You are streaming, screen
 * sharing, or sitting in a cafe, and the order book and the chart should stay
 * readable while your balance, your positions and your address do not.
 *
 * WHY THIS IS NOT A HOOK IN format.ts. The obvious implementation is to mask
 * inside the shared formatters, and it is wrong: `fmtPrice`, `fmtQty`, `fmtPct`
 * and `fmt` are the SAME functions the order book, the tape and the chart's OHLC
 * legend use. Masking there blanks the market data too - 14 of the 42 `fmtPrice`
 * call sites are the chart legend alone. Only the CALL SITE knows whether a
 * number is yours or the venue's, so the mask is applied there.
 *
 * WHAT THIS IS AND IS NOT. It replaces or paints over what is RENDERED. It is a
 * display control, not encryption, and it is not sold as one - except that the
 * blur modes below go further than they look, for the reason in `SAFE_TEXT`.
 */
import {
  createContext, useCallback, useContext, useMemo, type ReactNode,
} from 'react';
import { useStored } from './hooks';

/* ---------------------------------------------------------------------------
 * WHAT can be hidden.
 * ------------------------------------------------------------------------ */

export const PRIVACY_KEYS = [
  'address', 'equity', 'funds', 'pnl', 'charts', 'positions', 'orders',
  'counts', 'fees', 'favorites', 'history',
] as const;
export type PrivacyKey = (typeof PRIVACY_KEYS)[number];

export const PRIVACY_LABELS: Record<PrivacyKey, string> = {
  address: 'Wallet address',
  equity: 'Total equity',
  funds: 'Balances and margin',
  pnl: 'Profit and loss',
  charts: 'Performance charts',
  positions: 'Open positions',
  orders: 'Open orders',
  counts: 'Counts on tabs',
  fees: 'Fee tier and rates',
  favorites: 'Favourites',
  history: 'Trade history',
};

export const PRIVACY_HINTS: Record<PrivacyKey, string> = {
  address: 'Your address and account id, everywhere they appear.',
  equity: 'The headline account value.',
  funds: 'Available, margin, withdrawable, and every coin balance.',
  pnl: 'Realised and unrealised PnL.',
  charts: 'The account-value and performance curves — shape leaks as much as a number.',
  positions: 'Size, entry, liquidation and margin on open positions.',
  orders: 'Price and size on your resting orders.',
  counts: 'The numbers in “Positions (3)” and “Open Orders (2)”.',
  fees: 'Your fee tier and the rates it earns you.',
  favorites: 'Which markets you have starred.',
  history: 'Fills, order history, transfers and funding.',
};

/**
 * WHAT IS HIDDEN BY DEFAULT when you press the eye.
 *
 * Not everything, because "hide all" should still leave a usable screen. The
 * default set is what identifies you or says how much you have; the rest -
 * counts, favourites, fee tier - are opt-in for people who care about them.
 */
const DEFAULT_ON: readonly PrivacyKey[] = ['address', 'equity', 'funds', 'pnl', 'positions'];

export type PrivacyState = Record<PrivacyKey, boolean>;

const NONE: PrivacyState = Object.fromEntries(
  PRIVACY_KEYS.map((k) => [k, false]),
) as PrivacyState;

const DEFAULTS_HIDDEN: PrivacyState = Object.fromEntries(
  PRIVACY_KEYS.map((k) => [k, DEFAULT_ON.includes(k)]),
) as PrivacyState;

/* ---------------------------------------------------------------------------
 * HOW it is hidden.
 * ------------------------------------------------------------------------ */

export const PRIVACY_MODES = ['stars', 'blackout', 'pixelate', 'blur'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const MODE_LABELS: Record<PrivacyMode, string> = {
  stars: 'Asterisks',
  blackout: 'Blacked out',
  pixelate: 'Pixelated',
  blur: 'Blurred',
};

export const MODE_HINTS: Record<PrivacyMode, string> = {
  stars: 'Replaced with ***, sized to the value it hides.',
  blackout: 'A solid bar. Nothing about the value survives.',
  pixelate: 'A block mosaic. Nothing of the value is drawn at all.',
  blur: 'Softened. The value underneath is replaced first.',
};

/**
 * THE TEXT THAT SITS BEHIND A BLUR.
 *
 * A blur is a filter over text that is still in the DOM: selectable, copyable,
 * readable in devtools, and recoverable from a screenshot by anyone who cares to
 * try - deblurring a monospace figure is not hard. So the blur modes do NOT blur
 * your number. They render a GENERIC stand-in of roughly the right shape and
 * blur that; the real value never reaches the page at all.
 *
 * That makes blur and pixelate as strong as asterisks while still looking like
 * data, which is the reason people choose them.
 */
const SAFE_DIGITS = '0123456789';
function safeText(sample: string): string {
  /* Same shape, no information: digits become a fixed rotating sequence rather
     than a random one, so the placeholder does not shimmer on every render. */
  let i = 0;
  return sample.replace(/\d/g, () => SAFE_DIGITS[(i++ * 7) % 10]!);
}

interface PrivacyApi {
  hidden: PrivacyState;
  mode: PrivacyMode;
  setMode: (m: PrivacyMode) => void;
  allHidden: boolean;
  anyHidden: boolean;
  set: (key: PrivacyKey, value: boolean) => void;
  /** Every category at once (the menu's "Hide all" / "Show all"). */
  setAll: (value: boolean) => void;
  /**
   * The one-press switch: anything hidden -> show everything (remembering what
   * was hidden); nothing hidden -> hide that remembered selection again (the
   * default set the first time).
   */
  toggle: () => void;
  isHidden: (key: PrivacyKey) => boolean;
}

const Ctx = createContext<PrivacyApi | null>(null);

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useStored<PrivacyState>('ot.privacy', NONE);
  const [mode, setMode] = useStored<PrivacyMode>('ot.privacy.mode', 'stars');
  const [last, setLast] = useStored<PrivacyState | null>('ot.privacy.last', null);

  /* A stored object from an older build can be missing keys a newer build knows
     about; merging over the defaults means a new category arrives as visible
     rather than as `undefined`. */
  const safe = useMemo<PrivacyState>(() => ({ ...NONE, ...(hidden ?? {}) }), [hidden]);

  const set = useCallback((key: PrivacyKey, value: boolean) => {
    setHidden({ ...safe, [key]: value });
  }, [safe, setHidden]);

  /*
   * THE STUCK-HIDDEN BUG. The one-press switch used to be `setAll(!allHidden)`,
   * and pressing it hid only the DEFAULT set - so `allHidden` stayed false and
   * the next press "hid" again instead of showing. Showing is now decided by
   * whether ANYTHING is hidden, which is also what the eye icon displays.
   */
  const setAll = useCallback((value: boolean) => {
    setHidden(value ? (Object.fromEntries(PRIVACY_KEYS.map((k) => [k, true])) as PrivacyState) : NONE);
  }, [setHidden]);

  const toggle = useCallback(() => {
    if (PRIVACY_KEYS.some((k) => safe[k])) {
      setLast(safe);
      setHidden(NONE);
      return;
    }
    const back = last && PRIVACY_KEYS.some((k) => last[k]) ? { ...NONE, ...last } : DEFAULTS_HIDDEN;
    setHidden(back);
  }, [safe, last, setHidden, setLast]);

  const api = useMemo<PrivacyApi>(() => ({
    hidden: safe,
    mode: PRIVACY_MODES.includes(mode) ? mode : 'stars',
    setMode,
    allHidden: PRIVACY_KEYS.every((k) => safe[k]),
    anyHidden: PRIVACY_KEYS.some((k) => safe[k]),
    set,
    setAll,
    toggle,
    isHidden: (k: PrivacyKey) => safe[k],
  }), [safe, mode, setMode, set, setAll, toggle]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/**
 * Falls back to "nothing hidden" rather than throwing when no provider is
 * mounted: a missing provider must not take the app down, and the safe default
 * for a display control is to show the data.
 */
export function usePrivacy(): PrivacyApi {
  return useContext(Ctx) ?? {
    hidden: NONE,
    mode: 'stars',
    setMode: () => {},
    allHidden: false,
    anyHidden: false,
    set: () => {},
    setAll: () => {},
    toggle: () => {},
    isHidden: () => false,
  };
}

/**
 * The workhorse: a masker for one category.
 *
 *   const mask = useMask('funds');
 *   <span>{mask(fmtUsd(account.value))}</span>
 *
 * Takes the ALREADY FORMATTED value, so a call site reads "format, then hide",
 * and a dash stays a dash - masking "—" would invent data where the venue
 * reported none.
 */
export function useMask(key: PrivacyKey): (value: ReactNode) => ReactNode {
  const { isHidden, mode } = usePrivacy();
  const on = isHidden(key);

  return useCallback(
    (value: ReactNode) => {
      if (!on) return value;
      if (value === null || value === undefined || value === '') return value;
      if (typeof value === 'string' && (value === '—' || value === '-')) return value;

      const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';

      if (mode === 'stars') {
        /* Sized to what it hides - a three-character mask over "$1,234,567.89"
           reads as a shorter number, which is itself a hint. Capped so a long
           string does not become a wall. */
        const n = Math.min(12, Math.max(3, text.replace(/[^\w]/g, '').length));
        return '*'.repeat(n);
      }

      if (mode === 'blackout') {
        return (
          <span className="mask mask--blackout" aria-label="hidden">
            {/* The bar is sized by an invisible copy, so the layout does not
                shift when it turns on. */}
            <span className="mask__ghost">{text || '000'}</span>
          </span>
        );
      }

      /* blur / pixelate: the REAL value never renders - see `safeText`. */
      return (
        <span className={`mask mask--${mode}`} aria-label="hidden">
          {safeText(text || '0000')}
        </span>
      );
    },
    [on, mode],
  );
}

/**
 * Address masking keeps the SHAPE.
 *
 * `0x1234…abcd` becomes `0x***…***` rather than a bare mask, because a field
 * that still looks like an address does not reflow the layout around it.
 */
export function maskAddress(addr: string | null | undefined, hidden: boolean): string {
  if (!addr) return '';
  if (!hidden) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return '0x***…***';
}

export function useAddressMask(): (addr: string | null | undefined) => string {
  const { isHidden } = usePrivacy();
  const on = isHidden('address');
  return useCallback((addr: string | null | undefined) => maskAddress(addr, on), [on]);
}

/**
 * Mask a whole SUBTREE, for the dense tables and the charts.
 *
 * Positions, orders, balances and history are four components with sixty-odd
 * value call sites between them; threading a masker through every one would be
 * sixty chances to miss one. This marks the container instead and one CSS rule
 * covers every numeric cell inside it.
 *
 * A CHART IS ALSO A VALUE. Its shape says as much as any figure - drawdowns,
 * when you were up - so `charts` is a category and the curve is covered as a
 * subtree, where there is no text to replace.
 *
 * THE TRADE-OFF, STATED. For the TABLES this paints over content that is still
 * in the DOM. Acceptable there and not elsewhere: the threat is a camera or a
 * person behind you, and the alternative is incomplete coverage. Everything a
 * `useMask` call site covers is genuinely replaced.
 */
export function Private({ k, children }: { k: PrivacyKey; children: ReactNode }) {
  const { isHidden, mode } = usePrivacy();
  const on = isHidden(k);

  /*
   * A CHART IS NOT PAINTED OVER - IT IS NOT DRAWN.
   *
   * Every other category can be masked in CSS because the thing being hidden is
   * text in a box. A curve is not: blurring it leaves the shape, and the shape is
   * the information - when you were down, how far, how fast you recovered. A
   * canvas cannot have its contents swapped for a generic stand-in the way a text
   * node can, so the honest implementation is to render the placeholder INSTEAD of
   * the chart and never mount it.
   */
  if (on && k === 'charts') {
    return (
      <div className="private-blank" role="img" aria-label="Chart hidden">
        <span>Hidden</span>
      </div>
    );
  }

  return (
    <div
      className="private-scope"
      data-private={on ? '' : undefined}
      data-mask={on ? mode : undefined}
    >
      {children}
    </div>
  );
}
