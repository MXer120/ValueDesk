/**
 * The icon rail down the left edge (from 761px up), after the owner's
 * reference: the mark at the top, level with the navbar; the trade page's
 * terminals (Trade, News, and any the user adds - dashboard/terminals.ts), the
 * one on screen raised, and a + for a new one; then the tools that are the same
 * on every page - the market search and Knowledge (the knowledge folders' page;
 * anything dragged onto its button is saved into a folder, folders/QuickDrop.tsx), the
 * money (deposit, transfer, withdraw), the app's own (notifications, settings) -
 * and the wallet at the foot. The pages themselves are the navbar's links.
 * Below 761px there is no rail and the tools sit in the navbar again (NavBar.tsx
 * `rail`).
 *
 * Every button carries its name as a tooltip and an accessible name; the
 * notifications and settings menus open to the right of the rail (shell.css).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { Notices } from './Notices';
import { SettingsMenu } from './SettingsMenu';
import { AddressMenu } from './NavBar';
import { ConnectedWalletLogo } from './funds/ui';
import { usePresence } from './motion';
import { openConnectDialog } from './account/connect';
import { prefetchAccountTotals } from './account/useAccountTotals';
import { WALLET_EVENTS, requestDeposit, requestTransfer, requestWithdrawFrom, useAccountPending } from './account/actions';
import { useAddressMask } from '../privacy';
import { warmWalletModal } from '../walletconnect';
import type { Tab } from '../router';
import { TRADE_DASHBOARD } from '../dashboard/layout';
import { activateTerminal, addTerminal, useTerminals } from '../dashboard/terminals';
import { KnowledgeRailButton } from '../folders/QuickDrop';
import { FOLDER_ICON } from '../folders/icons';

export function SideBar({ address, hasLayout, dashLocked, onOpenSearch, tab, onNavigate }: {
  address: string | null;
  hasLayout: boolean;
  dashLocked: boolean;
  onOpenSearch: () => void;
  /** The page on screen: a terminal is raised only on Trade. */
  tab: Tab | null;
  onNavigate: (tab: Tab) => void;
}) {
  const terminals = useTerminals(TRADE_DASHBOARD);
  const onTrade = tab === 'trade';
  const open = (id: string) => {
    activateTerminal(TRADE_DASHBOARD, id);
    if (!onTrade) onNavigate('trade');
  };
  const add = () => {
    if (!onTrade) onNavigate('trade');
    addTerminal(TRADE_DASHBOARD);
  };
  return (
    <aside className="side" aria-label="Tools">
      <a className="side__brand" href="/" aria-label="ValueDesk" title="ValueDesk">
        <BrandMark size={28} />
      </a>
      <nav className="side__groups">
        {terminals.list.length > 0 && (
          <>
            <div className="side__group" role="group" aria-label="Terminals">
              {terminals.list.map((t) => {
                const on = t.id === terminals.active;
                return (
                  <SideButton
                    key={t.id}
                    label={`${t.name} terminal${on ? ' (open)' : ''}`}
                    onClick={() => open(t.id)}
                    raised={on && onTrade}
                    current={on && !onTrade}
                    pressed={on}
                  >
                    {TERMINAL_ICON[t.icon ?? ''] ?? TERMINAL_ICON.grid}
                  </SideButton>
                );
              })}
              <button type="button" className="side__add" aria-label="New terminal" title="New terminal" onClick={add}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
            <span className="side__sep" aria-hidden="true" />
          </>
        )}
        <div className="side__group">
          <SideButton label="Search markets (⌘K)" onClick={onOpenSearch}>
            <path d="M8.2 15.2a5.4 5.4 0 1 1 3.1-9.8" />
            <circle cx="13" cy="12.6" r="4.6" />
            <path d="M11.6 11.4h2.2M11.6 13.8h2.2" />
          </SideButton>
          <KnowledgeRailButton current={tab === 'knowledge'} onOpen={() => onNavigate('knowledge')}>
            <FOLDER_ICON />
          </KnowledgeRailButton>
        </div>
        <span className="side__sep" aria-hidden="true" />
        <div className="side__group">
          <SideButton label="Deposit" onClick={requestDeposit}>
            <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5" />
            <path d="M3.5 12.5v2.2c0 1 .8 1.8 1.8 1.8h9.4c1 0 1.8-.8 1.8-1.8v-2.2" />
          </SideButton>
          <SideButton label="Transfer between Spot, Futures and EVM" onClick={() => requestTransfer({ from: 'spot', to: 'perps' })}>
            <path d="M6 3.5v13M3 6.5l3-3 3 3M14 16.5v-13M11 13.5l3 3 3-3" />
          </SideButton>
          <SideButton label="Withdraw" onClick={() => requestWithdrawFrom('spot')}>
            <path d="M10 12V3M6.5 6.5 10 3l3.5 3.5" />
            <path d="M3.5 12.5v2.2c0 1 .8 1.8 1.8 1.8h9.4c1 0 1.8-.8 1.8-1.8v-2.2" />
          </SideButton>
        </div>
        <span className="side__sep" aria-hidden="true" />
        <div className="side__group">
          <Notices address={address} />
          <SettingsMenu hasLayout={hasLayout} dashLocked={dashLocked} />
        </div>
      </nav>
      <SideWallet address={address} />
    </aside>
  );
}

/**
 * The wallet, at the foot of the rail: Connect in the app's green while there
 * is none; with one, its logo, which opens the address menu (NavBar.tsx's
 * AddressMenu) beside the rail.
 */
function SideWallet({ address }: { address: string | null }) {
  const [open, setOpen] = useState(false);
  const pres = usePresence(open);
  const pending = useAccountPending();
  const mask = useAddressMask();
  const hasAddress = !!address;
  useEffect(() => {
    if (address) prefetchAccountTotals(address);
  }, [address]);
  // `wallet:menu` (actions.ts goToWallet) opens this menu, or Connect with no address.
  useEffect(() => {
    const onMenu = () => {
      if (hasAddress) setOpen(true);
      else openConnectDialog();
    };
    window.addEventListener(WALLET_EVENTS.menu, onMenu);
    return () => window.removeEventListener(WALLET_EVENTS.menu, onMenu);
  }, [hasAddress]);

  if (!address) {
    return (
      <div className="side__wallet">
        <button
          type="button"
          className="side__btn side__connect"
          aria-label="Connect wallet"
          title="Connect wallet"
          onClick={() => openConnectDialog()}
          onPointerEnter={warmWalletModal}
          onFocus={warmWalletModal}
          disabled={pending === 'connect'}
          aria-busy={pending === 'connect' || undefined}
        >
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="5" width="15" height="11" rx="2.2" />
            <path d="M2.5 8.5h11.5M13.5 12h1.5" />
          </svg>
          <span className="side__connect-t">{pending === 'connect' ? '…' : 'Connect'}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="side__wallet navaddr">
      <button
        type="button"
        className="side__btn side__addr"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Wallet ${mask(address)}`}
        title={mask(address)}
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={() => prefetchAccountTotals(address)}
      >
        <ConnectedWalletLogo size={22} />
      </button>
      {pres.mounted && <AddressMenu address={address} onClose={() => setOpen(false)} closing={pres.closing} onExited={pres.done} />}
    </div>
  );
}

/** The rail's glyph per terminal (TerminalSeed.icon); `grid` for one the user added. */
const TERMINAL_ICON: Record<string, ReactNode> = {
  trade: <><path d="M6.5 3.5v13M13.5 3.5v13" /><rect x="4.5" y="6.5" width="4" height="6.5" rx="1" /><rect x="11.5" y="5.5" width="4" height="5" rx="1" /></>,
  news: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 7.5h8M6 10.5h8M6 13.5h5" /></>,
  grid: <><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.3" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.3" /><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.3" /><rect x="11" y="11" width="5.5" height="5.5" rx="1.3" /></>,
};

function SideButton({ label, onClick, raised, current, pressed, children }: {
  label: string;
  onClick: () => void;
  raised?: boolean;
  /** The terminal that opens on Trade, while another page is on screen. */
  current?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`side__btn${raised ? ' is-raised' : ''}${current ? ' is-current' : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={() => onClick()}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
