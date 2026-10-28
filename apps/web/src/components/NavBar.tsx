/**
 * The one navbar. Every page gets this exact element.
 *
 * It used to be written inline in App.tsx's render, which meant "the navbar"
 * was a shape that existed only as part of a 647-line component and could not
 * be reasoned about, tested, or changed without reading the whole page around
 * it. Per-page differences are PROPS, not branches in a page's own copy: there
 * is one bar, and pages vary its state.
 *
 * WHAT IT DOES NOT OWN. It does not own `dashLocked` or `hasLayout`, and that is
 * not a style preference - it is an effect-ordering requirement. Detecting a
 * dashboard means dispatching `dash:lock:query` and seeing whether anything
 * answers, and React runs a child's effects BEFORE its parent's. This bar renders
 * above the page content, so its own effect would fire before the Dashboard below
 * it had registered a listener, and it would conclude "no layout" every time. The
 * query has to run in the common parent, after both have mounted. See App.tsx.
 *
 * Hierarchy is carried by colour alone: the wordmark and the current page are
 * --text, every other link is --muted, and the active item gets no pill, no box
 * and no underline.
 *
 * WITH THE RAIL (`rail`, from 761px up) the mark and the tool icons live in the
 * icon rail beside it (SideBar.tsx), and the bar is the owner's reference: on
 * Trade a Futures / Spot switch, a divider, then the pages; the wallet at the
 * end. Below 761px there is no rail and the bar carries them again.
 */
import { fmtDecimalString } from '../numStyle';
import type { Engine } from '../api';
import { BrandMark } from './BrandMark';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TABS, TAB_LABELS, pathForTab, type Tab } from '../router';
import { preloadWalletModal, warmWalletModal } from '../walletconnect';
import { Notices } from './Notices';
import { SettingsMenu } from './SettingsMenu';
import { useAddressMask, useMask } from '../privacy';
import { fmtUsd } from '../format';
import {
  WALLET_EVENTS,
  requestDeposit,
  requestSignOut,
  requestTransfer,
  requestWithdrawFrom,
  useAccountPending,
} from './account/actions';
import { CoinIcon } from './CoinIcon';
import { ConnectedWalletLogo } from './funds/ui';
import { Collapse, usePresence } from './motion';
import { openConnectDialog } from './account/connect';
import { prefetchAccountTotals, useAccountTotals } from './account/useAccountTotals';
import { NO_ACCOUNT_TRANSFER, useAccountExists } from './account/useAccountExists';
import { useWalletSnapshot } from './account/useWallet';
import { RegionPill } from '../legal/LegalGate';
import { FOLDER_ICON } from '../folders/icons';
import './account/account.css';

/** `/scan/index.html?address=0x...` - scan.js reads `address` (or `wallet`) off
 *  the URL on load and scans it immediately; with neither, it shows its own
 *  landing screen, which is also the right landing for a bare "Scan" click.
 *
 *  The explicit `index.html` is required, not cosmetic: Vite's dev server (and
 *  most static hosts) resolve a bare `/scan/` to the SPA's root page, not to the
 *  standalone page's index. */
export const scanHref = (address?: string): string =>
  address ? `/scan/index.html?address=${encodeURIComponent(address)}` : '/scan/index.html';

export interface NavBarProps {
  /** The page currently rendered, for the active-link state; null on a page outside the nav (the legal pages). */
  tab: Tab | null;
  /** Push a new page. The bar renders real hrefs, so this only handles the click. */
  onNavigate: (tab: Tab) => void;
  address: string | null;
  /**
   * Does the CURRENT page mount a Dashboard? Drives whether the two layout icons
   * are live or inert. Detected in App.tsx - see the note above.
   */
  hasLayout: boolean;
  /** Mirrors the mounted Dashboard's own `locked`, when there is one. */
  dashLocked: boolean;
  onOpenSearch: () => void;
  /** The icon rail is showing (SideBar.tsx): the mark and the tool icons are there, not here. */
  rail?: boolean;
  /** Futures or spot, for the switch on Trade. */
  engine?: Engine;
  onEngine?: (e: Engine) => void;
  /** Knowledge is on (folders/access.ts): its link and, without the rail, its button. Off, neither exists. */
  knowledge?: boolean;
}

export function NavBar({
  tab, onNavigate, address, hasLayout, dashLocked, onOpenSearch, rail = false, engine, onEngine, knowledge = false,
}: NavBarProps) {
  /*
   * Have the wallet modal's chunk in memory BEFORE the click.
   *
   * AppKit is a large chunk, and a modal that appears a second after the press
   * reads as a button that did not work. It is fetched once the page's own first
   * data is in (walletconnect.ts preloadWalletModal), and at once when the
   * pointer or the focus reaches Connect below - so by the time anyone has
   * chosen a wallet the code is already there.
   */
  useEffect(() => { preloadWalletModal(); }, []);

  /* One shared address masker. This bar had its own copy of `shortAddr`, which
     is exactly how a masked address would have leaked in one place while being
     hidden in another. */
  const maskAddr = useAddressMask();
  const [addrMenu, setAddrMenu] = useState(false);
  const addrPres = usePresence(addrMenu);
  const pending = useAccountPending();
  /* The address book's logo for whichever wallet is connected, left of the address. */
  /* The menu's wallet figures are read as soon as there is an address (and
     again on hover once stale), so opening it rarely waits. */
  useEffect(() => {
    if (address) prefetchAccountTotals(address);
  }, [address]);

  /*
   * `wallet:menu` opens this menu from elsewhere - the status footer's wallet
   * button lands here once there is nothing left to set up (actions.ts:goToWallet).
   * With no address there is no menu to open, so it connects instead.
   */
  const hasAddress = !!address;
  useEffect(() => {
    if (rail) return;
    const onMenu = () => {
      if (hasAddress) setAddrMenu(true);
      else openConnectDialog();
    };
    window.addEventListener(WALLET_EVENTS.menu, onMenu);
    return () => window.removeEventListener(WALLET_EVENTS.menu, onMenu);
  }, [hasAddress, rail]);

  /*
   * The bar's real height as `--navbar-live` on the root. The page scrolls behind
   * the bar (shell.css) and starts that far down, and --navbar-h is the desktop
   * row's 56px only: from 761px to 840px the row is 46px, and it wraps when it
   * runs out of room.
   */
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const put = () => root.style.setProperty('--navbar-live', `${Math.round(el.getBoundingClientRect().height)}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--navbar-live'); };
  }, []);

  return (
    <header ref={bar} className={`navbar${rail ? ' navbar--rail' : ''}`}>
      {/* The bar's ground over the page that scrolls behind it: blur bands under a tint (shell.css). */}
      <div className="navbar__glass" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
      <div className="navbar-inner">
        {!rail && (
          <span className="brand">
            <BrandMark />
            ValueDesk
          </span>
        )}
        {rail && tab === 'trade' && engine && onEngine && (
          <>
            <div className="nav-seg" role="radiogroup" aria-label="Market type">
              {(['perps', 'spot'] as const).map((e) => (
                <button key={e} type="button" role="radio" aria-checked={engine === e} className={engine === e ? 'is-on' : ''} onClick={() => onEngine(e)}>
                  {e === 'perps' ? 'Futures' : 'Spot'}
                </button>
              ))}
            </div>
            <span className="nav-div" aria-hidden="true" />
          </>
        )}
        <nav className="navlinks">
          {TABS.filter((t) => t !== 'knowledge' || knowledge).map((t) => (
            /*
             * A REAL ANCHOR with a real href, not a button.
             *
             * These are addressable pages now, so middle-click, ctrl-click and
             * "copy link address" have to work - a <button> silently drops all
             * three. The click handler routes in-place and preventDefault()s;
             * anything the browser should own (a modified click, or a middle
             * click, which never fires a plain click event) falls through to
             * the href and loads the page for real.
             */
            <a
              key={t}
              href={pathForTab(t)}
              className={`navlink${tab === t ? ' active' : ''}`}
              aria-current={tab === t ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onNavigate(t);
              }}
            >
              {TAB_LABELS[t]}
            </a>
          ))}
        </nav>

        <div className={`navstatus${rail ? ' navstatus--rail' : ''}`}>
          {/*
           * THE NOTIFICATIONS' LANE (owner, 2026-10-25): the toasts and the indexing card dock
           * here, in the bar's empty right side, newest at the right (toast.tsx ToastRail portals
           * into this slot); the bell with its list beside them. Deposits, withdrawals and
           * transfers announce themselves on the wallet button instead (SideBar.tsx).
           */}
          {rail && <div id="vs-notify-slot" className="navnotify" />}
          {/* A restricted (close-only) place: the red pill, always, rail or not (legal/LegalGate.tsx). */}
          <RegionPill address={address} />
          {rail && <Notices address={address} />}
          {/* ONE settings gear: hide mode, and the page layout (lock / edit). In the rail when it shows. */}
          {!rail && (
            <>
              <SettingsMenu hasLayout={hasLayout} dashLocked={dashLocked} />
              <Notices address={address} />
              {knowledge && (
                <button type="button" className="navicon" title="Knowledge" aria-label="Knowledge" onClick={() => onNavigate('knowledge')}>
                  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><FOLDER_ICON /></svg>
                </button>
              )}
              <button
                type="button" className="navicon" title="Search markets (⌘K)"
                aria-label="Search markets" onClick={onOpenSearch}
              >
                <SearchIcon />
              </button>
            </>
          )}
          {/*
            CONNECTED AND DISCONNECTED ARE DIFFERENT CONTROLS.

            With no wallet this is a call to action, and it opens OUR Connect
            dialog (account/ConnectDialog.tsx) - never AppKit directly; AppKit
            appears only after a wallet row in that dialog is pressed.
            With a wallet, the address is an IDENTITY, and pressing it offers
            what you can do with it: copy it, arm trading, the advanced key
            options, drop it.
          */}
          {rail ? null : address ? (
            <div className="navaddr">
              <button
                className="navbtn navaddr__btn"
                aria-haspopup="menu"
                aria-expanded={addrMenu}
                onClick={() => setAddrMenu((v) => !v)}
                onPointerEnter={() => prefetchAccountTotals(address)}
              >
                <ConnectedWalletLogo size={18} className="navaddr__wicon" />
                {maskAddr(address)}
              </button>
              {addrPres.mounted && (
                <AddressMenu address={address} onClose={() => setAddrMenu(false)} closing={addrPres.closing} onExited={addrPres.done} />
              )}
            </div>
          ) : (
            <button
              type="button"
              className="navbtn"
              onClick={() => openConnectDialog()}
              onPointerEnter={warmWalletModal}
              onFocus={warmWalletModal}
              disabled={pending === 'connect'}
              aria-busy={pending === 'connect' || undefined}
            >
              {pending === 'connect' ? 'Opening…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/* Navbar glyphs. Inline, stroked in `currentColor` so they inherit the
 * muted -> text transition the button already carries.
 *
 * 20px viewBoxes in a 24px hit box, and every path is drawn to REACH the edges
 * of that viewBox. The size being matched is the ink, not the box: a 16px box
 * holding a conservatively-inset drawing renders ~13px. The circle radii, the
 * bell's flare and the search handle's end point are all chosen so the stroke's
 * OUTER edge lands within a pixel of the viewBox, which is the whole difference
 * between a 20px icon and a 20px icon that looks 20px.
 *
 * Each one drives a control that actually does something; there is no
 * decorative icon in this bar. */
const SearchIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <circle cx="8.6" cy="8.6" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M13.3 13.3L18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * The connected address's menu, laid out after the owner's reference:
 *
 *   Perps                       label over  (USDC) $1,243.79
 *        [⇅]
 *   Spot               [↑]
 *   EVM                [↓]      collapsed; opens smoothly to the 4 largest holdings + "& N others"
 *   ─────────────────────
 *   Copy Address          ⧉
 *   Sign out              ⇥   (always red)
 *
 * Perps has no action of its own (SoDEX has no route from Perps to a wallet -
 * [⇅] moves it); Spot [↑] is Withdraw; [⇅] the Transfer sheet; EVM [↓] the
 * Deposit sheet. Sign out forgets this browser's trading key, then the wallet.
 * Preferences, API keys and Help are deliberately not here.
 *
 * The actions run in AccountController (mounted once in App.tsx), so the menu
 * closes the moment a row is pressed without cancelling anything.
 */
export function AddressMenu({ address, onClose, closing = false, onExited }: {
  address: string;
  onClose: () => void;
  /** Playing its exit (motion.css) - `onExited` unmounts it. */
  closing?: boolean;
  onExited?: () => void;
}) {
  const wallet = useWalletSnapshot();
  const totals = useAccountTotals(address);
  const noAccount = useAccountExists(address) === false;
  const maskFunds = useMask('funds');
  const [copied, setCopied] = useState(false);
  const [evmOpen, setEvmOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /* The address button is outside the menu but inside .navaddr: a press on it
       is left to its own toggle - closing here first made it reopen at once. */
    const onDown = (e: PointerEvent) => {
      const host = wrap.current?.closest('.navaddr') ?? wrap.current;
      if (!host?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /* Toasts live in this same corner and sit above everything, so while the menu
     is open the stack steps left of it (or, with no room there, hides): a toast
     over the menu swallowed presses on its buttons. */
  useLayoutEffect(() => {
    const root = document.documentElement;
    const left = wrap.current?.getBoundingClientRect().left ?? window.innerWidth;
    const reserve = Math.round(window.innerWidth - left + 8);
    root.style.setProperty('--addr-menu-reserve', `${reserve}px`);
    root.setAttribute('data-addr-menu', left < 380 ? 'narrow' : 'wide');
    return () => {
      root.removeAttribute('data-addr-menu');
      root.style.removeProperty('--addr-menu-reserve');
    };
  }, []);

  /* The menu stays open on copy, and says so for a moment. Closing it is the
     obvious thing to do and the wrong one: the confirmation would unmount in
     the same frame it appeared, so a copy that silently failed would look
     exactly like one that worked. */
  const copy = () => {
    navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  /* Close first, then act: the action opens its own sheet, and this menu must
     not sit on top of it. */
  const run = (fn: () => void) => () => { onClose(); fn(); };

  /* "Live" = this page can ask the wallet to sign right now. An address can be
     remembered from last visit with nothing attached to it. */
  const live = wallet.status === 'connected' && !!wallet.provider;
  const restoring = wallet.status === 'connecting';
  const usd = (v: number | null) => maskFunds(v === null ? '—' : fmtUsd(v));
  // Largest value first, then largest amount; four shown, the rest summed.
  const evmRows = [...(totals.evm ?? [])].sort((a, b) => b.usd - a.usd || Number(b.amount) - Number(a.amount));
  const evmShown = evmRows.slice(0, 4);
  const evmRest = evmRows.slice(4);

  return (
    <div
      className={`navaddr__menu menu-popup acct-menu${closing ? ' is-closing' : ''}`}
      role="menu"
      ref={wrap}
      onAnimationEnd={(e) => { if (closing && e.animationName === 'mo-pop-out') onExited?.(); }}
    >
      {!live && (
        <button
          type="button"
          className="navaddr__item acct-menu__item--accent"
          role="menuitem"
          disabled={restoring}
          onClick={run(openConnectDialog)}
        >
          {restoring ? 'Reconnecting wallet…' : 'Reconnect wallet'}
        </button>
      )}

      <div className="acct-menu__funds">
        <div className="acct-menu__pair">
          <div className="acct-menu__acct">
            <div className="acct-menu__acct-main">
              <span className="acct-menu__acct-k">Futures</span>
              <span className="acct-menu__acct-v"><CoinIcon coin="USDC" size={22} />{usd(totals.perpsUsd)}</span>
            </div>
          </div>
          <button
            type="button"
            className="acct-menu__swap"
            role="menuitem"
            aria-label="Transfer between Spot, Futures and EVM"
            title={noAccount ? NO_ACCOUNT_TRANSFER : 'Transfer'}
            disabled={noAccount}
            onClick={run(() => requestTransfer({ from: 'spot', to: 'perps' }))}
          >
            <SwapIcon />
          </button>
          <div className="acct-menu__acct">
            <div className="acct-menu__acct-main">
              <span className="acct-menu__acct-k">Spot</span>
              <span className="acct-menu__acct-v"><CoinIcon coin="USDC" size={22} />{usd(totals.spotUsd)}</span>
            </div>
            <button
              type="button"
              className="acct-menu__iconbtn"
              role="menuitem"
              aria-label="Withdraw from Spot"
              title="Withdraw"
              onClick={run(() => requestWithdrawFrom('spot'))}
            >
              <UploadIcon />
            </button>
          </div>
        </div>

        <div className={`acct-menu__acct acct-menu__acct--evm${evmOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="acct-menu__acct-main acct-menu__acct-toggle"
            aria-expanded={evmOpen}
            onClick={() => setEvmOpen((v) => !v)}
            title={evmOpen ? 'Hide wallet holdings' : 'Show wallet holdings'}
          >
            <span className="acct-menu__acct-k">EVM <Chevron /></span>
            <span className="acct-menu__acct-v">
              <ConnectedWalletLogo size={22} />{usd(totals.evmUsd)}
              {totals.evmLoading && <span className="acct-menu__spin" role="status" aria-label="Reading the other chains" />}
            </span>
          </button>
          <button
            type="button"
            className="acct-menu__iconbtn"
            role="menuitem"
            aria-label="Deposit"
            title="Deposit"
            onClick={run(requestDeposit)}
          >
            <DownloadIcon />
          </button>
          <Collapse open={evmOpen}>
            <ul className="acct-menu__holdings">
              {totals.evm === null && <li className="acct-menu__holding is-dim">Reading your wallet…</li>}
              {totals.evm !== null && evmRows.length === 0 && <li className="acct-menu__holding is-dim">Nothing on ValueChain or the other EVM chains.</li>}
              {evmShown.map((h) => (
                <li key={`${h.chain}:${h.symbol}`} className="acct-menu__holding">
                  <span className="acct-menu__holding-ic">
                    <CoinIcon coin={h.symbol} size={18} />
                    <CoinIcon chain={h.chain} size={11} className="acct-menu__holding-chain" />
                  </span>
                  <span className="acct-menu__holding-t">
                    {maskFunds(`${fmtAmount(h.amount)} ${h.symbol}`)}
                    <small>{h.chainLabel}</small>
                  </span>
                  <span className="acct-menu__holding-v">{maskFunds(fmtUsd(h.usd))}</span>
                </li>
              ))}
              {evmRest.length > 0 && (
                <li className="acct-menu__holding acct-menu__holding--rest">
                  <span>& {evmRest.length} {evmRest.length === 1 ? 'other' : 'others'}</span>
                  <span className="acct-menu__holding-v">{maskFunds(fmtUsd(evmRest.reduce((sum, h) => sum + h.usd, 0)))}</span>
                </li>
              )}
            </ul>
          </Collapse>
        </div>
      </div>

      <div className="acct-menu__section">
        <button type="button" className="navaddr__item acct-menu__row" role="menuitem" onClick={copy}>
          <span>{copied ? 'Copied' : 'Copy Address'}</span>
          <CopyIcon />
        </button>
        <button type="button" className="navaddr__item acct-menu__row acct-menu__row--out" role="menuitem" onClick={run(requestSignOut)}>
          <span>Sign out</span>
          <SignOutIcon />
        </button>
      </div>
    </div>
  );
}

/** Up to 6 significant decimals, never rounded up: a wallet line, not an order. */
const fmtAmount = (amount: string): string => {
  const [w, f = ''] = amount.split('.');
  const frac = f.slice(0, Number(w) >= 1000 ? 2 : 6).replace(/0+$/, '');
  return fmtDecimalString(frac ? `${w ?? 0}.${frac}` : (w ?? '0'));
};

const glyph = (d: string, size = 16) => () => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
/** Out of the account: an arrow leaving a tray. */
const UploadIcon = glyph('M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v2.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3V10');
/** Into the account: the same tray, arrow turned round. */
const DownloadIcon = glyph('M8 2.5v8M5 7.5l3 3 3-3M2.5 10v2.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3V10');
const SwapIcon = glyph('M5 2.5v11M2.5 5 5 2.5 7.5 5M11 13.5v-11M8.5 11 11 13.5 13.5 11');
const CopyIcon = glyph('M5.5 5.5V3.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3h-1.7M3.8 5.5h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V6.8c0-.7.6-1.3 1.3-1.3Z');
const SignOutIcon = glyph('M6.5 13.5H3.8c-.7 0-1.3-.6-1.3-1.3V3.8c0-.7.6-1.3 1.3-1.3h2.7M10.5 11 13.5 8l-3-3M13.5 8H6');
const Chevron = () => (
  <svg className="acct-menu__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
