/**
 * The icon rail down the left edge (from 761px up), after the owner's
 * reference: the mark at the top, level with the navbar, then the tools that
 * are the same on every page in three groups - the market search (raised, the
 * one most reached for), the money (deposit, transfer, withdraw), and the
 * app's own (notifications, settings). The pages themselves are the navbar's
 * links. Below 761px there is no rail and these sit in the navbar again
 * (NavBar.tsx `rail`).
 *
 * Every button carries its name as a tooltip and an accessible name; the
 * notifications and settings menus open to the right of the rail (shell.css).
 */
import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { Notices } from './Notices';
import { SettingsMenu } from './SettingsMenu';
import { requestDeposit, requestTransfer, requestWithdrawFrom } from './account/actions';

export function SideBar({ address, hasLayout, dashLocked, onOpenSearch }: {
  address: string | null;
  hasLayout: boolean;
  dashLocked: boolean;
  onOpenSearch: () => void;
}) {
  return (
    <aside className="side" aria-label="Tools">
      <a className="side__brand" href="/" aria-label="ValueDesk" title="ValueDesk">
        <BrandMark size={28} />
      </a>
      <nav className="side__groups">
        <div className="side__group">
          <SideButton label="Search markets (⌘K)" onClick={onOpenSearch} raised>
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
        <span className="side__sep" aria-hidden="true" />
        <div className="side__group">
          <Notices address={address} />
          <SettingsMenu hasLayout={hasLayout} dashLocked={dashLocked} />
        </div>
      </nav>
    </aside>
  );
}

function SideButton({ label, onClick, raised, children }: { label: string; onClick: () => void; raised?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`side__btn${raised ? ' is-raised' : ''}`} aria-label={label} title={label} onClick={() => onClick()}>
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
