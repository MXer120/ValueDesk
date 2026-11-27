/**
 * The connected address's menu (the navbar's address button, the rail's wallet button): moved out of NavBar.tsx
 * unchanged (2026-11-18) so that its figures - useAccountTotals, the wallet's balances on every chain, the prices -
 * load only for a page with a wallet, not in every page's first render. addressMenuLazy.ts loads it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWalletSnapshot } from './useWallet';
import { useAccountTotals } from './useAccountTotals';
import { NO_ACCOUNT_TRANSFER, useAccountExists } from './useAccountExists';
import { openConnectDialog } from './connect';
import { requestDeposit, requestSignOut, requestTransfer, requestWithdrawFrom } from './actions';
import { DepositIcon, TransferIcon, WithdrawIcon } from './moneyIcons';
import { useMask } from '../../privacy';
import { fmtUsd } from '../../format';
import { fmtDecimalString } from '../../numStyle';
import { CoinIcon } from '../CoinIcon';
import { ConnectedWalletLogo } from '../funds/ui';
import { Collapse } from '../motion';
import { Identicon } from '../Identicon';
import { useUsername } from '../../onboarding/profile';
import { useSettingsBadge } from '../SettingsMenu';
import { PrefsIcon } from '../PrefsIcon';
import { openSettings } from '../../settingsBus';
import { FEEDBACK_LABEL, FeedbackIcon, openFeedback } from '../../feedback/FeedbackButton';
import './account.css';

/**
 * The menu, laid out after the owner's reference:
 *
 *   Perps                       label over  (USDC) $1,243.79
 *        [⇅]
 *   Spot               [↑]
 *   EVM                [↓]      collapsed; opens smoothly to the 4 largest holdings + "& N others"
 *   ─────────────────────
 *   Portfolio             ▦
 *   Copy Address          ⧉
 *   Send feedback         💬   (after Copy Address: owner 2026-10-31)
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
export function AddressMenu({ address, onClose, closing = false, onExited, onPortfolio }: {
  address: string;
  onClose: () => void;
  /** The Portfolio page (owner 2026-10-31: from the wallet menu too). */
  onPortfolio: () => void;
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
  const username = useUsername(address);
  const badge = useSettingsBadge(address);
  const restoring = wallet.status === 'connecting';
  const usd = (v: number | null) => maskFunds(v === null ? '—' : fmtUsd(v));
  // Largest value first, then largest amount; four shown, the rest summed.
  const evmRows = [...(totals.evm ?? [])].sort((a, b) => b.usd - a.usd || Number(b.amount) - Number(a.amount));
  const evmShown = evmRows.slice(0, 4);
  const evmRest = evmRows.slice(4);

  return (
    <div
      className={`navaddr__menu menu-popup acct-menu navpop${closing ? ' is-closing' : ''}`}
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
            <TransferIcon />
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
              <WithdrawIcon />
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
            <DepositIcon />
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
        {username ? (
          <div className="acct-menu__who" title="Your username. It can't be changed."><Identicon seed={address} size={18} /><b>{username}</b></div>
        ) : null}
        <button type="button" className="navaddr__item acct-menu__row" role="menuitem" onClick={run(onPortfolio)}>
          <span>Portfolio</span>
          <PortfolioIcon />
        </button>
        <button type="button" className="navaddr__item acct-menu__row" role="menuitem" onClick={copy}>
          <span>{copied ? 'Copied' : 'Copy Address'}</span>
          <CopyIcon />
        </button>
        <button
          type="button"
          className="navaddr__item acct-menu__row"
          role="menuitem"
          title={badge.profile ? 'Settings - your profile' : badge.anyHidden ? 'Settings - some of your data is hidden' : undefined}
          onClick={run(() => openSettings('profile'))}
        >
          <span>Settings</span>
          <span className="acct-menu__rowic">
            <PrefsIcon size={16} />
            {badge.profile ? <span className="settings__dot settings__dot--go" aria-hidden="true" /> : badge.anyHidden && <span className="settings__dot" aria-hidden="true" />}
          </span>
        </button>
        <button type="button" className="navaddr__item acct-menu__row" role="menuitem" onClick={run(() => openFeedback())}>
          <span>{FEEDBACK_LABEL}</span>
          <FeedbackIcon />
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
const CopyIcon = glyph('M5.5 5.5V3.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3h-1.7M3.8 5.5h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V6.8c0-.7.6-1.3 1.3-1.3Z');
/** Portfolio: a small bar chart. */
const PortfolioIcon = glyph('M2.5 13.5h11M4.5 11V7.5M8 11V4.5M11.5 11V8');
const SignOutIcon = glyph('M6.5 13.5H3.8c-.7 0-1.3-.6-1.3-1.3V3.8c0-.7.6-1.3 1.3-1.3h2.7M10.5 11 13.5 8l-3-3M13.5 8H6');
const Chevron = () => (
  <svg className="acct-menu__chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
