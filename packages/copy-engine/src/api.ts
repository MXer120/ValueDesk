/**
 * The executor API: what a web app sends to an executor (hosted or
 * self-hosted) and how the executor knows the follower asked for it.
 *
 * EVERY CHANGE IS SIGNED BY THE FOLLOWER'S WALLET. A request is EIP-712 typed
 * data whose message carries the action, the wallet, the executor it is meant
 * for, the payload as readable JSON, a nonce and a deadline:
 *
 *   CopyRequest(string action,address owner,string executor,string payload,uint64 nonce,uint64 deadline)
 *
 * so the wallet shows exactly what is being agreed to ("subscribe", the
 * trader, every copy rule), the executor verifies it by recovering the
 * signer, and the signed request is kept as the record of the follower's
 * instruction. The domain's chainId is the wallet's CURRENT chain (wallets
 * refuse typed data for another chain), as for SoDEX's own key registration;
 * replay across executors is prevented by `executor`, within one by the nonce.
 *
 * Reads use a short-lived session token obtained with one signed 'session'
 * request.
 */
import { ZERO_ADDRESS, bytesToHex, hashTypedData, hexToBytes, recoverAddress, type TypedData } from '../../sodex-core/src/index.ts';
import type { RegionPolicy } from './policy.ts';
import type { CopyView } from './runtime.ts';
import type { ActivityEntry, CopyMode, CopySettings } from './types.ts';

export const COPY_DOMAIN = { name: 'ValueDesk Copy', version: '1' } as const;

/**
 * The `executor` an 'accept-terms' request names: the terms are one statement
 * whoever records it, so ONE signature is posted to ValueDesk's executor (its
 * record of who accepted what) and to a follower's own executor alike.
 */
export const COPY_TERMS_EXECUTOR = 'valuedesk-copy-terms';

export type CopyAction =
  | 'session'
  | 'accept-terms'
  | 'create-key'
  | 'delete-key'
  | 'subscribe'
  | 'update'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'stop-all'
  /** Start an algo order (TWAP, VWAP, ...): the payload is its spec, as the wallet displays it. */
  | 'algo-start'
  /** Pause, resume or cancel an algo order, or cancel all of them. */
  | 'algo-action';

export const COPY_ACTIONS: readonly CopyAction[] = ['session', 'accept-terms', 'create-key', 'delete-key', 'subscribe', 'update', 'pause', 'resume', 'stop', 'stop-all', 'algo-start', 'algo-action'];

export const COPY_REQUEST_FIELDS = [
  { name: 'action', type: 'string' },
  { name: 'owner', type: 'address' },
  { name: 'executor', type: 'string' },
  { name: 'payload', type: 'string' },
  { name: 'nonce', type: 'uint64' },
  { name: 'deadline', type: 'uint64' },
] as const;

/** A request as the wallet signed it. Integers are decimal strings (ms). */
export interface CopyRequest {
  action: CopyAction;
  owner: string;
  executor: string;
  payload: string;
  nonce: string;
  deadline: string;
  /** The wallet's chain when it signed: the EIP-712 domain chainId. */
  chainId: number;
}

export interface SignedCopyRequest extends CopyRequest {
  /** 0x + 65 bytes (r, s, v). */
  signature: string;
}

/** JSON with object keys sorted at every level: the exact text a wallet shows and signs. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJSON(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`)
    .join(',')}}`;
}

export function copyRequestTypedData(r: CopyRequest): TypedData<'CopyRequest'> {
  return {
    domain: { name: COPY_DOMAIN.name, version: COPY_DOMAIN.version, chainId: r.chainId, verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      CopyRequest: COPY_REQUEST_FIELDS,
    },
    primaryType: 'CopyRequest',
    message: {
      action: r.action,
      owner: r.owner.toLowerCase(),
      executor: r.executor,
      payload: r.payload,
      nonce: r.nonce,
      deadline: r.deadline,
    },
  };
}

export const copyRequestDigest = (r: CopyRequest): string => bytesToHex(hashTypedData(copyRequestTypedData(r)));

/**
 * An instruction is valid for minutes; an acceptance of the terms is a
 * statement, recorded wherever the follower copies, so it stays valid a year.
 */
export const REQUEST_TTL_MS = 5 * 60_000;
export const TERMS_TTL_MS = 365 * 86_400_000;
const MAX_WINDOW_MS = (action: CopyAction): number => (action === 'accept-terms' ? TERMS_TTL_MS + 86_400_000 : 60 * 60_000);

/** Build an unsigned request for `action` with `payload`, valid for `ttlMs`. */
export function buildCopyRequest(o: { action: CopyAction; owner: string; executor: string; payload: unknown; chainId: number; now?: number; ttlMs?: number }): CopyRequest {
  const now = o.now ?? Date.now();
  return {
    action: o.action,
    owner: o.owner.toLowerCase(),
    executor: o.executor,
    payload: canonicalJSON(o.payload ?? {}),
    nonce: String(now),
    deadline: String(now + (o.ttlMs ?? (o.action === 'accept-terms' ? TERMS_TTL_MS : REQUEST_TTL_MS))),
    chainId: o.chainId,
  };
}

export type VerifyResult = { ok: true; digest: string; payload: unknown } | { ok: false; error: string };

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Check a signed request: shape, the executor it names, its time window, and
 * that the owner's wallet signed exactly these fields. Replay of a nonce is
 * the caller's to refuse (it knows which nonces it has seen).
 */
export function verifyCopyRequest(r: unknown, o: { executor: string; now?: number; maxAgeMs?: number }): VerifyResult {
  const now = o.now ?? Date.now();
  if (!r || typeof r !== 'object') return { ok: false, error: 'missing signed request' };
  const q = r as Record<string, unknown>;
  const action = q.action as CopyAction;
  if (!COPY_ACTIONS.includes(action)) return { ok: false, error: 'unknown action' };
  const owner = typeof q.owner === 'string' ? q.owner.toLowerCase() : '';
  if (!ADDRESS.test(owner)) return { ok: false, error: 'owner must be a 0x address' };
  if (q.executor !== o.executor) return { ok: false, error: 'this request was signed for another executor' };
  if (typeof q.payload !== 'string' || q.payload.length > 16_384) return { ok: false, error: 'payload must be a JSON string under 16 KB' };
  if (typeof q.nonce !== 'string' || !/^\d{1,16}$/.test(q.nonce)) return { ok: false, error: 'nonce must be a decimal string' };
  if (typeof q.deadline !== 'string' || !/^\d{1,16}$/.test(q.deadline)) return { ok: false, error: 'deadline must be a decimal string' };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof q.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const nonce = Number(q.nonce);
  const deadline = Number(q.deadline);
  if (deadline < now) return { ok: false, error: 'this request has expired; sign it again' };
  if (deadline - nonce > MAX_WINDOW_MS(action)) return { ok: false, error: 'this request is valid for longer than allowed' };
  const skew = o.maxAgeMs ?? 15 * 60_000;
  if (nonce - now > skew || (action !== 'accept-terms' && now - nonce > skew)) return { ok: false, error: 'the request time is too far from now; check your clock' };
  let payload: unknown;
  try {
    payload = JSON.parse(q.payload);
  } catch {
    return { ok: false, error: 'payload is not JSON' };
  }
  if (canonicalJSON(payload) !== q.payload) return { ok: false, error: 'payload is not in canonical form' };
  const req: CopyRequest = { action, owner, executor: o.executor, payload: q.payload, nonce: q.nonce, deadline: q.deadline, chainId };
  const digest = copyRequestDigest(req);
  let signer: string;
  try {
    signer = recoverAddress(hexToBytes(digest), hexToBytes(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: 'the signature cannot be read' };
  }
  if (signer !== owner) return { ok: false, error: 'the signature is not from this wallet' };
  return { ok: true, digest, payload };
}

/* --------------------------------------------------------------- payloads ----- */

export interface AcceptTermsPayload {
  termsVersion: string;
  /** keccak256 of the terms text the follower saw (0x hex). */
  termsHash: string;
  /** Country of residence, ISO alpha-2. */
  country: string;
  /** The follower's statements, each one they ticked. */
  adult: true;
  notUsPerson: true;
  ownDecision: true;
  risksUnderstood: true;
}

export interface CreateKeyPayload {
  accountId: number;
  /** Requested key lifetime, days (the executor caps it). */
  days: number;
}

export interface SubscribePayload {
  settings: Record<string, unknown>;
  termsVersion: string;
}

export interface IdPayload {
  id: string;
}

export interface StopPayload {
  id: string;
  close: boolean;
}

export interface StopAllPayload {
  close: boolean;
}

export interface UpdatePayload {
  id: string;
  settings: Record<string, unknown>;
}

/** 'algo-start': the algo's spec (parseAlgoSpec form) and the seed of its random choices, so it runs the schedule the ticket previewed. */
export interface AlgoStartPayload {
  spec: Record<string, unknown>;
  seed: number;
}

export interface AlgoActionPayload {
  op: 'pause' | 'resume' | 'cancel' | 'cancel-all';
  /** Every op but 'cancel-all'. */
  id?: string;
}

/* -------------------------------------------------------------- responses ----- */

export interface ExecutorInfo {
  /** What requests must name in `executor`. */
  executorId: string;
  kind: Exclude<CopyMode, 'browser'>;
  version: string;
  network: 'mainnet' | 'testnet';
  /** Where it runs, e.g. 'ap-northeast-1 (Tokyo)'. */
  location: string;
  /** Open for new followers (hosted) or paired (self-hosted). */
  open: boolean;
  /** Self-hosted: the one wallet it serves, once paired. */
  owner: string | null;
  builder: { id: number; ladder: Array<{ fromUsd: number; fee: number }>; windowDays: number } | null;
  termsVersion: string;
  /** The country the executor saw this request come from (hosted, behind the edge). */
  viewerCountry: string | null;
  keyTtlDaysMax: number;
  /** The key name the follower registers on SoDEX for this executor. */
  keyName: string;
  /** It also runs algo orders (TWAP, VWAP, ...) with the same key; absent on an older executor. */
  algos?: { maxPerOwner: number };
  /**
   * What this executor understands beyond the first release (EXECUTOR_FEATURES). An
   * executor without 'counter' would IGNORE a counter-trade's direction (unknown rule
   * fields are ignored) and copy the trader instead, so the site never sends one to it.
   */
  features?: string[];
}

/** 'counter': the rules may carry direction 'counter' (planner.ts). */
export const EXECUTOR_FEATURES = ['counter'] as const;

export interface SessionGrant {
  token: string;
  expiresAt: number;
}

export interface KeyInfo {
  address: string;
  name: string;
  /** What the follower registered on SoDEX (null until verified). */
  expiresAt: number | null;
  registered: boolean;
  createdAt: number;
}

export interface TermsRecord {
  termsVersion: string;
  termsHash: string;
  country: string;
  observedCountry: string | null;
  acceptedAt: number;
}

export interface MeResponse {
  owner: string;
  terms: TermsRecord | null;
  policy: RegionPolicy;
  key: KeyInfo | null;
  copies: CopyView[];
}

export interface ActivityResponse {
  entries: ActivityEntry[];
}

export type CopySettingsInput = Omit<CopySettings, 'leader'> & { leader: { venue: string; address: string } };
