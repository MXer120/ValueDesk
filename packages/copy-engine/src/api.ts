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
import { ZERO_ADDRESS, bytesToHex, hashTypedData, hexToBytes, recoverAddress, signDigest, type TypedData } from '../../sodex-core/src/index.ts';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import type { RegionPolicy } from './policy.ts';
import type { CopyView } from './runtime.ts';
import type { ActivityEntry, CopyMode, CopySettings } from './types.ts';
import type { FlowGate, NewsGate, QuietWindow } from './algo/types.ts';

export const COPY_DOMAIN = { name: 'ValueDesk Copy', version: '1' } as const;

/**
 * The `executor` an 'accept-terms' request names: the terms are one statement
 * whoever records it, so ONE signature is posted to ValueDesk's executor (its
 * record of who accepted what) and to a follower's own executor alike.
 */
export const COPY_TERMS_EXECUTOR = 'valuedesk-copy-terms';

/**
 * The `executor` an 'accept-site-terms' request names: ValueDesk's Terms of use
 * and Risk disclosure (apps/web/src/legal/acceptance.ts), signed by a wallet
 * before it trades through ValueDesk and recorded by ValueDesk's executor in
 * the same append-only log as every other signed instruction.
 */
export const SITE_TERMS_EXECUTOR = 'valuedesk-site-terms';

export type CopyAction =
  | 'session'
  | 'accept-terms'
  /** ValueDesk's own terms (not the copy terms): a statement like 'accept-terms'. */
  | 'accept-site-terms'
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
  | 'algo-action'
  /** Move this wallet's bots to the VIP executor (payload {to: 'vip'}): one signature, run server to server. */
  | 'vip-move'
  /**
   * Let a key this browser made sign this wallet's everyday actions for at most a day (payload {key, expiresAt}):
   * the one wallet signature a day (owner 2026-11-08: "not every action should need a sign ... once per day max").
   */
  | 'delegate';

export const COPY_ACTIONS: readonly CopyAction[] = ['session', 'accept-terms', 'accept-site-terms', 'create-key', 'delete-key', 'subscribe', 'update', 'pause', 'resume', 'stop', 'stop-all', 'algo-start', 'algo-action', 'vip-move', 'delegate'];

/**
 * What a day key (action 'delegate') may sign: the everyday actions. Never the terms, a trading key's creation or
 * removal, or another delegation - those always take the wallet itself.
 */
export const DELEGABLE_ACTIONS: ReadonlySet<CopyAction> = new Set<CopyAction>(['session', 'subscribe', 'update', 'pause', 'resume', 'stop', 'stop-all', 'algo-start', 'algo-action', 'vip-move']);
/** How long a day key lives at most. */
export const DELEGATION_TTL_MS = 24 * 60 * 60_000;

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
  /**
   * Signed by a day key, not the wallet: the wallet's own signed 'delegate' request naming that key, valid now. Only
   * for DELEGABLE_ACTIONS (verifyCopyRequest).
   */
  delegation?: SignedCopyRequest;
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
/** An acceptance of terms - the copy terms or ValueDesk's own: a statement, valid a year. */
export const isStatement = (action: CopyAction): boolean => action === 'accept-terms' || action === 'accept-site-terms';
const MAX_WINDOW_MS = (action: CopyAction): number => (isStatement(action) ? TERMS_TTL_MS + 86_400_000 : action === 'delegate' ? DELEGATION_TTL_MS + 60_000 : 60 * 60_000);

/** Build an unsigned request for `action` with `payload`, valid for `ttlMs`. */
export function buildCopyRequest(o: { action: CopyAction; owner: string; executor: string; payload: unknown; chainId: number; now?: number; ttlMs?: number }): CopyRequest {
  const now = o.now ?? Date.now();
  return {
    action: o.action,
    owner: o.owner.toLowerCase(),
    executor: o.executor,
    payload: canonicalJSON(o.payload ?? {}),
    nonce: String(now),
    deadline: String(now + (o.ttlMs ?? (isStatement(o.action) ? TERMS_TTL_MS : REQUEST_TTL_MS))),
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
export function verifyCopyRequest(r: unknown, o: { executor: string; now?: number; maxAgeMs?: number; revokedBefore?: (owner: string) => number }): VerifyResult {
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
  // 65 bytes: the wallet (or a secp256k1 day key); 64 bytes: a P-256 day key (WebCrypto, r||s).
  if (typeof q.signature !== 'string' || !/^0x([0-9a-fA-F]{130}|[0-9a-fA-F]{128})$/.test(q.signature)) return { ok: false, error: 'signature must be 65 bytes of hex' };
  const nonce = Number(q.nonce);
  const deadline = Number(q.deadline);
  // Expired: either it waited too long, or the signer's clock is behind - then signing again gives the same answer.
  if (deadline < now) return { ok: false, error: "this request has expired; sign it again (if it keeps happening, check your computer's clock: it may be behind)" };
  if (deadline - nonce > MAX_WINDOW_MS(action)) return { ok: false, error: 'this request is valid for longer than allowed' };
  const skew = o.maxAgeMs ?? 15 * 60_000;
  // A delegation is signed once and used all day: its deadline bounds it, not its age.
  if (nonce - now > skew || (!isStatement(action) && action !== 'delegate' && now - nonce > skew)) return { ok: false, error: 'the request time is too far from now; check your clock' };
  let payload: unknown;
  try {
    payload = JSON.parse(q.payload);
  } catch {
    return { ok: false, error: 'payload is not JSON' };
  }
  if (canonicalJSON(payload) !== q.payload) return { ok: false, error: 'payload is not in canonical form' };
  const req: CopyRequest = { action, owner, executor: o.executor, payload: q.payload, nonce: q.nonce, deadline: q.deadline, chainId };
  const digest = copyRequestDigest(req);
  const p256Sig = q.signature.length === 130;
  let signer = '';
  if (!p256Sig) {
    try {
      signer = recoverAddress(hexToBytes(digest), hexToBytes(q.signature)).toLowerCase();
    } catch {
      return { ok: false, error: 'the signature cannot be read' };
    }
  }
  if (p256Sig || signer !== owner) {
    // A day key's signature: the wallet's delegation must name this key, for this executor, and be valid now.
    const d = q.delegation as SignedCopyRequest | undefined;
    if (!d || !DELEGABLE_ACTIONS.has(action)) return { ok: false, error: 'the signature is not from this wallet' };
    if (d.action !== 'delegate' || (d as { delegation?: unknown }).delegation !== undefined) return { ok: false, error: 'the day key\'s approval is not a delegation' };
    const dv = verifyCopyRequest(d, { executor: o.executor, now, maxAgeMs: o.maxAgeMs });
    if (!dv.ok) return { ok: false, error: `the day key's approval does not hold: ${dv.error}` };
    if (d.owner.toLowerCase() !== owner) return { ok: false, error: 'the day key was approved by another wallet' };
    const p = dv.payload as { key?: unknown; expiresAt?: unknown; alg?: unknown };
    if (typeof p.key !== 'string') return { ok: false, error: 'the signature is not from this wallet or its day key' };
    if (p256Sig) {
      // A P-256 day key (WebCrypto ECDSA with SHA-256 over the digest; its private key never leaves the browser's crypto).
      if (p.alg !== 'p256') return { ok: false, error: 'the signature is not from this wallet or its day key' };
      let ok = false;
      try {
        ok = p256.verify(hexToBytes(q.signature), sha256(hexToBytes(digest)), hexToBytes(p.key), { lowS: false, prehash: false });
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, error: 'the signature is not from this wallet or its day key' };
    } else if (p.alg !== undefined || p.key.toLowerCase() !== signer) return { ok: false, error: 'the signature is not from this wallet or its day key' };
    if (typeof p.expiresAt !== 'number' || !(p.expiresAt > now) || p.expiresAt - Number(d.nonce) > DELEGATION_TTL_MS + 60_000) return { ok: false, error: 'the day key has expired; approve a new one with your wallet' };
    // Revoked by the wallet (signed out everywhere): every day key approved before then is refused.
    if (o.revokedBefore && Number(d.nonce) < o.revokedBefore(owner)) return { ok: false, error: 'this day key was revoked; approve a new one with your wallet' };
  }
  return { ok: true, digest, payload };
}

/** Sign a request with a day key (a 32-byte secp256k1 private key): 0x + r, s, v as the wallet would. */
export function signCopyRequestWithKey(r: CopyRequest, privateKey: Uint8Array): string {
  const wire = signDigest(hexToBytes(copyRequestDigest(r)), privateKey, 0);
  return bytesToHex(wire.slice(1));
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

/** 'accept-site-terms': ValueDesk's Terms of use and Risk disclosure, as the wallet saw them. */
export interface AcceptSiteTermsPayload {
  /** SITE_TERMS_VERSION (apps/web/src/legal/acceptance.ts): a date, with a counter for a second change on one day. */
  termsVersion: string;
  /** keccak256 of the texts the wallet's owner saw (0x hex). */
  termsHash: string;
  /** Country of residence, ISO alpha-2. */
  country: string;
  /** The four statements (apps/web/src/legal/acceptance.ts STATEMENTS), each one ticked. */
  agree: true;
  eligible: true;
  risks: true;
  ownDecisions: true;
  /** The statements word for word, as the wallet showed them: the readable record. */
  text: string;
}

/** What the executor answers to 'accept-site-terms'. */
export interface SiteTermsRecord {
  recorded: true;
  termsVersion: string;
  country: string;
  /** The country the executor saw the request come from (hosted, behind the edge). */
  observedCountry: string | null;
  acceptedAt: number;
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
  /**
   * A bot's restart with new settings (feature 'bot-restart'): the bot it replaces, and how.
   *   'clean'     the old bot stops and closes what it holds (resting first); the new one starts once it has ended
   *   'takeover'  the old bot only pulls its orders; the new one starts at once and trades on what it held (same market)
   */
  restart?: { from: string; how: 'clean' | 'takeover' };
}

export interface AlgoActionPayload {
  /** 'archive' (feature 'bots'): an ended algo leaves the wallet's list; its record and log stay kept. */
  op: 'pause' | 'resume' | 'cancel' | 'cancel-all' | 'update' | 'archive' | 'close-rest';
  /** Every op but 'cancel-all'. */
  id?: string;
  /**
   * 'update' only (feature 'algo-update'): what to change on the running algo -
   * its size (`quantity`, more than has filled), limit price, spread guard or
   * label. Nothing else of what was signed at the start can change.
   */
  patch?: AlgoUpdatePatch;
}

/** What 'update' may change on a running algo (AlgoRuntime.update). */
export interface AlgoUpdatePatch {
  quantity?: string;
  limitPrice?: number | null;
  maxSpreadBps?: number | null;
  label?: string | null;
  /** A bot (feature 'bots'): its sizes, distances and limits - never its market, range or levels. */
  orderUsd?: number;
  maxInventoryUsd?: number;
  offsetTicks?: number;
  chaseTicks?: number;
  minRepriceMs?: number;
  skewTicks?: number;
  edgeBps?: number;
  queueGuard?: number;
  levels?: number;
  moveGuard?: number;
  refBps?: number;
  pullBps?: number;
  placeBps?: number;
  calmBps?: number;
  calmMs?: number;
  stillBps?: number;
  stillMs?: number;
  restMs?: number;
  /** A volume maker's patient-taker gate and quiet windows (null: off); checked by the spec parser. */
  flowGate?: FlowGate | null;
  quiet?: QuietWindow[] | null;
  quietOnly?: boolean | null;
  news?: NewsGate | null;
  volumeTargetUsd?: number | null;
  maxLossUsd?: number | null;
  endAt?: number | null;
  onStop?: 'close' | 'keep';
  outOfRange?: 'wait' | 'stop';
  /** Every setting saves in place (owner 2026-11-08): the oracle, the gate's pause, leverage, post-only, a grid's range. */
  ref?: 'binance' | null;
  noFair?: boolean;
  pauseAfter?: number | null;
  pauseMs?: number | null;
  leverage?: number | null;
  marginMode?: 'cross' | 'isolated' | null;
  postOnly?: boolean;
  low?: number;
  high?: number;
  spacing?: 'linear' | 'geometric';
}

/** The fields of an AlgoUpdatePatch, for checking a signed one. */
export const ALGO_UPDATE_FIELDS: ReadonlyArray<keyof AlgoUpdatePatch> = [
  'quantity', 'limitPrice', 'maxSpreadBps', 'label',
  'orderUsd', 'maxInventoryUsd', 'offsetTicks', 'chaseTicks', 'minRepriceMs', 'skewTicks', 'edgeBps', 'queueGuard', 'levels', 'moveGuard', 'refBps', 'pullBps', 'placeBps', 'calmBps', 'calmMs', 'stillBps', 'stillMs', 'restMs', 'flowGate', 'quiet', 'quietOnly', 'news', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'onStop', 'outOfRange',
  'ref', 'noFair', 'pauseAfter', 'pauseMs', 'leverage', 'marginMode', 'postOnly', 'low', 'high', 'spacing',
];

/* -------------------------------------------------------------- responses ----- */

export interface ExecutorInfo {
  /** What requests must name in `executor`. */
  executorId: string;
  /**
   * SoDEX as this executor sees it (apps/executor venue.ts): 'maintenance' while SoDEX is in its maintenance - every
   * copy, algo and bot here is held and goes on by itself after - since when (ms), and SoDEX's own expected end (ms,
   * null when it gave none). Absent on an older executor.
   */
  venue?: { state: 'normal' | 'maintenance'; since: number | null; expectedEnd: number | null };
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
  /** It runs bots (feature 'bots'): the builder fee on their orders, tenths of a bp. Absent on an older executor. */
  /** fee: the old flat bot fee (kept for older pages); ladder: the bot fee by 14-day volume (policy.ts BOT_FEE_LADDER). */
  bots?: { fee: number; ladder?: ReadonlyArray<{ fromUsd: number; fee: number }>; vipFee?: number; betaVipDays?: number };
  /** VIP (apps/executor vip.ts): this executor's tier, and whether it can move a wallet's bots to the VIP one. */
  vip?: { tier: 'standard' | 'vip'; canMove: boolean; /** The VIP executor moves wallets that lost VIP back to the standard one (once a UTC day). */ canMoveBack?: boolean; location: string; /** Moves without the VIP check (tests, local runs). */ open?: boolean };
  /**
   * A SoDEX API key the follower made themselves can be brought here: its private key
   * encrypted to `publicKey` (ECDH P-256, HKDF-SHA256 with `info` - '<owner>' replaced by
   * the wallet - then AES-256-GCM). Absent on an older executor.
   */
  keyImport?: { alg: string; publicKey: string; info: string };
  /**
   * What this executor understands beyond the first release (EXECUTOR_FEATURES). An
   * executor without 'counter' would IGNORE a counter-trade's direction (unknown rule
   * fields are ignored) and copy the trader instead, so the site never sends one to it.
   */
  features?: string[];
  /**
   * The operator's emergency brake, while it is on: live copies send nothing and
   * live algos are held; nothing new live starts. null or absent: off.
   */
  brake?: { copies: boolean; algos: boolean; reason: string; since: number | null } | null;
}

/**
 * 'bots': it runs the bot kinds (volume maker, grid) and bot DCAs at the bot fee (policy.ts BOT_FEE).
 * 'counter': the rules may carry direction 'counter' (planner.ts).
 * 'site-terms': it records 'accept-site-terms' (POST /site-terms); the site sends no record to one without it.
 * 'terms-doc': GET /terms/copy serves the copy terms in force here (version, hash, text) for the web to sign exactly.
 * 'day-key': it accepts requests signed by a wallet-approved day key (SignedCopyRequest.delegation); the site signs
 * with the wallet itself for an executor without it (an older release refuses a 64-byte signature).
 */
export const EXECUTOR_FEATURES = ['counter', 'site-terms', 'key-import', 'algo-update', 'bots', 'multiplier', 'bot-restart', 'day-key', 'terms-doc'] as const;

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
  /**
   * Its bots run on the other executor: 'vip' (read on the standard one after a move up) or 'standard' (read on the VIP
   * one after a move back). The page then talks to that one. Absent on an older executor.
   */
  movedTo?: 'vip' | 'standard' | null;
  /**
   * The wallet's bot fee now (the executor's botFee: the bot ladder by its 14-day volume, or lower by VIP or a fee
   * program such as the beta's 30 days): tenths of a bp, whether it is VIP's, and until when a lowered fee lasts
   * (null: no end, or the ladder's own step). Absent on an older executor.
   */
  bots?: { feeTenths: number; vip: boolean; until: number | null };
}

/**
 * An executor's refusal as the web reads it: `{ ok: false, code, error, detail? }`. A bot's codes (service.ts
 * BotRefusalCode): key, account, beta, limit, bot-capacity, margin, margin-unknown, bot-market, market-copy,
 * market-algo, market-position, vip-moving, moved. `detail` carries figures for some of them (margin: needUsd,
 * freeUsd, reservedUsd, equityUsd; market-*: the copy, algo or position in the way).
 */
export interface ExecutorRefusal {
  ok: false;
  code: string;
  error: string;
  detail?: Record<string, unknown>;
}

/** A VIP move as its owner reads it (POST /vip/move starts it, GET /vip/move follows it). */
export interface VipMoveView {
  id: string;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  steps: Array<{ id: string; label: string; state: 'wait' | 'run' | 'done' | 'fail'; ms: number | null; note?: string }>;
  bots: number;
  error: string | null;
  session: { token: string; expiresAt: number } | null;
  /** How it ended for the bots: moved, not-moved (resumed here), unknown (paused here until checked). Absent on an older executor. */
  outcome?: 'moved' | 'not-moved' | 'unknown';
  /** up: to VIP (the wallet asked); down: back to standard (VIP ended, at most once a UTC day). Absent: up. */
  direction?: 'up' | 'down';
  /** Why it moved back (the API server's words). */
  reason?: string;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
}

export type CopySettingsInput = Omit<CopySettings, 'leader'> & { leader: { venue: string; address: string } };
