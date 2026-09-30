/**
 * User-signed (master-wallet) actions: EIP-712 typed data for the "universal"
 * domain, ported from Opentrade/server/src/signing/userSigned.ts and extended
 * with the documented AddAPIKey, AddAPIKeyWithBuilder and ApproveBuilderFeeAction.
 *
 * These are the only actions the USER's own wallet ever signs. They are plain
 * EIP-712 typed data, so a browser wallet can sign them with
 * `eth_signTypedData_v4` - the master private key never leaves the wallet.
 *
 * Quirks vs. the exchange actions (authentication-and-signing + builder-codes docs):
 *   1. The domain name is "universal", and its chainId is whatever is sent in
 *      the `X-API-Chain` header. For AddAPIKeyWithBuilder, the permissioned
 *      action and ApproveBuilderFeeAction that is the WALLET's chain; the SoDEX
 *      network id (286623 / 138565) travels in the message's own `chainID`
 *      field instead. Ordinary AddAPIKey has NO message chainID, so the docs
 *      tell you to put the SoDEX network id in the domain (and header).
 *   2. The wire signature is prefixed with SignatureType.EIP712Universal (0x02),
 *      not 0x01, and `v` is normalised from 27/28 to 0/1.
 *   3. The typed message calls the key type `keyType`; the HTTP body calls it `type`.
 *   4. The API key's `publicKey` is its EVM ADDRESS, hashed as `bytes`.
 *
 * Every typed-data object below is checked by tests against the Go SDK's
 * digests through the generic `hashTypedData` (eip712.ts), i.e. the objects
 * themselves - not a parallel hand-rolled hash - produce the bytes the gateway
 * verifies.
 *
 * Reference: common/types/eip712.go, common/signer/evm_signer.go (2026-07-21).
 */
import {
  EIP712_DOMAIN_FIELDS,
  SignatureType,
  ZERO_ADDRESS,
  bytesToHex,
  concat,
  hashTypedData,
  hexToBytes,
  isAddress,
  recoverAddress,
  signDigest,
  type Hex,
  type TypedData,
  type TypedDataField,
} from './eip712.ts';
import { DomainName } from './network.ts';
import type { U64 } from './actions.ts';

/** enums.APIKeyType */
export const APIKeyType = { UNKNOWN: 0, EVM: 1 } as const;

export interface ApiKeyFields {
  /** SoDEX numeric account id (primary or owned sub-account). */
  accountID: U64;
  /** Human-readable key name; later the `X-API-Key` header value. */
  name: string;
  /** The new signing key's EVM ADDRESS (the gateway calls this "publicKey"). */
  publicKey: string;
  /** MILLISECONDS since the epoch. 0 means "never expires". */
  expiresAt: U64;
  keyType?: number;
}

const s = (v: U64 | bigint | number): string => String(v);

function checkPublicKey(publicKey: string): void {
  if (!isAddress(publicKey)) throw new Error('publicKey must be the API key EVM address (0x + 40 hex)');
}

const universalDomain = (chainId: number) => ({
  name: DomainName.universal,
  version: '1',
  chainId,
  verifyingContract: ZERO_ADDRESS,
});

function assertChainId(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`${what} must be a positive integer chain id`);
  return v;
}

// ---------------------------------------------------------------------------
// Type definitions (field order is part of the signature)
// ---------------------------------------------------------------------------

export const ADD_API_KEY_FIELDS: readonly TypedDataField[] = [
  { name: 'accountID', type: 'uint64' },
  { name: 'name', type: 'string' },
  { name: 'keyType', type: 'uint8' },
  { name: 'publicKey', type: 'bytes' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
];

export const ADD_API_KEY_WITH_BUILDER_FIELDS: readonly TypedDataField[] = [
  { name: 'chainID', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
  { name: 'accountID', type: 'uint64' },
  { name: 'name', type: 'string' },
  { name: 'keyType', type: 'uint8' },
  { name: 'publicKey', type: 'bytes' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'builderID', type: 'uint64' },
  { name: 'maxFeeRate', type: 'uint64' },
];

/**
 * `UserSignedAddAPIKeyAction` - the ORDINARY key registration the engines
 * actually verify for a universal (0x02) signature, and the one sodex.com's own
 * web app signs (its `webkey`). Same fields as AddAPIKey, with the SoDEX network
 * id in the message and the nonce second - see `userSignedAddAPIKeyTypedData`.
 */
export const USER_SIGNED_ADD_API_KEY_FIELDS: readonly TypedDataField[] = [
  { name: 'chainID', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
  { name: 'accountID', type: 'uint64' },
  { name: 'name', type: 'string' },
  { name: 'keyType', type: 'uint8' },
  { name: 'publicKey', type: 'bytes' },
  { name: 'expiresAt', type: 'uint64' },
];

export const PERMISSIONED_API_KEY_FIELDS: readonly TypedDataField[] = [
  { name: 'chainID', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
  { name: 'accountID', type: 'uint64' },
  { name: 'name', type: 'string' },
  { name: 'keyType', type: 'uint8' },
  { name: 'publicKey', type: 'bytes' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'permissions', type: 'uint64' },
];

export const APPROVE_BUILDER_FEE_FIELDS: readonly TypedDataField[] = [
  { name: 'chainID', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
  { name: 'accountID', type: 'uint64' },
  { name: 'builderID', type: 'uint64' },
  { name: 'maxFeeRate', type: 'uint64' },
];

// ---------------------------------------------------------------------------
// AddAPIKey - ORDINARY key, documented at POST /api/v1/user/{addr}/api-keys
// ---------------------------------------------------------------------------

/**
 * `AddAPIKey(uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 nonce)`.
 *
 * `domainChainId` is required: pass the SoDEX network id (the docs: "Set
 * domain.chainId and X-API-Chain to the target network"). The header must
 * carry the same value. Because the message has no chainID, this domain value
 * is the only network separation - and wallets that insist the domain chainId
 * equal their active chain must be switched to ValueChain to sign it.
 */
export function addAPIKeyTypedData(
  p: ApiKeyFields,
  nonce: bigint,
  domainChainId: number,
): TypedData<'AddAPIKey'> {
  checkPublicKey(p.publicKey);
  return {
    domain: universalDomain(assertChainId(domainChainId, 'domainChainId')),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, AddAPIKey: ADD_API_KEY_FIELDS },
    primaryType: 'AddAPIKey',
    message: {
      accountID: s(p.accountID),
      name: p.name,
      keyType: s(p.keyType ?? APIKeyType.EVM),
      publicKey: p.publicKey,
      expiresAt: s(p.expiresAt),
      nonce: nonce.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// AddAPIKeyWithBuilder - ordinary key + builder approval in ONE signature
// ---------------------------------------------------------------------------

/**
 * `AddAPIKeyWithBuilder(uint64 chainID,uint64 nonce,uint64 accountID,string name,uint8 keyType,
 *  bytes publicKey,uint64 expiresAt,uint64 builderID,uint64 maxFeeRate)`.
 *
 * `sodexChainId` goes in the message; `signatureChainId` (the wallet's chain,
 * == X-API-Chain) goes in the domain.
 */
export function addAPIKeyWithBuilderTypedData(
  p: ApiKeyFields & { builderID: U64; maxFeeRate: number },
  sodexChainId: number,
  nonce: bigint,
  signatureChainId: number,
): TypedData<'AddAPIKeyWithBuilder'> {
  checkPublicKey(p.publicKey);
  return {
    domain: universalDomain(assertChainId(signatureChainId, 'signatureChainId')),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, AddAPIKeyWithBuilder: ADD_API_KEY_WITH_BUILDER_FIELDS },
    primaryType: 'AddAPIKeyWithBuilder',
    message: {
      chainID: s(assertChainId(sodexChainId, 'sodexChainId')),
      nonce: nonce.toString(),
      accountID: s(p.accountID),
      name: p.name,
      keyType: s(p.keyType ?? APIKeyType.EVM),
      publicKey: p.publicKey,
      expiresAt: s(p.expiresAt),
      builderID: s(p.builderID),
      maxFeeRate: s(p.maxFeeRate),
    },
  };
}

// ---------------------------------------------------------------------------
// UserSignedAddAPIKeyAction - ORDINARY key, the flow sodex.com runs in production
// ---------------------------------------------------------------------------

/**
 * `UserSignedAddAPIKeyAction(uint64 chainID,uint64 nonce,uint64 accountID,string name,
 *  uint8 keyType,bytes publicKey,uint64 expiresAt)`.
 *
 * WHY THIS AND NOT `AddAPIKey`. The public docs describe AddAPIKey under the
 * universal domain, but the engines verify a 0x02 registration as THIS struct
 * (the Go SDK's recover path for universal signatures only knows the
 * UserSigned* actions). Signed as AddAPIKey, the engine hashes a different
 * struct, recovers a stranger and answers "API key error: API key not found".
 * sodex.com signs exactly this, and submits it to each engine's `/exchange`.
 *
 * `signatureChainId` is the WALLET's current chain (the domain), so no wallet
 * has to switch networks; `sodexChainId` (286623 / 138565) is in the message.
 */
export function userSignedAddAPIKeyTypedData(
  p: ApiKeyFields,
  sodexChainId: number,
  nonce: bigint,
  signatureChainId: number,
): TypedData<'UserSignedAddAPIKeyAction'> {
  checkPublicKey(p.publicKey);
  return {
    domain: universalDomain(assertChainId(signatureChainId, 'signatureChainId')),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, UserSignedAddAPIKeyAction: USER_SIGNED_ADD_API_KEY_FIELDS },
    primaryType: 'UserSignedAddAPIKeyAction',
    message: {
      chainID: s(assertChainId(sodexChainId, 'sodexChainId')),
      nonce: nonce.toString(),
      accountID: s(p.accountID),
      name: p.name,
      keyType: s(p.keyType ?? APIKeyType.EVM),
      publicKey: p.publicKey.toLowerCase(),
      expiresAt: s(p.expiresAt),
    },
  };
}

// ---------------------------------------------------------------------------
// UserSignedAddPermissionedAPIKeyAction (Opentrade's flow; mask = DISABLED bits)
// ---------------------------------------------------------------------------

export interface AddPermissionedAPIKeyParams extends ApiKeyFields {
  /** Bitmask from APIKeyPermission. A SET bit DISABLES that permission. */
  permissions: number;
}

/**
 * The exact `eth_signTypedData_v4` argument for a PERMISSIONED key.
 *
 * A wallet hashes this per the EIP-712 spec, which produces the identical digest
 * to `permissionedAPIKeyDigest`. Test `user_signed_add_permissioned_api_key`
 * pins this equality. Callers must validate the mask first
 * (permissions.assertPermissionedMask): it must disable TRADE or CANCEL.
 */
export function permissionedAPIKeyTypedData(
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
): TypedData<'UserSignedAddPermissionedAPIKeyAction'> {
  checkPublicKey(p.publicKey);
  return {
    domain: universalDomain(assertChainId(signatureChainID, 'signatureChainID')),
    types: {
      EIP712Domain: EIP712_DOMAIN_FIELDS,
      UserSignedAddPermissionedAPIKeyAction: PERMISSIONED_API_KEY_FIELDS,
    },
    primaryType: 'UserSignedAddPermissionedAPIKeyAction',
    message: {
      chainID: s(assertChainId(sodexChainID, 'sodexChainID')),
      nonce: nonce.toString(),
      accountID: s(p.accountID),
      name: p.name,
      keyType: s(p.keyType ?? APIKeyType.EVM),
      publicKey: p.publicKey,
      expiresAt: s(p.expiresAt),
      permissions: s(p.permissions),
    },
  };
}

/** Full EIP-712 digest the wallet must sign (Opentrade API, kept for parity). */
export const permissionedAPIKeyDigest = (
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
): Uint8Array => hashTypedData(permissionedAPIKeyTypedData(p, sodexChainID, nonce, signatureChainID));

// ---------------------------------------------------------------------------
// ApproveBuilderFeeAction - POST /api/v1/user/{addr}/builders
// ---------------------------------------------------------------------------

/**
 * `ApproveBuilderFeeAction(uint64 chainID,uint64 nonce,uint64 accountID,uint64 builderID,uint64 maxFeeRate)`.
 * `accountID` is the user's PRIMARY account id. `maxFeeRate` 0..2000; 0 clears.
 */
export function approveBuilderFeeTypedData(
  p: { accountID: U64; builderID: U64; maxFeeRate: number },
  sodexChainId: number,
  nonce: bigint,
  signatureChainId: number,
): TypedData<'ApproveBuilderFeeAction'> {
  return {
    domain: universalDomain(assertChainId(signatureChainId, 'signatureChainId')),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ApproveBuilderFeeAction: APPROVE_BUILDER_FEE_FIELDS },
    primaryType: 'ApproveBuilderFeeAction',
    message: {
      chainID: s(assertChainId(sodexChainId, 'sodexChainId')),
      nonce: nonce.toString(),
      accountID: s(p.accountID),
      builderID: s(p.builderID),
      maxFeeRate: s(p.maxFeeRate),
    },
  };
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Convert a wallet's 65-byte (r,s,v) signature into the SoDEX wire format.
 * Wallets return v as 27/28; SoDEX wants 0/1 behind a type byte - 0x02 for
 * universal actions (default), 0x01 when a master wallet signs an
 * ExchangeAction (e.g. the documented revokeAPIKey route).
 */
export function walletSignatureToWire(
  signature: string,
  sigType: number = SignatureType.EIP712Universal,
): Hex {
  const raw = hexToBytes(signature);
  if (raw.length !== 65) throw new Error(`expected 65-byte wallet signature, got ${raw.length}`);
  const v = raw[64]!;
  const normalisedV = v >= 27 ? v - 27 : v;
  if (normalisedV > 1) throw new Error(`unexpected recovery id ${v}`);
  return bytesToHex(concat(new Uint8Array([sigType]), raw.slice(0, 64), new Uint8Array([normalisedV])));
}

/** Who signed `typedData`, given the wallet's raw 65-byte signature. */
export const recoverTypedDataSigner = (typedData: TypedData, walletSignature: string): Hex =>
  recoverAddress(hashTypedData(typedData), hexToBytes(walletSignature));

/**
 * Sign typed data with a RAW key and return the wire signature. For tests and
 * headless tooling only - in the app the master wallet signs, never this code.
 */
export const signTypedDataWithKey = (
  typedData: TypedData,
  privateKey: Uint8Array,
  sigType: number = SignatureType.EIP712Universal,
): Hex => bytesToHex(signDigest(hashTypedData(typedData), privateKey, sigType));

/** Sign the permissioned add-key action with a raw key (Opentrade API, tests/headless only). */
export const signPermissionedAPIKey = (
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
  privateKey: Uint8Array,
): Hex => signTypedDataWithKey(permissionedAPIKeyTypedData(p, sodexChainID, nonce, signatureChainID), privateKey);
