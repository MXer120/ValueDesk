/**
 * The routes on chains the runner cannot sign on, planned (pure: plan.ts and the
 * steps both use it): which withdrawal goes where, which is skipped and why, and
 * the checks of chain-withdrawals and manual-deposits.
 */
import { chainLabel, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { chainRank } from './chains';
import { manualDepositCheckId, withdrawCheckId, type CheckArea } from './checks';
import type { RunConfig } from './config';

/** The receiver a chain withdrawal goes to: `receivers.sol`, `receivers.btc`, `receivers.xrp` ... */
export const chainReceiverName = (chainKey: string): string => chainKey.toLowerCase();

export interface ChainWithdrawal {
  coin: CoinConfig;
  route: ChainRoute;
  receiverName: string;
  /** SoDEX's withdrawal minimum there (null: it lists none). What is withdrawn is roundTripAmount() of it and the fee. */
  minimum: string | null;
  /** Why it does not run (null: it runs). */
  skip: string | null;
}

/** Every route on a chain the runner cannot sign on, with what the run does there. */
export function chainWithdrawals(coins: readonly CoinConfig[], cfg: RunConfig): ChainWithdrawal[] {
  const out: ChainWithdrawal[] = [];
  for (const coin of coins) {
    for (const route of coin.chains) {
      if (route.addressKind === 'evm') continue;
      const receiverName = chainReceiverName(route.key);
      let skip: string | null = null;
      if (coin.assetId === null) skip = `${coin.coin} is not tradable on SoDEX`;
      else if (cfg.chainWithdrawals.skip.includes(route.key)) skip = 'in chainWithdrawals.skip';
      else if (route.addressKind === 'other') skip = `the app does not offer ${route.label}`;
      else if (!route.withdraw.allowed) skip = `${coin.coin} withdrawals to ${route.label} are closed on SoDEX right now`;
      else if (!route.withdraw.min) skip = `SoDEX lists no withdrawal minimum for ${coin.coin} on ${route.label}`;
      else if (!cfg.receivers[receiverName]) skip = `receivers.${receiverName} is not set (your own ${route.label} address)`;
      out.push({ coin, route, receiverName, minimum: route.withdraw.min, skip });
    }
  }
  return out.sort((a, b) => chainRank(a.route.key) - chainRank(b.route.key) || a.route.key.localeCompare(b.route.key) || (a.coin.coin === 'USDC' ? -1 : b.coin.coin === 'USDC' ? 1 : a.coin.coin.localeCompare(b.coin.coin)));
}

type Add = (key: string, area: CheckArea, direction: 'deposit' | 'withdraw', coin: string, chain: string, title: string, id: string) => void;

export function declareChainWithdrawalChecks(coins: readonly CoinConfig[], cfg: RunConfig, add: Add): void {
  for (const w of chainWithdrawals(coins, cfg)) {
    add(
      `${w.route.key}#${w.coin.coin}`,
      'withdrawals',
      'withdraw',
      w.coin.coin,
      w.route.key,
      `Withdrawal of ${w.coin.coin} to your own ${w.route.label} address (receivers.${w.receiverName}) is final in SoDEX's record (the arrival cannot be read from here)`,
      withdrawCheckId(w.coin.coin, w.route.key),
    );
  }
}

export function declareManualDepositChecks(cfg: RunConfig, add: Add): void {
  cfg.manualDeposits.forEach((d, i) =>
    add(String(i), 'deposits', 'deposit', d.coin, d.chain, `Deposit of ${d.coin} you send by hand from ${chainLabel(d.chain)} to the verified deposit address is credited to Spot`, manualDepositCheckId(d.coin, d.chain)),
  );
}
