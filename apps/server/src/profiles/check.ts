/**
 * The server's check of a signed username change (claim.ts): its shape, wording, name rules, time
 * window, and that the wallet it names signed exactly those fields. Whether the name is free, and
 * whether the signature is newer than the wallet's last change, is the store's to say (store.ts).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { USERNAME_CHANGE_TTL_MS, USERNAME_DOMAIN, USERNAME_STATEMENT, USERNAME_TYPE, USERNAME_ZERO_ADDRESS, usernameProblem, usernameProblemText, type UsernameChange } from './claim.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(USERNAME_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of a change: what the wallet signed. */
export function usernameChangeDigest(c: Omit<UsernameChange, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    TYPEHASH,
    addressWord(c.owner.toLowerCase()),
    keccak_256(utf8(c.username)),
    keccak_256(utf8(c.statement)),
    keccak_256(utf8(c.nonce)),
    word(BigInt(c.issuedAt)),
    word(BigInt(c.expiresAt)),
  ));
  const domain = domainSeparator({ name: USERNAME_DOMAIN.name, version: USERNAME_DOMAIN.version, chainId: c.chainId, verifyingContract: USERNAME_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type ChangeCheck = { ok: true; change: UsernameChange } | { ok: false; error: string };

export function checkUsernameChange(raw: unknown, now = Date.now()): ChangeCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing change' };
  const q = raw as Record<string, unknown>;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (typeof q.username !== 'string') return { ok: false, error: 'username must be text' };
  const problem = usernameProblem(q.username);
  if (problem) return { ok: false, error: usernameProblemText(problem) };
  if (q.statement !== USERNAME_STATEMENT) return { ok: false, error: 'this is not the username change; reload the page and sign again' };
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this signature has expired; sign again' };
  if (expiresAt - issuedAt > USERNAME_CHANGE_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this signature is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the signature time is too far ahead; check your clock' };
  const fields = { owner, username: q.username, statement: USERNAME_STATEMENT, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId };
  let signer: string;
  try {
    signer = recoverAddress(usernameChangeDigest(fields), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, change: { ...fields, signature: q.signature } };
}
