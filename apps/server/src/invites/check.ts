/**
 * The server's check of a signed invite join (claim.ts): its shape, wording, time window, and that the wallet it
 * names signed exactly those fields. Whether that wallet may still join is the store's to say.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import { CLAIM_DOMAIN, CLAIM_STATEMENT, CLAIM_TYPE, CODE_RE, INVITE_DOMAIN, INVITE_STATEMENT, INVITE_TTL_MS, INVITE_TYPE, INVITE_ZERO_ADDRESS, type CreditClaim, type InviteJoin } from './claim.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(INVITE_TYPE));
const CLAIM_TYPEHASH = keccak_256(utf8(CLAIM_TYPE));

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

/** What a wallet signs when it accepts ValueDesk's terms (packages/copy-engine/src/api.ts CopyRequest; kept equal by test/invites.test.ts). */
const TERMS_TYPEHASH = keccak_256(utf8('CopyRequest(string action,address owner,string executor,string payload,uint64 nonce,uint64 deadline)'));
export const TERMS_DOMAIN = { name: 'ValueDesk Copy', version: '1' } as const;
/** The statements of the terms, and the executor each names: ValueDesk's own terms, or the copy and bot terms that carry them. */
const TERMS_ACTIONS: Record<string, string> = { 'accept-site-terms': 'valuedesk-site-terms', 'accept-terms': 'valuedesk-copy-terms' };
/** A terms signature joins for this long after it was given (the page sends it at once, and again while the server does not answer). */
export const TERMS_JOIN_MS = 7 * 86_400_000;

export interface TermsRequest { action: string; owner: string; executor: string; payload: string; nonce: string; deadline: string; chainId: number; signature: string }

export function termsDigest(r: Omit<TermsRequest, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    TERMS_TYPEHASH,
    keccak_256(utf8(r.action)),
    addressWord(r.owner.toLowerCase()),
    keccak_256(utf8(r.executor)),
    keccak_256(utf8(r.payload)),
    word(BigInt(r.nonce)),
    word(BigInt(r.deadline)),
  ));
  const domain = domainSeparator({ name: TERMS_DOMAIN.name, version: TERMS_DOMAIN.version, chainId: r.chainId, verifyingContract: INVITE_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

/**
 * A join by the terms signature: the wallet accepted ValueDesk's terms in a window that showed the referral code, and the
 * page sends that signed acceptance with the code. The signature proves the wallet; it is not public (the wallet's browser
 * and ValueDesk have it), so nobody else can join a wallet with it.
 */
export function checkTermsJoin(raw: unknown, now = Date.now()): JoinCheck {
  const t = raw as { code?: unknown; request?: unknown } | null;
  const q = t?.request as Partial<TermsRequest> | null;
  if (!t || !q || typeof q !== 'object') return { ok: false, error: 'missing terms' };
  if (typeof t.code !== 'string' || !CODE_RE.test(t.code)) return { ok: false, error: 'this is not an invite code' };
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'wallet must be a 0x address' };
  if (typeof q.action !== 'string' || !Object.hasOwn(TERMS_ACTIONS, q.action) || q.executor !== TERMS_ACTIONS[q.action]) return { ok: false, error: 'this is not an acceptance of the terms' };
  if (typeof q.payload !== 'string' || q.payload.length > 12_000) return { ok: false, error: 'payload must be text' };
  if (typeof q.nonce !== 'string' || !STAMP.test(q.nonce) || typeof q.deadline !== 'string' || !STAMP.test(q.deadline)) return { ok: false, error: 'nonce and deadline must be times in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const signedAt = Number(q.nonce);
  if (signedAt - now > 5 * 60_000) return { ok: false, error: 'the signature time is too far ahead; check your clock' };
  if (now - signedAt > TERMS_JOIN_MS || Number(q.deadline) <= now) return { ok: false, error: 'this signature is too old to join with' };
  const r = { action: q.action, owner, executor: TERMS_ACTIONS[q.action]!, payload: q.payload, nonce: q.nonce, deadline: q.deadline, chainId };
  let signer: string;
  try {
    signer = recoverAddress(termsDigest(r), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, join: { wallet: owner, code: t.code, statement: INVITE_STATEMENT, nonce: `terms:${q.nonce}`, issuedAt: q.nonce, expiresAt: q.deadline, chainId, signature: q.signature } };
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

/** The EIP-712 digest of a weekly claim. */
export function creditClaimDigest(c: Omit<CreditClaim, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    CLAIM_TYPEHASH,
    addressWord(c.wallet.toLowerCase()),
    word(BigInt(c.week)),
    keccak_256(utf8(c.statement)),
    keccak_256(utf8(c.nonce)),
    word(BigInt(c.issuedAt)),
    word(BigInt(c.expiresAt)),
  ));
  const domain = domainSeparator({ name: CLAIM_DOMAIN.name, version: CLAIM_DOMAIN.version, chainId: c.chainId, verifyingContract: INVITE_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type ClaimCheck = { ok: true; claim: CreditClaim } | { ok: false; error: string };

/** A signed claim: its shape, wording, time window, and that the wallet it names signed it. Which week is open is the service's. */
export function checkCreditClaim(raw: unknown, now = Date.now()): ClaimCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing claim' };
  const q = raw as Record<string, unknown>;
  const wallet = typeof q.wallet === 'string' ? q.wallet.toLowerCase() : '';
  if (!ADDRESS.test(wallet)) return { ok: false, error: 'wallet must be a 0x address' };
  const week = Number(q.week);
  if (!Number.isSafeInteger(week) || week < 0) return { ok: false, error: 'week must be a number' };
  if (q.statement !== CLAIM_STATEMENT) return { ok: false, error: 'this is not the credit claim; reload the page and sign again' };
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
  const fields = { wallet, week, statement: CLAIM_STATEMENT, nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId };
  let signer: string;
  try {
    signer = recoverAddress(creditClaimDigest(fields), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== wallet) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, claim: { ...fields, signature: q.signature } };
}
