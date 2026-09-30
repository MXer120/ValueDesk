/**
 * Receiving addresses, by kind: what an address IS (so the address book can
 * tell a Bitcoin address from a Tron one) and whether it is a VALID one of its
 * kind - checksums included, because a withdrawal to a mistyped address is
 * gone. Pure functions, no network.
 *
 *   evm       0x + 40 hex, EIP-55 checksum when mixed-case
 *   solana    base58, 32 bytes
 *   bitcoin   base58check P2PKH/P2SH, bech32 (bc1q…) / bech32m taproot (bc1p…)
 *   litecoin  base58check L/M/3, bech32 ltc1…
 *   dogecoin  base58check D/9/A
 *   tron      base58check T… (0x41 + 20 bytes)
 *   xrp       r… (XRP Ledger's base58 alphabet, base58check)
 *   stellar   G… StrKey (base32, CRC16-XModem)
 *   ton       user-friendly EQ…/UQ… (base64(url), CRC16) or raw 0:<64 hex>
 *   sui       0x + 64 hex
 *   cardano   Shelley bech32 addr1…
 */
import { sha256 } from '@noble/hashes/sha256';
import { keccak256, utf8 } from '@sodex-core';

export type AddressKind =
  | 'evm' | 'solana' | 'bitcoin' | 'litecoin' | 'dogecoin' | 'tron' | 'xrp' | 'stellar' | 'ton' | 'sui' | 'cardano';

export const ADDRESS_KIND_LABEL: Record<AddressKind, string> = {
  evm: 'EVM', solana: 'Solana', bitcoin: 'Bitcoin', litecoin: 'Litecoin', dogecoin: 'Dogecoin', tron: 'Tron',
  xrp: 'XRP Ledger', stellar: 'Stellar', ton: 'TON', sui: 'Sui', cardano: 'Cardano',
};

// --- encodings ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_XRP = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** base58 -> bytes (leading "zeros" = the alphabet's first character), or null. */
export function base58Decode(s: string, alphabet = B58): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === alphabet[0]) zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array, alphabet = B58): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = alphabet[0]! + out;
  }
  return out;
}

const dsha = (b: Uint8Array) => sha256(sha256(b));

/** base58check -> payload (version byte included), or null when the checksum fails. */
export function base58CheckDecode(s: string, alphabet = B58): Uint8Array | null {
  const raw = base58Decode(s, alphabet);
  if (!raw || raw.length < 5) return null;
  const payload = raw.slice(0, -4);
  const sum = dsha(payload);
  for (let i = 0; i < 4; i++) if (raw[raw.length - 4 + i] !== sum[i]) return null;
  return payload;
}

export function base58CheckEncode(payload: Uint8Array, alphabet = B58): string {
  const sum = dsha(payload).slice(0, 4);
  return base58Encode(Uint8Array.from([...payload, ...sum]), alphabet);
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (values: number[]): number => {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
};
const hrpExpand = (hrp: string): number[] => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** bech32 / bech32m -> {hrp, words, variant}, or null. `limit`: 90 for BIP-173 addresses, more for Cardano. */
export function bech32Decode(s: string, limit = 90): { hrp: string; words: number[]; variant: 'bech32' | 'bech32m' } | null {
  if (s.length > limit || s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const str = s.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return null;
  const hrp = str.slice(0, pos);
  const words: number[] = [];
  for (const ch of str.slice(pos + 1)) {
    const v = BECH32.indexOf(ch);
    if (v < 0) return null;
    words.push(v);
  }
  const check = polymod([...hrpExpand(hrp), ...words]);
  const variant = check === 1 ? 'bech32' : check === 0x2bc830a3 ? 'bech32m' : null;
  if (!variant) return null;
  return { hrp, words: words.slice(0, -6), variant };
}

export function bech32Encode(hrp: string, words: number[], variant: 'bech32' | 'bech32m' = 'bech32'): string {
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ (variant === 'bech32' ? 1 : 0x2bc830a3);
  const sum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => BECH32[w]).join('')}`;
}

/** Regroup bits (5 -> 8 for bech32 data); null on bad padding. */
export function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max)) {
    return null;
  }
  return out;
}

/** A segwit address for `hrp` (bc, ltc): v0 = bech32 with 20/32 bytes, v1+ = bech32m. */
function segwitValid(s: string, hrp: string): boolean {
  const d = bech32Decode(s);
  if (!d || d.hrp !== hrp || !d.words.length) return false;
  const version = d.words[0]!;
  const program = convertBits(d.words.slice(1), 5, 8, false);
  if (!program || version > 16 || program.length < 2 || program.length > 40) return false;
  if (version === 0) return d.variant === 'bech32' && (program.length === 20 || program.length === 32);
  return d.variant === 'bech32m';
}

const crc16xmodem = (bytes: Uint8Array): number => {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function base64Decode(s: string): Uint8Array | null {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(std)) return null;
  try {
    const bin = atob(std);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// --- validators ----------------------------------------------------------------------------

/** EIP-55 checksum form of a 0x address. */
export function toChecksumAddress(addr: string): string {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const hash = Array.from(keccak256(utf8(lower)), (b) => b.toString(16).padStart(2, '0')).join('');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

const versioned = (s: string, versions: number[], len = 21, alphabet = B58): boolean => {
  const p = base58CheckDecode(s, alphabet);
  return !!p && p.length === len && versions.includes(p[0]!);
};

/**
 * Why `addr` is not a valid address of this kind (null = valid). EVM checks
 * the EIP-55 checksum only when the address is mixed-case, as wallets do.
 */
export function addressProblem(kind: AddressKind, addr: string): 'format' | 'checksum' | 'zero' | null {
  const a = addr.trim();
  switch (kind) {
    case 'evm': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return 'format';
      if (/^0x0{40}$/i.test(a)) return 'zero';
      const body = a.slice(2);
      return body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksumAddress(a) !== a ? 'checksum' : null;
    }
    case 'solana': {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'format';
      return base58Decode(a)?.length === 32 ? null : 'checksum';
    }
    case 'bitcoin':
      if (/^(bc1|BC1)/.test(a)) return segwitValid(a, 'bc') ? null : 'checksum';
      if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return 'format';
      return versioned(a, [0x00, 0x05]) ? null : 'checksum';
    case 'litecoin':
      if (/^(ltc1|LTC1)/.test(a)) return segwitValid(a, 'ltc') ? null : 'checksum';
      if (!/^[LM3][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return 'format';
      return versioned(a, [0x30, 0x32, 0x05]) ? null : 'checksum';
    case 'dogecoin':
      if (!/^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return 'format';
      return versioned(a, [0x1e, 0x16]) ? null : 'checksum';
    case 'tron':
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'format';
      return versioned(a, [0x41]) ? null : 'checksum';
    case 'xrp':
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return 'format';
      return versioned(a, [0x00], 21, B58_XRP) ? null : 'checksum';
    case 'stellar': {
      if (!/^G[A-Z2-7]{55}$/.test(a)) return 'format';
      const raw = base32Decode(a);
      if (!raw || raw.length !== 35 || raw[0] !== 6 << 3) return 'checksum';
      const crc = crc16xmodem(raw.slice(0, 33));
      return raw[33] === (crc & 0xff) && raw[34] === crc >> 8 ? null : 'checksum';
    }
    case 'ton': {
      if (/^-?[01]:[0-9a-fA-F]{64}$/.test(a)) return null;
      if (!/^[A-Za-z0-9_+/-]{48}$/.test(a)) return 'format';
      const raw = base64Decode(a);
      if (!raw || raw.length !== 36) return 'checksum';
      const crc = crc16xmodem(raw.slice(0, 34));
      return raw[34] === crc >> 8 && raw[35] === (crc & 0xff) ? null : 'checksum';
    }
    case 'sui':
      return /^0x[0-9a-fA-F]{64}$/.test(a) ? null : 'format';
    case 'cardano': {
      if (!/^addr1[02-9ac-hj-np-z]{50,}$/.test(a)) return 'format';
      const d = bech32Decode(a, 200);
      return d && d.hrp === 'addr' && d.variant === 'bech32' ? null : 'checksum';
    }
  }
}

/** Every kind `addr` is a valid address of (EVM and Sui never overlap: 40 vs 64 hex). */
export function addressKinds(addr: string): AddressKind[] {
  const a = addr.trim();
  if (!a) return [];
  return (Object.keys(ADDRESS_KIND_LABEL) as AddressKind[]).filter((k) => addressProblem(k, a) === null);
}

/** The one kind `addr` is, or null (none, or - never for real addresses - several). */
export function addressKindOf(addr: string): AddressKind | null {
  const kinds = addressKinds(addr);
  return kinds.length === 1 ? kinds[0]! : null;
}
