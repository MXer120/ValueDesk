/**
 * A single line above the trading screen, shown only when something blocks
 * trading — and nothing at all when it doesn't.
 *
 * This replaced a dedicated "Start" onboarding page. The page made every user
 * pay for the worst case: a first-time visitor needs three things, but a
 * returning one needs none, and landing them on a checklist to read "all done"
 * is pure friction. Same state machine, one line, and it disappears when
 * satisfied.
 *
 * It keeps polling because one step happens off-site (SoDEX account
 * registration), so the bar has to clear itself when the user comes back.
 */
import { api } from '../api';
import { useAsync } from '../hooks';
import type { Eip1193Provider } from '../wallet';

interface Props {
  address: string | null;
  provider: Eip1193Provider | null;
  refreshToken: number;
  onGoToWallet: () => void;
  onGoToMoney: () => void;
}

export function StatusBar({ address, provider, refreshToken, onGoToWallet, onGoToMoney }: Props) {
  const { data } = useAsync(() => api.onboarding(address ?? undefined), [address, refreshToken], {
    pollMs: 6000,
  });

  // Nothing to say: either still loading, or the user is ready to trade.
  if (!data) return null;

  const blocking = data.steps.find((s) => !s.done);
  if (!blocking) return null;

  // Funding is not a blocker — the market data and panels all work without it,
  // and nagging someone who is just looking around is exactly the friction
  // this component exists to remove.
  if (blocking.id === 'funds') return null;

  const kind = blocking.blocked ? 'warn' : 'info';

  return (
    <div className={`banner ${kind}`}>
      <div className="banner-inner">
        <span className="banner-text">{shortMessage(blocking.id, data)}</span>
        <span className="row">
          {blocking.id === 'wallet' && <button onClick={onGoToWallet}>Connect wallet</button>}
          {blocking.id === 'key' && !provider && <button onClick={onGoToWallet}>Reconnect wallet</button>}
          {blocking.id === 'key' && provider && <button onClick={onGoToWallet}>Enable trading</button>}
          {blocking.id === 'account' && (
            <>
              <button onClick={onGoToMoney}>Deposit to get started</button>
              <a href="https://sodex.com" target="_blank" rel="noreferrer" className="muted small">
                or register at sodex.com
              </a>
            </>
          )}
          {data.registered && !data.funded && blocking.id !== 'account' && (
            <button onClick={onGoToMoney}>Deposit</button>
          )}
        </span>
      </div>
    </div>
  );
}

function shortMessage(id: string, data: { accountId: number | null }): string {
  switch (id) {
    case 'wallet':
      return 'Connect a wallet to trade. Market data works without one.';
    case 'account':
      return 'This wallet has no SoDEX account yet. Deposit from any chain to get started — no sodex.com trip needed.';
    case 'key':
      return `Account #${data.accountId} found. One signature enables trading, transfers and withdrawals.`;
    default:
      return '';
  }
}
