/**
 * The signed fee terms (docs/BUILDER-TIERS.md section 3), checked from the
 * outside: the guide asks the running backend for terms and verifies the
 * answer with the PUBLIC key the tier tool printed - the same check the app
 * makes before it lowers a fee. Nothing is signed here; there is no private
 * key anywhere in the guide.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { Verdict } from './readonly';

export const TERMS_PATH = '/api/vs/builder/terms';
export const TERMS_CHAIN = 286623;
/** The app caps a terms answer's lifetime at 15 minutes. */
export const TERMS_TTL_CAP_MS = 15 * 60_000;

export interface TermsFields {
  chain: number;
  builderId: number;
  address: string;
  perps: number;
  spot: number;
  nonce: string;
  issued: number;
  ttl: number;
}

/** Exactly the bytes the server signs: lines joined by "\n", no trailing newline. */
export function termsMessage(t: TermsFields): string {
  return [
    'valuescan-builder-terms/1',
    `chain:${t.chain}`,
    `builder:${t.builderId}`,
    `address:${t.address.toLowerCase()}`,
    `perps:${t.perps}`,
    `spot:${t.spot}`,
    `nonce:${t.nonce}`,
    `issued:${t.issued}`,
    `ttl:${t.ttl}`,
  ].join('\n');
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The raw 32 bytes of an Ed25519 public key given as base64url, or null. */
export function rawPublicKey(b64url: string): Buffer | null {
  const s = b64url.trim();
  if (!B64URL.test(s)) return null;
  const raw = Buffer.from(s, 'base64url');
  return raw.length === 32 ? raw : null;
}

/** `keyId`: the first 8 hex characters of SHA-256 of the raw public key. */
export function keyIdOf(publicKeyB64url: string): string | null {
  const raw = rawPublicKey(publicKeyB64url);
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 8) : null;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key follows. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyTermsSignature(message: string, sigB64url: string, publicKeyB64url: string): boolean {
  const raw = rawPublicKey(publicKeyB64url);
  if (!raw || !B64URL.test(sigB64url.trim())) return false;
  const sig = Buffer.from(sigB64url.trim(), 'base64url');
  if (sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** A nonce as the endpoint wants it: 16-64 characters of [A-Za-z0-9_-]. */
export function isTermsNonce(s: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

export interface TermsExpectation {
  address: string;
  nonce: string;
  /** The builder the tiers were set up for (null: only report what the backend says). */
  builderId: number | null;
  /** Public keys the answer may be signed with (base64url). Empty: the signature cannot be checked. */
  publicKeys: readonly string[];
  cacheControl: string | null;
  now: number;
}

export interface TermsVerdict extends Verdict {
  /** What the terms say an order placed now carries. */
  fee?: { perps: number; spot: number };
  defaultFee?: { perps: number; spot: number };
  /** The next tier, as the answer shows it (display only - it is not signed). */
  next?: { atUsd: number; perps: number; spot: number } | null;
  /** false: the backend says the feature is off (no tiers file). */
  on?: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const pair = (v: unknown): { perps: number; spot: number } | null => {
  const o = obj(v);
  const p = int(o?.perps);
  const s = int(o?.spot);
  return p !== null && s !== null && p >= 0 && s >= 0 ? { perps: p, spot: s } : null;
};

/** Is this terms answer one the app would accept - and does it say what the tiers file says? */
export function judgeTerms(status: number, body: unknown, x: TermsExpectation): TermsVerdict {
  const o = obj(body);
  if (status === 404) return { status: 'FAIL', detail: `the backend has no ${TERMS_PATH} route yet (HTTP 404) - the fee tiers are not in this server version` };
  if (status !== 200 || !o) return { status: 'FAIL', detail: `HTTP ${status}${o && typeof o.error === 'string' ? `: ${o.error}` : ''}` };
  if (o.ok !== true) return { status: 'FAIL', detail: `the terms answer is not ok${typeof o.code === 'string' ? ` (${o.code})` : ''}: ${String(o.error ?? 'no message')} - every order carries the default fee until it is` };
  if (o.builderId === null || o.builderId === undefined) {
    return x.builderId === null
      ? { status: 'WARN', detail: 'fee tiers are OFF on the backend (no tiers file): every order carries the build\'s default fee', on: false }
      : { status: 'FAIL', detail: 'the backend says the fee tiers are OFF (builderId null) - it has not picked up builder-tiers.json', on: false };
  }
  const problems: string[] = [];
  /** Things the app tolerates (it accepts the terms anyway) but a correct server would not send. */
  const oddities: string[] = [];
  const builderId = int(o.builderId);
  if (builderId === null) problems.push('builderId is not a whole number');
  else if (x.builderId !== null && builderId !== x.builderId) problems.push(`the backend signs for builder #${builderId}, not #${x.builderId}`);
  if (int(o.chain) !== TERMS_CHAIN) problems.push(`chain is ${String(o.chain)}, expected ${TERMS_CHAIN}`);
  if (typeof o.address !== 'string' || o.address.toLowerCase() !== x.address.toLowerCase()) problems.push('the answer is for another address');
  if (o.nonce !== x.nonce) problems.push('the nonce was not echoed (a replayed answer would look like this)');
  const fee = pair(o.fee);
  const dflt = pair(o.default);
  if (!fee) problems.push('fee.perps / fee.spot are not whole numbers');
  if (fee && dflt && (fee.perps > dflt.perps || fee.spot > dflt.spot)) problems.push(`the signed fee (${fee.perps}/${fee.spot}) is above the default (${dflt.perps}/${dflt.spot})`);
  const issued = int(o.issued);
  const ttl = int(o.ttl);
  if (issued === null || ttl === null) problems.push('issued / ttl are missing');
  else {
    // The app needs a positive ttl and caps it at 15 minutes itself; it does not use `issued` for validity.
    if (ttl <= 0) problems.push(`ttl is ${ttl} ms - the app needs a positive one`);
    else if (ttl > TERMS_TTL_CAP_MS) oddities.push(`ttl is ${ttl} ms; the app cuts it to ${TERMS_TTL_CAP_MS}`);
    if (Math.abs(x.now - issued) > 5 * 60_000) oddities.push(`issued is ${Math.round(Math.abs(x.now - issued) / 1000)} s away from this computer's clock (check the server's clock)`);
  }
  if (!/\bno-store\b/i.test(x.cacheControl ?? '')) problems.push(`Cache-Control is "${x.cacheControl ?? ''}", not no-store`);

  let signed = '';
  if (o.sig === null || o.sig === undefined) {
    problems.push('the answer is NOT SIGNED (sig null): the backend has no terms key, so every app pays the default fee');
  } else if (typeof o.sig !== 'string') {
    problems.push('sig is not a string');
  } else if (!x.publicKeys.length) {
    signed = ' (signature not checked: no public key is known here)';
  } else if (fee && builderId !== null && issued !== null && ttl !== null && typeof o.address === 'string') {
    const msg = termsMessage({ chain: TERMS_CHAIN, builderId, address: o.address, perps: fee.perps, spot: fee.spot, nonce: x.nonce, issued, ttl });
    const key = x.publicKeys.find((k) => verifyTermsSignature(msg, o.sig as string, k));
    if (!key) problems.push('the signature does NOT verify under the public key the tier tool printed - the app would ignore these terms and charge the default fee');
    else {
      // keyId only says which pinned key to try first: the app accepts terms that verify under any pinned key.
      const id = keyIdOf(key);
      if (typeof o.keyId === 'string' && id && o.keyId !== id) oddities.push(`keyId says ${o.keyId}, the key that verifies has id ${id} (the app accepts it anyway)`);
      signed = `, signature verifies (key ${id})`;
    }
  }
  const tier = obj(o.tier);
  const nextObj = obj(tier?.next);
  const nextFee = pair(nextObj?.fee);
  const next = nextObj && nextFee && typeof nextObj.atUsd === 'number' ? { atUsd: nextObj.atUsd, ...nextFee } : null;
  if (problems.length) return { status: 'FAIL', detail: [...problems, ...oddities].join('; '), on: true, ...(fee ? { fee } : {}), ...(dflt ? { defaultFee: dflt } : {}), next };
  return {
    status: signed.includes('not checked') || oddities.length ? 'WARN' : 'PASS',
    detail: `terms for builder #${builderId}: perps ${fee!.perps} / spot ${fee!.spot}${dflt ? ` (default ${dflt.perps} / ${dflt.spot})` : ''}, valid ${Math.round(ttl! / 60_000)} min${signed}${oddities.length ? `; but: ${oddities.join('; ')}` : ''}`,
    on: true,
    fee: fee!,
    ...(dflt ? { defaultFee: dflt } : {}),
    next,
  };
}
