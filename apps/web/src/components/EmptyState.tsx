/**
 * An empty panel, after the owner's reference: a quiet icon, a title in the
 * text colour, one muted line under it, and an action when there is one to
 * take (Connect for a missing wallet). The words come from the caller or from
 * emptyCopy.ts.
 */
import type { ReactNode } from 'react';
import type { EmptyIcon } from './emptyCopy';
import { openConnectDialog } from './account/connect';
import './EmptyState.css';

const PATHS: Record<EmptyIcon, ReactNode> = {
  positions: <path d="M3 15.5 8 10.5l3 3 6-6M13.5 7.5H17V11" />,
  orders: <path d="M6.5 5.5h10M6.5 10h10M6.5 14.5h10M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" />,
  history: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.6" /></>,
  wallet: <><rect x="3" y="5" width="14" height="11" rx="2" /><path d="M3 8h11.5M13.5 11.5h1" /></>,
  coins: <><ellipse cx="10" cy="6" rx="5.5" ry="2.5" /><path d="M4.5 6v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V6M4.5 10v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4" /></>,
  funding: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5v7M12 8.2c-.4-.7-1.1-1-2-1-1.1 0-2 .6-2 1.4 0 1.9 4 1 4 2.9 0 .8-.9 1.4-2 1.4-.9 0-1.7-.4-2.1-1.1" /></>,
  transfers: <path d="M5 7h10.5M12.5 4l3 3-3 3M15 13H4.5M7.5 10l-3 3 3 3" />,
  search: <><circle cx="9" cy="9" r="5" /><path d="m13 13 3.5 3.5" /></>,
  news: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 8h8M6 11h8M6 14h5" /></>,
  chart: <path d="M3.5 16.5h13M5.5 13V9M9 13V5.5M12.5 13v-5M16 13V7" />,
};

/**
 * No wallet is connected: the empty state with Connect, for a dialog or panel
 * that needs one ("Connect a wallet to withdraw.").
 */
export function NoWallet({ line, compact }: { line: string; compact?: boolean }) {
  return (
    <EmptyState
      icon="wallet"
      title="No wallet connected"
      line={line}
      compact={compact}
      action={<button type="button" className="empty-state__cta" onClick={() => openConnectDialog()}>Connect wallet</button>}
    />
  );
}

export function EmptyState({ icon, title, line, action, compact }: {
  icon: EmptyIcon;
  title: string;
  line?: ReactNode;
  action?: ReactNode;
  /** A short panel: less space above. */
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' empty-state--compact' : ''}`} role="status">
      <span className="empty-state__ic" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{PATHS[icon]}</svg>
      </span>
      <b className="empty-state__t">{title}</b>
      {line && <span className="empty-state__d">{line}</span>}
      {action && <span className="empty-state__act">{action}</span>}
    </div>
  );
}
