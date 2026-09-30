/**
 * One endpoint that answers "where is this user, and what is the next step?".
 *
 * The flow has four gates and they fail in ways that look similar from the UI
 * (an empty balance, a 401, a reverted transaction), so they are resolved here
 * once, against the authoritative source for each:
 *
 *   1. wallet      - the browser told us an address
 *   2. registered  - the EXCHANGE CONTRACT's getUserId(), not the gateway,
 *                    because the contract is what gates deposits
 *   3. signing key - our own keystore/session
 *   4. funded      - gateway balances on either engine
 *
 * Step 2 is the only one Valuetrade cannot perform itself: `register(address)`
 * on the exchange is owner-gated (it reverts with OwnableUnauthorizedAccount for
 * every caller), there is no public registration endpoint on either the trading
 * gateway or the business API, and across 750 transactions to the exchange there
 * is not a single user-initiated register() call - they all come from SoDEX's
 * own sequencer. So the UI delegates that one step to sodex.com and polls this
 * endpoint until it clears, rather than pretending it can be done here.
 */
import type { FastifyInstance } from 'fastify';
import { sodex } from '../sodex/rest.js';
import { registration, CHAIN, nativeBalance, fromBaseUnits } from '../sodex/chain.js';
import { enginePath, NETWORK } from '../config.js';
import { APIKeyPermission, enabledPermissionNames, permits } from '../signing/actions.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface Step {
  id: string;
  title: string;
  done: boolean;
  blocked: boolean;
  detail: string;
  /** Where the user must go if Valuetrade cannot do this itself. */
  externalUrl?: string;
  action?: string;
}

const num = (v: unknown): number => {
  const n = Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/onboarding', async (req) => {
    const { address } = req.query as { address?: string };
    const hasWallet = Boolean(address && ADDRESS_RE.test(address));
    const session = sodex.sessionInfo();

    const [reg, spot, perps, gas] = hasWallet
      ? await Promise.all([
          registration(address!).catch(() => ({ registered: false, accountId: null })),
          sodex.get<any>(`${enginePath('spot')}/accounts/${address}/state`).catch(() => null),
          sodex.get<any>(`${enginePath('perps')}/accounts/${address}/state`).catch(() => null),
          nativeBalance(address!).catch(() => 0n),
        ])
      : [{ registered: false, accountId: null }, null, null, 0n];

    const spotBalances: any[] = spot?.B ?? [];
    const perpsBalances: any[] = perps?.B ?? [];
    const funded =
      spotBalances.some((b) => num(b?.t ?? b?.total) > 0) ||
      perpsBalances.some((b) => num(b?.t ?? b?.total) > 0) ||
      num(perps?.av) > 0;

    const unlocked = Boolean(session);
    const perms = session?.permissions ?? 0;

    const steps: Step[] = [
      {
        id: 'wallet',
        title: 'Connect a wallet',
        done: hasWallet,
        blocked: false,
        detail: hasWallet
          ? `Connected as ${address}`
          : 'Use a browser extension or pair a phone wallet with WalletConnect.',
        action: hasWallet ? undefined : 'connect',
      },
      {
        id: 'account',
        title: 'SoDEX account',
        done: reg.registered,
        blocked: false,
        detail: reg.registered
          ? `Registered on-chain as account #${reg.accountId}`
          : hasWallet
            ? 'This wallet has no SoDEX account yet. Its first deposit of USDC or SOSO creates it (SoDEX keeps 1 USDC / 1 SOSO as a one-time activation fee) - from another network or from ValueChain, right here.'
            : 'Connect a wallet first.',
        action: hasWallet && !reg.registered ? 'create-account' : undefined,
      },
      {
        id: 'key',
        title: 'Enable trading',
        done: unlocked,
        blocked: false,
        detail: unlocked
          ? `Enabled — you can ${describe(perms).join(', ')}`
          : reg.registered
            ? 'One click and one wallet signature. Valuetrade keeps a dedicated key encrypted on this machine so it can sign your orders; your wallet key is never read.'
            : 'Available once the account exists.',
        action: reg.registered && !unlocked ? 'enable' : undefined,
      },
      {
        id: 'funds',
        title: 'Fund the account',
        done: funded,
        blocked: false,
        detail: funded
          ? 'Balance available to trade.'
          : reg.registered
            ? `Deposit on ${CHAIN.name}. Your wallet holds ${fromBaseUnits(gas as bigint, CHAIN.nativeCurrency.decimals)} ${CHAIN.nativeCurrency.symbol} for gas.`
            : 'Available once the account exists.',
        action: reg.registered && !funded ? 'deposit' : undefined,
      },
    ];

    const firstIncomplete = steps.find((s) => !s.done);
    return {
      network: NETWORK,
      address: hasWallet ? address : null,
      accountId: reg.accountId,
      registered: reg.registered,
      unlocked,
      permissions: perms,
      permissionNames: describe(perms),
      // `perms` is the wire mask: a set bit DISABLES the permission.
      canTrade: unlocked && permits(perms, APIKeyPermission.TRADE),
      canTransfer: unlocked && permits(perms, APIKeyPermission.TRANSFER),
      canWithdraw: unlocked && permits(perms, APIKeyPermission.WITHDRAW),
      funded,
      gasBalance: fromBaseUnits(gas as bigint, CHAIN.nativeCurrency.decimals),
      steps,
      nextStep: firstIncomplete?.id ?? null,
      ready: steps.every((s) => s.done),
    };
  });
}

const describe = enabledPermissionNames;
