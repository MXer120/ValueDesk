/**
 * Request assembly: turn a SignableAction + an in-memory key into the exact
 * HTTP request to send, WITHOUT sending it.
 *
 * Header names are exactly the ones Opentrade sends (server/src/sodex/rest.ts,
 * web/src/signing.ts) and the Go SDK sends (client/client.go):
 *   X-API-Key    the API key NAME (omitted when the master wallet signs)
 *   X-API-Sign   0x01 || r || s || v  (66 bytes, v in {0,1})
 *   X-API-Nonce  decimal ms nonce
 *   X-API-Chain  the SoDEX chain id (286623 mainnet / 138565 testnet)
 * The gateway's CORS preflight allows exactly these four from any origin
 * (verified by Opentrade), plus the standard Content-Type/Accept.
 *
 * THE HTTP BODY IS NOT THE SIGNING PAYLOAD. The signature covers
 * keccak256(goJSON({"type": <action>, "params": <body>})); the body is only
 * `params`. The body is serialised ONCE and the signing payload is built
 * around those exact bytes, so what is hashed is what is sent.
 *
 * The EIP-712 domain is 'futures' for perps and 'spot' for spot - NOT 'perps'.
 */
import { endpointFor, type SignableAction } from './actions.ts';
import {
  SignatureType,
  bytesToHex,
  eip712Digest,
  exchangeActionStructHash,
  goJSONStringify,
  keccak256,
  makeDomain,
  payloadJSONFromBody,
  privateKeyToAddress,
  signDigest,
  utf8,
  type Hex,
} from './eip712.ts';
import { isKeyExpired } from './keys.ts';
import { DEFAULT_RELAY_BASE, enginePath, engineDomainName, type Engine } from './network.ts';
import { DEFAULT_NONCE_WINDOW_MARGIN_MS, assertNonceInWindow, nonceKey, type NonceManager } from './nonce.ts';

/** Header names, verbatim. */
export const HEADER = {
  key: 'X-API-Key',
  sign: 'X-API-Sign',
  nonce: 'X-API-Nonce',
  chain: 'X-API-Chain',
} as const;

/** What signs: an API key (with its registered name) or the master wallet key (no name). */
export interface SigningKeyRef {
  /** 32 raw bytes, held in memory only. */
  readonly privateKey: Uint8Array;
  /** Registered API key NAME, sent as X-API-Key. Omit ONLY when the master key signs directly. */
  readonly name?: string;
  /** Registration expiry in MILLISECONDS (0/undefined = never). Checked locally before signing. */
  readonly expiresAt?: number;
  /** The key's address, if already known (skips a public-key derivation). */
  readonly address?: string;
}

/**
 * Bind a generated TradingKey to its registration (name + expiry) as a
 * SigningKeyRef whose privateKey stays NON-enumerable (no accidental JSON/log).
 */
export function signingKeyFrom(
  key: { readonly privateKey: Uint8Array; readonly address: string },
  registration: { name: string; expiresAt: number },
): SigningKeyRef {
  const ref = { name: registration.name, expiresAt: registration.expiresAt, address: key.address.toLowerCase() };
  Object.defineProperty(ref, 'privateKey', { value: key.privateKey, enumerable: false, writable: false });
  return Object.freeze(ref) as SigningKeyRef;
}

export interface SignOptions {
  /** SoDEX chain id: 286623 (mainnet) or 138565 (testnet). Also the EIP-712 domain chainId. */
  chainId: number;
  /** Explicit nonce (ms). Use `signAndBuildWithNonceManager` to allocate one. */
  nonce: bigint | number;
  /** Prefix for `path`. Default '/sodex' (the same-origin relay). '' = bare gateway path. */
  base?: string;
  /** Clock for the expiry and nonce-window checks. Default Date.now(). */
  now?: number;
  /** Window margin for the nonce check. Default DEFAULT_NONCE_WINDOW_MARGIN_MS. */
  nonceWindowMarginMs?: number;
}

export interface BuiltRequest {
  method: 'POST' | 'DELETE';
  /** Ready to fetch: `${base}/api/v1/${engine}${endpoint}`. */
  path: string;
  /** The gateway-relative path, e.g. '/api/v1/perps/trade/orders'. */
  gatewayPath: string;
  headers: Record<string, string>;
  /** Exactly the bytes whose {type, params} wrapper was signed. */
  body: string;
  /** Diagnostics - never needed to send. */
  meta: {
    engine: Engine;
    actionType: string;
    nonce: string;
    signer: Hex;
    payloadHash: Hex;
    digest: Hex;
    signature: Hex;
  };
}

export class SigningError extends Error {
  override name = 'SigningError';
}

const joinBase = (base: string, path: string): string => base.replace(/\/+$/, '') + path;

/**
 * Sign `action` with `key` and assemble the request. Pure and synchronous: it
 * reads no clock beyond `opts.now`, touches no storage and sends nothing.
 */
export function signAndBuild(action: SignableAction, key: SigningKeyRef, opts: SignOptions): BuiltRequest {
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(opts.chainId) || opts.chainId <= 0) {
    throw new SigningError('chainId must be the SoDEX chain id (286623 mainnet, 138565 testnet)');
  }
  if (isKeyExpired(key.expiresAt, now)) {
    throw new SigningError('This trading key has expired. Register a new one - it takes one wallet signature.');
  }
  if (key.name !== undefined && key.name === '') throw new SigningError('API key name must not be empty');
  const nonce = assertNonceInWindow(opts.nonce, now, opts.nonceWindowMarginMs ?? DEFAULT_NONCE_WINDOW_MARGIN_MS);
  const ep = endpointFor(action.engine, action.type);

  const body = goJSONStringify(action.params);
  const payloadHash = keccak256(utf8(payloadJSONFromBody(action.type, body)));
  const digest = eip712Digest(
    makeDomain(engineDomainName(action.engine), opts.chainId),
    exchangeActionStructHash(payloadHash, nonce),
  );
  const signature = bytesToHex(signDigest(digest, key.privateKey, SignatureType.EIP712));
  const gatewayPath = enginePath(action.engine) + ep.path;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    [HEADER.sign]: signature,
    [HEADER.nonce]: nonce.toString(),
    [HEADER.chain]: String(opts.chainId),
  };
  // The single most common cause of 401s if omitted - and it must be omitted
  // when the MASTER wallet signs, or the gateway looks for an API key instead.
  if (key.name !== undefined) headers[HEADER.key] = key.name;

  return {
    method: ep.method,
    path: joinBase(opts.base ?? DEFAULT_RELAY_BASE, gatewayPath),
    gatewayPath,
    headers,
    body,
    meta: {
      engine: action.engine,
      actionType: action.type,
      nonce: nonce.toString(),
      signer: (key.address?.toLowerCase() as Hex | undefined) ?? privateKeyToAddress(key.privateKey),
      payloadHash: bytesToHex(payloadHash),
      digest: bytesToHex(digest),
      signature,
    },
  };
}

/**
 * `signAndBuild` with a nonce allocated from `nonces` under the signer's key
 * (`nonceKey(signerAddress, chainId)`). The request still is not sent.
 *
 * Nonces for one key are unique and increasing across tabs (see nonce.ts).
 * If wire ORDER matters to you, allocate with `nonces.withNonce` and send
 * inside the callback instead.
 *
 * Opentrade finding (server/src/sodex/rest.ts): if your transport waits on a
 * rate-limit budget, wait BEFORE allocating the nonce. Budget waiters wake in
 * timer order, not arrival order, so allocating first let the request holding
 * nonce N leave after N+1. (The gateway now keeps the 100 highest nonces, which
 * tolerates small reorderings, but keeping the orders aligned costs nothing.)
 */
export async function signAndBuildWithNonceManager(
  action: SignableAction,
  key: SigningKeyRef,
  opts: Omit<SignOptions, 'nonce'> & { nonces: NonceManager },
): Promise<BuiltRequest> {
  const signer = key.address ?? privateKeyToAddress(key.privateKey);
  const nonce = await opts.nonces.next(nonceKey(signer, opts.chainId));
  // NOT `{...key}`: a TradingKey's privateKey is non-enumerable and a spread would drop it.
  const ref: SigningKeyRef = { privateKey: key.privateKey, name: key.name, expiresAt: key.expiresAt, address: signer };
  return signAndBuild(action, ref, { ...opts, nonce });
}
