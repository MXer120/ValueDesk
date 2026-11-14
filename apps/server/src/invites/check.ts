/**
 * The server's check of a signed invite join (claim.ts): its shape, wording, time window, and that the wallet it
 * names signed exactly those fields. Whether that wallet may still join is the store's to say.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { CODE_RE, INVITE_DOMAIN, INVITE_STATEMENT, INVITE_TTL_MS, INVITE_TYPE, INVITE_ZERO_ADDRESS, type InviteJoin } from './claim.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(INVITE_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of a join: what the wallet signed. */
export function inviteJoinDigest(c: Omit<InviteJoin, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    TYPEHASH,
    addressWord(c.wallet.toLowerCase()),
    keccak_256(utf8(c.code)),
    keccak_256(utf8(c.statement)),
    keccak_256(utf8(c.nonce)),
    word(BigInt(c.issuedAt)),
    word(BigInt(c.expiresAt)),
  ));
  const domain = domainSeparator({ name: INVITE_DOMAIN.name, version: INVITE_DOMAIN.version, chainId: c.chainId, verifyingContract: INVITE_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type JoinCheck = { ok: true; join: InviteJoin } | { ok: false; error: string };

export function checkInviteJoin(raw: unknown, now = Date.now()): JoinCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing join' };
  const q = raw as Record<string, unknown>;
  const wallet = typeof q.wallet === 'string' ? q.wallet.toLowerCase() : '';
  if (!ADDRESS.test(wallet)) return { ok: false, error: 'wallet must be a 0x address' };
  if (typeof q.code !== 'string' || !CODE_RE.test(q.code)) return { ok: false, error: 'this is not an invite code' };
  if (q.statement !== INVITE_STATEMENT) return { ok: false, error: 'this is not the invite join; reload the page and sign again' };
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this signature has expired; sign again' };
  if (expiresAt - issuedAt > INVITE_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this signature is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the signature time is too far ahead; check your clock' };
  const fields = { wallet, code: q.code, statement: INVITE_STATEMENT, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId };
  let signer: string;
  try {
    signer = recoverAddress(inviteJoinDigest(fields), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== wallet) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, join: { ...fields, signature: q.signature } };
}
