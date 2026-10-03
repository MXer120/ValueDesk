/**
 * The routes on chains the runner cannot sign on, planned (pure: plan.ts and the
 * steps both use it): which withdrawal goes where, which is skipped and why, and
 * the checks of chain-withdrawals and manual-deposits.
 */
import { chainLabel, type ChainRoute, type CoinConfig } from '../../src/trading/funds';
import { chainRank } from './chains';
import { depositCheckId, manualDepositCheckId, withdrawCheckId, type CheckArea } from './checks';
import type { RunConfig } from './config';
import { NATIVE_CHAIN_KEYS } from './native/types';

/** The receiver a chain withdrawal goes to: `receivers.sol`, `receivers.btc`, `receivers.xrp` ... */
export const chainReceiverName = (chainKey: string): string => chainKey.toLowerCase();

export interface ChainWithdrawal {
  coin: CoinConfig;
  route: ChainRoute;
  /**
   * Where the withdrawal goes. A chain the runner signs on (native/*.ts): `native:<chain key>`, the TEST wallet's
   * own address there - and the run sends the coin BACK to SoDEX from it (a round trip: withdrawal and deposit
   * tested). Any other: `receivers.<chain key in lower case>`, the owner's own address (a withdrawal only).
   */
  receiverName: string;
  /** The run signs on this chain itself: the deposit back runs too. */
  roundTrip: boolean;
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
      const roundTrip = NATIVE_CHAIN_KEYS.has(route.key);
      const receiverName = roundTrip ? `native:${route.key}` : chainReceiverName(route.key);
      let skip: string | null = null;
      // TON: SoDEX lists it, but its only market (vTON_vUSDC) is halted - what is deposited cannot be traded. The app does not offer it.
      if (route.key === 'TON') skip = 'SoDEX has no market for TON (its only one is halted): the app does not offer TON';
      else if (coin.assetId === null) skip = `${coin.coin} is not tradable on SoDEX`;
      else if (cfg.chainWithdrawals.skip.includes(route.key)) skip = 'in chainWithdrawals.skip';
      else if (route.addressKind === 'other') skip = `the app does not offer ${route.label}`;
      else if (!route.withdraw.allowed) skip = `${coin.coin} withdrawals to ${route.label} are closed on SoDEX right now`;
      else if (!route.withdraw.min) skip = `SoDEX lists no withdrawal minimum for ${coin.coin} on ${route.label}`;
      else if (!roundTrip && !cfg.receivers[receiverName]) skip = `receivers.${receiverName} is not set (your own ${route.label} address)`;
      out.push({ coin, route, receiverName, roundTrip, minimum: route.withdraw.min, skip });
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
      w.roundTrip
        ? `Withdrawal of ${w.coin.coin} to the test wallet's own ${w.route.label} address (the same key) arrives there and SoDEX's record is final`
        : `Withdrawal of ${w.coin.coin} to your own ${w.route.label} address (receivers.${w.receiverName}) is final in SoDEX's record (the arrival cannot be read from here)`,
      withdrawCheckId(w.coin.coin, w.route.key),
    );
    if (w.roundTrip) {
      add(
        `${w.route.key}#${w.coin.coin}#deposit`,
        'deposits',
        'deposit',
        w.coin.coin,
        w.route.key,
        `Deposit of ${w.coin.coin} from the test wallet's own ${w.route.label} address (signed by the runner - DIRECT) to the wallet's verified SoDEX deposit address is credited to Spot`,
        depositCheckId(w.coin.coin, w.route.key),
      );
    }
  }
}

export function declareManualDepositChecks(cfg: RunConfig, add: Add): void {
  cfg.manualDeposits.forEach((d, i) =>
    add(String(i), 'deposits', 'deposit', d.coin, d.chain, `Deposit of ${d.coin} you send by hand from ${chainLabel(d.chain)} to the verified deposit address is credited to Spot`, manualDepositCheckId(d.coin, d.chain)),
  );
}
