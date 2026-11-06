/**
 * The icon rail down the left edge (from 761px up), after the owner's
 * reference: the mark at the top, level with the navbar; the trade page's
 * terminals (Trade, News, and any the user adds - dashboard/terminals.ts), the
 * one on screen raised, and a + for a new one; then the tools that are the same
 * on every page - the market search, the
 * money (deposit, transfer, withdraw) - and the wallet at the foot, whose menu holds Settings. The pages themselves are the navbar's links.
 * Below 761px there is no rail and the tools sit in the navbar again (NavBar.tsx
 * `rail`).
 *
 * Every button carries its name as a tooltip and an accessible name.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { SettingsMenu, useSettingsBadge } from './SettingsMenu';
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
import { activateTerminal, addTerminal, openLayouts, removeTerminal, restoreTerminal, setTerminalOff, useTerminals } from '../dashboard/terminals';
import { historyLabel } from '../dashboard/storage';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../dashboard/tabExtras';
import { useMoneyNotice } from './funds/moneyNotice';

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
  // A terminal's right-click menu (`id`), or the + button's (null): hide, delete, and what can come back.
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string | null } | null>(null);
  const onMenu = (id: string | null) => (e: MouseEvent) => setMenu({ at: menuAt(e), id });
  const menuItems = (id: string | null): TabMenuItem[] => {
    const t = id ? terminals.list.find((x) => x.id === id) : undefined;
    const back: TabMenuItem[] = [
      ...terminals.hidden.slice(0, 5).map((h) => ({ label: `Show ${h.name}`, icon: MENU_ICONS.show, onClick: () => setTerminalOff(TRADE_DASHBOARD, h.id, false) })),
      ...terminals.history.slice(0, 5).map((h) => ({
        label: `Restore ${h.name} (${historyLabel(h.why, h.at).toLowerCase()})`,
        icon: MENU_ICONS.reset,
        onClick: () => { restoreTerminal(TRADE_DASHBOARD, h.id); if (!onTrade) onNavigate('trade'); },
      })),
      { label: 'All previous layouts…', icon: MENU_ICONS.edit, onClick: () => { openLayouts(); if (!onTrade) onNavigate('trade'); } },
    ];
    back[0] = { ...back[0]!, sep: true };
    if (!t) return [{ label: 'New terminal', icon: MENU_ICONS.add, onClick: add }, ...back];
    return [
      { label: 'Open', icon: MENU_ICONS.open, onClick: () => open(t.id) },
      { label: 'Hide from sidebar', icon: MENU_ICONS.hide, disabled: terminals.list.length <= 1, onClick: () => setTerminalOff(TRADE_DASHBOARD, t.id, true) },
      ...back,
      { label: `Delete ${t.name}`, icon: MENU_ICONS.remove, danger: true, onClick: () => removeTerminal(TRADE_DASHBOARD, t.id) },
    ];
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
                    onContextMenu={onMenu(t.id)}
                    raised={on && onTrade}
                    current={on && !onTrade}
                    pressed={on}
                  >
                    {TERMINAL_ICON[t.icon ?? ''] ?? TERMINAL_ICON.grid}
                  </SideButton>
                );
              })}
              <button type="button" className="side__add" aria-label="New terminal" title="New terminal (right-click: hidden and previous layouts)" onClick={add} onContextMenu={onMenu(null)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
              {menu && <TabMenu at={menu.at} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
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
      </nav>
      <SettingsMenu hasLayout={hasLayout} dashLocked={dashLocked} address={address} trigger={false} />
      <SideWallet address={address} onPortfolio={() => onNavigate('portfolio')} />
    </aside>
  );
}

/**
 * The wallet, at the foot of the rail: Connect in the app's green while there
 * is none; with one, its logo, which opens the address menu (NavBar.tsx's
 * AddressMenu) beside the rail.
 */
function SideWallet({ address, onPortfolio }: { address: string | null; onPortfolio: () => void }) {
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

  const money = useMoneyNotice();
  const badge = useSettingsBadge(address);
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
    <div className={`side__wallet navaddr${money ? ' is-money' : ''}`}>
      {/* Money in and out widens out of the wallet logo and says it (funds/moneyNotice.ts). */}
      {money && (
        <div key={money.text} className={`side__money is-${money.status}`} role="status" aria-live="polite">
          <span className={`side__money-ic is-${money.kind}`} aria-hidden="true">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {money.kind === 'deposit' ? <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M3.5 15.5h13" /> : money.kind === 'withdraw' ? <path d="M10 12V3M6.5 6.5 10 3l3.5 3.5M3.5 15.5h13" /> : <path d="M6 3.5v13M3 6.5l3-3 3 3M14 16.5v-13M11 13.5l3 3 3-3" />}
            </svg>
          </span>
          <span className="side__money-t">{money.text}</span>
        </div>
      )}
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
        {/* Settings live in this menu now, so the wallet carries their "your profile is waiting". */}
        {badge.profile && <span className="settings__dot settings__dot--go" aria-hidden="true" />}
      </button>
      {pres.mounted && <AddressMenu address={address} onClose={() => setOpen(false)} closing={pres.closing} onExited={pres.done} onPortfolio={onPortfolio} />}
    </div>
  );
}

/** The rail's glyph per terminal (TerminalSeed.icon); `grid` for one the user added. */
const TERMINAL_ICON: Record<string, ReactNode> = {
  trade: <><path d="M6.5 3.5v13M13.5 3.5v13" /><rect x="4.5" y="6.5" width="4" height="6.5" rx="1" /><rect x="11.5" y="5.5" width="4" height="5" rx="1" /></>,
  news: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 7.5h8M6 10.5h8M6 13.5h5" /></>,
  grid: <><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.3" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.3" /><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.3" /><rect x="11" y="11" width="5.5" height="5.5" rx="1.3" /></>,
};

function SideButton({ label, onClick, onContextMenu, raised, current, pressed, children }: {
  label: string;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
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
      onContextMenu={onContextMenu}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
