/**
 * The server's signed fee terms (docs/BUILDER-TIERS.md section 3), verified by
 * the RUNNER - independently of the app, with node:crypto.
 *
 * Why the runner verifies them itself: the app lowers a wallet's builder fee
 * only on the strength of a signed statement. The runner must be able to tell
 * "the app carried 15 because the server signed 15 for this wallet, this
 * request, now" from "the app carried 15" - so it keeps its own list of the
 * statements it has seen verify, and the network guard lets an order leave with
 * a fee below the default ONLY when such a statement is in force.
 *
 * `TermsWatch.observe` is fed every answer of GET /api/vs/builder/terms that
 * passes the guard - the runner's own requests and the app's - before the
 * caller sees it. Nothing here signs anything; there is no private key.
 */
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';

export const TERMS_PATH = '/api/vs/builder/terms';
/** The app caps a terms answer's lifetime at 15 minutes (contract section 3). */
export const TERMS_TTL_CAP_MS = 15 * 60_000;

export interface FeePair {
  perps: number;
  spot: number;
}

export interface TermsVolume {
  perpsUsd: number;
  spotUsd: number;
  totalUsd: number;
  verifiedAt: number | null;
  pending: boolean;
}

/** One answer, as parsed - nothing in here is trusted until `verified` says so. */
export interface TermsAnswer {
  ok: boolean;
  chain: number | null;
  builderId: number | null;
  address: string | null;
  fee: FeePair | null;
  nonce: string | null;
  issued: number | null;
  ttl: number | null;
  keyId: string | null;
  sig: string | null;
  /** Display only (not signed): the first tier, the wallet's verified volume, its tier, its flags. */
  default: FeePair | null;
  volume: TermsVolume | null;
  tier: { index: number | null; next: { atUsd: number; fee: FeePair } | null } | null;
  flags: string[];
}

export interface TermsVerdict {
  answer: TermsAnswer;
  /** The answer is one the app must accept: signed by a pinned key for exactly this wallet, builder, chain and request. */
  verified: boolean;
  /** Why not (empty when verified, or when the feature is simply off). */
  problems: string[];
  /** The server has no tiers file: `{ ok: true, builderId: null }` - every order carries the build's default. */
  off: boolean;
  /** `sig: null`: the server has no signing key - every app pays the default. */
  unsigned: boolean;
  /** The key that verified it (first 8 hex of SHA-256 of the raw key). */
  keyId: string | null;
  /** When the runner received it (its own clock, ms) and until when it is in force (ttl capped at 15 min). */
  receivedAt: number;
  validUntil: number;
  /** The nonce of the request this answers (from the request, not from the answer). */
  requestNonce: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pair = (v: unknown): FeePair | null => {
  const o = obj(v);
  const p = int(o?.perps);
  const s = int(o?.spot);
  return p !== null && s !== null && p >= 0 && s >= 0 ? { perps: p, spot: s } : null;
};

/** Parse an answer body. Never throws; what is missing is null. */
export function parseTerms(body: unknown): TermsAnswer {
  const o = obj(body) ?? {};
  const vol = obj(o.volume);
  const tier = obj(o.tier);
  const next = obj(tier?.next);
  const nextFee = pair(next?.fee);
  return {
    ok: o.ok === true,
    chain: int(o.chain),
    builderId: int(o.builderId),
    address: typeof o.address === 'string' ? o.address : null,
    fee: pair(o.fee),
    nonce: typeof o.nonce === 'string' ? o.nonce : null,
    issued: int(o.issued),
    ttl: int(o.ttl),
    keyId: typeof o.keyId === 'string' ? o.keyId : null,
    sig: typeof o.sig === 'string' ? o.sig : null,
    default: pair(o.default),
    volume: vol
      ? { perpsUsd: num(vol.perpsUsd) ?? 0, spotUsd: num(vol.spotUsd) ?? 0, totalUsd: num(vol.totalUsd) ?? 0, verifiedAt: num(vol.verifiedAt), pending: vol.pending === true }
      : null,
    tier: tier ? { index: int(tier.index), next: next && nextFee && num(next.atUsd) !== null ? { atUsd: num(next.atUsd)!, fee: nextFee } : null } : null,
    flags: Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === 'string') : [],
  };
}

/** Exactly the bytes the server signs: lines joined by "\n", no trailing newline. */
export function termsMessage(t: { chain: number; builderId: number; address: string; perps: number; spot: number; nonce: string; issued: number; ttl: number }): string {
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
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** The raw 32 bytes of an Ed25519 public key given as base64url, or null. */
export function rawTermsKey(b64url: string): Buffer | null {
  const s = String(b64url ?? '').trim();
  if (!B64URL.test(s)) return null;
  const raw = Buffer.from(s, 'base64url');
  return raw.length === 32 ? raw : null;
}

/** `keyId`: the first 8 hex characters of SHA-256 of the raw public key. */
export function termsKeyId(b64url: string): string | null {
  const raw = rawTermsKey(b64url);
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 8) : null;
}

export function verifyTermsSignature(message: string, sigB64url: string, publicKeyB64url: string): boolean {
  const raw = rawTermsKey(publicKeyB64url);
  const s = String(sigB64url ?? '').trim();
  if (!raw || !B64URL.test(s)) return false;
  const sig = Buffer.from(s, 'base64url');
  if (sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** A fresh request nonce: 22 characters of [A-Za-z0-9_-] (the endpoint takes 16-64). */
export const newTermsNonce = (): string => randomBytes(16).toString('base64url');
export const isTermsNonce = (s: string): boolean => /^[A-Za-z0-9_-]{16,64}$/.test(s);

export interface TermsExpect {
  /** The connected wallet. */
  address: string;
  /** The nonce the request carried. */
  nonce: string;
  /** The pinned builder. */
  builderId: number;
  /** The chain the run trades on. */
  chainId: number;
  /** The pinned public keys (base64url of the raw 32 bytes). */
  keys: readonly string[];
  /** The build's default fees: a signed fee above them is refused. */
  defaults: FeePair;
  /** The runner's clock at arrival. */
  receivedAt: number;
}

/** Would the app have to accept this answer? The same rules as contract section 3, checked independently. */
export function judgeTerms(status: number, body: unknown, x: TermsExpect): TermsVerdict {
  const a = parseTerms(body);
  const problems: string[] = [];
  const base = { answer: a, receivedAt: x.receivedAt, validUntil: x.receivedAt, requestNonce: x.nonce };
  if (status !== 200) return { ...base, verified: false, problems: [`HTTP ${status}`], off: false, unsigned: false, keyId: null };
  if (!a.ok) return { ...base, verified: false, problems: ['the answer is not ok'], off: false, unsigned: false, keyId: null };
  if (a.builderId === null) return { ...base, verified: false, problems: [], off: true, unsigned: false, keyId: null };
  if (a.builderId !== x.builderId) problems.push(`signed for builder #${a.builderId}, not the pinned #${x.builderId}`);
  if (a.chain !== x.chainId) problems.push(`chain ${String(a.chain)}, expected ${x.chainId}`);
  if (!a.address || a.address.toLowerCase() !== x.address.toLowerCase()) problems.push('for another address');
  if (a.nonce !== x.nonce) problems.push('the nonce is not the one this request sent');
  if (!a.fee) problems.push('fee.perps / fee.spot are not whole numbers');
  else {
    if (a.fee.perps > x.defaults.perps) problems.push(`perps fee ${a.fee.perps} is above the default ${x.defaults.perps}`);
    if (a.fee.spot > x.defaults.spot) problems.push(`spot fee ${a.fee.spot} is above the default ${x.defaults.spot}`);
  }
  if (a.issued === null || a.ttl === null || a.ttl <= 0) problems.push('issued / ttl are missing');
  const unsigned = a.sig === null;
  let keyId: string | null = null;
  if (unsigned) problems.push('not signed (sig null): the server has no terms key');
  else if (!x.keys.length) problems.push('no public key is pinned in the run\'s config (builder.termsKeys)');
  else if (a.fee && a.issued !== null && a.ttl !== null && a.address && a.nonce !== null && a.builderId !== null && a.chain !== null) {
    // Rebuilt from the values that will be USED, so a changed field breaks the signature.
    const msg = termsMessage({ chain: a.chain, builderId: a.builderId, address: a.address, perps: a.fee.perps, spot: a.fee.spot, nonce: a.nonce, issued: a.issued, ttl: a.ttl });
    const key = x.keys.find((k) => verifyTermsSignature(msg, a.sig!, k));
    if (!key) problems.push('the signature does not verify under any pinned key');
    else keyId = termsKeyId(key);
  }
  const verified = problems.length === 0;
  return {
    answer: a,
    verified,
    problems,
    off: false,
    unsigned,
    keyId,
    receivedAt: x.receivedAt,
    validUntil: verified ? x.receivedAt + Math.min(a.ttl ?? 0, TERMS_TTL_CAP_MS) : x.receivedAt,
    requestNonce: x.nonce,
  };
}

export interface TermsWatchOptions {
  owner: string;
  builderId: number;
  chainId: number;
  keys: readonly string[];
  defaults: FeePair;
  now?: () => number;
}

/** Every terms answer that passed the guard, judged; and from them, which fees an order may carry right now. */
export class TermsWatch {
  readonly seen: TermsVerdict[] = [];
  private readonly now: () => number;
  constructor(private readonly o: TermsWatchOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  get defaults(): FeePair {
    return this.o.defaults;
  }

  /** Feed one answer (the guard calls this). `url` is the request's, for its address and nonce. */
  observe(url: URL, status: number, bodyText: string): TermsVerdict | null {
    const address = url.searchParams.get('address') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    // Another wallet's terms (nothing in this run asks for them) say nothing about this wallet's fee.
    if (address.toLowerCase() !== this.o.owner.toLowerCase()) return null;
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    const v = judgeTerms(status, body, { address: this.o.owner, nonce, builderId: this.o.builderId, chainId: this.o.chainId, keys: this.o.keys, defaults: this.o.defaults, receivedAt: this.now() });
    this.seen.push(v);
    if (this.seen.length > 500) this.seen.splice(0, this.seen.length - 500);
    return v;
  }

  /** The verified statements still in force. */
  inForce(at: number = this.now()): TermsVerdict[] {
    return this.seen.filter((v) => v.verified && v.answer.fee && at <= v.validUntil);
  }

  /** The fees an order on `engine` may carry now: the default, and every fee a statement in force names. */
  allowedFees(engine: 'spot' | 'perps', at: number = this.now()): number[] {
    return [...new Set([this.o.defaults[engine], ...this.inForce(at).map((v) => v.answer.fee![engine])])];
  }

  /** The latest answer (verified or not). */
  last(): TermsVerdict | null {
    return this.seen.at(-1) ?? null;
  }
}

/**
 * Ask the server for this wallet's terms - the runner's OWN request (the app
 * makes its own through its terms module). The answer is judged by the watch
 * on its way through the guard; this returns that verdict.
 */
export async function requestTerms(watch: TermsWatch, owner: string, o: { hint?: boolean } = {}): Promise<{ verdict: TermsVerdict; cacheControl: string | null; nonce: string }> {
  const nonce = newTermsNonce();
  const q = new URLSearchParams({ address: owner.toLowerCase(), nonce });
  if (o.hint) q.set('hint', '1');
  const before = watch.seen.length;
  const res = await fetch(`${TERMS_PATH}?${q}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  const text = await res.text();
  // The guard fed the watch already; when no guard is installed (unit tests) feed it here.
  const seen = watch.seen.slice(before).find((v) => v.requestNonce === nonce);
  const verdict = seen ?? watch.observe(new URL(`http://x${TERMS_PATH}?${q}`), res.status, text)!;
  return { verdict, cacheControl: res.headers.get('cache-control'), nonce };
}
