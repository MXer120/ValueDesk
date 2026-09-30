/**
 * Just-in-time elevation for money movement.
 *
 * WHY THIS EXISTS.
 *
 * The only place "this key cannot move funds" can be enforced against a
 * compromised machine is the permission mask fixed at key-creation time, and
 * that enforcement lives at the exchange, not in this process. (This file
 * originally said SoDEX has no wallet-signed transfer action. The current docs
 * say the master wallet may sign `transferAsset` directly, with no API key
 * involved - see docs/PERMISSION-MASK.md, which proposes that as the eventual
 * replacement for this whole mechanism.)
 *
 * So the resting key is trade-only (wire mask 14 - a set bit DISABLES a
 * permission). When the user actually wants to transfer or withdraw, a SECOND
 * key is minted for that one operation, with exactly one permission enabled:
 *
 *   - it exists in this process's memory only, and is never written to the
 *     keystore, so a leaked, synced or backed-up keystore can never move funds;
 *   - it carries a short protocol-level `expiresAt`, so even a key captured out
 *     of memory dies on its own - that 180s expiry is the bound that matters;
 *   - it is single-use: consumed by exactly one money operation;
 *   - a revoke is attempted after use, on expiry and on shutdown. It is signed
 *     by the elevation key itself, and the docs say `revokeAPIKey` must be
 *     signed by the master wallet, so expect it to fail silently until that is
 *     tested. Do not count on it.
 *
 * The cost is one wallet signature per money movement. That is the whole point:
 * it reduces "can an attacker move this user's funds" to "can an attacker make
 * this user's wallet sign", which is the one thing outside our control anyway.
 *
 * This is NOT a defence against a user who approves a malicious signature. It is
 * a defence against every path that does not involve the wallet: stolen
 * keystore, stolen device key, compromised backend, malware on the box, a
 * hostile process calling the local API.
 */
import { enginePath, mintingBlockedReason, NET, NETWORK, type Engine } from './config.js';
import { sodex, SodexApiError, type SigningSession } from './sodex/rest.js';
import { generateKey } from './keys.js';
import { hexToBytes } from './signing/eip712.js';
import {
  permissionedAPIKeyBody,
  permissionedAPIKeyTypedData,
  walletSignatureToWire,
  APIKeyType,
} from './signing/userSigned.js';
import {
  APIKeyPermission,
  PERMISSION_MASK,
  ACTION,
  permits,
  revokeAPIKey,
} from './signing/actions.js';

/** How long the minted key is valid AT THE GATEWAY, in seconds. */
const ELEVATION_TTL_SEC = 180;
/** How long an armed-but-unused elevation survives in memory, in ms. */
const ARMED_TTL_MS = ELEVATION_TTL_SEC * 1000;
/** How long a prepared-but-unsigned elevation survives, in ms. */
const PENDING_TTL_MS = 5 * 60_000;

export type ElevationScope = 'transfer' | 'withdraw';

/**
 * The exact operation an elevation authorises.
 *
 * The EIP-712 the wallet signs carries only scope, name and expiry - the
 * protocol has no field for "to whom" or "how much", so the signature alone
 * cannot bind those. Recording them here and requiring an exact match at
 * consume time closes the remaining window: within the 180s an elevation is
 * live, the ONLY operation it can be spent on is the one whose parameters the
 * user was shown before they signed. A hostile caller that races the window
 * cannot redirect the destination or inflate the amount; it can at most replay
 * the operation the user already approved.
 *
 * This is enforced locally, so it does not survive a compromised backend the way
 * the permission mask does. It is the second line, not the first.
 */
export interface ElevationIntent {
  scope: ElevationScope;
  engine: Engine;
  coinId: number;
  /** Canonical decimal string, compared verbatim. */
  amount: string;
  /** Destination sub-account for an internal transfer; null otherwise. */
  toAccountId: number | null;
  /** 'spot-to-perps' | 'perps-to-spot' for a cross-engine move; null otherwise. */
  direction: string | null;
}

/** Field-by-field equality. Any mismatch means "not what the user approved". */
export function intentMatches(a: ElevationIntent, b: ElevationIntent): boolean {
  return (
    a.scope === b.scope &&
    a.engine === b.engine &&
    a.coinId === b.coinId &&
    a.amount === b.amount &&
    a.toAccountId === b.toAccountId &&
    a.direction === b.direction
  );
}

/** Human-readable, for the mismatch error and the UI confirmation. */
export function describeIntent(i: ElevationIntent): string {
  const where =
    i.toAccountId !== null ? ` to account #${i.toAccountId}`
    : i.direction ? ` (${i.direction})`
    : ' to your own wallet';
  return `${i.scope} ${i.amount} of coin ${i.coinId} on ${i.engine}${where}`;
}

/**
 * The permission bit an operation actually needs.
 *
 * Decided by the intent, not just the scope: a spot <-> perps move is a
 * "transfer" in the UI, but on the wire it is SPOT_WITHDRAW / PERPS_WITHDRAW,
 * and the schema files it under WITHDRAW ("Withdraw from spot or perps to EVM
 * or the other engine"). TRANSFER covers only "Sub-account and internal
 * transfers". So a cross-engine key necessarily could also withdraw on-chain -
 * SoDEX has no bit that separates the two.
 */
export function requiredBit(intent: Pick<ElevationIntent, 'scope' | 'direction'>): number {
  return intent.scope === 'withdraw' || intent.direction !== null
    ? APIKeyPermission.WITHDRAW
    : APIKeyPermission.TRANSFER;
}

/** Least privilege per operation: the wire mask enabling `requiredBit` and nothing else. */
export function elevationMask(intent: Pick<ElevationIntent, 'scope' | 'direction'>): number {
  return requiredBit(intent) === APIKeyPermission.WITHDRAW
    ? PERMISSION_MASK.WITHDRAW_ONLY
    : PERMISSION_MASK.TRANSFER_ONLY;
}

interface Prepared {
  privateKey: string;
  keyAddress: string;
  address: string;
  accountId: number;
  name: string;
  scope: ElevationScope;
  intent: ElevationIntent;
  permissions: number;
  expiresAt: number;
  nonce: bigint;
  signatureChainId: number;
  engine: Engine;
  createdAt: number;
}

interface Armed extends Prepared {
  armedAt: number;
}

const addrKey = (a: string): string => a.trim().toLowerCase();

const prepared = new Map<string, Prepared>();
const armed = new Map<string, Armed>();

export class ElevationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Best-effort revoke at the gateway. Never throws: the key expires regardless. */
async function revokeAtGateway(a: Armed): Promise<void> {
  const session: SigningSession = {
    privateKey: hexToBytes(a.privateKey),
    apiKeyName: a.name,
    accountId: a.accountId,
    address: a.address,
    keyAddress: a.keyAddress,
    permissions: a.permissions,
  };
  try {
    await sodex.post(
      a.engine,
      '/accounts/api-keys/revoke',
      ACTION.revokeAPIKey,
      revokeAPIKey(a.accountId, a.name),
      session,
    );
  } catch {
    /* Expiry is the backstop. A failed revoke must not surface as a failed transfer. */
  } finally {
    session.privateKey.fill(0);
  }
}

/** Drop anything past its TTL, revoking armed keys on the way out. */
function sweep(): void {
  const now = Date.now();
  for (const [k, p] of prepared) {
    if (now - p.createdAt >= PENDING_TTL_MS) prepared.delete(k);
  }
  for (const [k, a] of armed) {
    if (now - a.armedAt >= ARMED_TTL_MS) {
      armed.delete(k);
      void revokeAtGateway(a);
    }
  }
}

/**
 * Step 1: mint a keypair and return the EIP-712 the wallet must sign.
 * Nothing is registered and nothing can move until the signature comes back.
 */
export function prepareElevation(opts: {
  address: string;
  intent: ElevationIntent;
  accountId: number;
  signatureChainId?: number;
}): {
  name: string;
  keyAddress: string;
  permissions: number;
  expiresAt: number;
  intent: ElevationIntent;
  summary: string;
  typedData: unknown;
} {
  sweep();
  const blocked = mintingBlockedReason();
  if (blocked) throw new ElevationError(blocked, 409);
  const scope = opts.intent.scope;
  const permissions = elevationMask(opts.intent);
  const { privateKey, address: keyAddress } = generateKey();
  const name = `vt-${scope}-${Date.now().toString(36)}`;
  const nonce = BigInt(Date.now());
  // Milliseconds, like every other `expiresAt` on this wire - see the note on
  // SESSION_TTL_MS in routes/wallet.ts for how that was established.
  const expiresAt = Date.now() + ELEVATION_TTL_SEC * 1000;
  const signatureChainId = opts.signatureChainId ?? NET.chainId;

  prepared.set(addrKey(opts.address), {
    privateKey,
    keyAddress,
    address: opts.address,
    accountId: opts.accountId,
    name,
    scope,
    intent: opts.intent,
    permissions,
    expiresAt,
    nonce,
    signatureChainId,
    engine: opts.intent.engine,
    createdAt: Date.now(),
  });

  return {
    name,
    keyAddress,
    permissions,
    expiresAt,
    intent: opts.intent,
    summary: describeIntent(opts.intent),
    typedData: permissionedAPIKeyTypedData(
      {
        accountID: opts.accountId,
        name,
        publicKey: keyAddress,
        expiresAt,
        permissions,
        keyType: APIKeyType.EVM,
      },
      NET.chainId,
      nonce,
      signatureChainId,
    ),
  };
}

/** Step 2: register the signed key. It is armed in memory and never stored. */
export async function completeElevation(
  address: string,
  signature: string,
): Promise<{ scope: ElevationScope; expiresAt: number; name: string }> {
  sweep();
  const key = addrKey(address);
  const p = prepared.get(key);
  if (!p) throw new ElevationError('No elevation is pending for this wallet - start the operation again.');

  let wire: string;
  try {
    wire = walletSignatureToWire(signature);
  } catch (e) {
    throw new ElevationError((e as Error).message);
  }

  const body = permissionedAPIKeyBody({
    accountID: p.accountId,
    name: p.name,
    publicKey: p.keyAddress,
    expiresAt: p.expiresAt,
    permissions: p.permissions,
    keyType: APIKeyType.EVM,
  });

  try {
    await sodex.relay(`${enginePath(p.engine)}/accounts/api-keys`, body, {
      'X-API-Sign': wire,
      'X-API-Nonce': p.nonce.toString(),
      'X-API-Chain': String(NET.chainId),
    });
  } catch (e) {
    const err = e as SodexApiError;
    throw new ElevationError(err.message ?? 'The exchange rejected the elevation.');
  }

  prepared.delete(key);
  // Any previous armed key for this wallet is superseded - revoke it rather than
  // leaving a live fund-moving key that nothing will ever consume.
  const prev = armed.get(key);
  if (prev) void revokeAtGateway(prev);
  armed.set(key, { ...p, armedAt: Date.now() });

  return { scope: p.scope, expiresAt: p.expiresAt, name: p.name };
}

/**
 * Step 3: hand the armed key to exactly one operation.
 *
 * Removed from the map BEFORE it is returned, so a second concurrent call
 * cannot reuse it, and revoked once the caller settles.
 */
export function consumeElevation(
  address: string,
  intent: ElevationIntent,
): { session: SigningSession; settle: () => void } {
  sweep();
  const scope = intent.scope;
  const key = addrKey(address);
  const a = armed.get(key);
  if (!a) {
    throw new ElevationError(
      `This action needs a fresh wallet signature. The key held on this machine can only trade - it cannot ${scope}.`,
      403,
    );
  }
  if (a.scope !== scope || !permits(a.permissions, requiredBit(intent))) {
    throw new ElevationError(
      `The authorised operation was "${a.scope}", not "${scope}". Approve the right one.`,
      403,
    );
  }
  if (!intentMatches(a.intent, intent)) {
    // Deliberately spells out both sides: if this ever fires for a real user it
    // is either a UI bug or someone trying to spend their signature on a
    // different operation, and both need to be visible.
    armed.delete(key);
    void revokeAtGateway(a);
    throw new ElevationError(
      `This request does not match what you approved. You authorised: ${describeIntent(a.intent)}. ` +
        `This asked for: ${describeIntent(intent)}. The authorisation has been revoked - start again.`,
      403,
    );
  }
  if (Date.now() - a.armedAt >= ARMED_TTL_MS) {
    armed.delete(key);
    void revokeAtGateway(a);
    throw new ElevationError('That authorisation expired. Approve it again.', 403);
  }

  armed.delete(key); // single use, and before any await can interleave
  const session: SigningSession = {
    privateKey: hexToBytes(a.privateKey),
    apiKeyName: a.name,
    accountId: a.accountId,
    address: a.address,
    keyAddress: a.keyAddress,
    permissions: a.permissions,
  };
  return {
    session,
    settle: () => {
      session.privateKey.fill(0);
      void revokeAtGateway(a);
    },
  };
}

/** Public, secret-free view for the UI. */
export function elevationStatus(
  address?: string,
): { scope: ElevationScope; summary: string; expiresAt: number; secondsLeft: number } | null {
  sweep();
  const key = address ? addrKey(address) : null;
  const a = key ? armed.get(key) : null;
  if (!a) return null;
  return {
    scope: a.scope,
    summary: describeIntent(a.intent),
    expiresAt: a.expiresAt,
    secondsLeft: Math.max(0, Math.round((a.armedAt + ARMED_TTL_MS - Date.now()) / 1000)),
  };
}

/** Revoke everything still armed. Called on shutdown. */
export async function revokeAllElevations(): Promise<void> {
  const all = [...armed.values()];
  armed.clear();
  prepared.clear();
  await Promise.allSettled(all.map(revokeAtGateway));
}

export const ELEVATION = { TTL_SEC: ELEVATION_TTL_SEC, NETWORK } as const;
