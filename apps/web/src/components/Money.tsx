/**
 * Money movement: balances, and the Deposit / Withdraw / Transfer sheets
 * (funds/DepositModal.tsx, funds/WithdrawModal.tsx, funds/TransferModal.tsx).
 *
 * Transfers and withdrawals are signed in this browser by the trading key
 * (trading/actions.ts) from inside those sheets. Per SoDEX's docs that key can
 * move funds only between the owner's own spot account, perps account and own
 * wallet: a withdrawal is paid to the owner's address, which is fixed on-chain
 * and is not a parameter of the request. Transfers to OTHER accounts are
 * documented by SoDEX as not supported yet, so there is no control for them.
 */
import { api, type SessionInfo } from '../api';
import {
  requestAdvanced,
  requestDeposit,
  requestDisableTrading,
  requestEnableTrading,
  requestTransfer,
  requestWithdraw,
} from './account/actions';
import type { Eip1193Provider } from '../wallet';
import { useAsync } from '../hooks';
import { fmt, pick } from '../format';
import { CoinLabel } from './CoinIcon';
import { NO_ACCOUNT_TRANSFER, useAccountExists } from './account/useAccountExists';

export function Money({
  address, session, refreshToken,
}: {
  address: string | null;
  session: SessionInfo | null;
  provider: Eip1193Provider | null;
  refreshToken: number;
  onChanged: () => void;
}) {
  const { data: overview } = useAsync(
    () => api.moneyOverview(address!),
    [address, refreshToken],
    { enabled: !!address, pollMs: 30_000 },
  );

  const unlocked = session?.unlocked ?? false;
  const noAccount = useAccountExists(address) === false;

  const balanceRows = (side: 'spot' | 'perps') => {
    const raw = overview?.[side];
    const list = Array.isArray(raw) ? raw : (raw?.balances ?? []);
    return Array.isArray(list) ? list : [];
  };

  return (
    <section className="panel">
      <h2>Money</h2>

      {!address && <p className="muted">Connect a wallet.</p>}

      {address && (
        <>
          <div className="row wrap balancecols">
            {(['spot', 'perps'] as const).map((side) => (
              <div key={side}>
                <h3>{side}</h3>
                <table className="datatable">
                  <thead><tr><th>Asset</th><th>Total</th><th>Locked</th></tr></thead>
                  <tbody>
                    {balanceRows(side).length === 0 && <tr><td colSpan={3} className="muted">-</td></tr>}
                    {balanceRows(side).map((b: any, i: number) => {
                      const coin = pick<string>(b, 'coin', 'a', 'name');
                      return (
                        <tr key={i}>
                          <td>{coin ? <CoinLabel coin={coin}>{coin}</CoinLabel> : '-'}</td>
                          <td>{fmt(pick(b, 'total', 't'), 6)}</td>
                          <td>{fmt(pick(b, 'locked', 'l'), 6)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <div className="row wrap">
            <button type="button" className="btn-primary" onClick={requestDeposit}>Deposit</button>
            <button type="button" onClick={() => requestWithdraw()}>Withdraw</button>
            <button type="button" onClick={() => requestTransfer()} disabled={noAccount} title={noAccount ? NO_ACCOUNT_TRANSFER : undefined}>Transfer</button>
          </div>

          <p className="status info">
            {unlocked
              ? 'Transfers and withdrawals are signed in this browser with your trading key. SoDEX pays withdrawals only to your own wallet.'
              : 'Enable trading to move funds between your spot and perps accounts or withdraw to your wallet.'}
          </p>

          {/* The trading key's own controls live here, not in the address menu
              (which follows the owner's reference: balances, copy, invite, sign out). */}
          <div className="row wrap">
            <span className="muted">Trading key: {unlocked ? 'enabled in this browser' : 'not enabled'}</span>
            {unlocked
              ? <button type="button" onClick={requestDisableTrading}>Turn off trading</button>
              : <button type="button" onClick={requestEnableTrading}>Enable trading</button>}
            <button type="button" onClick={requestAdvanced}>Key options…</button>
          </div>
        </>
      )}
    </section>
  );
}
