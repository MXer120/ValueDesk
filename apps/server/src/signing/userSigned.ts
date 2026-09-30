/**
 * User-signed (master-wallet) actions.
 *
 * These are the only actions the USER's own wallet ever signs. They are plain
 * EIP-712 typed data, so a browser wallet can sign them with
 * `eth_signTypedData_v4` - the master private key never leaves the wallet.
 *
 * This is what lets Valuetrade mint a RESTRICTED API key in-app instead of
 * sending the user to sodex.com to create one by hand: the wallet authorises a
 * freshly generated keypair, with a permission mask and an expiry. The mask
 * lists DISABLED permissions (see APIKeyPermission in actions.ts).
 *
 * Two quirks vs. the exchange actions:
 *   1. The domain name is "universal", and its chainId is the chain the WALLET
 *      is currently on (`signatureChainID`) - not the SoDEX chain. The SoDEX
 *      chain id travels in the message's own `chainID` field.
 *   2. The wire signature is prefixed with SignatureType.EIP712Universal (0x02),
 *      not 0x01.
 *
 * Reference: common/types/eip712.go (UserSignedAddPermissionedAPIKeyAction),
 *            common/signer/evm_signer.go (SignAddPermissionedAPIKeyAction).
 */
import {
  DomainName,
  SignatureType,
  bytesToHex,
  concat,
  eip712Digest,
  hexToBytes,
  keccak256,
  makeDomain,
  signDigest,
  utf8,
  word,
  type Hex,
} from './eip712.js';

/** enums.APIKeyType */
export const APIKeyType = { UNKNOWN: 0, EVM: 1 } as const;

const PERMISSIONED_TYPE_STRING =
  'UserSignedAddPermissionedAPIKeyAction(uint64 chainID,uint64 nonce,uint64 accountID,' +
  'string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 permissions)';

const PERMISSIONED_TYPEHASH = keccak256(utf8(PERMISSIONED_TYPE_STRING));

export interface AddPermissionedAPIKeyParams {
  /** SoDEX numeric account id. */
  accountID: number;
  /** Human-readable key name; also the `X-API-Key` header value. */
  name: string;
  /** The new signing key's EVM ADDRESS (the gateway calls this "publicKey"). */
  publicKey: string;
  /** Unix SECONDS. 0 means "never expires". */
  expiresAt: number;
  /** Bitmask from APIKeyPermission. A SET bit DISABLES that permission. */
  permissions: number;
  keyType?: number;
}

/**
 * Struct hash for UserSignedAddPermissionedAPIKeyAction.
 * `sodexChainID` is the inner chainID field (286623 / 138565).
 */
export function permissionedAPIKeyStructHash(
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
): Uint8Array {
  return keccak256(
    concat(
      PERMISSIONED_TYPEHASH,
      word(sodexChainID),
      word(nonce),
      word(p.accountID),
      keccak256(utf8(p.name)),
      word(p.keyType ?? APIKeyType.EVM),
      keccak256(hexToBytes(p.publicKey)),
      word(p.expiresAt),
      word(p.permissions),
    ),
  );
}

/** Full EIP-712 digest the wallet must sign. */
export const permissionedAPIKeyDigest = (
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
): Uint8Array =>
  eip712Digest(
    makeDomain(DomainName.universal, signatureChainID),
    permissionedAPIKeyStructHash(p, sodexChainID, nonce),
  );

/**
 * The exact `eth_signTypedData_v4` argument to hand a browser wallet.
 *
 * A wallet hashes this per the EIP-712 spec, which produces the identical digest
 * to `permissionedAPIKeyDigest` - so the server can verify without ever seeing
 * the master key. Test `user_signed_add_permissioned_api_key` pins this equality.
 */
export function permissionedAPIKeyTypedData(
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
) {
  return {
    domain: {
      name: DomainName.universal,
      version: '1',
      chainId: signatureChainID,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    primaryType: 'UserSignedAddPermissionedAPIKeyAction' as const,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      UserSignedAddPermissionedAPIKeyAction: [
        { name: 'chainID', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
        { name: 'accountID', type: 'uint64' },
        { name: 'name', type: 'string' },
        { name: 'keyType', type: 'uint8' },
        { name: 'publicKey', type: 'bytes' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'permissions', type: 'uint64' },
      ],
    },
    message: {
      chainID: String(sodexChainID),
      nonce: nonce.toString(),
      accountID: String(p.accountID),
      name: p.name,
      keyType: String(p.keyType ?? APIKeyType.EVM),
      publicKey: p.publicKey,
      expiresAt: String(p.expiresAt),
      permissions: String(p.permissions),
    },
  };
}

/**
 * The HTTP body for the add-key request. Field order matches
 * common/types.AddPermissionedAPIKeyRequest.
 */
export const permissionedAPIKeyBody = (p: AddPermissionedAPIKeyParams) => ({
  accountID: p.accountID,
  name: p.name,
  type: p.keyType ?? APIKeyType.EVM,
  publicKey: p.publicKey,
  expiresAt: p.expiresAt,
  permissions: p.permissions,
});

/**
 * Convert a wallet's 65-byte (r,s,v) signature into the SoDEX wire format.
 * Wallets return v as 27/28; SoDEX wants 0/1 behind a 0x02 type byte.
 */
export function walletSignatureToWire(signature: string): Hex {
  const raw = hexToBytes(signature);
  if (raw.length !== 65) throw new Error(`expected 65-byte wallet signature, got ${raw.length}`);
  const v = raw[64]!;
  const normalisedV = v >= 27 ? v - 27 : v;
  if (normalisedV > 1) throw new Error(`unexpected recovery id ${v}`);
  return bytesToHex(
    concat(
      new Uint8Array([SignatureType.EIP712Universal]),
      raw.slice(0, 64),
      new Uint8Array([normalisedV]),
    ),
  );
}

/** Sign the add-key action with a raw key (used by tests and headless setups). */
export const signPermissionedAPIKey = (
  p: AddPermissionedAPIKeyParams,
  sodexChainID: number,
  nonce: bigint,
  signatureChainID: number,
  privateKey: Uint8Array,
): Hex =>
  bytesToHex(
    signDigest(
      permissionedAPIKeyDigest(p, sodexChainID, nonce, signatureChainID),
      privateKey,
      SignatureType.EIP712Universal,
    ),
  );
