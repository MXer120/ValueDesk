/**
 * SoDEX's "call for permit" relay on ValueChain - the way sodex.com moves
 * funds between the owner's ValueChain wallet and the exchange, gas paid by
 * SoDEX's relayer:
 *
 *   Funding -> Spot (ERC-20)   TWO signatures: the token's ERC-2612 `Permit`
 *                              (spender = the CallForPermit contract), then a
 *                              `CallForPermit{to: CLOB gateway, cmd:
 *                              DepositERC20WithPermit{token, amount, deadline,
 *                              v, r, s}}` (nonce lane 2).
 *   Withdraw to another chain  ONE `CallForPermit{to: Withdrawer, cmd:
 *                              WithdrawToken{...}}` (nonce lane 0; permit.ts).
 *
 * Both are POSTed to `alpha-biz /biz/mirror/call_for_permit` as
 * `{to, cmdType, cmdData, nonce, deadline, signature}` and executed on-chain by
 * `CallForPermit.execute(to, cmdType, cmdData, nonce, deadline, signature)`,
 * which anyone may call - so the exact request can be SIMULATED with eth_call
 * before it is sent (executeCallData).
 *
 * Taken from sodex.com's own bundle and checked against SoDEX's verified
 * contract sources on ValueChain (SoDexTokenCallForPermit, SoDexTokenWithdrawer,
 * SoDexToken - OpenZeppelin v5): the contract's `hashCallForPermit` returns
 * exactly `hashTypedData` of these objects (test/callForPermit.test.ts).
 *
 * Signatures are the raw wallet `eth_signTypedData_v4` result: 65 bytes, v
 * 27/28, no prefix (OZ ECDSA 5.1 rejects v 0/1 and high s). Every signature is
 * recovered and checked against the owner before it leaves the browser.
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
import { CALL_FOR_PERMIT_CONTRACT, WITHDRAW_TOKEN_TARGET, abiEncode, type PreparedWithdrawPermit } from './permit.ts';

/** The CLOB gateway - the exchange contract a deposit is addressed to. */
export const CLOB_GATEWAY = '0x0101010101010101010101010101010101010101';
/** The keyed-nonce lane sodex.com uses for Funding -> Spot deposits. */
export const DEPOSIT_NONCE_KEY = 2n;
/** Where sodex.com POSTs every call-for-permit request. */
export const CALL_FOR_PERMIT_PATH = '/biz/mirror/call_for_permit';

export const TOKEN_PERMIT_FIELDS: readonly TypedDataField[] = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

export const DEPOSIT_ERC20_WITH_PERMIT_FIELDS: readonly TypedDataField[] = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'v', type: 'uint8' },
  { name: 'r', type: 'bytes32' },
  { name: 's', type: 'bytes32' },
];

const CALL_FOR_PERMIT_DEPOSIT_FIELDS: readonly TypedDataField[] = [
  { name: 'to', type: 'address' },
  { name: 'cmd', type: 'DepositERC20WithPermit' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** A 65-byte wallet signature as r / s / v (v normalized to 27/28, low s required). */
export function splitSignature(walletSignature: string): { r: Hex; s: Hex; v: 27 | 28; bytes: Uint8Array } {
  const raw = hexToBytes(walletSignature);
  if (raw.length !== 65) throw new SigningError(`expected a 65-byte wallet signature, got ${raw.length}`);
  const v = raw[64]! < 27 ? raw[64]! + 27 : raw[64]!;
  if (v !== 27 && v !== 28) throw new SigningError(`unexpected recovery id ${raw[64]}`);
  const s = raw.slice(32, 64);
  if (BigInt(bytesToHex(s)) > SECP256K1_HALF_N) throw new SigningError('the wallet returned a high-s signature, which the contract refuses');
  const bytes = concat(raw.slice(0, 64), new Uint8Array([v]));
  return { r: bytesToHex(raw.slice(0, 32)), s: bytesToHex(s), v, bytes };
}

function checkSigner(digest: Hex, walletSignature: string, owner: string, what: string): Uint8Array {
  const { bytes } = splitSignature(walletSignature);
  const signer = recoverAddress(hexToBytes(digest), bytes);
  if (!sameAddress(signer, owner)) throw new SigningError(`the wallet signed the ${what} as ${signer}, but it must be signed by ${owner}`);
  return bytes;
}

// --- Funding -> Spot, signature 1: the token's ERC-2612 permit -----------------------------

export interface TokenPermitInput {
  owner: string;
  /** The ValueChain token (vUSDC, ...). */
  token: string;
  /** The token's own EIP-712 name - read `name()` at runtime, it can change. */
  tokenName: string;
  /** Base units of the token. */
  amount: bigint;
  /** `token.nonces(owner)`. */
  nonce: bigint;
  /** Unix seconds; the SAME deadline goes into signature 2. */
  deadline: bigint;
  chainId: number;
}

export function prepareTokenPermit(i: TokenPermitInput): { typedData: TypedData<'Permit'>; digest: Hex } {
  if (!isAddress(i.owner) || !isAddress(i.token)) throw new SigningError('owner and token must be addresses');
  if (!i.tokenName) throw new SigningError('the token name is required (read it from the token)');
  if (i.amount <= 0n) throw new SigningError('amount must be positive');
  if (i.deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new SigningError('deadline is in the past');
  const typedData: TypedData<'Permit'> = {
    domain: { name: i.tokenName, version: '1', chainId: i.chainId, verifyingContract: i.token },
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, Permit: TOKEN_PERMIT_FIELDS },
    primaryType: 'Permit',
    message: { owner: i.owner, spender: CALL_FOR_PERMIT_CONTRACT, value: i.amount.toString(), nonce: i.nonce.toString(), deadline: i.deadline.toString() },
  };
  return { typedData, digest: bytesToHex(hashTypedData(typedData)) };
}

// --- Funding -> Spot, signature 2: CallForPermit wrapping DepositERC20WithPermit ------------

export interface PreparedCallForPermit {
  to: string;
  cmdType: string;
  typedData: TypedData<'CallForPermit'>;
  digest: Hex;
  cmdData: Hex;
  nonce: bigint;
  deadline: bigint;
  expectedSigner: Hex;
}

export interface DepositPermitInput {
  owner: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  /** Signature 1 (the token permit) - checked to be the owner's before it is wrapped. */
  tokenPermit: { digest: Hex; signature: string };
  /** `CallForPermit.nonces(owner, 2)` as the contract returns it (key-packed). */
  nonce: bigint;
  chainId: number;
}

/** `abi.encode(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` */
export function encodeDepositCmd(token: string, amount: bigint, deadline: bigint, v: number, r: Hex, s: Hex): Hex {
  return bytesToHex(abiEncode(['address', 'uint256', 'uint256', 'uint8', 'bytes32', 'bytes32'], [token, amount, deadline, v, r, s]));
}

export function prepareDepositPermit(i: DepositPermitInput): PreparedCallForPermit {
  if (!isAddress(i.owner) || !isAddress(i.token)) throw new SigningError('owner and token must be addresses');
  if (i.amount <= 0n) throw new SigningError('amount must be positive');
  if (i.nonce >> 64n !== DEPOSIT_NONCE_KEY) throw new SigningError('the deposit nonce must be read from lane 2');
  checkSigner(i.tokenPermit.digest, i.tokenPermit.signature, i.owner, 'token permit');
  const { v, r, s } = splitSignature(i.tokenPermit.signature);
  const typedData: TypedData<'CallForPermit'> = {
    domain: { name: 'SoDexTokenCallForPermit', version: '1.0.0', chainId: i.chainId, verifyingContract: CALL_FOR_PERMIT_CONTRACT },
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, CallForPermit: CALL_FOR_PERMIT_DEPOSIT_FIELDS, DepositERC20WithPermit: DEPOSIT_ERC20_WITH_PERMIT_FIELDS },
    primaryType: 'CallForPermit',
    message: {
      to: CLOB_GATEWAY,
      cmd: { token: i.token, amount: i.amount.toString(), deadline: i.deadline.toString(), v, r, s },
      nonce: i.nonce.toString(),
      deadline: i.deadline.toString(),
    },
  };
  return {
    to: CLOB_GATEWAY,
    cmdType: 'DepositERC20WithPermit',
    typedData,
    digest: bytesToHex(hashTypedData(typedData)),
    cmdData: encodeDepositCmd(i.token, i.amount, i.deadline, v, r, s),
    nonce: i.nonce,
    deadline: i.deadline,
    expectedSigner: i.owner.toLowerCase() as Hex,
  };
}

/** A withdrawal permit (permit.ts) as a call-for-permit request. */
export function withdrawAsCallForPermit(p: PreparedWithdrawPermit): PreparedCallForPermit {
  return { ...p, to: WITHDRAW_TOKEN_TARGET, cmdType: 'WithdrawToken' };
}

// --- the request -------------------------------------------------------------------------

/** The body sodex.com POSTs to `/biz/mirror/call_for_permit`. */
export interface CallForPermitRequest {
  to: string;
  cmdType: string;
  cmdData: Hex;
  nonce: string;
  deadline: string;
  /** 65 bytes r || s || v, v 27/28, no prefix. */
  signature: Hex;
}

/** Attach the wallet's signature - RECOVERED and checked to be the owner's first. */
export function assembleCallForPermit(p: PreparedCallForPermit, walletSignature: string): CallForPermitRequest {
  const sig = checkSigner(p.digest, walletSignature, p.expectedSigner, p.cmdType);
  return { to: p.to, cmdType: p.cmdType, cmdData: p.cmdData, nonce: p.nonce.toString(), deadline: p.deadline.toString(), signature: bytesToHex(sig) };
}

const selector = (sig: string): Uint8Array => keccak256(utf8(sig)).slice(0, 4);

/** Calldata for `CallForPermit.execute(...)` - for an eth_call simulation of exactly what will be sent. */
export function executeCallData(r: CallForPermitRequest): Hex {
  return bytesToHex(
    concat(
      selector('execute(address,string,bytes,uint256,uint256,bytes)'),
      abiEncode(['address', 'string', 'bytes', 'uint256', 'uint256', 'bytes'], [r.to, r.cmdType, r.cmdData, BigInt(r.nonce), BigInt(r.deadline), r.signature]),
    ),
  );
}

/** Calldata for the contract's own digest (`hashCallForPermit`), to compare with the local one. */
export function hashCallForPermitCallData(p: PreparedCallForPermit): Hex {
  return bytesToHex(
    concat(
      selector('hashCallForPermit(address,string,bytes,uint256,uint256)'),
      abiEncode(['address', 'string', 'bytes', 'uint256', 'uint256'], [p.to, p.cmdType, p.cmdData, p.nonce, p.deadline]),
    ),
  );
}

// --- small views ---------------------------------------------------------------------------

export const nameCallData = (): Hex => bytesToHex(selector('name()'));
export const tokenNoncesCallData = (owner: string): Hex => bytesToHex(concat(selector('nonces(address)'), abiEncode(['address'], [owner])));
export const getWithdrawalCallData = (id: bigint): Hex => bytesToHex(concat(selector('getWithdrawal(uint256)'), abiEncode(['uint256'], [id])));
/** `getWithdrawRequirements(coinSymbol, chain, account, withdrawType)` on the registry (fee, userBalance, availableAmount, ...). */
export const withdrawRequirementsCallData = (coinSymbol: string, chain: string, account: string, withdrawType: number): Hex =>
  bytesToHex(concat(selector('getWithdrawRequirements(string,string,address,uint8)'), abiEncode(['string', 'string', 'address', 'uint8'], [coinSymbol, chain, account, withdrawType])));
/** `isBlacklistedWallet(chain, receiver)` on the Withdrawer. */
export const isBlacklistedCallData = (chain: string, receiver: string): Hex =>
  bytesToHex(concat(selector('isBlacklistedWallet(string,string)'), abiEncode(['string', 'string'], [chain, receiver])));
/** The native-SOSO deposit: `depositERC20(address(0), amount)` sent with value = amount. */
export const nativeDepositCallData = (amount: bigint): Hex =>
  bytesToHex(concat(selector('depositERC20(address,uint256)'), abiEncode(['address', 'uint256'], ['0x0000000000000000000000000000000000000000', amount])));

// --- decoding ------------------------------------------------------------------------------

const wordAt = (b: Uint8Array, byte: number): bigint => {
  if (byte < 0 || byte + 32 > b.length) throw new RangeError('ABI data too short');
  return BigInt(bytesToHex(b.slice(byte, byte + 32)));
};
const offsetAt = (b: Uint8Array, byte: number): number => {
  const v = wordAt(b, byte);
  if (v > BigInt(b.length)) throw new RangeError('ABI offset out of range');
  return Number(v);
};
const stringAt = (b: Uint8Array, byte: number): string => {
  const len = offsetAt(b, byte);
  if (byte + 32 + len > b.length) throw new RangeError('ABI string out of range');
  return utf8Decode(b.slice(byte + 32, byte + 32 + len));
};

/** UTF-8 bytes -> string (this package carries no DOM or Node typings, so no TextDecoder). */
function utf8Decode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++]!;
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++]! & 0x3f));
    else if (c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f));
    else out += String.fromCodePoint(((c & 0x07) << 18) | ((b[i++]! & 0x3f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f));
  }
  return out;
}

export const decodeUint = (hex: string, index = 0): bigint => wordAt(hexToBytes(hex), index * 32);
/** A single `string` return value. */
export const decodeString = (hex: string): string => {
  const b = hexToBytes(hex);
  return stringAt(b, offsetAt(b, 0));
};

/** SoDexTokenWithdrawer `TxStatus`. */
export const WithdrawalStatus = { PENDING: 0, SUCCESS: 1, FAILED: 2, REJECTED: 3, APPROVED: 4 } as const;

/** SoDexTokenWithdrawer's `Withdrawal` struct (event `WithdrawalCreated`, view `getWithdrawal`). */
export interface WithdrawalRecord {
  withdrawId: bigint;
  chain: string;
  coinAddr: string;
  account: Hex;
  receiver: string;
  amount: bigint;
  withdrawFee: bigint;
  bridgeAddr: string;
  createdTimestamp: bigint;
  settledTimestamp: bigint;
  /** The payout transaction on the destination chain, once there is one. */
  txHash: string;
  status: number;
  memo: string;
  failedBackToClob: boolean;
  updatedTimestamp: bigint;
  coinSymbol: string;
}

/** `topic0` of `WithdrawalCreated(Withdrawal)`. */
export const WITHDRAWAL_CREATED_TOPIC = bytesToHex(
  keccak256(utf8('WithdrawalCreated((uint256,string,string,address,string,uint256,uint256,string,uint256,uint256,string,uint8,string,bool,uint256,string))')),
);

/** Decode `abi.encode(Withdrawal)` - the event's data, or `getWithdrawal`'s return data. */
export function decodeWithdrawal(hex: string): WithdrawalRecord {
  const b = hexToBytes(hex);
  const t = offsetAt(b, 0);
  const u = (i: number) => wordAt(b, t + i * 32);
  const s = (i: number) => stringAt(b, t + offsetAt(b, t + i * 32));
  return {
    withdrawId: u(0),
    chain: s(1),
    coinAddr: s(2),
    account: `0x${u(3).toString(16).padStart(40, '0')}` as Hex,
    receiver: s(4),
    amount: u(5),
    withdrawFee: u(6),
    bridgeAddr: s(7),
    createdTimestamp: u(8),
    settledTimestamp: u(9),
    txHash: s(10),
    status: Number(u(11)),
    memo: s(12),
    failedBackToClob: u(13) !== 0n,
    updatedTimestamp: u(14),
    coinSymbol: s(15),
  };
}

// --- why the contract would refuse -----------------------------------------------------------

const ERRORS: Array<[string, string]> = [
  ['InvalidAccountNonce(address,uint256)', 'the permit nonce was already used - nothing more was sent'],
  ['ECDSAInvalidSignature()', 'the signature does not verify'],
  ['ECDSAInvalidSignatureLength(uint256)', 'the signature has the wrong length'],
  ['ECDSAInvalidSignatureS(bytes32)', 'the signature is not in canonical form'],
  ['WalletIsBlacklisted()', 'SoDEX blocks withdrawals to this address'],
  ['WalletNotWhitelisted()', 'this account only allows withdrawals to its whitelisted addresses'],
  ['WithdrawAmountLessThanMinWithdrawAmount(uint256,uint256)', 'the amount is below the minimum for this chain'],
  ['WithdrawAmountShouldBeGreaterThanWithdrawFee(uint256,uint256)', 'the amount does not cover the withdrawal fee'],
  ['CustodyDisabled()', 'SoDEX has withdrawals to this chain switched off'],
  ['ChainNotSupported()', 'SoDEX does not pay out this coin on this chain'],
  ['BridgeAddrNotSet()', 'SoDEX has no bridge set up for this coin'],
  ['EnforcedPause()', 'SoDEX has paused withdrawals'],
  ['InsufficientBalance(uint256,uint256)', 'not enough balance'],
  ['ERC20InsufficientBalance(address,uint256,uint256)', 'the wallet does not hold enough of this token'],
  ['ERC20InsufficientAllowance(address,uint256,uint256)', 'the token allowance is too low'],
  ['ERC2612ExpiredSignature(uint256)', 'the token permit expired'],
  ['ERC2612InvalidSigner(address,address)', 'the token permit was signed by the wrong account'],
];
const ERROR_BY_SELECTOR = new Map(ERRORS.map(([sig, text]) => [bytesToHex(selector(sig)), { name: sig.slice(0, sig.indexOf('(')), text }]));

/** A readable reason for revert data (a custom error or `Error(string)`), or null when unknown. */
export function describeRevert(data: string | null | undefined): { name: string; text: string } | null {
  if (!data || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === '0x08c379a0') {
    try {
      const body = hexToBytes(`0x${data.slice(10)}` as Hex);
      const msg = stringAt(body, offsetAt(body, 0));
      return { name: 'Error', text: msg.replace(/^SoDexToken[A-Za-z]*:\s*/, '') };
    } catch {
      return { name: 'Error', text: 'reverted' };
    }
  }
  return ERROR_BY_SELECTOR.get(sel as Hex) ?? null;
}
