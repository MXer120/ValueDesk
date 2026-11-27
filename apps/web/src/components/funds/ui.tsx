/**
 * Small pieces shared by the Deposit, Withdraw and Transfer sheets: a picker
 * with coin/chain icons (our own copies, see logos.ts - the venue's mark when an
 * asset has none), and the handful of line icons the reference sheets use.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../motion';
import { brandLogo } from '../../logos';
import type { FundsStep } from '../../trading/funds';
import { useWalletSnapshot } from '../account/useWallet';
import { CoinIcon } from '../CoinIcon';
import { stepLabel } from './stepLabel';

/** A coin icon, or a chain's with kind="chain" (seed = SoDEX chain key, e.g. BASE_ETH). */
export function Avatar({ seed, size = 20, kind = 'coin' }: { seed: string; size?: number; kind?: 'coin' | 'chain' }) {
  return kind === 'chain'
    ? <CoinIcon chain={seed} size={size} className="fx-av" />
    : <CoinIcon coin={seed} size={size} className="fx-av" />;
}

export interface FxOption {
  value: string;
  label: string;
  /** Icon seed: a coin name, or a chain key with iconKind 'chain'; none = no icon. */
  icon?: string;
  iconKind?: 'coin' | 'chain';
  /** A ready-made icon (a wallet or brand mark), in place of `icon`. */
  iconNode?: ReactNode;
  /** Right-aligned detail in the list (a balance, a time). */
  hint?: string;
  disabled?: boolean;
}

/** Where the open list sits, in viewport pixels (it is portalled to <body>). */
interface ListPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * A dropdown that looks like the reference's token/chain pickers.
 *
 * The list is PORTALLED to <body> and placed against its button: inside a
 * sheet it was clipped by the sheet's own scroll box (`.modal-body` is
 * overflow: auto), so the last options of a chain list were cut off. It opens
 * upwards when there is no room below, never grows past 320px, scrolls, and
 * has a search field on top when there is more than a handful to choose from.
 */
export function FxSelect({ value, options, onChange, label, compact, searchable, searchPlaceholder, loading, trigger, triggerClassName, listMinWidth, listAlign = 'start' }: {
  value: string;
  options: FxOption[];
  onChange: (v: string) => void;
  label: string;
  /** The Withdraw sheet's row style: label left, value right. */
  compact?: boolean;
  /** Search field on top of the list; default: more than 5 options. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Still loading its options: shown with a spinner, not openable. */
  loading?: boolean;
  /** Draws the button's content itself (the chevron is still added) - e.g. one end of the Transfer route. */
  trigger?: (current: FxOption | undefined) => ReactNode;
  triggerClassName?: string;
  /** The list may be wider than a narrow button... */
  listMinWidth?: number;
  /** ...and then lines up with the button's left edge, or its right ('end'). */
  listAlign?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const pres = usePresence(open);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<ListPos | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  const withSearch = searchable ?? options.length > 5;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => `${o.label} ${o.value} ${o.hint ?? ''}`.toLowerCase().includes(q)) : options;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setQuery('');
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    // Closed: keep the last place, so the list can fade out where it was.
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      const gap = 4;
      const edge = 8;
      const below = vh - r.bottom - gap - edge;
      const above = r.top - gap - edge;
      const up = below < 220 && above > below;
      const maxHeight = Math.max(140, Math.min(320, up ? above : below));
      const width = Math.max(r.width, listMinWidth ?? 0);
      const left = Math.max(edge, Math.min(listAlign === 'end' ? r.right - width : r.left, window.innerWidth - width - edge));
      setPos(up
        ? { left, width, bottom: vh - r.top + gap, maxHeight }
        : { left, width, top: r.bottom + gap, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, listMinWidth, listAlign]);

  useEffect(() => {
    if (!open) return;
    // The list lives in <body>, so a press inside EITHER box is inside.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    // Escape closes the list, not the sheet around it: Modal listens on
    // document in the capture phase, and window's capture phase runs first.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // Start on the chosen option; after typing, on the first match.
  useEffect(() => {
    if (!open) return;
    const i = shown.findIndex((o) => o.value === value);
    setActive(q ? 0 : Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed && withSearch) searchRef.current?.focus({ preventScroll: true });
  }, [open, placed, withSearch]);
  useEffect(() => {
    if (open) listRef.current?.querySelector('.fx-opt-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: FxOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  };
  const onNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Tab' && open) {
      close();
    }
  };

  return (
    <div className={`fx-selwrap${compact ? ' fx-selwrap--row' : ''}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName ?? (compact ? 'fx-row fx-row--btn' : 'fx-sel')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}: ${current?.label ?? 'none'}`}
        aria-busy={loading || undefined}
        onClick={() => (loading ? undefined : open ? close() : setOpen(true))}
        onKeyDown={(e) => { if (!loading) onNavKey(e); }}
      >
        {trigger ? trigger(current) : (
          <>
            {compact && <span className="fx-row__k">{label}</span>}
            <span className="fx-sel__v">
              {current?.iconNode ?? (current?.icon && <Avatar seed={current.icon} kind={current.iconKind} />)}
              <span data-no-i18n={current?.iconKind === 'chain' ? '' : undefined}>{current?.label ?? '—'}</span>
            </span>
          </>
        )}
        {loading ? <Spinner /> : <Chevron />}
      </button>
      {pres.mounted && pos && createPortal(
        <div
          ref={listRef}
          className={`fx-list${pres.closing ? ' is-closing' : ''}`}
          onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
        >
          {withSearch && (
            <div className="fx-search">
              <SearchIcon />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onNavKey}
                placeholder={searchPlaceholder ?? 'Search'}
                aria-label={`Search ${label}`}
                aria-controls={listId}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          <ul className="fx-list__ul" role="listbox" id={listId} aria-label={label}>
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={`fx-opt-row${i === active ? ' is-active' : ''}${o.disabled ? ' is-off' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
              >
                {o.iconNode ?? (o.icon && <Avatar seed={o.icon} kind={o.iconKind} />)}
                {/* A chain is a name ("Base" is not "Basis"): the translation layer leaves it. */}
                <span className="fx-opt-row__l" data-no-i18n={o.iconKind === 'chain' ? '' : undefined}>{o.label}</span>
                {o.hint && <span className="fx-opt-row__h">{o.hint}</span>}
              </li>
            ))}
            {shown.length === 0 && <li className="fx-opt-empty">No match for "{query.trim()}"</li>}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}

export const SearchIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const Chevron = () => (
  <svg className="fx-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const WalletIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3 9.5h18" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="16.5" cy="14" r="1.2" fill="currentColor" />
  </svg>
);

export const QrIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
    </g>
    <path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z" fill="currentColor" />
  </svg>
);

export const CopyIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="5" y="5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const Arrow = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Info = ({ title }: { title: string }) => (
  <span className="fx-i" title={title} aria-label={title} role="img">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.1v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
    </svg>
  </span>
);

/* The address-book match (addrbook/walletLogo.ts) needs the whole catalogue: loaded the first time a fallback is wanted. */
type WalletLogoFor = (name: string | null | undefined) => string | null;
let walletLogoFor: WalletLogoFor | null = null;
let loadingWalletLogos: Promise<WalletLogoFor> | null = null;
const loadWalletLogos = (): Promise<WalletLogoFor> =>
  (loadingWalletLogos ??= import('./addrbook/walletLogo').then(
    (m) => (walletLogoFor = m.walletLogoForName),
    (e: unknown) => {
      loadingWalletLogos = null;
      throw e;
    },
  ));

/** The address book's logo for this wallet name while `wanted`; null until the catalogue is in (a moment, once). */
function useWalletLogoFallback(name: string, wanted: boolean): string | null {
  const [, loaded] = useState(0);
  useEffect(() => {
    if (!wanted || !name.trim() || walletLogoFor) return;
    let live = true;
    loadWalletLogos().then(() => { if (live) loaded((n) => n + 1); }, () => {});
    return () => { live = false; };
  }, [wanted, name]);
  return wanted && walletLogoFor ? walletLogoFor(name) : null;
}

/**
 * The icon the connected wallet announced. The address-book logo is only used
 * when the wallet did not provide one, or that image failed to load.
 */
export function ConnectedWalletLogo({ size = 18, className = '' }: { size?: number; className?: string }) {
  const wallet = useWalletSnapshot();
  const [remoteOk, setRemoteOk] = useState(true);
  const local = useWalletLogoFallback(wallet.walletName, !(remoteOk && wallet.walletIcon));
  useEffect(() => setRemoteOk(true), [wallet.walletIcon, wallet.walletName]);
  const src = (remoteOk && wallet.walletIcon) || local || '';
  if (!src) return <WalletIcon />;
  return (
    <img
      className={`wmark ${className}`}
      src={src}
      alt={wallet.walletName || ''}
      width={size}
      height={size}
      draggable={false}
      onError={() => { if (src === wallet.walletIcon) setRemoteOk(false); }}
    />
  );
}

/** The wallet app's own icon, with a small SOSO mark: the EVM account is the wallet on ValueChain. */
export function WalletMark({ size = 22 }: { size?: number }) {
  return (
    <span className="fx-wmark" style={{ width: size, height: size }} aria-hidden="true">
      <ConnectedWalletLogo size={size} />
      <CoinIcon coin="SOSO" size={Math.round(size * 0.55)} className="fx-wmark__badge" />
    </span>
  );
}

/** SoDEX's own mark (Spot and Perps). */
export function SodexMark({ size = 20 }: { size?: number }) {
  const src = brandLogo('SODEX');
  return src ? <img className="fx-av fx-brand" src={src} alt="" width={size} height={size} /> : <Avatar seed="SoDEX" size={size} />;
}

/** The busy button's words for the connected wallet (stepLabel.ts); `null` = "Confirming…". */
export function useStepLabel(): (step: FundsStep | null) => string {
  const wallet = useWalletSnapshot();
  return (step) => stepLabel(step, wallet);
}

/** The one wallet prompt of enabling trading. */
export const ONE_CONFIRM: FundsStep = { wallet: 'confirm', n: 1, of: 1 };

/** A small spinner for one value that is still loading. */
export const Spinner = ({ label = 'Loading' }: { label?: string }) => <span className="fx-spin" role="status" aria-label={label} />;

/** One label line: text left, optional aside right. */
export const Label = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="fx-lbl">
    <span>{children}</span>
    {aside && <span className="fx-lbl__aside">{aside}</span>}
  </div>
);

/** 0x1234…abcd */
export const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/**
 * What an "Enable trading" button says while the wallet is asking: a spinner,
 * "Please approve on mobile" with a phone (a wallet paired over WalletConnect)
 * or "Please approve in browser" with a browser window (an extension) - where
 * the prompt actually is, as chosen when connecting.
 */
export function ApproveLabel() {
  const w = useWalletSnapshot();
  const mobile = w.kind === 'walletconnect';
  return (
    <span className="fx-approve">
      <Spinner label="Waiting for your wallet" />
      <span>Please approve {mobile ? 'on mobile' : 'in browser'}</span>
      {mobile ? <PhoneGlyph /> : <BrowserGlyph />}
    </span>
  );
}
const PhoneGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M7 12.3h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const BrowserGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1.5 5.6h13" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="3.6" cy="4.05" r="0.55" fill="currentColor" />
    <circle cx="5.3" cy="4.05" r="0.55" fill="currentColor" />
  </svg>
);
