/**
 * Wallet, session and API-key lifecycle.
 *
 * The flow this file exists to enable:
 *
 *   1. Browser connects a wallet -> we look up the SoDEX account id from the
 *      address (no signature needed).
 *   2. /apikey/prepare generates a BRAND NEW keypair server-side and returns
 *      EIP-712 typed data authorising it, with WITHDRAW, TRANSFER and CANCEL
 *      disabled (wire mask 14 - a set bit DISABLES a permission).
 *   3. The user signs that in their wallet. The master key never leaves the
 *      extension; we only ever see a signature.
 *   4. /apikey/complete relays the registration to SoDEX, then holds the new
 *      private key in memory for the session.
 *
 * The intended result is a signing key that can trade but can never withdraw or
 * transfer, and a master key that never touched this process.
 *
 * That restriction is meant to be the security model: if the exchange enforces
 * the mask, a fully compromised backend still cannot move funds. Transfers and
 * withdrawals go through just-in-time elevation instead - a separate,
 * single-use, in-memory key that costs one wallet signature per operation. See
 * elevation.ts. The enforcement is documented by SoDEX but not yet observed by
 * us, so mainnet minting is gated on config.PERMISSIONS_VERIFIED.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

import { sodex, SodexApiError } from '../sodex/rest.js';
import { KEYSTORE_PATH, NET, NETWORK, enginePath, mintingBlockedReason, type Engine } from '../config.js';
import * as ks from '../keystore.js';
import { hexToBytes, privateKeyToAddress } from '../signing/eip712.js';
import {
  permissionedAPIKeyBody,
  permissionedAPIKeyTypedData,
  walletSignatureToWire,
  APIKeyType,
} from '../signing/userSigned.js';
import {
  APIKeyPermission,
  PERMISSION_MASK,
  canMoveFunds,
  disableAllBut,
  enabledPermissionNames,
  isPermissionedKeyMask,
  permits,
} from '../signing/actions.js';
import { devicePassphrase, deviceKeyExists, deviceKeyPath } from '../deviceKey.js';

/**
 * The wire mask of the session trading key: 14, i.e. CANCEL, WITHDRAW and
 * TRANSFER disabled, TRADE enabled.
 *
 * Trade-only, deliberately - the same shape every major perp DEX uses for a
 * delegated key (Hyperliquid's "agent wallet", Aevo's signing key, Vertex's
 * linked signer). Withdrawals and transfers require the master wallet, per
 * operation. See elevation.ts.
 *
 * NOT `TRADE|CANCEL` (3). A set bit disables a permission, so 3 is a key that
 * cannot trade and CAN withdraw and transfer - which is what this constant held
 * until the docs were read properly. CANCEL stays disabled because the gateway
 * refuses a permissioned key with both TRADE and CANCEL enabled; per the schema
 * TRADE covers cancels by itself. Both points are documented, not yet observed.
 */
const SESSION_PERMISSIONS = PERMISSION_MASK.TRADE_ONLY;

/**
 * Lifetime of the session key, in MILLISECONDS (24 hours).
 *
 * THE UNIT IS THE WHOLE POINT OF THIS COMMENT. `expiresAt` on the SoDEX wire is
 * a millisecond timestamp, not a Unix second, and sending seconds is what made
 * enabling trading fail with "expiresAt is invalid": 1.79e9 read as milliseconds
 * is three weeks after the epoch, so every key we asked for had already expired
 * fifty-six years ago.
 *
 * It is not guessed. The venue's own keys on a live account read:
 *     webkey     1788193904811  -> 2026-08-31   (~24h out)
 *     mobilekey  1786523374853  -> 2026-08-12
 *     default    0              -> never expires
 * Interpreted as seconds those land in the year 58635. Milliseconds it is, and
 * `webkey` also shows the venue is perfectly happy with a 24-hour key.
 *
 * The key is memory-only (see below), so it already dies when the backend stops.
 * The expiry is the backstop for the case where it does not: a long-running
 * process, or a key registered at the gateway that we lost track of locally.
 * 24h means an authorisation the user granted and forgot cannot be spent a week
 * later. Re-enabling is one signature.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The EIP-712 domain chainId the wallet will sign under.
 *
 * Client-supplied by necessity - it must equal the chain the WALLET is on, and
 * only the browser knows that - so it is bounded rather than trusted. A wallet
 * refuses to sign typed data whose domain chainId is not its current chain, so
 * a wrong value fails closed at the wallet; the check here is to keep junk,
 * negatives and out-of-range values out of the signed payload entirely.
 */
const MAX_UINT64 = 18446744073709551615n;
function checkSignatureChainId(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || BigInt(v) > MAX_UINT64) {
    throw Object.assign(
      new Error('signatureChainId must be a positive integer chain id'),
      { statusCode: 400 },
    );
  }
  return v;
}
/** Key names travel in an HTTP header, so keep them boring. */
const KEY_NAME_RE = /^[0-9a-zA-Z_-]{1,32}$/;
/** 32 bytes of hex, 0x prefix optional. */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * A generated-but-not-yet-registered key, held only in memory.
 *
 * Keyed by wallet address rather than held in a single slot: enrolling a second
 * wallet used to overwrite the first one's pending key, so whoever signed second
 * completed an enrollment for a key the gateway had never been told about, and
 * the first wallet's signature became unredeemable.
 */
interface Pending {
  privateKey: string;
  keyAddress: string;
  address: string;
  accountId: number;
  name: string;
  permissions: number;
  expiresAt: number;
  nonce: bigint;
  signatureChainId: number;
  engine: Engine;
  createdAt: number;
  /**
   * 'memory' = never written to disk (the one-click default), 'device' =
   * auto-managed secret on this machine, 'passphrase' = user supplies one.
   */
  protection: 'device' | 'passphrase' | 'memory';
}

const pending = new Map<string, Pending>();
const PENDING_TTL = 10 * 60_000;

/** Drop expired enrollments. Cheap, and keeps key material out of memory. */
function sweepPending(): void {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.createdAt >= PENDING_TTL) pending.delete(k);
}

function setPending(p: Pending): void {
  sweepPending();
  pending.set(ks.addressKey(p.address), p);
}

/**
 * Resolve which enrollment a /complete call is finishing.
 *
 * With no address we only guess when there is exactly one candidate. Picking the
 * newest instead would mean a second /prepare silently redirects the first
 * wallet's signature onto the wrong key - the signature is over the key address,
 * so the gateway would reject it, but only after the user thinks they enrolled.
 */
function pendingFor(address?: string): Pending | null {
  sweepPending();
  if (address) return pending.get(ks.addressKey(address)) ?? null;
  return pending.size === 1 ? [...pending.values()][0]! : null;
}

function generateKey(): { privateKey: string; address: string } {
  for (;;) {
    const buf = randomBytes(32);
    if (secp256k1.utils.isValidSecretKey?.(buf) ?? true) {
      try {
        return { privateKey: '0x' + buf.toString('hex'), address: privateKeyToAddress(buf) };
      } catch {
        /* astronomically unlikely; retry */
      }
    }
  }
}

/** Names of the permissions a wire mask leaves ENABLED - the bits that are clear. */
const describePermissions = enabledPermissionNames;

function applySession(privateKeyHex: string, meta: ks.KeystoreMeta): void {
  sodex.addSession({
    privateKey: hexToBytes(privateKeyHex),
    apiKeyName: meta.apiKeyName,
    accountId: meta.accountId,
    address: meta.address,
    keyAddress: meta.keyAddress,
    permissions: meta.permissions,
    // Carried so the client can refuse an expired key locally, with a message
    // the user can act on, rather than surfacing the gateway's opaque 401.
    expiresAt: meta.expiresAt,
  });
}

/**
 * One row per LIVE session.
 *
 * There is no stored-but-locked state any more, because there is no store: every
 * key this app holds lives in memory and dies with the process. So the account
 * switcher lists exactly what can sign right now, and nothing that merely could
 * if you typed a passphrase.
 */
function accountRows() {
  const activeAddress = (sodex.activeAddress ?? '').toLowerCase();
  return sodex.sessionList().map((s) => ({
    address: s.address,
    accountId: s.accountId,
    apiKeyName: s.apiKeyName,
    keyAddress: s.keyAddress,
    network: NETWORK,
    permissions: s.permissions,
    permissionNames: describePermissions(s.permissions),
    expiresAt: s.expiresAt ?? 0,
    secondsLeft: s.secondsLeft ?? null,
    protection: 'memory' as const,
    autoUnlock: false,
    unlocked: true,
    active: s.address.toLowerCase() === activeAddress,
  }));
}

/**
 * A keystore file from an older version, if one is still lying around.
 *
 * Nothing writes one any more. This exists only so the app can TELL the user it
 * is there and offer to take the key into memory and delete the file - leaving
 * them where every other path already is, with no key on disk.
 */
function legacyKeystore() {
  try {
    const vault = ks.loadVault(KEYSTORE_PATH);
    const keys = Object.keys(vault.accounts);
    if (!keys.length) return null;
    return {
      path: KEYSTORE_PATH,
      accounts: keys.map((k) => {
        const meta = vault.accounts[k]!.meta;
        return {
          address: meta.address || k,
          apiKeyName: meta.apiKeyName,
          permissions: meta.permissions,
          permissionNames: describePermissions(meta.permissions),
          protection: meta.protection ?? 'passphrase',
          canMoveFunds: canMoveFunds(meta.permissions),
        };
      }),
    };
  } catch {
    return null;
  }
}

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  // -- session ---------------------------------------------------------------

  app.get('/api/session', async () => {
    // The active record, so the single-account fields below keep describing the
    // account that unspecified requests actually act as.
    const active = sodex.sessionInfo();
    const accounts = accountRows();
    const legacy = legacyKeystore();
    return {
      network: NETWORK,
      chainId: NET.chainId,
      unlocked: sodex.isUnlocked,
      session: active,
      permissionNames: active ? describePermissions(active.permissions) : [],
      /** Always 'memory' now - see accountRows. */
      protection: active ? ('memory' as const) : null,
      autoUnlock: false,
      /**
       * Non-null ONLY if a file written by an older version is still present.
       * Reported so the UI can offer to clear it, not because anything uses it.
       */
      legacyKeystore: legacy,
      weightSpent: sodex.weightSpent(),
      // -- multi-account view ---------------------------------------------
      accounts,
      activeAddress: active?.address ?? null,
      unlockedCount: sodex.sessionCount,
    };
  });

  /** Just the switcher's data, so a poll does not re-read the whole session. */
  app.get('/api/session/accounts', async () => ({
    accounts: accountRows(),
    activeAddress: sodex.activeAddress,
    unlockedCount: sodex.sessionCount,
  }));

  /**
   * Take a key out of a legacy keystore file and into memory, then DELETE the file.
   *
   * This is a migration, not a feature. Older versions wrote an encrypted key to
   * disk; nothing does now. Rather than stranding those users, this decrypts the
   * record once, installs it as an ordinary in-memory session, and removes the
   * file - so they end up where everyone else already is, with no key on disk.
   * There is deliberately no way to put one back.
   */
  app.post('/api/session/unlock', async (req, reply) => {
    const { passphrase, address } = (req.body ?? {}) as { passphrase?: string; address?: string };
    if (address && !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'address must be a valid 0x address' });
    }
    const file = address ? ks.loadAccount(KEYSTORE_PATH, address) : ks.load(KEYSTORE_PATH);
    if (!file) {
      return reply.code(404).send({
        error: 'no keystore file - keys are session-only now, so just enable trading',
      });
    }

    const useDevice = (file.meta.protection ?? 'passphrase') === 'device';
    if (!useDevice && !passphrase) return reply.code(400).send({ error: 'passphrase is required' });
    try {
      const secret = useDevice ? devicePassphrase() : passphrase!;
      applySession(ks.decryptKeystore(file, secret), file.meta);
    } catch (e) {
      // Fails closed per account: a wrong passphrase for one wallet leaves every
      // other unlocked account exactly as it was.
      return reply.code(401).send({ error: (e as Error).message });
    }
    // Decrypted successfully, so the file has served its last purpose. Removing
    // it here - not on some later user action - is what makes this a one-way
    // migration rather than an optional tidy-up.
    ks.removeAccount(KEYSTORE_PATH, file.meta.address);
    return {
      unlocked: true,
      migrated: true,
      fileRemoved: true,
      note: 'The key is now held in memory for this session only, and the file has been deleted.',
      session: sodex.sessionInfo(),
      accounts: accountRows(),
    };
  });

  /**
   * Lock one account (`address`), all of them (`all: true`), or - matching the
   * old single-account behaviour - the active one.
   */
  app.post('/api/session/lock', async (req, reply) => {
    const { address, all } = (req.body ?? {}) as { address?: string; all?: boolean };
    if (all) {
      sodex.lockAll();
    } else if (address) {
      if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: 'address must be a valid 0x address' });
      if (!sodex.lockAccount(address)) return reply.code(404).send({ error: `${address} is not unlocked` });
    } else {
      sodex.setSession(null);
    }
    // `unlocked` stays whole-process so the existing client keeps reading it as
    // "can I sign anything at all".
    return { unlocked: sodex.isUnlocked, session: sodex.sessionInfo(), accounts: accountRows() };
  });

  /** Fast switch: which unlocked account unqualified requests act as. */
  app.post('/api/session/active', async (req, reply) => {
    const { address } = (req.body ?? {}) as { address?: string };
    if (!address || !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'a valid 0x address is required' });
    }
    if (!sodex.setActiveAddress(address)) {
      return reply.code(404).send({
        error: `${address} has no live session - enable trading for that wallet first`,
      });
    }
    // Nothing to persist: "active" is a property of this process's sessions.
    return { active: sodex.sessionInfo(), accounts: accountRows() };
  });

  /** Forget one account's stored key, or the whole keystore when unqualified. */
  app.delete('/api/session/keystore', async (req, reply) => {
    const q = (req.query ?? {}) as { address?: string };
    const b = (req.body ?? {}) as { address?: string };
    const address = q.address ?? b.address;
    if (address) {
      if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: 'address must be a valid 0x address' });
      const removed = ks.removeAccount(KEYSTORE_PATH, address);
      if (!removed) return reply.code(404).send({ error: `no stored key for ${address}` });
      sodex.lockAccount(address);
      return { deleted: true, address, accounts: accountRows() };
    }
    sodex.lockAll();
    ks.remove(KEYSTORE_PATH);
    return { deleted: true, accounts: [] as ReturnType<typeof accountRows> };
  });

  /**
   * Import a key created by hand on sodex.com/apikeys.
   *
   * Held in memory for this session and never written down. An imported key is
   * by definition one you already have a copy of somewhere else - you pasted it
   * from there - so writing a second copy into a cloud-synced project folder
   * would add exposure without adding any capability. Re-import after a restart.
   */
  app.post('/api/session/import', async (req, reply) => {
    const b = req.body as {
      privateKey?: string; apiKeyName?: string; accountId?: number;
      address?: string; passphrase?: string;
    };
    // `^0x?` would demand a literal leading '0', rejecting most unprefixed keys.
    if (!b?.privateKey || !PRIVATE_KEY_RE.test(b.privateKey.trim())) {
      // Deliberately does NOT echo the value - it is a secret even when malformed.
      return reply.code(400).send({ error: 'privateKey must be 32 bytes of hex, with or without a 0x prefix' });
    }
    if (!b.apiKeyName || !KEY_NAME_RE.test(b.apiKeyName)) {
      return reply.code(400).send({ error: `apiKeyName must match ${KEY_NAME_RE}` });
    }
    if (!b.address || !ADDRESS_RE.test(b.address)) {
      return reply.code(400).send({ error: 'a valid master wallet address is required' });
    }
    const raw = b.privateKey.trim();
    const pk = raw.startsWith('0x') ? raw : '0x' + raw;
    let keyAddress: string;
    try {
      keyAddress = privateKeyToAddress(hexToBytes(pk));
    } catch {
      // Swallow the underlying error: its message embeds the key material, which
      // would then be logged at error level and returned in the response body.
      return reply.code(400).send({ error: 'privateKey is not a valid secp256k1 key' });
    }

    let accountId = b.accountId ?? 0;
    if (!accountId) {
      const state = await sodex.get<any>(`${enginePath('spot')}/accounts/${b.address}/state`);
      accountId = state?.aid ?? 0;
    }
    if (!accountId) {
      return reply.code(400).send({ error: 'this wallet has no SoDEX account yet - deposit first' });
    }

    // Confirm the key is actually registered, so a typo fails here rather than
    // as an opaque 401 on the first order.
    const keys = await sodex.get<any[]>(`${enginePath('spot')}/accounts/${b.address}/api-keys`);
    const match = (keys ?? []).find(
      (k) => String(k.name) === b.apiKeyName && String(k.publicKey).toLowerCase() === keyAddress.toLowerCase(),
    );
    if (!match) {
      return reply.code(400).send({
        error: `no API key named "${b.apiKeyName}" with address ${keyAddress} is registered for this account`,
        registered: (keys ?? []).map((k) => ({ name: k.name, publicKey: k.publicKey })),
      });
    }

    const meta: ks.KeystoreMeta = {
      apiKeyName: b.apiKeyName, accountId, address: b.address, keyAddress,
      // An ordinary key (made on sodex.com, or by AddAPIKey) has no
      // `permissions` field at all, and per the schema that means every
      // permission is enabled. 0 is the right wire mask for it - nothing
      // disabled - so this default is correct, but it means "can withdraw", not
      // "can do nothing".
      network: NETWORK, permissions: Number(match.permissions ?? 0),
      expiresAt: Number(match.expiresAt ?? 0), createdAt: Date.now(),
      protection: 'memory',
    };
    applySession(pk, meta);
    return {
      imported: true,
      persisted: false,
      note: 'Held for this session only. Nothing was written to disk.',
      permissionNames: describePermissions(meta.permissions),
      canMoveFunds: canMoveFunds(meta.permissions),
      session: sodex.sessionInfo(),
      keyAddress,
      accounts: accountRows(),
    };
  });

  /**
   * The permission bits a signing key can carry.
   *
   * Exposed so the UI can offer them explicitly rather than hard-coding a
   * mask: a key that can withdraw is a materially different security posture
   * from a trade-only key, and the user should be choosing it deliberately.
   *
   * `permissions` is the WIRE mask, where a set bit DISABLES a permission.
   * Every preset leaves CANCEL disabled because the gateway refuses a
   * permissioned key with TRADE and CANCEL both enabled.
   */
  app.get('/api/wallet/permissions', async () => ({
    presets: [
      {
        id: 'trading',
        label: 'Trading only',
        permissions: PERMISSION_MASK.TRADE_ONLY,
        description:
          'Place, modify and cancel orders. Per SoDEX docs it cannot withdraw or transfer - not yet verified end to end.',
        recommended: true,
      },
      {
        id: 'trading-transfer',
        label: 'Trading + transfers',
        permissions: disableAllBut(APIKeyPermission.TRADE | APIKeyPermission.TRANSFER),
        description:
          'Adds sub-account and internal transfers. SoDEX does not document any limit on the destination account, so treat this as able to move funds away.',
        dangerous: true,
      },
      {
        id: 'full',
        label: 'Trading + transfers + withdrawal',
        permissions: disableAllBut(
          APIKeyPermission.TRADE | APIKeyPermission.TRANSFER | APIKeyPermission.WITHDRAW,
        ),
        description:
          'Adds on-chain withdrawal and spot <-> perps moves. Anyone who obtains this key can drain the account.',
        dangerous: true,
      },
    ],
    semantics: 'a set bit disables the permission',
    bits: Object.entries(APIKeyPermission).map(([name, bit]) => ({
      name: name.toLowerCase(),
      bit,
    })),
  }));

  // -- account discovery -----------------------------------------------------

  app.get('/api/wallet/account', async (req, reply) => {
    const { address } = req.query as { address?: string };
    if (!address || !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'a valid 0x address is required' });
    }
    const [spot, perps, keys] = await Promise.all([
      sodex.get<any>(`${enginePath('spot')}/accounts/${address}/state`).catch(() => null),
      sodex.get<any>(`${enginePath('perps')}/accounts/${address}/state`).catch(() => null),
      sodex.get<any[]>(`${enginePath('spot')}/accounts/${address}/api-keys`).catch(() => []),
    ]);
    const accountId = spot?.aid || perps?.aid || 0;
    return {
      address,
      accountId,
      // aid 0 means SoDEX has never seen a deposit from this wallet.
      exists: accountId !== 0,
      network: NETWORK,
      apiKeys: (keys ?? []).map((k) => ({
        name: k.name, type: k.type, publicKey: k.publicKey,
        expiresAt: k.expiresAt, permissions: k.permissions,
      })),
      spotState: spot,
      perpsState: perps,
    };
  });

  // -- restricted API key creation ------------------------------------------

  /**
   * Step 1: generate a keypair and return the typed data for the wallet to sign.
   * The private key stays here, in memory, until step 2 succeeds.
   */
  app.post('/api/wallet/apikey/prepare', async (req, reply) => {
    const b = req.body as {
      address?: string; accountId?: number; name?: string;
      permissions?: number; expiresAt?: number;
      signatureChainId?: number; engine?: Engine;
    };
    if (!b?.address || !ADDRESS_RE.test(b.address)) {
      return reply.code(400).send({ error: 'a valid 0x address is required' });
    }
    const blocked = mintingBlockedReason();
    if (blocked) return reply.code(409).send({ error: blocked });
    const name = b.name ?? `valuetrade-${Date.now().toString(36)}`;
    if (!KEY_NAME_RE.test(name)) {
      return reply.code(400).send({ error: `name must match ${KEY_NAME_RE}` });
    }

    let accountId = b.accountId ?? 0;
    if (!accountId) {
      const state = await sodex.get<any>(`${enginePath('spot')}/accounts/${b.address}/state`);
      accountId = state?.aid ?? 0;
    }
    if (!accountId) {
      return reply.code(400).send({
        error: 'this wallet has no SoDEX account yet. Deposit once to create one, then retry.',
      });
    }

    // Default to trade-only. A key that can withdraw is opt-in, never implicit.
    const permissions = b.permissions ?? PERMISSION_MASK.TRADE_ONLY;
    if (!isPermissionedKeyMask(permissions)) {
      return reply.code(400).send({
        error:
          'permissions is a mask of DISABLED bits - TRADE(1) | CANCEL(2) | WITHDRAW(4) | TRANSFER(8) - ' +
          `and must disable TRADE, CANCEL or both; got ${permissions}`,
      });
    }
    const expiresAt = b.expiresAt ?? 0;
    const { privateKey, address: keyAddress } = generateKey();
    const nonce = BigInt(Date.now());
    const signatureChainId = b.signatureChainId ?? NET.chainId;
    const engine: Engine = b.engine === 'perps' ? 'perps' : 'spot';

    setPending({
      privateKey, keyAddress, address: b.address, accountId, name,
      permissions, expiresAt, nonce, signatureChainId, engine, createdAt: Date.now(),
      // Memory, like every other path. The scope picker still matters - a
      // session-long transfer-capable key is a legitimate choice - but it is
      // never written down, so there is no ciphertext to steal and no passphrase
      // to forget.
      protection: 'memory',
    });

    return {
      keyAddress,
      name,
      accountId,
      // Echoed back so /complete can name WHICH pending enrollment it finishes -
      // several wallets can be mid-enrollment at once.
      address: b.address,
      permissions,
      permissionNames: describePermissions(permissions),
      expiresAt,
      nonce: nonce.toString(),
      canWithdraw: permits(permissions, APIKeyPermission.WITHDRAW),
      canTransfer: permits(permissions, APIKeyPermission.TRANSFER),
      typedData: permissionedAPIKeyTypedData(
        { accountID: accountId, name, publicKey: keyAddress, expiresAt, permissions, keyType: APIKeyType.EVM },
        NET.chainId,
        nonce,
        signatureChainId,
      ),
    };
  });

  /**
   * Step 2: relay the wallet's signature to SoDEX, then install the key.
   *
   * For the one-click flow (`protection: 'memory'`) "install" means exactly
   * that: the key goes into this process's session map and NOWHERE else. There
   * is no keystore write, so there is no file to steal, sync, back up or
   * decrypt, and closing the app destroys it.
   *
   * The Advanced flows still persist, and for those the keystore is only written
   * after the gateway accepts the registration - a failed attempt never leaves
   * an unusable key on disk.
   */
  app.post('/api/wallet/apikey/complete', async (req, reply) => {
    const b = req.body as { signature?: string; passphrase?: string; address?: string };
    if (b?.address && !ADDRESS_RE.test(b.address)) {
      return reply.code(400).send({ error: 'address must be a valid 0x address' });
    }
    const p = pendingFor(b?.address);
    if (!p) {
      return reply.code(400).send({
        error:
          !b?.address && pending.size > 1
            ? 'several API-key enrollments are in flight - pass the wallet address this signature is for'
            : 'no pending API key - call /prepare first (or it expired)',
      });
    }
    if (!b?.signature) return reply.code(400).send({ error: 'signature is required' });

    let wire: string;
    try {
      wire = walletSignatureToWire(b.signature);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const body = permissionedAPIKeyBody({
      accountID: p.accountId, name: p.name, publicKey: p.keyAddress,
      expiresAt: p.expiresAt, permissions: p.permissions, keyType: APIKeyType.EVM,
    });

    try {
      await sodex.relay(`${enginePath(p.engine)}/accounts/api-keys`, body, {
        'X-API-Sign': wire,
        'X-API-Nonce': p.nonce.toString(),
        'X-API-Chain': String(NET.chainId),
      });
    } catch (e) {
      const err = e as SodexApiError;
      return reply.code(400).send({ error: err.message, code: err.code, hint: err.hint });
    }

    const meta: ks.KeystoreMeta = {
      apiKeyName: p.name, accountId: p.accountId, address: p.address,
      keyAddress: p.keyAddress, network: NETWORK, permissions: p.permissions,
      expiresAt: p.expiresAt, createdAt: Date.now(), protection: p.protection,
    };
    // No branch here any more: NOTHING is written to disk, ever. The only
    // install path is into this process's memory.
    applySession(p.privateKey, meta);
    pending.delete(ks.addressKey(p.address));

    return {
      created: true,
      session: sodex.sessionInfo(),
      keyAddress: meta.keyAddress,
      name: meta.apiKeyName,
      address: meta.address,
      protection: p.protection,
      permissionNames: describePermissions(p.permissions),
      accounts: accountRows(),
    };
  });

  /**
   * One-click enable, step 1.
   *
   * No key name, no scope picker, no passphrase: a name is generated, the scope
   * is everything a trading UI needs, and the key will be encrypted under this
   * machine's device secret. The user's only job is to approve one signature.
   */
  app.post('/api/wallet/enable', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: string; signatureChainId?: number };
    if (!b.address || !ADDRESS_RE.test(b.address)) {
      return reply.code(400).send({ error: 'a valid 0x address is required' });
    }
    const blocked = mintingBlockedReason();
    if (blocked) return reply.code(409).send({ error: blocked });

    const state = await sodex.get<any>(`${enginePath('spot')}/accounts/${b.address}/state`);
    const accountId = state?.aid ?? 0;
    if (!accountId) {
      return reply.code(400).send({
        error: 'This wallet has no SoDEX account yet. Register once at sodex.com, then come back.',
      });
    }

    const name = `valuetrade-${Date.now().toString(36)}`;
    const { privateKey, address: keyAddress } = generateKey();
    const nonce = BigInt(Date.now());
    const signatureChainId = checkSignatureChainId(b.signatureChainId) ?? NET.chainId;
    const expiresAt = Date.now() + SESSION_TTL_MS;

    setPending({
      privateKey, keyAddress, address: b.address, accountId, name,
      permissions: SESSION_PERMISSIONS, expiresAt, nonce, signatureChainId,
      engine: 'spot', createdAt: Date.now(), protection: 'memory',
    });

    return {
      name,
      keyAddress,
      accountId,
      address: b.address,
      permissions: SESSION_PERMISSIONS,
      permissionNames: describePermissions(SESSION_PERMISSIONS),
      expiresAt,
      expiresInHours: Math.round(SESSION_TTL_MS / 3_600_000),
      // Shown next to the wallet prompt. The wallet renders `permissions` as a
      // bare integer, so this is the only place the user can read what the
      // signature actually grants.
      grants:
        'Place, modify and cancel orders, for 24 hours. Withdrawal and transfer are disabled on this ' +
        'key (your wallet shows that as permissions: 14). It is never written to disk.',
      typedData: permissionedAPIKeyTypedData(
        { accountID: accountId, name, publicKey: keyAddress, expiresAt, permissions: SESSION_PERMISSIONS, keyType: APIKeyType.EVM },
        NET.chainId,
        nonce,
        signatureChainId,
      ),
    };
  });

  /** Revoke a key. Signed by the named account's key, or the active one. */
  app.post('/api/wallet/apikey/revoke', async (req, reply) => {
    const { name, address } = (req.body ?? {}) as { name?: string; address?: string };
    if (address && !ADDRESS_RE.test(address)) {
      return reply.code(400).send({ error: 'address must be a valid 0x address' });
    }
    const s = sodex.requireSession(address);
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const { revokeAPIKey, ACTION } = await import('../signing/actions.js');
    const result = await sodex.post(
      'spot',
      '/accounts/api-keys/revoke',
      ACTION.revokeAPIKey,
      revokeAPIKey(s.accountId, name),
      // Sign with the same account we resolved above, not whatever is active by
      // the time the request reaches the wire.
      s.address,
    );
    // We just revoked ourselves. Only THAT account loses its session; the other
    // unlocked wallets are unaffected.
    if (name === s.apiKeyName) sodex.lockAccount(s.address);
    return { revoked: name, address: s.address, result, accounts: accountRows() };
  });

}
