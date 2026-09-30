/**
 * Master-wallet-signed API-key lifecycle: registration, builder approval and
 * revocation - PREPARED here (typed data + the unsigned request), SIGNED by the
 * user's wallet (`eth_signTypedData_v4`), then ASSEMBLED here into the final
 * request. Nothing in this module sends anything.
 *
 *   const prepared = prepareApiKeyRegistration({...});
 *   const sig = await wallet.signTypedData(JSON.stringify(prepared.typedData)); // app code
 *   const req = assembleWalletSignedRequest(prepared, sig);                      // checks the signer
 *   await fetch(req.path, { method: req.method, headers: req.headers, body: req.body }); // app code
 *
 * Routes, and how sure we are about each:
 *
 *   REGISTRATION
 *   - 'exchange' (PRODUCTION, use this): POST /api/v1/{spot,perps}/exchange, body
 *     {type:'addAPIKey', params, nonce, signature, signatureChainID}, typed data
 *     UserSignedAddAPIKeyAction with the WALLET's chain as the domain - exactly
 *     what sodex.com's web app sends for every user (its bundle, 2026-09-26).
 *     One signature, no network switch. Pinned by Go SDK vectors
 *     (SignAddAPIKeyRequest with a wallet chain) and cross-checked with viem.
 *   - 'user' (DOCUMENTED, REJECTED LIVE): POST /api/v1/user/{addr}/api-keys with
 *     AddAPIKey under the universal domain. The engines verify a 0x02
 *     registration as UserSignedAddAPIKeyAction, recover a stranger and answer
 *     "spot: API key error: API key not found" (seen on mainnet 2026-09-26).
 *     Kept for AddAPIKeyWithBuilder / the permissioned action, whose typed data
 *     already carries the message chainID.
 *   - 'engine' (OPENTRADE LEGACY): POST /api/v1/{engine}/accounts/api-keys with
 *     UserSignedAddPermissionedAPIKeyAction, as Opentrade's routes/wallet.ts does.
 *     One engine per call; permissioned keys only; Opentrade sends X-API-Chain =
 *     the SoDEX chain id while the domain uses the wallet's chain, which the
 *     current docs say must be equal. The signature layer was accepted on testnet
 *     in Aug 2026 (Opentrade NOTES.md) - that is all that is known.
 *
 *   REVOCATION (three candidates; none exercised by this codebase)
 *   - 'engine-delete' (DOCUMENTED): DELETE /api/v1/{engine}/accounts/api-keys,
 *     MASTER wallet, ExchangeAction under the engine domain (0x01). Once per
 *     engine. The payload/signature bytes are pinned by Go vectors
 *     (perps_revoke_api_key, spot_revoke_api_key).
 *   - 'engine-post-revoke' (OPENTRADE, UNDOCUMENTED): POST
 *     /api/v1/{engine}/accounts/api-keys/revoke. Opentrade signs it with the API
 *     key itself; the docs require the master wallet. UNVERIFIED and probably wrong.
 *   - 'user-delete-universal' (PYTHON SDK 2026-09-08): DELETE
 *     /api/v1/user/{addr}/api-keys, ExchangeAction under the UNIVERSAL domain
 *     (0x02). CONTRADICTS the public API page ("a universal 0x02 signature cannot
 *     be used for revocation"). UNVERIFIED.
 */
import {
  ACTION,
  MAX_BUILDER_APPROVAL_RATE,
  revokeAPIKey,
  type U64,
} from './actions.ts';
import {
  SignatureType,
  actionPayloadHash,
  bytesToHex,
  exchangeActionTypedData,
  goJSONStringify,
  hashTypedData,
  hexToBytes,
  isAddress,
  recoverAddress,
  sameAddress,
  type Hex,
  type TypedData,
} from './eip712.ts';
import { assertApiKeyName, assertShortExpiry } from './keys.ts';
import {
  DEFAULT_RELAY_BASE,
  DomainName,
  assertSodexChainId,
  enginePath,
  engineDomainName,
  userPath,
  type Engine,
} from './network.ts';
import { DEFAULT_NONCE_WINDOW_MARGIN_MS, assertNonceInWindow } from './nonce.ts';
import { assertPermissionedMask, assertRegistrationScope } from './permissions.ts';
import { HEADER, SigningError } from './request.ts';
import {
  APIKeyType,
  addAPIKeyTypedData,
  addAPIKeyWithBuilderTypedData,
  approveBuilderFeeTypedData,
  permissionedAPIKeyTypedData,
  userSignedAddAPIKeyTypedData,
  walletSignatureToWire,
} from './userSigned.ts';

export type WalletActionKind =
  | 'addAPIKey'
  | 'addAPIKeyWithBuilder'
  | 'addPermissionedAPIKey'
  | 'approveBuilderFee'
  | 'revokeAPIKey';

export type WalletRoute = 'user' | 'engine' | 'engine-delete' | 'engine-post-revoke' | 'user-delete-universal';

/** How far each route is established. Surface this in the UI/logs, do not hide it. */
export type RouteConfidence = 'documented' | 'opentrade-legacy' | 'python-sdk' | 'undocumented';

export interface PreparedWalletAction<K extends WalletActionKind = WalletActionKind> {
  kind: K;
  route: WalletRoute;
  confidence: RouteConfidence;
  /** Caveats that apply to this exact request. Empty means "documented, nothing extra known". */
  caveats: string[];
  /** Hand to `eth_signTypedData_v4` as `JSON.stringify(typedData)`. */
  typedData: TypedData;
  /** What the wallet's signature must recover against. */
  digest: Hex;
  /** Wire type byte this signature gets: 1 (engine domain) or 2 (universal). */
  signatureType: 1 | 2;
  nonce: string;
  /** The master wallet that must sign (lower-case). */
  expectedSigner: Hex;
  /** Everything except X-API-Sign. */
  request: {
    method: 'POST' | 'DELETE';
    gatewayPath: string;
    headers: Record<string, string>;
    body: string;
  };
}

export interface WalletSignedRequest {
  method: 'POST' | 'DELETE';
  path: string;
  gatewayPath: string;
  headers: Record<string, string>;
  body: string;
}

interface CommonInput {
  /** The master wallet (the SoDEX account owner). */
  userAddress: string;
  /** Master-wallet nonce, ms. Allocate with a NonceManager under nonceKey(userAddress, sodexChainId). */
  nonce: bigint | number;
  /** 286623 (mainnet) or 138565 (testnet). */
  sodexChainId: number;
  /** Clock for the nonce-window and expiry checks. Default Date.now(). */
  now?: number;
}

function checkCommon(i: CommonInput): { user: Hex; nonce: bigint; now: number } {
  if (!isAddress(i.userAddress)) throw new SigningError('userAddress must be the master wallet 0x address');
  assertSodexChainId(i.sodexChainId);
  const now = i.now ?? Date.now();
  const nonce = assertNonceInWindow(i.nonce, now, DEFAULT_NONCE_WINDOW_MARGIN_MS);
  return { user: i.userAddress.toLowerCase() as Hex, nonce, now };
}

function positiveChain(v: number | undefined, fallback: number, what: string): number {
  const c = v ?? fallback;
  if (!Number.isSafeInteger(c) || c <= 0) throw new SigningError(`${what} must be a positive integer chain id`);
  return c;
}

const baseHeaders = (nonce: bigint, xApiChain: number): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  [HEADER.nonce]: nonce.toString(),
  [HEADER.chain]: String(xApiChain),
});

// ---------------------------------------------------------------------------
// Registration - documented user route
// ---------------------------------------------------------------------------

export interface RegisterApiKeyInput extends CommonInput {
  /** Primary (or owned sub-) account id: state.aid / subaccounts.primaryAccountID. */
  accountID: U64;
  /** Key name - becomes X-API-Key. PUBLIC: anyone can list an address's key names. */
  name: string;
  /** The TRADING key's EVM address. Must differ from the master wallet. */
  publicKey: string;
  /** Expiry in MILLISECONDS. Short by policy: see keys.expiryProblem. */
  expiresAt: number;
  /**
   * Approve a builder fee in the same signature (AddAPIKeyWithBuilder).
   * HTTP `builder.fee` == EIP-712 `maxFeeRate`, 0..2000 tenths of a bp.
   * Mutually exclusive with `permissions`.
   */
  builder?: { id: U64; maxFeeRate: number };
  /**
   * A DISABLE mask (permissions.ts). Must disable TRADE or CANCEL - so a
   * permissioned key cannot be a normal trading key. Omit for the browser key.
   */
  permissions?: number;
  /**
   * EIP-712 domain chainId == X-API-Chain. For builder/permissioned actions this
   * is the WALLET's current chain (default: sodexChainId). For ordinary AddAPIKey
   * the docs say to use the SoDEX network id (the default).
   */
  signatureChainId?: number;
  /** Expiry policy override (default: <= 7 days, never 0). */
  expiryPolicy?: { maxTtlMs?: number; allowNeverExpires?: boolean };
}

export function prepareApiKeyRegistration(
  i: RegisterApiKeyInput,
): PreparedWalletAction<'addAPIKey' | 'addAPIKeyWithBuilder' | 'addPermissionedAPIKey'> {
  const { user, nonce, now } = checkCommon(i);
  assertApiKeyName(i.name);
  if (!isAddress(i.publicKey)) throw new SigningError('publicKey must be the trading key EVM address');
  if (sameAddress(i.publicKey, user)) {
    throw new SigningError('the trading key must be a separate key, not the master wallet');
  }
  assertRegistrationScope({ builder: i.builder, permissions: i.permissions });
  assertShortExpiry(i.expiresAt, { now, ...i.expiryPolicy });
  const publicKey = i.publicKey.toLowerCase();
  const fields = { accountID: i.accountID, name: i.name, publicKey, expiresAt: i.expiresAt, keyType: APIKeyType.EVM };
  const caveats: string[] = [];

  let kind: 'addAPIKey' | 'addAPIKeyWithBuilder' | 'addPermissionedAPIKey';
  let typedData: TypedData;
  let chain: number;
  let body: Record<string, unknown>;
  const bodyBase = {
    accountID: i.accountID,
    name: i.name,
    type: APIKeyType.EVM,
    publicKey,
    expiresAt: i.expiresAt,
  };

  if (i.builder) {
    const id = i.builder.id;
    if (id === 0 || id === 0n) throw new SigningError('builder.id must be non-zero');
    checkApprovalRate(i.builder.maxFeeRate);
    kind = 'addAPIKeyWithBuilder';
    chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
    typedData = addAPIKeyWithBuilderTypedData(
      { ...fields, builderID: id, maxFeeRate: i.builder.maxFeeRate },
      i.sodexChainId,
      nonce,
      chain,
    );
    body = { ...bodyBase, builder: { id, fee: i.builder.maxFeeRate } };
    caveats.push(
      'Registers an ORDINARY key (no permissions field): per SoDEX docs it can also move funds between the ' +
        "owner's own engines and EVM wallet. Unverified.",
      'Approves the builder fee on BOTH engines in the same action; max 10 active approvals per user.',
    );
  } else if (i.permissions !== undefined) {
    const mask = assertPermissionedMask(i.permissions);
    kind = 'addPermissionedAPIKey';
    chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
    typedData = permissionedAPIKeyTypedData({ ...fields, permissions: mask }, i.sodexChainId, nonce, chain);
    body = { ...bodyBase, permissions: mask };
    caveats.push('Permission-mask ENFORCEMENT is documented, not observed by this codebase.');
  } else {
    kind = 'addAPIKey';
    chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
    typedData = addAPIKeyTypedData(fields, nonce, chain);
    body = bodyBase;
    caveats.push(
      'ORDINARY key: per SoDEX docs it can trade AND move funds between the owner\'s own engines and EVM wallet. Unverified.',
      'The domain chainId is the SoDEX network id, so wallets that enforce "domain chainId == active chain" ' +
        '(MetaMask does) must be switched to ValueChain first. AddAPIKeyWithBuilder avoids this.',
    );
    if (chain !== i.sodexChainId) {
      caveats.push('domain chainId differs from the SoDEX network id; the docs say to use the network id. Unverified.');
    }
  }

  return {
    kind,
    route: 'user',
    confidence: 'documented',
    caveats,
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712Universal,
    nonce: nonce.toString(),
    expectedSigner: user,
    request: {
      method: 'POST',
      gatewayPath: `${userPath(user)}/api-keys`,
      headers: baseHeaders(nonce, chain),
      body: goJSONStringify(body),
    },
  };
}

function checkApprovalRate(rate: number): void {
  if (!Number.isInteger(rate) || rate < 0 || rate > MAX_BUILDER_APPROVAL_RATE) {
    throw new SigningError(`maxFeeRate must be an integer 0..${MAX_BUILDER_APPROVAL_RATE} (tenths of a bp)`);
  }
}

// ---------------------------------------------------------------------------
// Registration - Opentrade's engine route (legacy, permissioned only)
// ---------------------------------------------------------------------------

export interface EngineRegisterApiKeyInput extends CommonInput {
  engine: Engine;
  accountID: U64;
  name: string;
  publicKey: string;
  expiresAt: number;
  /** REQUIRED here: this route only exists for UserSignedAddPermissionedAPIKeyAction. */
  permissions: number;
  /** The wallet's chain (EIP-712 domain). Default sodexChainId. */
  signatureChainId?: number;
  expiryPolicy?: { maxTtlMs?: number; allowNeverExpires?: boolean };
}

/**
 * Opentrade's routes/wallet.ts flow, reproduced faithfully except for the mask
 * semantics: POST /api/v1/{engine}/accounts/api-keys, permissioned typed data,
 * headers X-API-Sign / X-API-Nonce / X-API-Chain (= SoDEX chain id, as
 * Opentrade relays it). The mask is validated as a DISABLE mask, so Opentrade's
 * old "trade-only" mask 3 is accepted only for what it really is (TRADE and
 * CANCEL disabled). Not for the browser trading key.
 */
export function prepareEngineApiKeyRegistration(i: EngineRegisterApiKeyInput): PreparedWalletAction<'addPermissionedAPIKey'> {
  const { user, nonce, now } = checkCommon(i);
  assertApiKeyName(i.name);
  if (!isAddress(i.publicKey)) throw new SigningError('publicKey must be the trading key EVM address');
  if (sameAddress(i.publicKey, user)) throw new SigningError('the trading key must be a separate key');
  const mask = assertPermissionedMask(i.permissions);
  assertShortExpiry(i.expiresAt, { now, ...i.expiryPolicy });
  const walletChain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
  const publicKey = i.publicKey.toLowerCase();
  const typedData = permissionedAPIKeyTypedData(
    { accountID: i.accountID, name: i.name, publicKey, expiresAt: i.expiresAt, permissions: mask, keyType: APIKeyType.EVM },
    i.sodexChainId,
    nonce,
    walletChain,
  );
  const caveats = [
    'Opentrade legacy route: registers on ONE engine only; the documented route registers on both.',
    'Permission-mask ENFORCEMENT is documented, not observed by this codebase.',
  ];
  if (walletChain !== i.sodexChainId) {
    caveats.push(
      'X-API-Chain carries the SoDEX chain id while the domain uses the wallet chain (Opentrade behaviour); ' +
        'the current docs require them to be equal. Unverified.',
    );
  }
  return {
    kind: 'addPermissionedAPIKey',
    route: 'engine',
    confidence: 'opentrade-legacy',
    caveats,
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712Universal,
    nonce: nonce.toString(),
    expectedSigner: user,
    request: {
      method: 'POST',
      gatewayPath: `${enginePath(i.engine)}/accounts/api-keys`,
      headers: baseHeaders(nonce, i.sodexChainId),
      body: goJSONStringify({
        accountID: i.accountID,
        name: i.name,
        type: APIKeyType.EVM,
        publicKey,
        expiresAt: i.expiresAt,
        permissions: mask,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Builder fee approval - POST /api/v1/user/{addr}/builders
// ---------------------------------------------------------------------------

export interface ApproveBuilderFeeInput extends CommonInput {
  /** The user's PRIMARY account id. */
  accountID: U64;
  /** The builder's account id (non-zero). */
  builderID: U64;
  /** 0..2000 tenths of a bp; 0 CLEARS the approval. */
  maxFeeRate: number;
  /** The wallet's chain == X-API-Chain. Default sodexChainId. */
  signatureChainId?: number;
}

export function prepareBuilderFeeApproval(i: ApproveBuilderFeeInput): PreparedWalletAction<'approveBuilderFee'> {
  const { user, nonce } = checkCommon(i);
  if (i.builderID === 0 || i.builderID === 0n) throw new SigningError('builderID must be non-zero');
  checkApprovalRate(i.maxFeeRate);
  const chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
  const typedData = approveBuilderFeeTypedData(
    { accountID: i.accountID, builderID: i.builderID, maxFeeRate: i.maxFeeRate },
    i.sodexChainId,
    nonce,
    chain,
  );
  return {
    kind: 'approveBuilderFee',
    route: 'user',
    confidence: 'documented',
    caveats: [
      'The builder must hold >= 100 vUSDC in BOTH spot and perps, checked on approval and on clearing.',
      'Succeeds only when both engines accept; queries may lag - re-query both before retrying.',
    ],
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712Universal,
    nonce: nonce.toString(),
    expectedSigner: user,
    request: {
      method: 'POST',
      gatewayPath: `${userPath(user)}/builders`,
      headers: baseHeaders(nonce, chain),
      body: goJSONStringify({ accountID: i.accountID, builderID: i.builderID, maxFeeRate: i.maxFeeRate }),
    },
  };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type RevocationRoute = 'engine-delete' | 'engine-post-revoke' | 'user-delete-universal';

export interface RevokeApiKeyInput extends CommonInput {
  route: RevocationRoute;
  /** Required for the engine routes. */
  engine?: Engine;
  accountID: U64;
  name: string;
  /** Universal route only: the domain chainId / X-API-Chain. Default sodexChainId (as the Python SDK does). */
  signatureChainId?: number;
}

export function prepareApiKeyRevocation(i: RevokeApiKeyInput): PreparedWalletAction<'revokeAPIKey'> {
  const { user, nonce } = checkCommon(i);
  assertApiKeyName(i.name);
  const params = revokeAPIKey(i.accountID, i.name);
  const payloadHash = actionPayloadHash(ACTION.revokeAPIKey, params);
  const body = goJSONStringify(params);

  if (i.route === 'user-delete-universal') {
    const chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
    const typedData = exchangeActionTypedData(DomainName.universal, chain, payloadHash, nonce);
    return {
      kind: 'revokeAPIKey',
      route: i.route,
      confidence: 'python-sdk',
      caveats: [
        'Python SDK route (2026-09-08). The public API page says a universal 0x02 signature cannot be used ' +
          'for revocation. UNVERIFIED - may be rejected.',
      ],
      typedData,
      digest: bytesToHex(hashTypedData(typedData)),
      signatureType: SignatureType.EIP712Universal,
      nonce: nonce.toString(),
      expectedSigner: user,
      request: { method: 'DELETE', gatewayPath: `${userPath(user)}/api-keys`, headers: baseHeaders(nonce, chain), body },
    };
  }

  if (!i.engine) throw new SigningError(`route ${i.route} needs an engine`);
  const typedData = exchangeActionTypedData(engineDomainName(i.engine), i.sodexChainId, payloadHash, nonce);
  const documented = i.route === 'engine-delete';
  return {
    kind: 'revokeAPIKey',
    route: i.route,
    confidence: documented ? 'documented' : 'undocumented',
    caveats: documented
      ? [
          'Documented route; revokes on THIS engine only - revoke on spot AND perps.',
          'The master wallet signs under the engine domain with the SoDEX chain id, so wallets that enforce ' +
            '"domain chainId == active chain" must be on ValueChain. Route not exercised by this codebase.',
        ]
      : [
          "Opentrade's undocumented POST .../revoke route. UNVERIFIED; Opentrade signed it with the API key " +
            'itself, which the docs do not allow. Prefer engine-delete.',
        ],
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712,
    nonce: nonce.toString(),
    expectedSigner: user,
    request: {
      method: documented ? 'DELETE' : 'POST',
      gatewayPath: `${enginePath(i.engine)}/accounts/api-keys${documented ? '' : '/revoke'}`,
      headers: baseHeaders(nonce, i.sodexChainId),
      body,
    },
  };
}

/**
 * The documented revocation needs one request per engine, each with its OWN
 * master-wallet nonce: allocate both from the NonceManager (do not derive the
 * second as `first + 1` - the manager would not know it was used). Returns
 * [spot, perps]; the wallet is prompted twice.
 */
export function prepareApiKeyRevocationBothEngines(
  i: Omit<RevokeApiKeyInput, 'route' | 'engine' | 'nonce'> & {
    nonces: readonly [spot: bigint | number, perps: bigint | number];
  },
): [PreparedWalletAction<'revokeAPIKey'>, PreparedWalletAction<'revokeAPIKey'>] {
  const { nonces, ...rest } = i;
  if (BigInt(nonces[0]) === BigInt(nonces[1])) throw new SigningError('the two revocations need distinct nonces');
  return [
    prepareApiKeyRevocation({ ...rest, route: 'engine-delete', engine: 'spot', nonce: nonces[0] }),
    prepareApiKeyRevocation({ ...rest, route: 'engine-delete', engine: 'perps', nonce: nonces[1] }),
  ];
}

// ---------------------------------------------------------------------------
// The engine `/exchange` route - what sodex.com's own web app runs
// ---------------------------------------------------------------------------

/**
 * A master-wallet action sent to each engine's `/api/v1/{spot,perps}/exchange`
 * as ONE JSON body `{type, params, nonce, signature, signatureChainID?}` - no
 * X-API-* headers. This is how sodex.com registers its `webkey`/`mobilekey`
 * and revokes keys for every user (read off its production bundle, 2026-09-26),
 * so it is the route with the strongest evidence of working for any account.
 * The documented user route (`prepareApiKeyRegistration`) signs AddAPIKey, which
 * the engines verify as a different struct: "API key error: API key not found".
 */
export interface PreparedExchangeAction {
  kind: 'addAPIKey' | 'revokeAPIKey';
  route: 'exchange';
  /** Hand to `eth_signTypedData_v4` as `JSON.stringify(typedData)`. */
  typedData: TypedData;
  digest: Hex;
  /** 2 (universal) for the registration, 1 (engine domain) for a revocation. */
  signatureType: 1 | 2;
  nonce: string;
  /** The master wallet that must sign (lower-case). */
  expectedSigner: Hex;
  /** Which engines receive the body. */
  engines: readonly Engine[];
  /** The body without `signature` (inserted by `assembleExchangeRequests`). */
  envelope: { type: string; params: Record<string, unknown>; nonce: number; signatureChainID?: number };
}

export interface ExchangeRegistrationInput extends CommonInput {
  /** The PRIMARY account id (subaccounts.primaryAccountID). */
  accountID: number;
  /** Key name - becomes X-API-Key. Registering an existing name REPLACES that key. */
  name: string;
  /** The TRADING key's EVM address. Must differ from the master wallet. */
  publicKey: string;
  /** Expiry in MILLISECONDS (sodex.com: nonce + 7 days). */
  expiresAt: number;
  /** The wallet's CURRENT chain: the EIP-712 domain. Nothing needs switching. */
  signatureChainId: number;
  /** Default: both, as sodex.com does. */
  engines?: readonly Engine[];
  expiryPolicy?: { maxTtlMs?: number; allowNeverExpires?: boolean };
}

/** Register an ordinary trading key on both engines with ONE wallet signature. */
export function prepareApiKeyRegistrationExchange(i: ExchangeRegistrationInput): PreparedExchangeAction {
  const { user, nonce, now } = checkCommon(i);
  assertApiKeyName(i.name);
  if (!Number.isSafeInteger(i.accountID) || i.accountID <= 0) throw new SigningError('accountID must be a positive account id');
  if (!isAddress(i.publicKey)) throw new SigningError('publicKey must be the trading key EVM address');
  if (sameAddress(i.publicKey, user)) throw new SigningError('the trading key must be a separate key, not the master wallet');
  assertShortExpiry(i.expiresAt, { now, ...i.expiryPolicy });
  const chain = positiveChain(i.signatureChainId, i.sodexChainId, 'signatureChainId');
  const publicKey = i.publicKey.toLowerCase();
  const typedData = userSignedAddAPIKeyTypedData(
    { accountID: i.accountID, name: i.name, publicKey, expiresAt: i.expiresAt, keyType: APIKeyType.EVM },
    i.sodexChainId,
    nonce,
    chain,
  );
  return {
    kind: 'addAPIKey',
    route: 'exchange',
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712Universal,
    nonce: nonce.toString(),
    expectedSigner: user,
    engines: i.engines ?? ['spot', 'perps'],
    envelope: {
      type: 'addAPIKey',
      params: { accountID: i.accountID, name: i.name, type: APIKeyType.EVM, publicKey, expiresAt: i.expiresAt },
      nonce: Number(nonce),
      signatureChainID: chain,
    },
  };
}

/**
 * Revoke a key on ONE engine: the master wallet signs an ExchangeAction under
 * that engine's domain on the SoDEX chain (so the wallet must be on ValueChain),
 * one signature per engine - the same bytes as the documented DELETE route,
 * delivered the way sodex.com delivers them.
 */
export function prepareApiKeyRevocationExchange(
  i: CommonInput & { engine: Engine; accountID: number; name: string },
): PreparedExchangeAction {
  const { user, nonce } = checkCommon(i);
  assertApiKeyName(i.name);
  const params = revokeAPIKey(i.accountID, i.name);
  const payloadHash = actionPayloadHash(ACTION.revokeAPIKey, params);
  const typedData = exchangeActionTypedData(engineDomainName(i.engine), i.sodexChainId, payloadHash, nonce);
  return {
    kind: 'revokeAPIKey',
    route: 'exchange',
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    signatureType: SignatureType.EIP712,
    nonce: nonce.toString(),
    expectedSigner: user,
    engines: [i.engine],
    envelope: { type: 'revokeAPIKey', params: { accountID: i.accountID, name: i.name }, nonce: Number(nonce) },
  };
}

export interface ExchangeRequest {
  engine: Engine;
  method: 'POST';
  path: string;
  gatewayPath: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Attach the wallet's signature and return one POST per engine. The signature
 * is RECOVERED first: a wallet that signed as another account, or hashed the
 * typed data differently, is refused here rather than as a gateway error.
 */
export function assembleExchangeRequests(
  prepared: PreparedExchangeAction,
  walletSignature: string,
  opts: { base?: string } = {},
): ExchangeRequest[] {
  const wire = walletSignatureToWire(walletSignature, prepared.signatureType);
  const signer = recoverAddress(hexToBytes(prepared.digest), hexToBytes(wire).slice(1));
  if (!sameAddress(signer, prepared.expectedSigner)) {
    throw new SigningError(
      `the wallet signed as ${signer}, but this action must be signed by the account owner ${prepared.expectedSigner}`,
    );
  }
  const { type, params, nonce, signatureChainID } = prepared.envelope;
  const body = JSON.stringify(
    signatureChainID === undefined ? { type, params, nonce, signature: wire } : { type, params, nonce, signature: wire, signatureChainID },
  );
  const base = (opts.base ?? DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  return prepared.engines.map((engine) => {
    const gatewayPath = `${enginePath(engine)}/exchange`;
    return {
      engine,
      method: 'POST' as const,
      path: base + gatewayPath,
      gatewayPath,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Attach the wallet's signature and return the final request.
 *
 * `walletSignature` is what `eth_signTypedData_v4` returned (65 bytes, v 27/28
 * or 0/1). It is converted to the wire format with this action's type byte and
 * RECOVERED against the prepared digest: a signature from any address other
 * than `prepared.expectedSigner` (wrong account selected in the wallet, a
 * wallet that hashed differently) is refused here instead of as an opaque
 * gateway error.
 */
export function assembleWalletSignedRequest(
  prepared: PreparedWalletAction,
  walletSignature: string,
  opts: { base?: string } = {},
): WalletSignedRequest {
  const wire = walletSignatureToWire(walletSignature, prepared.signatureType);
  const signer = recoverAddress(hexToBytes(prepared.digest), hexToBytes(wire).slice(1));
  if (!sameAddress(signer, prepared.expectedSigner)) {
    throw new SigningError(
      `the wallet signed as ${signer}, but this action must be signed by the account owner ${prepared.expectedSigner}`,
    );
  }
  const base = (opts.base ?? DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  return {
    method: prepared.request.method,
    path: base + prepared.request.gatewayPath,
    gatewayPath: prepared.request.gatewayPath,
    headers: { ...prepared.request.headers, [HEADER.sign]: wire },
    body: prepared.request.body,
  };
}
