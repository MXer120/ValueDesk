/**
 * The server's check of a signed index action (claim.ts): its shape, which of the two statements it is, the index rules
 * for a publish, the time window, and that the wallet it names signed exactly those fields. Whether the index exists, is
 * that wallet's, is still up, and whether the signature is newer than the one that last changed it, is the store's to
 * say (store.ts).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { concat, domainSeparator, hexToBytes, recoverAddress, utf8, word } from '../signing/eip712.js';
import {
  INDEX_ACTION_TTL_MS, INDEX_DOMAIN, INDEX_ID, INDEX_IMAGE, INDEX_PUBLISH_STATEMENT, INDEX_TYPE, INDEX_UNPUBLISH_STATEMENT, INDEX_ZERO_ADDRESS,
  indexProblem, indexProblemText, legsText, parseLegs, tidyDescription, tidyName, type IndexAction, type IndexLegBp,
} from './claim.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{13}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TYPEHASH = keccak_256(utf8(INDEX_TYPE));

function addressWord(a: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}

/** The EIP-712 digest of an action: what the wallet signed for indexTypedData (eth_signTypedData_v4). */
export function indexActionDigest(c: Omit<IndexAction, 'signature'>): Uint8Array {
  const struct = keccak_256(concat(
    TYPEHASH,
    addressWord(c.owner.toLowerCase()),
    keccak_256(utf8(c.id)),
    keccak_256(utf8(c.name)),
    keccak_256(utf8(c.description)),
    keccak_256(utf8(c.legs)),
    keccak_256(utf8(c.image)),
    keccak_256(utf8(c.statement)),
    keccak_256(utf8(c.nonce)),
    word(BigInt(c.issuedAt)),
    word(BigInt(c.expiresAt)),
  ));
  const domain = domainSeparator({ name: INDEX_DOMAIN.name, version: INDEX_DOMAIN.version, chainId: c.chainId, verifyingContract: INDEX_ZERO_ADDRESS });
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

export type IndexActionKind = 'publish' | 'unpublish';

export type ActionCheck =
  /** `legs`: the parsed legs of a publish; [] for a take-down, whose legs text is signed but not read. */
  | { ok: true; action: IndexAction; kind: IndexActionKind; legs: IndexLegBp[] }
  | { ok: false; error: string };

export function checkIndexAction(raw: unknown, now = Date.now()): ActionCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing action' };
  const q = raw as Record<string, unknown>;
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  // The statement says what is asked: the two wordings differ, so one signature can never be read as the other.
  const kind: IndexActionKind | null = q.statement === INDEX_PUBLISH_STATEMENT ? 'publish' : q.statement === INDEX_UNPUBLISH_STATEMENT ? 'unpublish' : null;
  if (!kind) return { ok: false, error: 'this is not an index action; reload the page and sign again' };
  if (typeof q.id !== 'string' || (q.id !== '' && !INDEX_ID.test(q.id))) return { ok: false, error: 'id must be an index id, or empty for a new index' };
  if (kind === 'unpublish' && q.id === '') return { ok: false, error: 'taking an index down needs its id' };
  if (typeof q.name !== 'string' || typeof q.description !== 'string' || typeof q.legs !== 'string') return { ok: false, error: 'name, description and legs must be text' };
  // The picture's hash, or '' for none: signed on a take-down too (whatever the page had), checked the same way.
  if (typeof q.image !== 'string' || (q.image !== '' && !INDEX_IMAGE.test(q.image))) return { ok: false, error: 'image must be the SHA-256 of the picture in lowercase hex, or empty for none' };
  let legs: IndexLegBp[] = [];
  if (kind === 'publish') {
    // Signed as stored: the page tidies before it signs, so a text the server would tidy differently is refused,
    // never silently changed after the wallet signed it.
    if (tidyName(q.name) !== q.name) return { ok: false, error: 'the name has extra spaces; reload the page and sign again' };
    if (tidyDescription(q.description) !== q.description) return { ok: false, error: 'the description has extra spaces or blank lines; reload the page and sign again' };
    const parsed = parseLegs(q.legs);
    // One spelling only ("vQQQ:4000", not "vQQQ:04000"): what is stored is the text that was signed.
    if (!parsed || legsText(parsed) !== q.legs) return { ok: false, error: 'legs must be written as fundId:bp,fundId:bp' };
    const problem = indexProblem({ name: q.name, description: q.description, legs: parsed });
    if (problem) return { ok: false, error: indexProblemText(problem) };
    legs = parsed;
  }
  if (typeof q.nonce !== 'string' || !NONCE.test(q.nonce)) return { ok: false, error: 'nonce must be 32 hex characters' };
  if (typeof q.issuedAt !== 'string' || !STAMP.test(q.issuedAt)) return { ok: false, error: 'issuedAt must be a time in ms' };
  if (typeof q.expiresAt !== 'string' || !STAMP.test(q.expiresAt)) return { ok: false, error: 'expiresAt must be a time in ms' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !SIGNATURE.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const issuedAt = Number(q.issuedAt);
  const expiresAt = Number(q.expiresAt);
  if (expiresAt <= now) return { ok: false, error: 'this signature has expired; sign again' };
  if (expiresAt - issuedAt > INDEX_ACTION_TTL_MS || expiresAt <= issuedAt) return { ok: false, error: 'this signature is valid for longer than allowed' };
  if (issuedAt - now > 5 * 60_000) return { ok: false, error: 'the signature time is too far ahead; check your clock' };
  const fields = {
    owner, id: q.id, name: q.name, description: q.description, legs: q.legs, image: q.image,
    statement: kind === 'publish' ? INDEX_PUBLISH_STATEMENT : INDEX_UNPUBLISH_STATEMENT,
    nonce: q.nonce, issuedAt: q.issuedAt, expiresAt: q.expiresAt, chainId,
  };
  let signer: string;
  try {
    signer = recoverAddress(indexActionDigest(fields), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, action: { ...fields, signature: q.signature }, kind, legs };
}
