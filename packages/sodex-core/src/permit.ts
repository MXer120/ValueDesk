/**
 * Withdrawing to ANOTHER chain: SoDEX's ValueChain "call for permit".
 *
 * Funds leave SoDEX for Base / Arbitrum / Ethereum / ... from the owner's
 * ValueChain wallet (its "EVM funding" balance - spot funds get there first
 * with an EVM_WITHDRAW transfer). The owner signs ONE EIP-712 permit
 * authorising a `WithdrawToken` command; SoDEX submits it (and pays the gas)
 * through `POST /api/v1/user/{owner}/evm-withdraw`, or the owner can execute it
 * themselves on the permit contract.
 *
 * Everything here is taken from both official clients and checked against
 * the contract itself:
 *   - sodex.com's web bundle (2026-09-26): the typed data a browser wallet
 *     signs - domain `SoDexTokenCallForPermit` v`1.0.0`, `CallForPermit{to, cmd,
 *     nonce, deadline}` wrapping `WithdrawToken{...}`, nonce key 0;
 *   - the Python SDK's `prepare_evm_withdraw`: the `cmdData` ABI encoding, the
 *     keyed nonce, custody = 0 / bridge = 1, `failedBackToClob` true;
 *   - the permit contract's own `hashCallForPermit` view on ValueChain returns
 *     exactly `hashTypedData` of these objects, and `execute` accepts an
 *     owner-signed permit (simulated with eth_call, see test/permit.test.ts).
 *
 * The SIGNER is the owner: the permit moves the signer's own tokens. A permit
 * signed by anyone else fails on-chain (ERC20InsufficientBalance on their
 * empty balance); `assembleWithdrawPermit` refuses it before it is sent.
 */
import {
  EIP712_DOMAIN_FIELDS,
  bytesToHex,
  concat,
  hashTypedData,
  hexToBytes,
  isAddress,
  keccak256,
  recoverAddress,
  sameAddress,
  utf8,
  type Hex,
  type TypedData,
  type TypedDataField,
} from './eip712.ts';
import { SigningError } from './request.ts';

/** The ValueChain permit contract (`nonces`, `hashCallForPermit`, `execute`). */
export const CALL_FOR_PERMIT_CONTRACT = '0x890B7D142841065E64E5f94a455876e6352A7801';
/** The contract a WithdrawToken command is addressed to (`CallForPermit.to`). */
export const WITHDRAW_TOKEN_TARGET = '0x441BDb33C7d6DC49f627a42c3d71671D50DC2e94';
/** The keyed-nonce lane withdrawals use (sodex.com and the SDK both use 0). */
export const WITHDRAW_NONCE_KEY = 0n;

/** Which rail pays out on the destination chain. */
export const WithdrawType = { CUSTODY: 0, BRIDGE: 1 } as const;

export const WITHDRAW_TOKEN_FIELDS: readonly TypedDataField[] = [
  { name: 'coinSymbol', type: 'string' },
  { name: 'chain', type: 'string' },
  { name: 'receiver', type: 'string' },
  { name: 'amount', type: 'uint256' },
  { name: 'withdrawType', type: 'uint8' },
  { name: 'memo', type: 'string' },
  { name: 'failedBackToClob', type: 'bool' },
];

export const CALL_FOR_PERMIT_FIELDS: readonly TypedDataField[] = [
  { name: 'to', type: 'address' },
  { name: 'cmd', type: 'WithdrawToken' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

// --- minimal ABI encoding (the types a WithdrawToken command uses) ----------------

type AbiType = 'string' | 'bytes' | 'uint256' | 'uint8' | 'uint192' | 'bool' | 'address' | 'bytes32';

const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 256n) throw new RangeError('value out of uint256 range');
  return hexToBytes('0x' + v.toString(16).padStart(64, '0'));
};

function staticWord(t: AbiType, v: unknown): Uint8Array {
  if (t === 'bool') return word(v ? 1n : 0n);
  if (t === 'bytes32') {
    const b = hexToBytes(String(v));
    if (b.length !== 32) throw new TypeError('expected 32 bytes');
    return b;
  }
  if (t === 'address') {
    if (typeof v !== 'string' || !isAddress(v)) throw new TypeError('expected an address');
    return word(BigInt(v));
  }
  const bits = t === 'uint8' ? 8 : t === 'uint192' ? 192 : 256;
  const n = BigInt(v as bigint | number | string);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new RangeError(`value out of ${t} range`);
  return word(n);
}

function dynamicTail(t: AbiType, v: unknown): Uint8Array {
  const data = t === 'string' ? utf8(String(v)) : hexToBytes(String(v));
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);
  return concat(word(BigInt(data.length)), padded);
}

/** `abi.encode(...)` for flat parameter lists of the types above. */
export function abiEncode(types: readonly AbiType[], values: readonly unknown[]): Uint8Array {
  if (types.length !== values.length) throw new Error('abiEncode: types/values length mismatch');
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = BigInt(32 * types.length);
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t === 'string' || t === 'bytes') {
      const tail = dynamicTail(t, values[i]);
      heads.push(word(tailOffset));
      tails.push(tail);
      tailOffset += BigInt(tail.length);
    } else {
      heads.push(staticWord(t, values[i]));
    }
  }
  return concat(...heads, ...tails);
}

const selector = (sig: string): Uint8Array => keccak256(utf8(sig)).slice(0, 4);

/** Calldata for the permit contract's `nonces(address owner, uint192 key)`. */
export function permitNonceCall(owner: string, key: bigint = WITHDRAW_NONCE_KEY): Hex {
  return bytesToHex(concat(selector('nonces(address,uint192)'), abiEncode(['address', 'uint192'], [owner, key])));
}

// --- the permit -------------------------------------------------------------------

export interface WithdrawTokenCmd {
  /** SoDEX's external coin name (asset config `assetName`), e.g. "USDC". */
  coinSymbol: string;
  /** SoDEX's chain key (asset config `chainName`), e.g. "ARBITRUM_ETH". */
  chain: string;
  /** Destination address on that chain, as the chain writes it. */
  receiver: string;
  /** Raw amount in the ValueChain token's decimals (asset config `valueChainMetadata.tokenDecimals`). */
  amount: bigint;
  withdrawType?: number;
  memo?: string;
  /** If the payout fails, credit the funds back to SoDEX spot (both official clients send true). */
  failedBackToClob?: boolean;
}

/** `abi.encode(string coinSymbol, string chain, string receiver, uint256 amount, uint8 withdrawType, string memo, bool failedBackToClob)` */
export function encodeWithdrawTokenCmd(c: WithdrawTokenCmd): Hex {
  return bytesToHex(
    abiEncode(
      ['string', 'string', 'string', 'uint256', 'uint8', 'string', 'bool'],
      [c.coinSymbol, c.chain, c.receiver, c.amount, c.withdrawType ?? WithdrawType.CUSTODY, c.memo ?? '', c.failedBackToClob ?? true],
    ),
  );
}

export interface PrepareWithdrawPermitInput extends WithdrawTokenCmd {
  /** The owner - the wallet that signs and whose ValueChain balance is withdrawn. */
  owner: string;
  /** `nonces(owner, 0)` on the permit contract, read just before signing. */
  nonce: bigint;
  /** Unix SECONDS. */
  deadline: bigint;
  /** ValueChain's chain id (286623 mainnet). */
  chainId: number;
}

export interface PreparedWithdrawPermit {
  typedData: TypedData<'CallForPermit'>;
  digest: Hex;
  cmdData: Hex;
  nonce: bigint;
  deadline: bigint;
  expectedSigner: Hex;
}

export function prepareWithdrawPermit(i: PrepareWithdrawPermitInput): PreparedWithdrawPermit {
  if (!isAddress(i.owner)) throw new SigningError('owner must be the wallet address');
  if (!i.coinSymbol || !/^[A-Za-z0-9._-]{1,32}$/.test(i.coinSymbol)) throw new SigningError('bad coin symbol');
  if (!i.chain || !/^[A-Z0-9_]{2,32}$/.test(i.chain)) throw new SigningError('bad chain key');
  if (!i.receiver || i.receiver.length > 128 || /\s/.test(i.receiver)) throw new SigningError('bad receiver address');
  if (i.amount <= 0n) throw new SigningError('amount must be positive');
  if (i.deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new SigningError('deadline is in the past');
  const cmd = {
    coinSymbol: i.coinSymbol,
    chain: i.chain,
    receiver: i.receiver,
    amount: i.amount.toString(),
    withdrawType: String(i.withdrawType ?? WithdrawType.CUSTODY),
    memo: i.memo ?? '',
    failedBackToClob: i.failedBackToClob ?? true,
  };
  const typedData: TypedData<'CallForPermit'> = {
    domain: { name: 'SoDexTokenCallForPermit', version: '1.0.0', chainId: i.chainId, verifyingContract: CALL_FOR_PERMIT_CONTRACT },
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, CallForPermit: CALL_FOR_PERMIT_FIELDS, WithdrawToken: WITHDRAW_TOKEN_FIELDS },
    primaryType: 'CallForPermit',
    message: { to: WITHDRAW_TOKEN_TARGET, cmd, nonce: i.nonce.toString(), deadline: i.deadline.toString() },
  };
  return {
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    cmdData: encodeWithdrawTokenCmd(i),
    nonce: i.nonce,
    deadline: i.deadline,
    expectedSigner: i.owner.toLowerCase() as Hex,
  };
}

/** The sponsored submission body (`POST /api/v1/user/{owner}/evm-withdraw`). */
export interface EvmWithdrawRequest {
  cmdData: Hex;
  nonce: string;
  deadline: string;
  /** 65 bytes r || s || v with v 27/28, as the SDK and sodex.com send it. */
  signature: Hex;
}

/**
 * Attach the wallet's signature. RECOVERS the signer first: a signature from
 * any other account (or a wallet that hashed differently) is refused here.
 */
export function assembleWithdrawPermit(p: PreparedWithdrawPermit, walletSignature: string): EvmWithdrawRequest {
  const raw = hexToBytes(walletSignature);
  if (raw.length !== 65) throw new SigningError(`expected a 65-byte wallet signature, got ${raw.length}`);
  const v = raw[64]! < 27 ? raw[64]! + 27 : raw[64]!;
  if (v !== 27 && v !== 28) throw new SigningError(`unexpected recovery id ${raw[64]}`);
  const sig = concat(raw.slice(0, 64), new Uint8Array([v]));
  const signer = recoverAddress(hexToBytes(p.digest), sig);
  if (!sameAddress(signer, p.expectedSigner)) {
    throw new SigningError(`the wallet signed as ${signer}, but the withdrawal must be signed by ${p.expectedSigner}`);
  }
  return { cmdData: p.cmdData, nonce: p.nonce.toString(), deadline: p.deadline.toString(), signature: bytesToHex(sig) };
}
