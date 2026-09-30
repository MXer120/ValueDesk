/**
 * Money movement: internal transfers, cross-engine moves, and withdrawal.
 *
 * Deposits are on-chain and live in routes/deposit.ts.
 *
 * SECURITY MODEL. The key this process holds at rest is trade-only (wire mask
 * 14 - a set bit DISABLES a permission), so per SoDEX's docs the exchange
 * rejects any money movement signed with it, even if this machine is fully
 * compromised. That is documented, not yet observed - see
 * docs/PERMISSION-MASK.md. Every route below therefore runs in two steps:
 *
 *   1. POST /api/money/elevate          -> returns EIP-712 for the user's wallet
 *      POST /api/money/elevate/complete -> arms a single-use, in-memory,
 *                                          3-minute key scoped to just this op
 *   2. the operation itself, which consumes that key and revokes it
 *
 * The elevation is bound to the exact parameters shown to the user before they
 * signed (see elevation.ts, ElevationIntent), so a caller that races the window
 * cannot redirect a transfer or change its amount.
 */
import type { FastifyInstance } from 'fastify';
import { sodex, unwrapList } from '../sodex/rest.js';
import { ALLOW_MAINNET_WRITES, NETWORK, enginePath, type Engine } from '../config.js';
import * as A from '../signing/actions.js';
import { coins } from '../sodex/symbols.js';
import { canonicalDecimal, decimalCompare } from '../decimal.js';
import {
  prepareElevation,
  completeElevation,
  consumeElevation,
  elevationStatus,
  ElevationError,
  type ElevationIntent,
  type ElevationScope,
} from '../elevation.js';
import { resolveAccountOnChain } from '../sodex/chain.js';

const asEngine = (v: unknown): Engine => (v === 'spot' ? 'spot' : 'perps');

function guardMainnet(): void {
  if (NETWORK === 'mainnet' && !ALLOW_MAINNET_WRITES) {
    throw Object.assign(
      new Error('Mainnet writes are disabled. Set VALUETRADE_ALLOW_MAINNET=1 to enable them.'),
      { statusCode: 403 },
    );
  }
}

/** Transfers are idempotency-keyed by a client-chosen id. */
const nextTransferId = (): number => Date.now();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT64 = 18446744073709551615n;

/** Same bounding as the enrolment route - see routes/wallet.ts. */
function checkSignatureChainId(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || BigInt(v) > MAX_UINT64) {
    throw Object.assign(
      new Error('signatureChainId must be a positive integer chain id'),
      { statusCode: 400 },
    );
  }
  return v;
}

/**
 * Build the canonical intent for a request.
 *
 * Canonicalising here - and ONLY here - is what makes the prepare-time and
 * consume-time intents comparable: both sides go through this function, so
 * "1.50" and "1.5" cannot be made to look like different operations, nor the
 * same one.
 */
function buildIntent(raw: {
  scope: ElevationScope;
  engine?: unknown;
  coinId?: number;
  amount?: string;
  toAccountId?: number | null;
  direction?: string | null;
}): ElevationIntent {
  if (!raw.amount || decimalCompare(raw.amount, '0') <= 0) {
    throw Object.assign(new Error('amount must be positive'), { statusCode: 400 });
  }
  return {
    scope: raw.scope,
    engine: asEngine(raw.engine),
    coinId: raw.coinId ?? 0,
    amount: canonicalDecimal(raw.amount),
    toAccountId: raw.toAccountId ?? null,
    direction: raw.direction ?? null,
  };
}

/** The address whose elevation we act under: explicit, else the active session. */
function actingAddress(explicit?: string): string {
  if (explicit) {
    if (!ADDRESS_RE.test(explicit)) {
      throw Object.assign(new Error('address must be a valid 0x address'), { statusCode: 400 });
    }
    return explicit;
  }
  return sodex.requireSession().address;
}

export async function moneyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/money/coins', async () => ({ coins: await coins() }));

  /** Balances on both engines, side by side - what the transfer UI needs. */
  app.get('/api/money/overview', async (req, reply) => {
    const { address } = req.query as { address?: string };
    if (!address) return reply.code(400).send({ error: 'address is required' });
    // It is spliced into the gateway path below: anything but an address could
    // walk that path (`../..`) to another gateway endpoint on this server's budget.
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'a valid 0x wallet address is required' });
    }
    const [spot, perps, coinList] = await Promise.all([
      sodex.get<any>(`${enginePath('spot')}/accounts/${address}/balances`).catch(() => null),
      sodex.get<any>(`${enginePath('perps')}/accounts/${address}/balances`).catch(() => null),
      coins().catch(() => []),
    ]);
    // Same wrapped-vs-bare inconsistency as the account routes; normalise here
    // so the UI has exactly one shape to render.
    return {
      address,
      spot: unwrapList(spot, 'balances'),
      perps: unwrapList(perps, 'balances'),
      coins: coinList,
    };
  });

  /** Is an elevation currently armed, and for what? Drives the UI's state. */
  app.get('/api/money/elevation', async (req) => {
    const { address } = req.query as { address?: string };
    return { elevation: elevationStatus(address ?? sodex.sessionInfo()?.address) };
  });

  /**
   * Who owns this sub-account id?
   *
   * Answered by the exchange contract itself and round-tripped through
   * `getUserId`, so a `verified: true` result is a fact, not a guess. A
   * `verified: false` result carries NO address - the resolver refuses to offer
   * a plausible-looking one, because the consumer of this is a transfer
   * confirmation and a wrong address there is a misdirected payment.
   */
  app.get('/api/money/resolve-destination', async (req, reply) => {
    const q = req.query as { id?: string };
    const id = Number.parseInt(q.id ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'a positive integer account id is required' });
    }
    try {
      const res = await resolveAccountOnChain(id);
      const mine = sodex.sessionInfo()?.address?.toLowerCase();
      return {
        ...res,
        // Only ever a boolean when the ownership itself was verified. An
        // unverified lookup yields null - "unknown" - never false, because
        // rendering "not yours" for a destination that IS yours trains people
        // to click past this line.
        isYourOwnAddress:
          res.verified && res.address && mine ? res.address.toLowerCase() === mine : null,
        advisory: res.verified
          ? 'Read from the exchange contract on ValueChain and round-tripped through getUserId.'
          : 'Ownership could not be established on-chain. Treat this destination as unknown.',
      };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, source: 'valuechain-explorer' });
    }
  });

  /**
   * Step 1 of any money movement: ask the wallet to authorise THIS operation.
   *
   * Returns the typed data plus a plain-language summary. The UI must show that
   * summary next to the wallet prompt, because the wallet itself renders the
   * scope as an opaque integer and cannot describe the operation.
   */
  app.post('/api/money/elevate', async (req, reply) => {
    guardMainnet();
    const b = (req.body ?? {}) as {
      address?: string;
      scope?: ElevationScope;
      engine?: Engine;
      coinId?: number;
      amount?: string;
      toAccountId?: number;
      direction?: string;
      signatureChainId?: number;
    };
    if (b.scope !== 'transfer' && b.scope !== 'withdraw') {
      return reply.code(400).send({ error: 'scope must be "transfer" or "withdraw"' });
    }
    const address = actingAddress(b.address);
    const s = sodex.requireSession(address);
    const intent = buildIntent({
      scope: b.scope,
      engine: b.engine,
      coinId: b.coinId,
      amount: b.amount,
      toAccountId: b.toAccountId ?? null,
      direction: b.direction ?? null,
    });
    return prepareElevation({
      address,
      accountId: s.accountId,
      intent,
      signatureChainId: checkSignatureChainId(b.signatureChainId),
    });
  });

  /** Step 2: hand back the wallet's signature. Arms the key in memory only. */
  app.post('/api/money/elevate/complete', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: string; signature?: string };
    if (!b.signature) return reply.code(400).send({ error: 'signature is required' });
    const address = actingAddress(b.address);
    const res = await completeElevation(address, b.signature);
    return { armed: true, ...res, elevation: elevationStatus(address) };
  });

  /**
   * Move funds between the spot (Spark) and perps (Bolt) engines.
   *
   * Direction is encoded by BOTH the endpoint and the transfer type, and the
   * destination is the magic account id 999:
   *   perps -> spot : perps endpoint, SPOT_WITHDRAW(5),  domain "futures"
   *   spot  -> perps: spot  endpoint, PERPS_WITHDRAW(3), domain "spot"
   */
  app.post('/api/money/transfer/cross', async (req, reply) => {
    guardMainnet();
    const b = req.body as { direction?: string; coinId?: number; amount?: string; address?: string };
    const address = actingAddress(b?.address);
    const s = sodex.requireSession(address);

    const toPerps = b.direction === 'spot-to-perps';
    const engine: Engine = toPerps ? 'spot' : 'perps';
    const direction = toPerps ? 'spot-to-perps' : 'perps-to-spot';
    const intent = buildIntent({
      scope: 'transfer',
      engine,
      coinId: b.coinId,
      amount: b.amount,
      toAccountId: null,
      direction,
    });

    const { session, settle } = consumeElevation(address, intent);
    try {
      const params = A.transferAsset({
        id: nextTransferId(),
        fromAccountID: s.accountId,
        toAccountID: A.CROSS_ENGINE_ACCOUNT_ID,
        coinID: intent.coinId,
        amount: intent.amount,
        type: toPerps ? A.TransferType.PERPS_WITHDRAW : A.TransferType.SPOT_WITHDRAW,
      });
      return {
        direction,
        engine,
        amount: intent.amount,
        result: await sodex.post(engine, '/accounts/transfers', A.ACTION.transferAsset, params, session),
      };
    } finally {
      settle();
    }
  });

  /** Move funds to another SoDEX sub-account. */
  app.post('/api/money/transfer/internal', async (req, reply) => {
    guardMainnet();
    const b = req.body as {
      engine?: Engine; toAccountId?: number; coinId?: number; amount?: string; address?: string;
    };
    if (!b?.toAccountId || !Number.isInteger(b.toAccountId) || b.toAccountId <= 0) {
      return reply.code(400).send({ error: 'a positive integer toAccountId is required' });
    }
    const address = actingAddress(b.address);
    const s = sodex.requireSession(address);
    if (b.toAccountId === s.accountId) {
      return reply.code(400).send({ error: 'that is this account - pick a different destination' });
    }
    const intent = buildIntent({
      scope: 'transfer',
      engine: b.engine,
      coinId: b.coinId,
      amount: b.amount,
      toAccountId: b.toAccountId,
      direction: null,
    });

    const { session, settle } = consumeElevation(address, intent);
    try {
      const params = A.transferAsset({
        id: nextTransferId(),
        fromAccountID: s.accountId,
        toAccountID: intent.toAccountId!,
        coinID: intent.coinId,
        amount: intent.amount,
        type: A.TransferType.INTERNAL,
      });
      return {
        engine: intent.engine,
        toAccountId: intent.toAccountId,
        amount: intent.amount,
        result: await sodex.post(intent.engine, '/accounts/transfers', A.ACTION.transferAsset, params, session),
      };
    } finally {
      settle();
    }
  });

  /** Withdraw back to the master wallet on-chain (EVM_WITHDRAW). */
  app.post('/api/money/withdraw', async (req, reply) => {
    guardMainnet();
    const b = req.body as {
      engine?: Engine; coinId?: number; amount?: string; toAccountId?: number; address?: string;
    };
    const address = actingAddress(b?.address);
    const s = sodex.requireSession(address);
    const intent = buildIntent({
      scope: 'withdraw',
      engine: b.engine,
      coinId: b.coinId,
      amount: b.amount,
      toAccountId: null,
      direction: null,
    });

    const { session, settle } = consumeElevation(address, intent);
    try {
      const params = A.transferAsset({
        id: nextTransferId(),
        fromAccountID: s.accountId,
        // An EVM withdrawal leaves the exchange ledger; there is no destination
        // sub-account, so this is 0 unless the operator overrides it.
        toAccountID: b.toAccountId ?? 0,
        coinID: intent.coinId,
        amount: intent.amount,
        type: A.TransferType.EVM_WITHDRAW,
      });
      return {
        engine: intent.engine,
        destination: s.address,
        amount: intent.amount,
        result: await sodex.post(intent.engine, '/accounts/transfers', A.ACTION.transferAsset, params, session),
      };
    } finally {
      settle();
    }
  });
}

export { ElevationError };
