/**
 * The executor's behaviour, without HTTP: every API call is a method here, so
 * the rules are tested without a socket (test/service.test.ts).
 *
 * Rules every change obeys:
 *   - it is a CopyRequest the follower's wallet signed for THIS executor,
 *     inside its time window, never used before (api.ts, db.ts consents);
 *   - it is recorded before it takes effect (the consent log);
 *   - a self-hosted executor serves one wallet: the one in EXECUTOR_OWNER, or
 *     the one that paired with the code it printed at start;
 *   - copying needs the current copy terms accepted (with a declared country),
 *     a region that allows it (declared and, behind the edge, seen), and for a
 *     live copy a registered key; the copy fee needs the follower's approval on
 *     SoDEX, which the runtime checks (a copy without it is `blocked`).
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  AlgoRuntime,
  AlgoSpecError,
  ALGO_UPDATE_FIELDS,
  COPY_ENGINE_VERSION,
  COPY_FEE_LADDER,
  COPY_FEE_WINDOW_DAYS,
  COPY_TERMS_EXECUTOR,
  COPY_TERMS_VERSION,
  currentCopyTerms,
  type CopyTermsServed,
  EXECUTOR_FEATURES,
  SITE_TERMS_EXECUTOR,
  CopyRuntime,
  FINAL_STATUSES,
  KeyAlgoSink,
  HyperliquidClient,
  KeySink,
  PaperSink,
  SettingsError,
  SodexClient,
  canonicalSettings,
  copyFeeFor,
  BOT_FEE,
  botReserveUsd,
  copyReserveUsd,
  botMarginUsd,
  BOT_FEE_LADDER,
  BOT_FEE_VIP,
  BETA_VIP_DAYS,
  botFeeFor,
  ALGO_NAMES,
  algoSymbols,
  coinOf,
  minChildQty,
  sodexNamesFor,
  type AlgoSpec,
  type MarketInfo,
  normaliseCountry,
  parseAlgoSpec,
  parseSettings,
  randomId,
  regionPolicy,
  sanctionedOf,
  screenPolicy,
  SANCTIONED_LEADER_REASON,
  SANCTIONED_WALLET_REASON,
  OracleFeed,
  verifyCopyRequest,
  type AcceptSiteTermsPayload,
  type AcceptTermsPayload,
  type ActivityEntry,
  type AlgoEvent,
  type AlgoRecord,
  type AlgoSink,
  type AlgoUpdatePatch,
  type AlgoView,
  type CopyAction,
  type CopyView,
  type CreateKeyPayload,
  type ExecutorInfo,
  type TermsRecord,
  type FetchLike,
  type KeyInfo,
  type Logger,
  type MeResponse,
  type QueueStats,
  type OrderSink,
  type RegionPolicy,
  type EngineNotice,
  type SessionGrant,
  type SignedCopyRequest,
  type SiteTermsRecord,
  type Subscription,
  type WebSocketFactory,
  sleep,
} from '../../../packages/copy-engine/src/index.ts';
import { SODEX_CHAIN_ID, createMemoryNonceManager, privateKeyToAddress, type BuilderParams, type SigningKeyRef } from '../../../packages/sodex-core/src/index.ts';
import { liveAlgosFor, type ExecutorConfig } from './config.ts';
import { sqlite, type ConsentRow, type ExecutorDb, type KeyRow } from './db.ts';
import { auditedAlgoSink, auditedOrderSink } from './audited.ts';
import { Brake, type BrakeState } from './brake.ts';
import { WriteLatency, type BotLatencyResponse } from './latency.ts';
import { KEY_IMPORT_ALG, importInfo, type ImportEnvelope, type Secrets } from './secrets.ts';
import { ErrorGuard, guardedAlgoSink, guardedOrderSink, type GuardTarget } from './guard.ts';
import { shortWallet, type Alerts } from './alerts.ts';
import { plainSockets } from './feed/binance.ts';
import { BinanceReference } from './feed/reference.ts';
import { DEFAULT_FEED_PATH } from './feed/ring.ts';
import { CalendarFeed } from './calendar.ts';
import { SodexMaintenanceWatch, type VenueView } from './venue.ts';
import { VIP_SWEEP_MS, downgradedToday, newVipJob, vipJobView, vipStep, type VipJob } from './vip.ts';

/** The pairing code's letters: no 0/O, 1/I/L, so it reads back from a terminal without doubt. */
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Wrong pairing codes before pairing locks for PAIR_LOCK_MS (the code is printed once; guessing is the only other way in). */
const PAIR_MAX_TRIES = 10;
const PAIR_LOCK_MS = 15 * 60_000;

/** 10 characters from PAIR_ALPHABET: about 50 bits. */
function pairingCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  return out;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A key may be registered on SoDEX for at most this much past the longest lifetime allowed (clock and rounding slack). */
const KEY_TTL_SLACK_MS = 86_400_000;

/**
 * Every algo spec inside `spec` (a conditional's `then: algo`), itself first,
 * each with whether it is a practice run. `raw` is the spec as signed: an inner
 * algo signed with no paper flag runs as its conditional does (the runtime
 * starts it with the parent's paper), so it inherits it; one signed with any
 * flag of its own is judged by that flag.
 */
function specsOf(spec: { kind: string; paper?: boolean; then?: unknown }, raw: unknown, parentPaper?: boolean): Array<{ paper: boolean }> {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const paper = parentPaper !== undefined && r.paper === undefined ? parentPaper : spec.paper === true;
  const out = [{ paper }];
  const then = spec.kind === 'conditional' ? (spec.then as { type?: string; algo?: { kind: string } } | undefined) : undefined;
  const rawThen = r.then && typeof r.then === 'object' ? (r.then as Record<string, unknown>) : {};
  if (then?.type === 'algo' && then.algo) out.push(...specsOf(then.algo, rawThen.algo, paper));
  return out;
}

/**
 * A signed 'update' patch, checked field by field: only what AlgoRuntime.update
 * may change, each of its own type (null clears an optional one). The runtime
 * then judges the values against the running algo.
 */
function algoPatch(raw: unknown): AlgoUpdatePatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'patch', 'update needs a patch: what to change.');
  const r = raw as Record<string, unknown>;
  const other = Object.keys(r).filter((k) => !(ALGO_UPDATE_FIELDS as readonly string[]).includes(k));
  if (other.length) throw new ApiError(400, 'patch', `Only ${ALGO_UPDATE_FIELDS.join(', ')} of a running algo can be changed (not ${other.join(', ')}).`);
  if (!Object.keys(r).length) throw new ApiError(400, 'patch', 'The patch changes nothing.');
  const out: AlgoUpdatePatch = {};
  if (r.quantity !== undefined) {
    if (typeof r.quantity !== 'string' || !/^\d+(\.\d+)?$/.test(r.quantity) || !(Number(r.quantity) > 0)) throw new ApiError(400, 'patch', 'The size must be a positive decimal string.');
    out.quantity = r.quantity;
  }
  for (const k of ['limitPrice', 'maxSpreadBps'] as const) {
    if (r[k] === undefined) continue;
    if (r[k] !== null && !(typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0)) throw new ApiError(400, 'patch', `${k} must be a positive number or null.`);
    out[k] = r[k] as number | null;
  }
  if (r.label !== undefined) {
    if (r.label !== null && (typeof r.label !== 'string' || r.label.length > 60)) throw new ApiError(400, 'patch', 'The label must be text of at most 60 characters, or null.');
    out.label = r.label as string | null;
  }
  // A bot's sizes, distances and limits: each of its type here, its range judged by the spec parser (AlgoRuntime.update).
  for (const k of ['orderUsd', 'maxInventoryUsd', 'offsetTicks', 'chaseTicks', 'minRepriceMs', 'skewTicks', 'edgeBps', 'queueGuard', 'levels', 'moveGuard', 'refBps', 'pullBps', 'placeBps', 'calmBps', 'calmMs', 'stillBps', 'stillMs', 'restMs'] as const) {
    if (r[k] === undefined) continue;
    if (!(typeof r[k] === 'number' && Number.isFinite(r[k]))) throw new ApiError(400, 'patch', `${k} must be a number.`);
    out[k] = r[k] as number;
  }
  for (const k of ['volumeTargetUsd', 'maxLossUsd', 'endAt'] as const) {
    if (r[k] === undefined) continue;
    if (r[k] !== null && !(typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0)) throw new ApiError(400, 'patch', `${k} must be a positive number or null.`);
    out[k] = r[k] as number | null;
  }
  if (r.onStop !== undefined) {
    if (r.onStop !== 'close' && r.onStop !== 'keep') throw new ApiError(400, 'patch', 'onStop must be close or keep.');
    out.onStop = r.onStop;
  }
  if (r.outOfRange !== undefined) {
    if (r.outOfRange !== 'wait' && r.outOfRange !== 'stop') throw new ApiError(400, 'patch', 'outOfRange must be wait or stop.');
    out.outOfRange = r.outOfRange;
  }
  // A volume maker's patient-taker gate and quiet windows: their shape here, their values judged by the spec parser (AlgoRuntime.update).
  if (r.flowGate !== undefined) {
    if (r.flowGate !== null && (typeof r.flowGate !== 'object' || Array.isArray(r.flowGate))) throw new ApiError(400, 'patch', 'flowGate must be an object or null.');
    out.flowGate = r.flowGate as AlgoUpdatePatch['flowGate'];
  }
  if (r.quiet !== undefined) {
    if (r.quiet !== null && !Array.isArray(r.quiet)) throw new ApiError(400, 'patch', 'quiet must be a list or null.');
    out.quiet = r.quiet as AlgoUpdatePatch['quiet'];
  }
  if (r.quietOnly !== undefined) {
    if (r.quietOnly !== null && typeof r.quietOnly !== 'boolean') throw new ApiError(400, 'patch', 'quietOnly must be true, false or null.');
    out.quietOnly = r.quietOnly as boolean | null;
  }
  if (r.news !== undefined) {
    if (r.news !== null && (typeof r.news !== 'object' || Array.isArray(r.news))) throw new ApiError(400, 'patch', 'news must be an object or null.');
    out.news = r.news as AlgoUpdatePatch['news'];
  }
  // The rest of a bot's settings (owner 2026-11-08: everything saves in place): their shape here, their values judged
  // by the spec parser (AlgoRuntime.update).
  if (r.ref !== undefined) {
    if (r.ref !== null && r.ref !== 'binance') throw new ApiError(400, 'patch', 'ref must be binance or null.');
    out.ref = r.ref as 'binance' | null;
  }
  for (const k of ['noFair', 'postOnly'] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'boolean') throw new ApiError(400, 'patch', `${k} must be true or false.`);
    out[k] = r[k] as boolean;
  }
  for (const k of ['pauseAfter', 'pauseMs', 'leverage'] as const) {
    if (r[k] === undefined) continue;
    if (r[k] !== null && !(typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0)) throw new ApiError(400, 'patch', `${k} must be a positive number or null.`);
    out[k] = r[k] as number | null;
  }
  if (r.marginMode !== undefined) {
    if (r.marginMode !== null && r.marginMode !== 'cross' && r.marginMode !== 'isolated') throw new ApiError(400, 'patch', 'marginMode must be cross, isolated or null.');
    out.marginMode = r.marginMode as 'cross' | 'isolated' | null;
  }
  for (const k of ['low', 'high'] as const) {
    if (r[k] === undefined) continue;
    if (!(typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0)) throw new ApiError(400, 'patch', `${k} must be a positive number.`);
    out[k] = r[k] as number;
  }
  if (r.spacing !== undefined) {
    if (r.spacing !== 'linear' && r.spacing !== 'geometric') throw new ApiError(400, 'patch', 'spacing must be linear or geometric.');
    out.spacing = r.spacing;
  }
  if (r.takeProfitUsd !== undefined) {
    if (r.takeProfitUsd !== null && !(typeof r.takeProfitUsd === 'number' && Number.isFinite(r.takeProfitUsd) && r.takeProfitUsd > 0)) throw new ApiError(400, 'patch', 'takeProfitUsd must be a positive number or null.');
    out.takeProfitUsd = r.takeProfitUsd as number | null;
  }
  for (const k of ['upper', 'lower'] as const) {
    if (r[k] === undefined) continue;
    const b = r[k] as { price?: unknown; then?: unknown } | null;
    if (b !== null && (typeof b !== 'object' || Array.isArray(b) || !(typeof b.price === 'number' && Number.isFinite(b.price) && b.price > 0) || (b.then !== 'hold' && b.then !== 'stop'))) throw new ApiError(400, 'patch', `${k} must be { price, then: hold or stop } or null.`);
    out[k] = b as AlgoUpdatePatch['upper'];
  }
  for (const k of ['sizeUsd', 'minLiqPct', 'growLiqPct', 'sliceUsd', 'maxSlipBps'] as const) {
    if (r[k] === undefined) continue;
    if (!(typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0)) throw new ApiError(400, 'patch', `${k} must be a positive number.`);
    out[k] = r[k] as number;
  }
  return out;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Figures that go with a refusal (a bot's margin: needed, free), for the page; never anything secret. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The bot refusals' codes (owner 2026-11-08: plain words for bot users, and a code the web maps to a button):
 *   key              no trading key here yet          -> "Approve the trading key"
 *   account          no SoDEX account yet              -> "Deposit to SoDEX"
 *   beta             real bots are beta-only           -> "Ask on Discord" (practice stays open)
 *   limit            the wallet's algo/bot limit       -> stop one
 *   bot-capacity     this executor's real-bot cap      -> try later / practice
 *   margin           the account cannot hold it        -> detail {needUsd, freeUsd, reservedUsd, equityUsd}; lower size
 *   margin-unknown   SoDEX's balance did not answer    -> try again
 *   bot-market       another bot of the wallet on it   -> stop that bot (detail {algoId})
 *   market-copy      a copy trades that market         -> stop the copy (detail {copyId})
 *   market-algo      an algo order runs on it          -> cancel it (detail {algoId})
 *   market-position  a position the bot did not open   -> close it (detail {symbol, size})
 *   vip-moving       a VIP move runs for the wallet    -> wait
 *   moved            the wallet's bots run on VIP      -> open the VIP servers
 */
export type BotRefusalCode = 'key' | 'account' | 'beta' | 'limit' | 'bot-capacity' | 'margin' | 'margin-unknown' | 'bot-market' | 'market-copy' | 'market-algo' | 'market-position' | 'vip-moving' | 'moved' | 'practice-off';

const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

/** A wallet's perks (VIP, programs) unread this long are dropped: a program ended on server 1 stops counting here too. */
const PERKS_STALE_MS = 6 * 60 * 60_000;
/** How long the executor keeps a wallet's fills for a perk budget (a budget read older than this stops the perk). */
const PERK_FILLS_KEEP_MS = 6 * 60 * 60_000;

/** The budget of a lowered fee from the invite welcome or fee credits (server 1, invites/service.ts PerkBudget). */
export interface PerkBudget { capUsd: number; perUsd: { copy: number; bots: number }; through: number }
interface Perk { fee: number; until: number | null; budget?: PerkBudget }

/** A budget as the API sends it, or null when any part of it is missing or not a number. */
export function readBudget(x: unknown): PerkBudget | null {
  const b = x as { capUsd?: unknown; perUsd?: { copy?: unknown; bots?: unknown }; through?: unknown } | null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cap = n(b?.capUsd);
  const copy = n(b?.perUsd?.copy);
  const bots = n(b?.perUsd?.bots);
  const through = n(b?.through);
  return cap === null || copy === null || bots === null || through === null ? null : { capUsd: cap, perUsd: { copy, bots }, through };
}
/** At most this many wallets' perks, beta answers and maker fees are kept in memory (the db keeps the beta answers). */
const WALLET_CACHE_MAX = 20_000;
/** A wallet's own SoDEX maker fee (GET .../fee-rate, weight 2) is read again after this. */
const MAKER_FEE_TTL_MS = 6 * 60 * 60_000;
/** The beta answer is asked again after this; a failed read keeps the last answer (memory, else the db). */
const BETA_TTL_MS = 60_000;
/** Notices before a trading key that real bots or copies use expires: 14 days, 3 days, ~24 h and ~1 h before (owner 2026-11-09). */
const KEY_WARN = [
  { ms: 14 * 86_400_000, tag: '14d', words: 'in 14 days' },
  { ms: 3 * 86_400_000, tag: '3d', words: 'in 3 days' },
  { ms: 24 * 60 * 60_000, tag: '24h', words: 'in about 24 hours' },
  { ms: 60 * 60_000, tag: '1h', words: 'within the hour' },
] as const;
/** A VIP move's send waits this long for the VIP side's answer; past it the outcome is asked, never guessed. */
const VIP_SEND_MS = 15_000;

/** Delete-then-set keeps a Map in last-used order; past `max` the oldest goes. */
export function remember<K, V>(m: Map<K, V>, k: K, v: V, max = WALLET_CACHE_MAX): void {
  m.delete(k);
  if (m.size >= max) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(k, v);
}

/** botMarginUsd with the market's minimum order and the region's leverage ceiling (the engine's newer signature; an older one ignores them). */
const marginOf = botMarginUsd as unknown as (s: AlgoSpec, minOrderUsd?: number, ceiling?: number) => number;

export interface RequestContext {
  /** Two-letter country of the viewer's IP, from the edge (hosted only). */
  viewerCountry: string | null;
  /** The pairing code a self-hosted executor printed, when the web app sends one. */
  pairingCode?: string | null;
  /** The site channel the request came through (hosted, behind the edge): 'beta' from beta.valuedesk.so. */
  channel?: 'main' | 'beta';
}

export interface ServiceDeps {
  fetch: FetchLike;
  factory: WebSocketFactory;
  /** Extra sockets for SoDEX account channels, one per local address (EXECUTOR_WS_ADDRESSES): 10 more wallets each. */
  accountFactories?: WebSocketFactory[];
  log: Logger;
  /** The operator's alerts (alerts.ts); none: nothing is sent. */
  alerts?: Alerts;
  /**
   * The pause between two reads of SoDEX that confirm a key is missing
   * (default KEY_READ_GAP_MS), and between those that confirm a position
   * change (copy-engine confirm.ts, default CONFIRM_GAP_MS); tests pass 0. SoDEX's gateway answers from
   * backends that disagree: one of them served a key list 17 minutes old
   * (2026-10-29), so one read that misses a key proves nothing.
   */
  readGapMs?: number;
}

/**
 * How long an opened follower key stays in memory after its last use. Signing
 * opens it from its sealed record (AES-GCM, microseconds); an idle wallet's key
 * is wiped from memory (zeroed) instead of sitting there for the process's life.
 */
const SIGNER_IDLE_MS = 2 * 60_000;
/** At most this many followers' volumes are remembered (the rest is read again). */
const VOLUMES_MAX = 20_000;

/** A read token (it changes nothing: every write is signed on its own). 30 days, owner 2026-11-08: "as minimal changes as possible where users need to re-sign". */
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** How long a follower's volume (the copy fee step) is used before it is read again. */
/** The volume and the fee perks (VIP, programs) of a wallet are read again this often (owner 2026-11-08: a program reaches orders within minutes). */
const VOLUME_TTL_MS = 2 * 60_000;
/**
 * A key SoDEX does not list is read this many times, KEY_READ_GAP_MS apart,
 * before anything is refused or taken away for it (one stale backend answered
 * 4 of 6 reads on 2026-10-29; nothing in its answer tells it apart).
 */
const KEY_READS = 3;
const KEY_READ_GAP_MS = 3_000;
/**
 * The `checkedAt` of a key SoDEX refused a signed action for (guard.ts, keyRefused):
 * it is no longer trusted from having been listed, and is read again (KEY_READS).
 */
const KEY_REFUSED_AT = 0;

export class ExecutorService {
  readonly executorId: string;
  readonly keyName: string;
  readonly runtime: CopyRuntime;
  /**
   * Algo orders (TWAP, VWAP, POV, ...): the same engine package, the same key
   * the follower registered for this executor, the same nonce sequence, the
   * same builder (the copy fee ladder), the same terms and region rules.
   */
  readonly algos: AlgoRuntime;
  /** The Binance-led maker's reference (feed/reference.ts); null on a self-hosted executor. */
  readonly reference: BinanceReference | null;
  /** The economic calendar, for a bot's news gate (calendar.ts); null without a calendar URL. */
  readonly calendar: CalendarFeed | null;
  readonly sodex: SodexClient;
  /** Signed-write latency to SoDEX per 10 min (latency.ts), for GET /bots/latency. */
  readonly latency: WriteLatency;
  private readonly hyperliquid: HyperliquidClient;
  private readonly nonces = createMemoryNonceManager();
  private readonly paper = new PaperSink();
  private readonly signers = new Map<string, { ref: SigningKeyRef; usedAt: number }>();
  private signerSweep: ReturnType<typeof setInterval> | null = null;
  /** What SoDEX refused, and the copies and algos held for it (guard.ts). */
  readonly guard: ErrorGuard;
  private readonly volumes = new Map<string, { usd: number | null; at: number }>();
  /**
   * VIP and the dev page's fee programs for copy trading and bots (owner 2026-11-08), from the same read as the
   * volume (GET /api/vs/builder/volume): the fee and until when. A program's end is checked on every order, so it
   * stops counting the moment it ends, whatever the cache.
   */
  private readonly perks = new Map<string, { vip: boolean; copy: Perk | null; bots: Perk | null; at: number }>();
  /**
   * The real fills this executor booked per wallet lately (copies and algos), what a budgeted perk is counted against:
   * the invite welcome and fee credits come with a budget (server 1's invites/service.ts perkBudget) - what is left,
   * what each dollar of an order uses up, and up to when the ledger had read the wallet's fills. Fills after that are
   * counted here; at the budget the perk stops until the next read says more is left.
   */
  private readonly fills = new Map<string, Array<{ t: number; usd: number; p: 'copy' | 'bots' }>>();

  /** Note a real fill (copy or algo) for the budget. Kept PERK_FILLS_KEEP_MS, bounded per wallet and in wallets. */
  private noteFill(owner: string, p: 'copy' | 'bots', usd: number, at: number): void {
    if (!(usd > 0)) return;
    const o = owner.toLowerCase();
    const list = this.fills.get(o) ?? [];
    list.push({ t: at, usd, p });
    const keep = at - PERK_FILLS_KEEP_MS;
    while (list.length && (list[0]!.t < keep || list.length > 20_000)) list.shift();
    this.fills.delete(o);
    this.fills.set(o, list);
    if (this.fills.size > 50_000) this.fills.delete(this.fills.keys().next().value!);
  }

  /** Whether a perk's budget is used up by this executor's fills since the ledger's read. */
  private budgetSpent(owner: string, b: PerkBudget): boolean {
    // Older than what this executor remembers: it cannot tell what was used - the perk stops (the safe side).
    if (b.through < Date.now() - PERK_FILLS_KEEP_MS) return true;
    let used = 0;
    for (const f of this.fills.get(owner.toLowerCase()) ?? []) if (f.t > b.through) used += f.usd * (b.perUsd[f.p] ?? 1);
    return used >= b.capUsd;
  }

  /** The wallet's perks as last read, while that read is not older than PERKS_STALE_MS (VIP and programs end with it). */
  private freshPerks(owner: string, now = Date.now()) {
    const p = this.perks.get(owner);
    return p && now - p.at < PERKS_STALE_MS ? p : null;
  }

  /** A product's lowered fee for the wallet now (Infinity: none). */
  private perkFee(owner: string, p: 'copy' | 'bots'): number {
    const now = Date.now();
    const x = this.freshPerks(owner, now)?.[p];
    if (!x || (x.until !== null && x.until <= now)) return Infinity;
    if (x.budget && this.budgetSpent(owner, x.budget)) return Infinity;
    return Math.max(0, x.fee);
  }

  /** The copy fee: the ladder by volume, or lower (VIP, a program). */
  private copyFee(owner: string, volume: number | null): number {
    return Math.min(copyFeeFor(volume), this.perkFee(owner, 'copy'));
  }

  /**
   * The bot fee: the bot ladder by volume, or lower - VIP by volume, and server 1's programs (the beta's 30 days of VIP
   * from the wallet's listing is one: `fees.bots` with its end). One source for the beta VIP: server 1's (owner
   * 2026-11-08); the executor no longer counts its own 30 days from the first bot.
   */
  private botFee(owner: string, volume: number | null): number {
    return Math.min(botFeeFor(volume, { vip: this.freshPerks(owner)?.vip === true || this.vipListed(owner) }), this.perkFee(owner, 'bots'));
  }

  /** A wallet EXECUTOR_VIP_WALLETS names: VIP whatever its volume. */
  private vipListed(owner: string): boolean {
    return (this.cfg.vipWallets ?? []).includes(owner.toLowerCase());
  }

  /** The wallet's bot fee as /me shows it: tenths of a bp, whether it is VIP's, until when a lowered fee lasts. */
  private botFeeView(owner: string): NonNullable<MeResponse['bots']> {
    const now = Date.now();
    const vol = this.volumeOf(owner);
    const fee = this.botFee(owner, vol);
    const p = this.freshPerks(owner, now);
    const perk = p?.bots && (p.bots.until === null || p.bots.until > now) ? p.bots : null;
    const byPerk = perk !== null && Math.max(0, perk.fee) === fee && fee < botFeeFor(vol, { vip: p?.vip === true });
    return { feeTenths: fee, vip: p?.vip === true || this.vipListed(owner) || (perk !== null && perk.fee <= BOT_FEE_VIP), until: byPerk ? perk.until : null };
  }
  private readonly volumeReads = new Map<string, Promise<number | null>>();
  private builderDb: DatabaseSync | null = null;
  /** Self-hosted, not yet paired: the code printed at start. */
  readonly pairingCode: string | null;
  private pairMisses = 0;
  private pairLockedUntil = 0;
  /** The operator's emergency brake (brake.ts): read from cfg.brakeFile. */
  readonly brake: Brake;
  /**
   * SoDEX's maintenance (venue.ts): while it lasts every live copy, algo and bot is held (the engines' `venue`) and
   * SodexClient sends nothing that opens. Polled once main.ts starts it (start()); tests call poll().
   */
  readonly venue: SodexMaintenanceWatch;

  constructor(
    readonly cfg: ExecutorConfig,
    readonly db: ExecutorDb,
    private readonly secrets: Secrets,
    private readonly deps: ServiceDeps,
  ) {
    // The hosted id is what every registered key and signed request names: it never changes (staging sets EXECUTOR_ID).
    this.executorId = cfg.executorId ?? (cfg.kind === 'hosted' ? `valuedesk-${cfg.network}-tokyo` : this.selfId());
    this.keyName = cfg.kind === 'hosted' ? 'vd-copy-tokyo' : 'vd-copy-self';
    this.pairingCode = cfg.kind === 'self' && !this.owner() ? pairingCode() : null;
    this.guard = new ErrorGuard({
      alert: (kind, o) => deps.alerts?.raise(kind, o.ref, o.text),
      held: (t, reason, until, wallet) => this.onHeld(t, reason, until, wallet),
      keyRefused: (owner) => {
        this.forgetSigner(owner);
        // SoDEX itself refused it: no longer trusted from having been listed; the next readiness check reads it again.
        const k = db.key(owner, 'active');
        if (k) db.markKey(owner, 'active', k.registered, k.expiresAt, KEY_REFUSED_AT);
      },
    });
    this.brake = new Brake(cfg.brakeFile, (now, before) => {
      db.audit('brake', null, null, { now, before });
      // Planned work (cause 'maintenance': ship.sh) is told by whoever set it; an operator's brake is an alert.
      if (now && now.cause !== 'maintenance') deps.alerts?.raise('brake-on', '', `Copies ${now.copies ? 'held' : 'running'}, algos ${now.algos ? 'held' : 'running'}. Reason: ${now.reason}`);
      else if (!now && before && before.cause !== 'maintenance') deps.alerts?.raise('brake-off', '', 'The emergency brake is off; trading goes on.');
      if (now) deps.log.warn('executor: the emergency brake is ON', { copies: now.copies, algos: now.algos, reason: now.reason });
      else if (before) deps.log.warn('executor: the emergency brake is off', {});
    });
    // Every signed write's time to answer, always on (GET /bots/latency): one region now, the array takes more.
    this.latency = new WriteLatency([{ id: 'tokyo', label: 'Tokyo · SoDEX', where: cfg.location }], db, Date.now, (e) => deps.log.warn('executor: write latency not recorded', { error: String(e) }));
    const logWrites = process.env.EXECUTOR_LOG_WRITES === '1';
    // The official route (/trade/orders) unless EXECUTOR_SODEX_DOOR names the fast door: the default stays official.
    this.sodex = new SodexClient({ network: cfg.network, fetch: deps.fetch, fastDoor: process.env.EXECUTOR_SODEX_DOOR === 'exchange' ? true : process.env.EXECUTOR_SODEX_DOOR === 'exchange-key' ? 'with-key' : false, raceCopies: Number(process.env.EXECUTOR_SODEX_RACE) || 1, lanesByMarket: process.env.EXECUTOR_SODEX_LANES === '1', onWrite: (w) => {
      this.latency.record('tokyo', w);
      if (logWrites) deps.log.info('write', w);
    } });
    this.hyperliquid = new HyperliquidClient(deps.fetch);
    // SoDEX's maintenance flag (alpha-biz, venue.ts MAINTENANCE_STATUS_URL); EXECUTOR_SODEX_MAINT_URL names another (a test box).
    const maintUrl = process.env.EXECUTOR_SODEX_MAINT_URL?.trim();
    this.venue = new SodexMaintenanceWatch({
      fetch: deps.fetch,
      ...(maintUrl ? { url: maintUrl } : {}),
      reach: () => this.sodex.reach,
      probe: () => this.sodex.get('/api/v1/perps/markets/mark-prices', undefined, 1),
      alerts: deps.alerts ?? null,
      log: deps.log,
      onChange: (hold) => {
        this.sodex.maintenance = hold;
        this.db.audit('venue', null, null, { maintenance: hold !== null, since: hold?.since ?? null, expectedEnd: hold?.expectedEnd ?? null });
      },
    });
    this.runtime = new CopyRuntime({
      store: db,
      sodex: this.sodex,
      hyperliquid: this.hyperliquid,
      factory: deps.factory,
      network: cfg.network,
      hlMode: cfg.kind === 'hosted' ? 'firehose' : 'user',
      log: deps.log,
      sinkFor: (s) => this.sinkFor(s),
      builderFor: async (s) => (cfg.builderId > 0 ? { id: cfg.builderId, fee: this.copyFee(s.owner, await this.freshVolume(s.owner)) } : null),
      onFill: (s, usd, at) => this.noteFill(s.owner, 'copy', usd, at),
      // The stricter of the country declared when the copy started and the one in the wallet's current terms.
      policyFor: (s) => screenPolicy(this.policyNow(s.owner, s.country, s.observedCountry), s.owner, s.settings.leader.address),
      keyProblem: async (s) => this.guard.holdOf({ kind: 'copy', id: s.id, owner: s.owner }) ?? this.keyProblem(s.owner),
      // A copy halted, held, stopped or closed outside the copier: kept for the follower to read after signing in.
      onNotice: (n) => db.addNotice(n),
      brake: () => this.brakeText('copies'),
      shortBrakeSince: () => {
        const b = this.brake.current();
        return b?.copies && b.cause === 'maintenance' ? b.since : null;
      },
      // SoDEX's maintenance holds every live copy as the brake does; caught up once it is back (runtime.ts resumeHeld).
      venue: () => this.venue.hold(),
      // Reads that confirm a change outside the copier (copy-engine confirm.ts), as far apart as the key reads.
      confirmGapMs: deps.readGapMs,
    });
    const oracleFeed = new OracleFeed({ fetch: deps.fetch });
    // The Binance-led maker's reference: the box's shared Binance feed (valuescan-feed), own sockets while it is down. Hosted only.
    this.reference = cfg.kind === 'hosted' ? new BinanceReference({ path: process.env.EXECUTOR_FEED_PATH || DEFAULT_FEED_PATH, factory: plainSockets, log: deps.log, fetch: deps.fetch as never }) : null;
    this.calendar = cfg.calendarUrl ? new CalendarFeed({ url: cfg.calendarUrl, fetch: deps.fetch, log: deps.log }) : null;
    // Host calls the engine reads when it has them (A1, 2026-11-08): the active key's expiry (a bot pulls its quotes
    // before it), the wallet's own SoDEX maker fee in bp for booked fees (null: the market's base rate). Spread, so an
    // engine without them still compiles.
    const botHost = {
      keyExpiresAt: (owner: string): number | null => this.db.key(owner.toLowerCase(), 'active')?.expiresAt ?? null,
      makerFeeFor: (owner: string, _symbol: string): number | null => this.makerFeeFor(owner),
    };
    this.algos = new AlgoRuntime({
      ...botHost,
      store: db,
      sodex: this.sodex,
      network: cfg.network,
      factory: deps.factory,
      ...(deps.accountFactories?.length ? { accountFactories: deps.accountFactories } : {}),
      log: deps.log,
      sinkFor: (a) => this.algoSink(a),
      // Bots: the bot ladder by 14-day volume; VIP, or beta in its first 30 days, the lowest step (policy.ts botFeeFor).
      builderRate: (a) => (cfg.builderId > 0 ? (a.spec?.bot === true ? this.botFee(a.owner, this.volumeOf(a.owner)) : this.copyFee(a.owner, this.volumeOf(a.owner))) / 100_000 : 0),
      onFill: (a, usd, at) => this.noteFill(a.owner, a.spec?.bot === true ? 'bots' : 'copy', usd, at),
      problem: async (a) => this.guard.holdOf({ kind: 'algo', id: a.id, owner: a.owner }) ?? this.algoProblem(a),
      brake: () => this.brakeText('algos'),
      // SoDEX's maintenance holds every live algo and bot; nothing counts as a refusal meanwhile.
      venue: () => this.venue.hold(),
      // The copy region rules, from the country declared with the terms and the one the request came from.
      policyFor: (a) => this.algoPolicy(a),
      // A sweep's reference price: the shared oracle (oracle.ts) - Binance futures and spot, Bitget,
      // Hyperliquid, OKX and Bybit, each read at most once a second per coin for every algo here.
      oracle: (coin) => oracleFeed.quotes(coin),
      ...(this.reference ? { reference: this.reference } : {}),
      // A bot's news gate: the API server's economic calendar, read every 30 minutes.
      events: () => this.calendar?.events() ?? null,
      // An algo failed, stopped, held or finished: kept for the follower to read after signing in.
      onNotice: (n) => db.addNotice(n),
      confirmGapMs: deps.readGapMs,
    });
  }

  async start(): Promise<void> {
    this.latency.start();
    this.calendar?.start();
    this.signerSweep ??= setInterval(() => {
      this.sweepSigners();
      this.warnKeyExpiry();
      this.watchBotHealth();
      if (this.canMoveBack() && Date.now() - this.vipSweepAt >= (this.cfg.vipSweepMs ?? VIP_SWEEP_MS)) {
        this.vipSweepAt = Date.now();
        void this.sweepVip().catch((e) => this.deps.log.warn('vip: sweep failed', { error: String(e) }));
      }
    }, 30_000);
    this.failInterruptedVipJobs();
    this.signerSweep.unref?.();
    // The per-IP rate limit, to the operator: SoDEX's 429 / Cloudflare 1015 opens a cooldown for every wallet here.
    this.sodex.budget.onEvent = (e) => {
      if (e.kind === 'rate-limited') {
        this.deps.log.warn('executor: SoDEX rate limited this IP', { ms: e.ms, path: e.path, retryAfterMs: e.retryAfterMs });
        this.deps.alerts?.raise('rate-limited', '', `SoDEX answered 429 on ${e.path}; nothing opens for ${Math.round(e.ms / 1000)} s${e.retryAfterMs !== null ? ` (Retry-After ${Math.round(e.retryAfterMs / 1000)} s)` : ''}. Closes and stops still go out, spaced.`);
      } else this.deps.alerts?.raise('rate-cleared', '', 'SoDEX answers again without 429.');
    };
    // Closes and stops waiting in the send queue (copy-engine sodex.ts SendQueue) longer than 10 s.
    this.sodex.queue.onEvent = (e) => {
      this.deps.log.warn('executor: the SoDEX send queue is slow', { waiting: e.waiting, oldestMs: e.oldestMs, byClass: e.byClass });
      this.deps.alerts?.raise('queue-slow', '', `${e.waiting} signed write(s) waiting, the oldest for ${Math.round(e.oldestMs / 1000)} s (cancels ${e.byClass.cancel}, stops/closes ${e.byClass.protect}, leverage ${e.byClass.leverage}). New openings are refused until it drains; cooldown ${Math.round(this.sodex.budget.cooldownLeft() / 1000)} s.`);
    };
    await this.runtime.start();
    await this.algos.start();
  }

  async stop(): Promise<void> {
    this.venue.stop();
    if (this.signerSweep) clearInterval(this.signerSweep);
    this.signerSweep = null;
    await this.algos.stop();
    this.reference?.stop();
    this.calendar?.stop();
    await this.runtime.stop();
    // Last: a stop still signs (what a step had on its way, the bots' cancels), and a wiped key signs nothing valid.
    for (const owner of [...this.signers.keys()]) this.forgetSigner(owner, true);
    this.builderDb?.close();
    this.latency.stop();
  }

  private selfId(): string {
    let id = this.db.meta('executorId');
    if (!id) {
      id = randomId('self-');
      this.db.setMeta('executorId', id);
    }
    return id;
  }

  /** Self-hosted: the one wallet it serves (configured, or paired), else null. */
  owner(): string | null {
    return this.cfg.owner ?? this.db.meta('owner');
  }

  /* ------------------------------------------------------------- info ----- */

  info(ctx: RequestContext): ExecutorInfo {
    return {
      executorId: this.executorId,
      kind: this.cfg.kind,
      version: COPY_ENGINE_VERSION,
      network: this.cfg.network,
      location: this.cfg.location,
      open: this.cfg.kind === 'hosted' ? this.cfg.open : this.owner() !== null,
      owner: this.cfg.kind === 'self' ? this.owner() : null,
      builder: this.cfg.builderId > 0 ? { id: this.cfg.builderId, ladder: COPY_FEE_LADDER.map((s) => ({ ...s })), windowDays: COPY_FEE_WINDOW_DAYS } : null,
      termsVersion: COPY_TERMS_VERSION,
      viewerCountry: ctx.viewerCountry,
      keyTtlDaysMax: this.cfg.keyTtlDaysMax,
      keyName: this.keyName,
      keyImport: { alg: KEY_IMPORT_ALG, publicKey: this.secrets.importPublicKey(), info: importInfo(this.executorId, '<owner>') },
      algos: { maxPerOwner: this.cfg.maxAlgosPerOwner },
      bots: { fee: BOT_FEE, ladder: BOT_FEE_LADDER, vipFee: BOT_FEE_VIP, betaVipDays: BETA_VIP_DAYS },
      features: [...EXECUTOR_FEATURES],
      vip: { tier: this.cfg.tier, canMove: this.cfg.tier === 'standard' && !!this.cfg.vipUrl && !!this.cfg.vipToken && !!this.cfg.vipPubkey, canMoveBack: this.canMoveBack(), location: this.cfg.location, open: this.cfg.vipOpen },
      brake: this.brakeView(),
      venue: this.venueView(),
    };
  }

  /** SoDEX's state for the site: normal, or in maintenance since when and until when SoDEX expects (venue.ts). */
  private venueView(): NonNullable<ExecutorInfo['venue']> {
    const v = this.venue.view();
    return { state: v.state, since: v.since, expectedEnd: v.expectedEnd };
  }

  /* ------------------------------------------------------------ audit ----- */

  /** One answered request, for the audit log (server.ts): route, status, where from, the signed action and wallet. */
  audit(r: { method: string; path: string; status: number; ms: number; client: string; country: string | null; request: { action: string | null; owner: string | null; digest: string | null } | null }): void {
    this.db.audit('request', r.request?.owner ?? null, r.path, r);
  }

  /* ------------------------------------------------------------ brake ----- */

  /** What the site shows while the brake is on (null: off). */
  private brakeView(): ExecutorInfo['brake'] {
    const b = this.brake.current();
    return b ? { copies: b.copies, algos: b.algos, reason: b.reason, since: b.since } : null;
  }

  /** The sentence a held copy or algo shows, or null while that switch is off. */
  private brakeText(what: 'copies' | 'algos'): string | null {
    const r = what === 'copies' ? this.brake.copies() : this.brake.algos();
    return r === null ? null : `ValueDesk paused all ${what === 'copies' ? 'copy trading' : 'algo orders'} on this executor: ${r}`;
  }

  /** New live trading (a copy, an algo, a resume, a bigger size) is refused while the brake is on; stopping never is. */
  private needNoBrake(what: 'copies' | 'algos'): void {
    const t = this.brakeText(what);
    if (t) throw new ApiError(503, 'brake', `${t} Nothing new starts until it is lifted; what you stop, pause or cancel still goes through.`);
  }

  /**
   * What release.sh and the health check read: ok only while the database answers and the SoDEX feed is up - or SoDEX
   * is in maintenance (venue.ts): then the feed being down is SoDEX's, not ours, so `ok` stays true (the health check
   * and the status prober read ok) and `venue` says why; `feeds.sodex` still tells the feed as it is (a warning there).
   */
  health(): { ok: boolean; db: boolean; copies: number; active: number; algos: number; feeds: { sodex: boolean }; brake?: BrakeState | null; queue?: QueueStats; venue?: VenueView } {
    let db = true;
    try {
      this.db.ping();
    } catch {
      db = false;
    }
    const venue = this.venue.view();
    if (!db) return { ok: false, db, copies: 0, active: 0, algos: 0, feeds: { sodex: false }, brake: this.brake.current(), queue: this.sodex.queue.stats(), venue };
    const all = this.runtime.list();
    const v = all[0] ? this.runtime.view(all[0].id) : null;
    const algos = this.algos.list().filter((a) => !FINAL_STATUSES.has(a.status)).length;
    const sodex = v?.feeds.sodex ?? true;
    // The send queue: how many signed writes wait, the oldest's age, the cooldown left (sodex.ts SendQueue).
    return { ok: sodex || venue.state === 'maintenance', db, copies: all.length, active: all.filter((s) => s.status === 'active').length, algos, feeds: { sodex }, brake: this.brake.current(), queue: this.sodex.queue.stats(), venue };
  }

  /**
   * One instruction of a wallet at a time. A subscribe or an algo start checks the
   * wallet's limits and duplicates, then waits on SoDEX (the key, the account)
   * before it adds: two sent together (a double click) would both pass the checks.
   */
  private readonly queues = new Map<string, Promise<unknown>>();
  private serial<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(owner) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(owner, tail);
    void tail.then(() => {
      if (this.queues.get(owner) === tail) this.queues.delete(owner);
    });
    return run;
  }

  /* --------------------------------------------------------- requests ----- */

  /** Verify, check the action and the wallet, record. Returns the owner and the payload. */
  private accept(req: unknown, want: CopyAction | readonly CopyAction[], ctx: RequestContext): { owner: string; payload: Record<string, unknown>; consent: Subscription['consent'] } {
    const q = req as Partial<SignedCopyRequest> | null;
    const termsWide = want === 'accept-terms' && q?.action === 'accept-terms' && q.executor === COPY_TERMS_EXECUTOR;
    // ValueDesk's own terms always name SITE_TERMS_EXECUTOR: one statement, whoever records it.
    const siteTerms = want === 'accept-site-terms';
    const v = verifyCopyRequest(req, { executor: siteTerms ? SITE_TERMS_EXECUTOR : termsWide ? COPY_TERMS_EXECUTOR : this.executorId, revokedBefore: (o) => Number(this.db.meta(`daykeys-revoked:${o}`) ?? 0) });
    if (!v.ok) throw new ApiError(401, 'signature', v.error);
    const r = req as SignedCopyRequest;
    const wanted = Array.isArray(want) ? want : [want];
    if (!wanted.includes(r.action)) throw new ApiError(400, 'action', `this endpoint takes ${wanted.join(' / ')}, not ${r.action}`);
    const owner = r.owner.toLowerCase();
    if (this.cfg.kind === 'self') {
      const paired = this.owner();
      if (!paired) {
        const code = ctx.pairingCode?.replace(/[\s-]/g, '').toUpperCase();
        if (Date.now() < this.pairLockedUntil) throw new ApiError(429, 'pairing-locked', 'Too many wrong pairing codes. Wait 15 minutes, or restart the copier for a new code.');
        if (r.action !== 'session' || !code || !this.pairingCode || !sameCode(code, this.pairingCode)) {
          if (r.action === 'session' && code) {
            if (++this.pairMisses >= PAIR_MAX_TRIES) {
              this.pairMisses = 0;
              this.pairLockedUntil = Date.now() + PAIR_LOCK_MS;
              this.deps.log.warn('pairing locked after wrong codes', { tries: PAIR_MAX_TRIES });
            }
          }
          throw new ApiError(403, 'unpaired', 'This executor is not paired with a wallet yet. Enter the pairing code it printed when it started.');
        }
        this.db.setMeta('owner', owner);
        this.deps.log.info('executor paired', { owner });
      } else if (paired !== owner) {
        throw new ApiError(403, 'owner', 'This executor serves another wallet.');
      }
    }
    const at = Date.now();
    const recorded = this.db.addConsent({
      owner,
      action: r.action,
      digest: v.digest,
      signature: r.signature,
      chainId: r.chainId,
      payload: r.payload,
      nonce: r.nonce,
      at,
      viewerCountry: ctx.viewerCountry,
    });
    if (!recorded) throw new ApiError(409, 'replay', 'This signed request was already used. Sign it again.');
    return {
      owner,
      payload: (v.payload && typeof v.payload === 'object' ? v.payload : {}) as Record<string, unknown>,
      consent: { action: r.action, digest: v.digest, signature: r.signature, chainId: r.chainId, payload: r.payload, at },
    };
  }

  /**
   * Revoke every day key the wallet approved before now (owner 2026-11-09 security review): a wallet-signed 'delegate'
   * with payload {revoke: true}. A day key is never stored here - its approval travels with each request - so the
   * revocation is a time: approvals signed before it are refused (verifyCopyRequest revokedBefore). Wallet only.
   */
  revokeDayKeys(req: unknown, ctx: RequestContext): { ok: true; revokedBefore: number } {
    const r = req as Partial<SignedCopyRequest> | null;
    if (r?.delegation !== undefined) throw new ApiError(401, 'signature', 'Only the wallet itself can revoke its day keys.');
    const { owner, payload } = this.accept(req, 'delegate', ctx);
    if (payload.revoke !== true) throw new ApiError(400, 'payload', 'A revocation says {revoke: true}.');
    const at = Date.now();
    this.db.setMeta(`daykeys-revoked:${owner}`, String(at));
    this.deps.log.info('day keys revoked', { owner });
    return { ok: true, revokedBefore: at };
  }

  session(req: unknown, ctx: RequestContext): SessionGrant {
    const { owner } = this.accept(req, 'session', ctx);
    // Its fee step is known before the first order needs it.
    void this.freshVolume(owner);
    return this.secrets.issueSession(owner, SESSION_TTL_MS);
  }

  /** The wallet behind a session token, or a 401. */
  authenticate(token: string | null | undefined): string {
    const owner = this.secrets.readSession(token);
    if (!owner) throw new ApiError(401, 'session', 'Sign in to the executor again (the session expired).');
    if (this.cfg.kind === 'self' && this.owner() !== owner) throw new ApiError(403, 'owner', 'This executor serves another wallet.');
    return owner;
  }

  /** The copy terms in force here - version, hash and the text itself - for the web to show and sign exactly. */
  copyTerms(): CopyTermsServed {
    return currentCopyTerms();
  }

  acceptTerms(req: unknown, ctx: RequestContext): MeResponse {
    const { owner, payload } = this.accept(req, 'accept-terms', ctx);
    const p = payload as Partial<AcceptTermsPayload>;
    // The web signs the version and text this executor serves (/info termsVersion, GET /terms/copy) and, on this
    // refusal, fetches them and asks again in the same flow: never a reload (owner 2026-11-09).
    if (p.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, 'terms-version', `ValueDesk's copy terms are now version ${COPY_TERMS_VERSION}. Read them and sign that version.`);
    if (typeof p.termsHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(p.termsHash)) throw new ApiError(400, 'terms-hash', 'termsHash must be the keccak256 of the terms text.');
    const country = normaliseCountry(p.country);
    if (!country) throw new ApiError(400, 'country', 'Choose your country of residence.');
    for (const k of ['adult', 'notUsPerson', 'ownDecision', 'risksUnderstood'] as const) {
      if (p[k] !== true) throw new ApiError(400, 'statements', 'Every statement must be confirmed to copy trades.');
    }
    this.screen(owner);
    const policy = regionPolicy(country, ctx.viewerCountry);
    this.db.setTerms(owner, { termsVersion: p.termsVersion, termsHash: p.termsHash, country, observedCountry: normaliseCountry(ctx.viewerCountry), acceptedAt: Date.now() });
    if (!policy.allowed) throw new ApiError(451, 'region', policy.reason ?? 'Copy trading is not available in your region.');
    return this.me(owner, ctx);
  }

  /**
   * ValueDesk's own Terms of use and Risk disclosure, signed by a wallet before
   * it trades through ValueDesk (apps/web/src/legal/acceptance.ts). Recorded
   * only: the consent log keeps the signed request with the country the edge
   * saw, like every instruction. The version is the site's - its terms change
   * without a release of this executor - so its form is checked, not its value;
   * so are the fingerprint, the country and the statements. Hosted only: it is
   * ValueDesk's record, not a follower's own executor's.
   */
  acceptSiteTerms(req: unknown, ctx: RequestContext): SiteTermsRecord {
    if (this.cfg.kind !== 'hosted') throw new ApiError(404, 'path', 'ValueDesk\'s terms are recorded by ValueDesk\'s own executor.');
    const { payload } = this.accept(req, 'accept-site-terms', ctx);
    const p = payload as Partial<AcceptSiteTermsPayload>;
    if (typeof p.termsVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(p.termsVersion)) throw new ApiError(400, 'terms-version', 'termsVersion must be the version of the terms shown.');
    if (typeof p.termsHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(p.termsHash)) throw new ApiError(400, 'terms-hash', 'termsHash must be the keccak256 of the terms text.');
    const country = normaliseCountry(p.country);
    if (!country) throw new ApiError(400, 'country', 'Choose your country of residence.');
    for (const k of ['agree', 'eligible', 'risks', 'ownDecisions'] as const) {
      if (p[k] !== true) throw new ApiError(400, 'statements', 'Every statement must be confirmed to trade through ValueDesk.');
    }
    if (typeof p.text !== 'string' || p.text.length < 40 || p.text.length > 4000) throw new ApiError(400, 'text', 'The signed message must carry the statements as text.');
    return { recorded: true, termsVersion: p.termsVersion, country, observedCountry: normaliseCountry(ctx.viewerCountry), acceptedAt: Date.now() };
  }

  me(owner: string, ctx: RequestContext): MeResponse {
    const terms = this.db.terms(owner);
    const current = terms && terms.termsVersion === COPY_TERMS_VERSION ? terms : null;
    return {
      owner,
      terms: current,
      policy: screenPolicy(regionPolicy(current?.country ?? null, ctx.viewerCountry), owner),
      key: this.keyInfo(owner),
      copies: this.runtime
        .list(owner)
        .map((s) => this.runtime.view(s.id))
        .filter((v): v is CopyView => v !== null)
        .sort((a, b) => b.subscription.createdAt - a.subscription.createdAt),
      movedTo: this.movedAway(owner),
      bots: this.botFeeView(owner),
    };
  }

  /* -------------------------------------------------------------- VIP ----- */

  private vipJobs = new Map<string, VipJob>();

  /** A move of this wallet's bots is under way (A6: its starts, resumes and changes wait for it; stops never do). */
  private vipMoving(owner: string): boolean {
    return this.vipJobs.get(owner)?.state === 'running';
  }

  /**
   * Start moving the signer's bots to the VIP executor (vip.ts). One job per wallet at a time, run inside the
   * wallet's queue (serial): nothing else of the wallet's runs in between, and a start or resume asked meanwhile is
   * refused (vip-moving). The job is kept in the db at every step.
   */
  vipMove(req: unknown, ctx: RequestContext): VipJob {
    const { owner } = this.accept(req, 'vip-move', ctx);
    if (this.cfg.tier !== 'standard' || !this.cfg.vipUrl || !this.cfg.vipToken || !this.cfg.vipPubkey) throw new ApiError(404, 'vip', 'The VIP servers are not set up on this executor.');
    const cur = this.vipJobs.get(owner);
    if (cur?.state === 'running') return vipJobView(cur);
    if (this.db.moved(owner)?.tier === 'vip') throw new ApiError(409, 'moved', 'Your bots run on the VIP servers already.');
    const job = newVipJob(owner);
    this.vipJobs.set(owner, job);
    this.db.saveVipJob(job);
    void this.serial(owner, () => this.runVipMove(job)).catch(() => undefined);
    return vipJobView(job);
  }

  /** Where the wallet's bots run when it is not here: the other executor's tier, else null. */
  private movedAway(owner: string): 'vip' | 'standard' | null {
    const t = this.db.moved(owner)?.tier;
    return (t === 'vip' || t === 'standard') && t !== this.cfg.tier ? t : null;
  }

  /** This executor takes moves in: the VIP one (up), or a standard one paired with a VIP one (back). */
  private takesMoves(): boolean {
    return this.cfg.tier === 'vip' || !!this.cfg.vipUrl;
  }

  /** The VIP executor can move wallets back (vip.ts BACK): the standard one's URL, its pinned key and the token. */
  private canMoveBack(): boolean {
    return this.cfg.tier === 'vip' && !!this.cfg.stdUrl && !!this.cfg.vipToken && !!this.cfg.stdPubkey;
  }

  /**
   * Move a wallet's bots back to the standard executor (VIP side; vip.ts BACK). At most one move back per wallet per
   * UTC day (a second the same day returns null and moves nothing); none while another move of the wallet runs.
   */
  vipMoveBack(owner: string, reason: string, now = Date.now()): VipJob | null {
    if (!this.canMoveBack()) return null;
    if (this.vipMoving(owner) || this.movedAway(owner)) return null;
    if (downgradedToday([...(this.vipJobs.has(owner) ? [this.vipJobs.get(owner)!] : []), ...this.db.vipJobs<VipJob>(owner)], now)) return null;
    const job = newVipJob(owner, 'down', reason);
    this.vipJobs.set(owner, job);
    this.db.saveVipJob(job);
    void this.serial(owner, () => this.runVipMove(job)).catch(() => undefined);
    return vipJobView(job);
  }

  /**
   * VIP side, every VIP_SWEEP_MS: each wallet with bots running here is asked about (vipEligible, twice, a moment
   * apart: one answer never moves anyone); one that is no longer VIP moves back (vipMoveBack: once a UTC day). A read
   * that fails moves nobody. Returns the jobs started.
   */
  async sweepVip(now = Date.now()): Promise<VipJob[]> {
    if (!this.canMoveBack() || this.cfg.vipOpen) return [];
    const owners = new Set(this.algos.list().filter((a) => a.spec?.bot === true && !FINAL_STATUSES.has(a.status)).map((a) => a.owner));
    const out: VipJob[] = [];
    for (const owner of owners) {
      if (this.movedAway(owner) || this.vipMoving(owner)) continue;
      if (downgradedToday(this.db.vipJobs<VipJob>(owner), now)) continue;
      try {
        const a = await this.vipEligible(owner);
        if (a.ok) continue;
        await sleep(this.deps.readGapMs ?? 2_000);
        const b = await this.vipEligible(owner);
        if (b.ok) continue;
        const j = this.vipMoveBack(owner, b.why, now);
        if (j) out.push(j);
      } catch (e) {
        this.deps.log.warn('vip: status read failed; nobody moved back', { owner, error: String(e) });
      }
    }
    return out;
  }
  private vipSweepAt = 0;

  /**
   * The operator's overview of this executor (owner 2026-11-08: "usage of our infrastructure + bot volume across all
   * valuedesk users"): what runs here against its caps, the shared SoDEX budget, and the bots' volume, PnL and fees
   * (all wallets together, real and practice apart). Read by server 1's admin suite with the internal token.
   */
  infraStats(now = Date.now()): Record<string, unknown> {
    const all = this.algos.list();
    const bots = all.filter((a) => a.spec?.bot === true);
    const liveBots = bots.filter((a) => !FINAL_STATUSES.has(a.status));
    const real = liveBots.filter((a) => !a.spec.paper);
    // Volume over the last 24 h: its volume now less its volume at the last 5-minute point before then (none: all of it).
    const vol24 = (a: AlgoRecord): number => {
      const b = a.book;
      if (!b) return 0;
      const before = [...(b.series ?? [])].reverse().find((p) => p[0] < now - 86_400_000);
      return Math.max(0, b.buyValue + b.sellValue - (before ? before[1] : 0));
    };
    const sum = (xs: AlgoRecord[]) => {
      let volume = 0, volume24h = 0, net = 0, tradeFees = 0, builderFees = 0, fills = 0;
      for (const a of xs) {
        const b = a.book;
        if (!b) continue;
        const v = this.algos.view(a.id)?.bot;
        volume += b.buyValue + b.sellValue;
        volume24h += vol24(a);
        net += v?.netPnl ?? 0;
        tradeFees += b.tradeFees;
        builderFees += b.builderFees;
        fills += b.fills;
      }
      return { volume, volume24h, netPnl: net, tradeFees, builderFees, fills };
    };
    const realAll = bots.filter((a) => !a.spec.paper);
    const markets = new Map<string, { symbol: string; live: number; volume: number; volume24h: number }>();
    for (const a of realAll) {
      const m = markets.get(a.spec.symbol) ?? { symbol: a.spec.symbol, live: 0, volume: 0, volume24h: 0 };
      if (!FINAL_STATUSES.has(a.status)) m.live++;
      m.volume += a.book ? a.book.buyValue + a.book.sellValue : 0;
      m.volume24h += vol24(a);
      markets.set(a.spec.symbol, m);
    }
    const budget = this.sodex.budget as unknown as { used(now?: number): number; perMinute: number; cooldownLeft?(): number };
    const socket = (this.algos as unknown as { socketWallets?: () => { followed: number; polled: number } }).socketWallets?.() ?? null;
    return {
      at: now,
      tier: this.cfg.tier,
      location: this.cfg.location,
      liveBots: real.length,
      maxLiveBots: this.cfg.maxLiveBots,
      practiceBots: liveBots.length - real.length,
      pausedBots: real.filter((a) => a.status === 'paused').length,
      closingBots: real.filter((a) => !!a.k.closing).length,
      botWallets: new Set(real.map((a) => a.owner)).size,
      algos: all.filter((a) => a.spec?.bot !== true && !FINAL_STATUSES.has(a.status) && !a.spec.paper).length,
      copies: this.runtime.list().filter((c) => c.status !== 'stopped' && !c.settings.paper).length,
      maxAlgosPerOwner: this.cfg.maxAlgosPerOwner,
      socket: socket ? { ...socket, max: 10 } : null,
      budget: { used: Math.round(budget.used(now)), perMinute: budget.perMinute, cooldownMs: budget.cooldownLeft?.() ?? 0 },
      real: sum(realAll),
      practice: sum(bots.filter((a) => a.spec.paper)),
      markets: [...markets.values()].sort((x, y) => y.volume24h - x.volume24h || y.volume - x.volume).slice(0, 40),
      vipMoves: this.db.vipJobs<VipJob>().filter((j) => now - j.startedAt < 7 * 86_400_000).map((j) => ({ direction: j.direction ?? 'up', state: j.state, outcome: j.outcome ?? null, at: j.startedAt })),
    };
  }

  /** The wallet's last move, as it stands (this process's, else the db's: a move from before a restart). */
  vipJob(owner: string): VipJob | null {
    const j = this.vipJobs.get(owner) ?? this.db.vipJobs<VipJob>(owner)[0] ?? null;
    return j ? vipJobView(j) : null;
  }

  /**
   * At start: a move the db still has as running was cut by a restart. Where its bots run is not known here (the VIP
   * side may have taken them), so they stay paused, the job says so, and the operator is told. Never resumed on a guess.
   */
  private failInterruptedVipJobs(): void {
    for (const j of this.db.vipJobs<VipJob>()) {
      if (j.state !== 'running') continue;
      j.state = 'failed';
      j.outcome = 'unknown';
      j.endedAt = Date.now();
      j.error = 'The standard servers restarted during the move. Your bots stay paused until ValueDesk has checked where they run.';
      this.db.saveVipJob(j);
      this.deps.log.warn('vip: a move was cut by a restart', { owner: j.owner, job: j.id });
      this.deps.alerts?.raise('vip-move-unknown', `owner:${j.owner}`, `A VIP move of ${shortWallet(j.owner)} (job ${j.id}) was cut by a restart; its bots are paused here. Check the VIP side's import (POST /internal/vip/import/status) before resuming or finishing it.`);
    }
  }

  /**
   * Headers for a call to the other executor (or server 1): with the origin secret, so the other side's edge gate
   * (Caddy, the executor's own check) lets it through - both executors share the origin secrets.
   */
  private peerHeaders(h: Record<string, string>): Record<string, string> {
    return this.cfg.originSecrets[0] ? { ...h, 'X-Origin-Verify': this.cfg.originSecrets[0] } : h;
  }

  private async vipEligible(owner: string): Promise<{ ok: boolean; why: string }> {
    if (this.cfg.vipOpen) return { ok: true, why: 'open' };
    if (this.vipListed(owner)) return { ok: true, why: 'listed' };
    if (!this.cfg.vipCheckUrl) return { ok: false, why: 'VIP status cannot be checked here.' };
    const u = new URL(this.cfg.vipCheckUrl);
    u.searchParams.set('address', owner);
    const res = await this.deps.fetch(u.toString(), { headers: this.peerHeaders({ Accept: 'application/json' }), signal: AbortSignal.timeout(5_000) });
    const b = JSON.parse(await res.text()) as { ok?: boolean; eligible?: boolean; volumeUsd?: number; minUsd?: number };
    if (!res.ok || !b.ok) throw new Error('VIP status could not be read. Try again in a moment.');
    return b.eligible ? { ok: true, why: 'eligible' } : { ok: false, why: `Not VIP yet: ${Math.round(b.volumeUsd ?? 0).toLocaleString('en-US')} of $${Math.round(b.minUsd ?? 5_000_000).toLocaleString('en-US')} in 14 days.` };
  }

  /**
   * How the VIP side's import of this job ended, asked after a send that was not answered cleanly (a timeout, an
   * error). `abandon`: an import of this job not begun yet never begins (the VIP side keeps the job as abandoned), so
   * the answer is final. 'running' is asked again a few times; no answer at all is 'unknown'.
   */
  private async vipImportOutcome(vip: string, token: string, job: VipJob): Promise<{ state: 'done' | 'failed' | 'abandoned' | 'unknown'; session?: { token: string; expiresAt: number } | null }> {
    for (let i = 0; i < 5; i++) {
      if (i) await sleep(this.deps.readGapMs ?? 2_000);
      try {
        const res = await this.deps.fetch(`${vip}/internal/vip/import/status`, {
          method: 'POST',
          headers: this.peerHeaders({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-Internal-Token': token }),
          body: JSON.stringify({ owner: job.owner, job: job.id, abandon: true }),
          signal: AbortSignal.timeout(5_000),
        });
        const b = JSON.parse(await res.text()) as { ok?: boolean; state?: string; session?: { token: string; expiresAt: number } | null };
        if (!res.ok || !b.ok) continue;
        if (b.state === 'done') return { state: 'done', session: b.session ?? null };
        if (b.state === 'failed' || b.state === 'abandoned') return { state: b.state };
      } catch {
        /* asked again */
      }
    }
    return { state: 'unknown' };
  }

  private async runVipMove(job: VipJob): Promise<void> {
    const owner = job.owner;
    // Up: this standard executor hands to the VIP one. Down (vip.ts BACK): this VIP executor hands back to the standard one.
    const down = job.direction === 'down';
    const vip = (down ? this.cfg.stdUrl! : this.cfg.vipUrl!).replace(/\/+$/, '');
    const token = this.cfg.vipToken ?? '';
    const pinned = down ? this.cfg.stdPubkey! : this.cfg.vipPubkey!;
    const there = down ? 'standard' : 'VIP';
    const pinName = down ? 'EXECUTOR_STD_PUBKEY' : 'EXECUTOR_VIP_PUBKEY';
    const bots = this.algos.list(owner).filter((a) => a.spec?.bot === true && !FINAL_STATUSES.has(a.status));
    job.bots = bots.length;
    const paused: string[] = [];
    let handed = false;
    let unknown = false;
    const step = async <T>(id: Parameters<typeof vipStep>[1], fn: () => Promise<T>): Promise<T> => {
      try {
        return await vipStep(job, id, fn);
      } finally {
        this.db.saveVipJob(job);
      }
    };
    try {
      await step('check', async () => {
        // Up needs VIP; down happens because it ended (sweepVip asked already).
        if (!down) {
          const e = await this.vipEligible(owner);
          if (!e.ok) throw new Error(e.why);
        }
        if (this.runtime.list(owner).some((s) => s.status !== 'stopped')) throw new Error('Stop your copies first: they keep their key on these servers.');
        if (this.algos.list(owner).some((a) => a.spec?.bot !== true && !FINAL_STATUSES.has(a.status))) throw new Error('Let your algo orders finish first: only bots move.');
        if (!this.db.key(owner, 'active') && bots.some((a) => !a.spec.paper)) throw new Error('Set up your SoDEX key first.');
      });
      await step('pause', async () => {
        for (const a of bots) {
          if (a.status === 'paused') continue;
          await this.algos.pause(a.id);
          paused.push(a.id);
        }
      });
      const envelope = await step('seal', async () => {
        // A read, nothing changes: asked up to 3 times (2026-11-09: one 5 s timeout, the next reads took 0.05-0.5 s, failed a live move).
        let res!: { ok: boolean; status: number; text(): Promise<string> };
        for (let i = 0; ; i++) {
          try {
            res = await this.deps.fetch(`${vip}/info`, { headers: this.peerHeaders({ Accept: 'application/json' }), signal: AbortSignal.timeout(8_000) });
            break;
          } catch (e) {
            if (i >= 2) throw e;
            await sleep(this.deps.readGapMs ?? 1_000);
          }
        }
        const info = JSON.parse(await res.text()) as { executorId?: string; keyImport?: { publicKey?: string }; vip?: { tier?: string } };
        if (!res.ok || info.vip?.tier !== (down ? 'standard' : 'vip') || !info.keyImport?.publicKey) throw new Error(`The ${there} servers did not answer.`);
        if (info.executorId !== this.executorId) throw new Error(`The ${there} servers run under another executor id.`);
        // The key is sealed to the pinned public key only (EXECUTOR_VIP_PUBKEY / EXECUTOR_STD_PUBKEY), never to one read over the wire.
        if (info.keyImport.publicKey !== pinned) {
          this.deps.alerts?.raise('vip-key-mismatch', '', `The ${there} servers' /info shows an import key that is not ${pinName}; no key was sent (move of ${shortWallet(owner)}).`);
          throw new Error(`The ${there} servers did not prove who they are. Nothing was sent; your bots stay here.`);
        }
        // Practice bots only, no key here: nothing to seal.
        const k = this.db.key(owner, 'active');
        return k ? { key: k, envelope: this.secrets.sealTo(this.cfg.network, owner, k.address, k.sealed, { publicKey: pinned, executorId: this.executorId }) } : null;
      });
      const answer = await step('send', async () => {
        type Answer = { ok?: boolean; error?: string; session?: { token: string; expiresAt: number } };
        let res = null as { ok: boolean; status: number; text(): Promise<string> } | null;
        let b = null as Answer | null;
        try {
          res = await this.deps.fetch(`${vip}/internal/vip/import`, {
            method: 'POST',
            headers: this.peerHeaders({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-Internal-Token': token }),
            body: JSON.stringify({
              owner,
              job: job.id,
              key: envelope ? { name: envelope.key.name, address: envelope.key.address, expiresAt: envelope.key.expiresAt, envelope: envelope.envelope } : null,
              record: this.db.ownerRecord(owner),
              algos: bots.map((a) => this.algos.get(a.id)),
              resume: bots.filter((a) => a.status !== 'paused' || paused.includes(a.id)).map((a) => a.id),
            }),
            signal: AbortSignal.timeout(VIP_SEND_MS),
          });
          b = JSON.parse(await res.text()) as Answer;
        } catch {
          b = null;
        }
        if (res?.ok && b?.ok) {
          handed = true;
          return b;
        }
        // Not answered cleanly (a timeout, an error, a refusal): the VIP side is asked how its import ended - and one
        // not begun is given up there, so it never starts late. Only its answer decides; no answer is 'unknown'.
        const o = await this.vipImportOutcome(vip, token, job);
        if (o.state === 'done') {
          handed = true;
          return { ok: true, session: o.session ?? undefined };
        }
        if (o.state === 'unknown') {
          unknown = true;
          throw new Error(`The ${there} servers did not confirm the move. Your bots stay paused until ValueDesk has checked where they run.`);
        }
        throw new Error(b?.error ?? (res ? `The ${there} servers answered HTTP ${res.status}.` : `The ${there} servers did not answer.`));
      });
      await step('start', async () => {
        job.session = answer?.session ?? null;
      });
      await step('finish', async () => {
        for (const a of bots) await this.algos.handOver(a.id, down ? `Moved back to the standard servers: ${job.reason ?? 'VIP ended'}` : 'Moved to the VIP servers.');
        this.db.deleteKeys(owner);
        this.forgetSigner(owner);
        this.db.setMoved(owner, down ? 'standard' : 'vip');
        this.deps.log.info(down ? 'vip: moved back' : 'vip: moved', { owner, bots: bots.length, ms: Date.now() - job.startedAt });
      });
      job.state = 'done';
      job.outcome = 'moved';
    } catch (e) {
      job.state = 'failed';
      job.error ??= e instanceof Error ? e.message : String(e);
      if (handed) job.outcome = 'moved';
      else if (unknown) {
        job.outcome = 'unknown';
        this.deps.alerts?.raise('vip-move-unknown', `owner:${owner}`, `A ${down ? 'move back to standard' : 'VIP move'} of ${shortWallet(owner)} (job ${job.id}) was not confirmed by the ${there} side; its ${bots.length} bot(s) stay paused here. Check that side's import (POST /internal/vip/import/status) before resuming or finishing it.`);
      } else {
        job.outcome = 'not-moved';
        // Not taken by the VIP side (its answer says so): back to what it was here - but never under the brake.
        const brake = this.brakeText('algos');
        if (brake) job.error = `${job.error} Your bots stay paused: ${brake}`;
        else for (const id of paused) await this.algos.resume(id).catch(() => undefined);
      }
      this.deps.log.warn('vip: move failed', { owner, error: job.error, handed, unknown });
    } finally {
      job.endedAt = Date.now();
      this.db.saveVipJob(job);
    }
  }

  /**
   * The VIP executor's side of a move (internal: the standard executor asks, with the internal token). Idempotent and
   * all-or-nothing: an id already taken in (and running here) is skipped; every bot is adopted before any resumes; a
   * failure part-way hands the ones adopted by this call back (ended here, nothing closed) and restores the key that
   * was here. The job's outcome is kept (vipImportStatus); a job the sender gave up on is refused.
   */
  async vipImport(body: unknown): Promise<{ ok: true; session: { token: string; expiresAt: number }; started: number; held: number }> {
    // The VIP side takes a move up; a standard side paired with a VIP one (EXECUTOR_VIP_URL) takes a move back.
    if (!this.takesMoves()) throw new ApiError(404, 'path', 'not found');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'vip', 'A move needs a body: the wallet, its key and its bots.');
    const b = body as { owner?: unknown; job?: unknown; key?: { name?: unknown; address?: unknown; expiresAt?: unknown; envelope?: unknown } | null; record?: { terms?: unknown; consents?: unknown }; algos?: unknown; resume?: unknown };
    const owner = typeof b.owner === 'string' && /^0x[0-9a-f]{40}$/.test(b.owner) ? b.owner : null;
    if (!owner || (b.key && (typeof b.key.name !== 'string' || typeof b.key.address !== 'string'))) throw new ApiError(400, 'vip', 'A move needs the wallet (and its key, when it has one).');
    const job = typeof b.job === 'string' && /^[0-9a-f]{16}$/.test(b.job) ? b.job : null;
    if (!job) throw new ApiError(400, 'vip', 'A move needs its job id.');
    const recs = Array.isArray(b.algos) ? (b.algos as AlgoRecord[]) : [];
    if (recs.some((r) => !r || typeof r !== 'object' || typeof r.id !== 'string' || r.owner !== owner || r.spec?.bot !== true)) throw new ApiError(400, 'vip', 'A move carries only the wallet\'s own bots.');
    const kept = this.db.vipImport(job);
    if (kept && kept.owner !== owner) throw new ApiError(409, 'vip', 'This move belongs to another wallet.');
    if (kept?.state === 'abandoned') throw new ApiError(409, 'vip-abandoned', 'The standard servers gave this move up. Start the move again.');
    if (kept?.state === 'running') throw new ApiError(409, 'vip-running', 'This move is being taken in right now.');
    if (kept?.state === 'done') {
      const d = kept.data as { started?: number; held?: number };
      return { ok: true, session: this.secrets.issueSession(owner, SESSION_TTL_MS), started: Number(d.started) || 0, held: Number(d.held) || 0 };
    }
    // Marked before anything waits: a status question from now on sees it running, never "not begun".
    this.db.setVipImport(job, owner, 'running');
    return this.serial(owner, async () => {
      const prevKey = this.db.key(owner, 'active');
      const adopted: string[] = [];
      let keyChanged = false;
      try {
        if (b.key) {
          const pk = this.secrets.openImport(this.executorId, owner, b.key.envelope as ImportEnvelope);
          try {
            const address = privateKeyToAddress(pk).toLowerCase();
            if (address !== String(b.key.address).toLowerCase()) throw new ApiError(400, 'vip', 'The key does not match.');
            const now = Date.now();
            const expiresAt = typeof b.key.expiresAt === 'number' ? b.key.expiresAt : null;
            this.db.putKey({ owner, slot: 'pending', address, name: String(b.key.name), sealed: this.secrets.seal(this.cfg.network, owner, address, pk), createdAt: now, expiresAt, registered: true, checkedAt: now });
            this.db.promoteKey(owner);
            keyChanged = true;
            this.forgetSigner(owner);
          } finally {
            pk.fill(0);
          }
        }
        if (b.record?.terms) this.db.setTerms(owner, b.record.terms as TermsRecord);
        // Consents are append-only and kept once (their digest): a retry adds nothing twice.
        for (const c of Array.isArray(b.record?.consents) ? (b.record!.consents as ConsentRow[]) : []) if (c.owner === owner) this.db.addConsent(c);
        for (const rec of recs) {
          const here = this.algos.get(rec.id);
          // Handed over from here in an earlier move (up then back, or back then up): it comes home (adopt replaces it).
          const home = here !== null && here !== undefined && here.owner === owner && FINAL_STATUSES.has(here.status) && here.k.handedOver === true;
          if (here && !home) {
            // Taken in by an earlier try of this move and still running here: skipped, not doubled.
            if (here.owner !== owner || FINAL_STATUSES.has(here.status)) throw new ApiError(409, 'vip', `Bot ${rec.id} has ended here already; it cannot be taken in again.`);
            continue;
          }
          await this.algos.adopt(rec, this.cfg.tier === 'vip' ? 'Moved to the VIP servers: it goes on from here with the same book.' : 'Moved back to the standard servers: it goes on from here with the same book.');
          adopted.push(rec.id);
        }
      } catch (e) {
        for (const id of adopted) await this.algos.handOver(id, 'The move to the VIP servers was rolled back: this bot stays on the standard servers.').catch(() => undefined);
        if (keyChanged) {
          this.forgetSigner(owner);
          if (prevKey) this.db.putKey(prevKey);
          else this.db.deleteKeys(owner);
        }
        const error = e instanceof Error ? e.message : String(e);
        this.db.setVipImport(job, owner, 'failed', { error, rolledBack: adopted.length });
        this.deps.log.warn('vip: take-in failed and was rolled back', { owner, job, error, rolledBack: adopted.length });
        throw e instanceof ApiError ? e : new ApiError(500, 'vip', `The move could not be taken in: ${error}`);
      }
      // Every bot is here: only now do they resume - and never under the brake (they stay paused, and say so).
      const resume = new Set(Array.isArray(b.resume) ? (b.resume as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      const brake = this.brakeText('algos');
      let started = 0;
      let held = 0;
      for (const rec of recs) {
        if (!resume.has(rec.id)) continue;
        if (brake) {
          held++;
          continue;
        }
        try {
          await this.algos.resume(rec.id);
          started++;
        } catch (e) {
          held++;
          this.deps.log.warn('vip: a bot taken in did not resume', { owner, algo: rec.id, error: String(e) });
        }
      }
      this.db.setMoved(owner, null);
      this.db.setVipImport(job, owner, 'done', { started, held, ids: recs.map((r) => r.id) });
      // Moved back: the wallet is told here, where its page now reads.
      if (this.cfg.tier === 'standard') {
        this.db.addNotice({
          id: `vip-back:${job}`, owner, source: 'algo', ref: recs[0]?.id ?? owner, kind: 'vip-back', grade: 'info',
          title: 'Your bots moved back to the standard servers',
          body: `VIP needs $1M of your own volume in 14 days (or a VIP program). ${recs.length} bot${recs.length === 1 ? '' : 's'} moved back with ${recs.length === 1 ? 'its' : 'their'} books and keep running here. You can move to VIP again any time you qualify.`,
          at: Date.now(), paper: false,
        });
      }
      this.deps.log.info('vip: took in', { owner, job, bots: recs.length, started, held });
      return { ok: true as const, session: this.secrets.issueSession(owner, SESSION_TTL_MS), started, held };
    });
  }

  /**
   * How a move's take-in ended, for the standard side after a send it could not confirm: 'done' (with a fresh read
   * token for the wallet), 'failed', 'running', or 'abandoned'. `abandon`: a job not begun here is marked abandoned,
   * so its import - should it still arrive - is refused (vipImport), and the answer is final.
   */
  vipImportStatus(body: unknown): { ok: true; state: string; session?: { token: string; expiresAt: number } } {
    if (!this.takesMoves()) throw new ApiError(404, 'path', 'not found');
    const b = (body && typeof body === 'object' ? body : {}) as { owner?: unknown; job?: unknown; abandon?: unknown };
    const owner = typeof b.owner === 'string' && /^0x[0-9a-f]{40}$/.test(b.owner) ? b.owner : null;
    const job = typeof b.job === 'string' && /^[0-9a-f]{16}$/.test(b.job) ? b.job : null;
    if (!owner || !job) throw new ApiError(400, 'vip', 'Name the wallet and the move.');
    const kept = this.db.vipImport(job);
    if (!kept) {
      if (b.abandon === true) {
        this.db.setVipImport(job, owner, 'abandoned');
        return { ok: true, state: 'abandoned' };
      }
      return { ok: true, state: 'unknown' };
    }
    if (kept.owner !== owner) throw new ApiError(404, 'vip', 'No such move.');
    if (kept.state === 'done') return { ok: true, state: 'done', session: this.secrets.issueSession(owner, SESSION_TTL_MS) };
    return { ok: true, state: kept.state };
  }

  /* ------------------------------------------------------------- keys ----- */

  private keyInfo(owner: string): KeyInfo | null {
    // The active key while it is good (a renewal under way, or one left half done, never reads as "no key"), else the
    // pending one being set up, else the active one as it is (expired or refused).
    const active = this.db.key(owner, 'active');
    const k = (active && this.trustedKey(active) ? active : null) ?? this.db.key(owner, 'pending') ?? active;
    return k ? { address: k.address, name: k.name, expiresAt: k.expiresAt, registered: k.registered, createdAt: k.createdAt } : null;
  }

  /**
   * A key the follower made on SoDEX themselves (sodex.com, API keys), brought
   * here instead of registering one this executor made. Its private key arrives
   * encrypted to this executor (secrets.ts, KEY IMPORT). It is used only when
   * SoDEX lists it on the follower's own account under the name given, for at
   * most keyTtlDaysMax days; then it becomes the active key, as a registered
   * key of ours does, and the one before it is forgotten.
   */
  async importKey(owner: string, body: { name?: unknown; envelope?: unknown }, ctx: RequestContext): Promise<KeyInfo> {
    return this.serial(owner, async () => {
      this.needTerms(owner, ctx);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(name)) throw new ApiError(400, 'name', 'Enter the key\'s name exactly as SoDEX shows it.');
      const e = body.envelope as Partial<ImportEnvelope> | null;
      if (!e || typeof e.epk !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string' || e.ct.length > 512 || e.epk.length > 256) throw new ApiError(400, 'envelope', 'The key did not arrive in the expected form. Reload the page and try again.');
      let pk: Uint8Array;
      try {
        pk = this.secrets.openImport(this.executorId, owner, e as ImportEnvelope);
      } catch {
        throw new ApiError(400, 'envelope', 'The key could not be read. Reload the page and paste it again.');
      }
      try {
        let address: string;
        try {
          address = privateKeyToAddress(pk).toLowerCase();
        } catch {
          throw new ApiError(400, 'key', 'That is not a SoDEX API private key.');
        }
        const r = await this.keyRead(owner, name, address);
        if (!r.ok) throw new ApiError(412, 'not-registered', r.expiresAt ? 'That key has expired on SoDEX. Make a new one.' : 'SoDEX does not list this key on your account under that name. Check the name and that you made it with this wallet.');
        const latest = Date.now() + this.cfg.keyTtlDaysMax * 86_400_000 + KEY_TTL_SLACK_MS;
        if (!r.expiresAt || r.expiresAt > latest) throw new ApiError(412, 'key-ttl', `That key is valid for longer than ${this.cfg.keyTtlDaysMax} days. Make one that expires within ${this.cfg.keyTtlDaysMax} days.`);
        const sealed = this.secrets.seal(this.cfg.network, owner, address, pk);
        const now = Date.now();
        this.db.putKey({ owner, slot: 'pending', address, name, sealed, createdAt: now, expiresAt: r.expiresAt, registered: true, checkedAt: now });
        this.db.promoteKey(owner);
        this.forgetSigner(owner);
        for (const s of this.runtime.list(owner)) void this.runtime.checkReady(s);
        this.deps.log.info('copy key imported', { owner, key: address });
        return this.keyInfo(owner)!;
      } finally {
        pk.fill(0);
      }
    });
  }

  /**
   * A new key for the follower to register on SoDEX. The lifetime is the longest allowed unless the wallet asks for
   * less (owner 2026-11-09: keys hold as long as allowed). A renewal never interrupts running bots or copies: SoDEX
   * replaces a key registered under the same name, so while the active key is still good the new one takes the other
   * of two names (keyNameFor) - the old key keeps trading until the new one is registered and promoted.
   */
  createKey(req: unknown, ctx: RequestContext): { address: string; name: string; maxDays: number; days: number } {
    const { owner, payload } = this.accept(req, 'create-key', ctx);
    this.needTerms(owner, ctx);
    const p = payload as Partial<CreateKeyPayload>;
    const days = p.days === undefined || p.days === null ? this.cfg.keyTtlDaysMax : Math.floor(Number(p.days));
    if (!Number.isFinite(days) || days < 1 || days > this.cfg.keyTtlDaysMax) throw new ApiError(400, 'days', `A key may live 1 to ${this.cfg.keyTtlDaysMax} days.`);
    const name = this.keyNameFor(owner);
    const { address, sealed } = this.secrets.newKey(this.cfg.network, owner);
    this.db.putKey({ owner, slot: 'pending', address, name, sealed, createdAt: Date.now(), expiresAt: null, registered: false, checkedAt: null });
    this.deps.log.info('copy key created', { owner, key: address, name });
    return { address, name, maxDays: this.cfg.keyTtlDaysMax, days };
  }

  /** The name a new key registers under: the other one than the active key's while that key is still good. */
  keyNameFor(owner: string): string {
    const active = this.db.key(owner, 'active');
    if (!active || !this.trustedKey(active)) return this.keyName;
    return active.name === this.keyName ? `${this.keyName}-b` : this.keyName;
  }

  /**
   * Ask SoDEX whether the follower registered the key; a registered pending key becomes the active one.
   * `confirm`: a refusal follows when no key is registered (a live copy or algo starting), so a key SoDEX
   * does not list is read KEY_READS times first; the site's polling (POST /keys/verify) reads once a
   * call and a miss there changes nothing. An active key once seen registered is kept until it expires
   * (trustedKey): no read takes it away.
   */
  async verifyKey(owner: string, o: { confirm?: boolean } = {}): Promise<KeyInfo | null> {
    const pending = this.db.key(owner, 'pending');
    const usable = this.trustedKey(this.db.key(owner, 'active'));
    if (pending) {
      const r = await this.keyRead(owner, pending.name, pending.address, o.confirm && !usable ? KEY_READS : 1);
      const latest = Date.now() + this.cfg.keyTtlDaysMax * 86_400_000 + KEY_TTL_SLACK_MS;
      if (r.ok && (!r.expiresAt || r.expiresAt > latest)) {
        // The terms promise a key lives at most keyTtlDaysMax days: one registered for longer is not used.
        this.deps.log.warn('copy key refused: registered for longer than allowed', { owner, key: pending.address, expiresAt: r.expiresAt });
      } else if (r.ok) {
        this.db.markKey(owner, 'pending', true, r.expiresAt, Date.now());
        this.db.promoteKey(owner);
        this.forgetSigner(owner);
        for (const s of this.runtime.list(owner)) void this.runtime.checkReady(s);
      }
    }
    const active = this.db.key(owner, 'active');
    if (active && (!pending || this.db.key(owner, 'pending')) && !this.trustedKey(active)) {
      const r = await this.keyRead(owner, active.name, active.address, o.confirm ? KEY_READS : 1);
      // A miss on one read (the site's polling) changes nothing; one every read agrees on marks it unregistered.
      if (r.ok || o.confirm) this.db.markKey(owner, 'active', r.ok, r.ok ? r.expiresAt : (r.expiresAt ?? active.expiresAt), Date.now());
    }
    return this.keyInfo(owner);
  }

  /**
   * A key once seen registered on SoDEX (its address, under its name, with its expiry) is trusted
   * until that expiry, unless SoDEX refused a signed action with it since (KEY_REFUSED_AT). SoDEX's
   * key list is read from backends that disagree (one served a list 17 minutes old, 2026-10-29), so a
   * read that misses a trusted key is a stale backend, not a revocation: a revoked key shows itself
   * when SoDEX refuses what it signs (guard.ts), and is read again then.
   */
  private trustedKey(k: KeyRow | null, now = Date.now()): boolean {
    return !!k && k.registered && k.checkedAt !== KEY_REFUSED_AT && (!k.expiresAt || k.expiresAt > now);
  }

  /**
   * SoDEX's answer for one key, read up to `reads` times (KEY_READ_GAP_MS apart) while it does not
   * list it: the first read that lists it wins; it is missing only when every read agrees.
   */
  private async keyRead(owner: string, name: string, address: string, reads = KEY_READS): Promise<{ ok: boolean; expiresAt: number | null }> {
    let r = await this.sodex.keyRegistered(owner, name, address);
    for (let i = 1; i < reads && !r.ok; i++) {
      await sleep(this.deps.readGapMs ?? KEY_READ_GAP_MS);
      r = await this.sodex.keyRegistered(owner, name, address);
      if (r.ok) this.deps.log.warn('executor: SoDEX listed a key on a later read (an earlier read was stale)', { owner, key: address, read: i + 1 });
    }
    return r;
  }

  /**
   * Stop every copy and algo and forget the keys. The follower revokes the key on SoDEX with their wallet.
   * Everything is pulled while the key is still here to sign the cancels: the algos' resting orders, the
   * exits of running and ended algos, children left resting (the kill switch). Once the key is gone
   * nothing here could cancel them - not even the other exit when one fills.
   */
  async deleteKey(req: unknown, ctx: RequestContext): Promise<MeResponse> {
    const { owner, payload } = this.accept(req, 'delete-key', ctx);
    return this.serial(owner, async () => {
      await this.algos.cancelAll(owner);
      await this.runtime.stopAll(owner, { close: payload.close === true });
      this.db.deleteKeys(owner);
      this.forgetSigner(owner);
      return this.me(owner, ctx);
    });
  }

  private async keyProblem(owner: string): Promise<string | null> {
    const k = this.db.key(owner, 'active');
    if (!k) return 'No copy key is registered for this executor. Approve one in copy setup.';
    const now = Date.now();
    if (k.expiresAt && k.expiresAt <= now) {
      // SoDEX's own expiry, known since it was listed: no read needed, and the opened key is not kept.
      this.forgetSigner(owner);
      return 'The copy key expired. Approve a new one in copy setup.';
    }
    // Seen registered and not refused by SoDEX since: no read takes it away (trustedKey).
    if (this.trustedKey(k, now)) return null;
    const r = await this.keyRead(owner, k.name, k.address);
    this.db.markKey(owner, 'active', r.ok, r.ok ? r.expiresAt : (r.expiresAt ?? k.expiresAt), now);
    if (!r.ok) {
      this.forgetSigner(owner);
      return r.expiresAt && r.expiresAt <= now ? 'The copy key expired. Approve a new one in copy setup.' : 'The copy key is no longer registered on SoDEX (revoked or replaced). Approve a new one in copy setup.';
    }
    return null;
  }

  private signer(owner: string): SigningKeyRef | null {
    const now = Date.now();
    const hit = this.signers.get(owner);
    if (hit) {
      hit.usedAt = now;
      return hit.ref;
    }
    const k: KeyRow | null = this.db.key(owner, 'active');
    if (!k || !k.registered) return null;
    try {
      const ref = this.secrets.open(this.cfg.network, owner, k.address, k.sealed, { name: k.name, expiresAt: k.expiresAt });
      this.signers.set(owner, { ref, usedAt: now });
      return ref;
    } catch (e) {
      // The error is the decipher's ("Unsupported state or unable to authenticate data"): no key material in it.
      this.deps.log.error('copy key could not be opened', { owner, error: String(e) });
      this.deps.alerts?.raise('key-decrypt', `owner:${owner}`, `The sealed key of wallet ${shortWallet(owner)} did not open (${String(e).slice(0, 120)}). Its copies and algos cannot trade. A wrong or rotated kek? (docs/deploy/SECRETS.md)`);
      return null;
    }
  }

  /**
   * Forget an opened key and wipe its bytes (zeroed): at once when the executor
   * stops, else a few seconds later - an order being signed with it right now
   * (it was handed out a moment ago) still signs with the real key.
   */
  private forgetSigner(owner: string, now = false): void {
    const hit = this.signers.get(owner);
    this.signers.delete(owner);
    if (!hit) return;
    if (now) hit.ref.privateKey.fill(0);
    else setTimeout(() => hit.ref.privateKey.fill(0), 5_000).unref?.();
  }

  /**
   * A1: a notice ~24 h and ~1 h before the trading key that the wallet's real bots use expires (the engine pulls
   * their quotes shortly before it; after it nothing of theirs can be cancelled here). Once per key and step: the
   * notice id names the key's address and expiry, and the db keeps a notice once.
   */
  warnKeyExpiry(now = Date.now()): void {
    // Wallets whose key real bots or live copies use (a copy stops copying when its key expires too).
    const owners = new Map<string, { source: 'algo' | 'copy'; ref: string }>();
    for (const a of this.algos.list()) if (a.spec?.bot === true && !a.spec.paper && !FINAL_STATUSES.has(a.status) && !owners.has(a.owner)) owners.set(a.owner, { source: 'algo', ref: a.id });
    for (const c of this.runtime.list()) if (c.status !== 'stopped' && !c.settings.paper && !owners.has(c.owner)) owners.set(c.owner, { source: 'copy', ref: c.id });
    for (const [owner, a] of owners) {
      const k = this.db.key(owner, 'active');
      if (!k?.expiresAt || k.expiresAt <= now) continue;
      const left = k.expiresAt - now;
      // The nearest step only: a key found with 40 minutes left gets the 1 h notice, not both.
      const step = [...KEY_WARN].reverse().find((w) => left <= w.ms);
      if (!step) continue;
      const id = `key-expiry:${step.tag}:${owner}:${k.address}:${k.expiresAt}`;
      if (this.keyWarned.has(id)) continue;
      remember(this.keyWarned, id, true, 5_000);
      const when = new Date(k.expiresAt).toISOString().replace('T', ' ').slice(0, 16);
      this.db.addNotice({
        id, owner, source: a.source, ref: a.ref, kind: 'key-expiry', grade: step.tag === '1h' ? 'error' : 'warn',
        title: `Your trading key expires ${step.words}`,
        body: `The key your real ${a.source === 'algo' ? 'bots trade' : 'copies trade'} with expires at ${when} UTC. Renew it now: they keep running on the old key until the new one is registered.`,
        at: now, paper: false,
      });
    }
  }
  private readonly keyWarned = new Map<string, true>();

  /**
   * The operator's alerts for what is ours to fix (owner 2026-11-09), never the user's: every 30 s each running real
   * bot's Watchdog (runtime botHealth) is read, and a check on our side - its loop, SoDEX's or the oracle's price, the
   * order updates, how late fills are booked, refusals nothing handles - that is bad on two sweeps in a row (30 s+)
   * raises a 🚨 FAILURE with the bot, the check and its figure; a 'recovered' follows when it is good again. The user's
   * own matters (the key, margin, a hold they chose, a pause) never alert. The alerts' own dedupe holds repeats.
   */
  watchBotHealth(now = Date.now()): void {
    // SoDEX in maintenance: its book, orders and fills are still because SoDEX is - not our side. The clocks start again.
    if (this.venue.active) {
      for (const v of this.healthBad.values()) if (!v.said) v.at = now;
      return;
    }
    const OURS = new Set(['loop', 'book', 'oracle', 'orders', 'fills', 'refusals']);
    const seen = new Set<string>();
    for (const a of this.algos.list()) {
      if (a.spec?.bot !== true || a.spec.paper || FINAL_STATUSES.has(a.status) || a.status === 'paused') continue;
      const h = this.algos.view(a.id)?.bot?.health;
      if (!h) continue;
      for (const c of h.checks) {
        if (!OURS.has(c.id)) continue;
        const key = `${a.id}|${c.id}`;
        const bad = c.state === 'bad' || (c.id === 'refusals' && c.state === 'warn');
        if (bad) {
          seen.add(key);
          const since = this.healthBad.get(key);
          if (since === undefined) this.healthBad.set(key, { at: now, said: false });
          else if (!since.said && now - since.at >= 25_000) {
            since.said = true;
            this.deps.alerts?.raise('bot-health', `bot:${a.id}:${c.id}`, `${a.spec.symbol} bot ${a.id} of ${shortWallet(a.owner)}: ${c.label} - ${c.value} (for ${Math.round((now - since.at) / 1000)} s).`);
          }
        }
      }
    }
    for (const [key, v] of this.healthBad) {
      if (seen.has(key)) continue;
      this.healthBad.delete(key);
      if (v.said) {
        const [id, check] = key.split('|');
        this.deps.alerts?.raise('bot-health-ok', `bot:${id}:${check}`, `Bot ${id}: ${check} is healthy again.`);
      }
    }
  }
  private readonly healthBad = new Map<string, { at: number; said: boolean }>();

  /**
   * The wallet's own SoDEX maker fee in bp (GET /perps/accounts/{a}/fee-rate, weight 2), for the engine's booked
   * fees: the last answer (sync), read again in the background after MAKER_FEE_TTL_MS. null until the first answer.
   */
  private readonly makerFees = new Map<string, { bp: number | null; at: number }>();
  private makerFeeFor(owner: string): number | null {
    const o = owner.toLowerCase();
    const hit = this.makerFees.get(o);
    if (!hit || Date.now() - hit.at >= MAKER_FEE_TTL_MS) {
      // Marked as read now, so one read goes out per wallet and TTL, however often the engine asks.
      remember(this.makerFees, o, { bp: hit?.bp ?? null, at: Date.now() });
      void this.sodex
        .get<{ makerFeeRate?: unknown } | null>(`/api/v1/perps/accounts/${o}/fee-rate`, 2, 1)
        .then((r) => {
          const rate = Number(r?.makerFeeRate);
          if (r?.makerFeeRate !== undefined && r?.makerFeeRate !== null && Number.isFinite(rate)) remember(this.makerFees, o, { bp: rate * 10_000, at: Date.now() });
        })
        .catch(() => undefined);
    }
    return hit?.bp ?? null;
  }

  /** Keys idle for SIGNER_IDLE_MS are wiped; a key in use was handed out moments ago and is never one of them. */
  private sweepSigners(now = Date.now()): void {
    for (const [owner, h] of this.signers) if (now - h.usedAt >= SIGNER_IDLE_MS) this.forgetSigner(owner);
  }

  /** The guard held a copy or an algo: its status says so now, and it is checked again when the hold ends. */
  private onHeld(t: GuardTarget, reason: string, until: number, wallet: boolean): void {
    this.deps.log.warn('executor: held after SoDEX refusals', { kind: t.kind, id: t.id, owner: t.owner, until, reason });
    this.db.audit('hold', t.owner, t.id, { kind: t.kind, wallet, until, reason });
    // A wallet-wide hold (the key) holds every copy of the wallet; a copy's own hold only that copy.
    // (A held algo needs nothing here: it asks `problem` before each step.)
    const recheck = () => {
      for (const s of this.runtime.list(t.owner)) if (wallet || (t.kind === 'copy' && s.id === t.id)) void this.runtime.checkReady(s);
    };
    recheck();
    const timer = setTimeout(recheck, Math.max(1_000, until - Date.now() + 1_000));
    timer.unref?.();
  }

  private sinkFor(s: Subscription): OrderSink | null {
    if (s.settings.paper) return this.paper;
    if (!this.db.key(s.owner, 'active')) return null;
    const sink = auditedOrderSink(new KeySink(this.sodex, () => this.signer(s.owner), this.nonces, SODEX_CHAIN_ID[this.cfg.network]), this.db, s.owner, s.id);
    return guardedOrderSink(sink, this.guard, { kind: 'copy', id: s.id, owner: s.owner });
  }

  /* ----------------------------------------------------------- copies ----- */

  /**
   * A follower or leader on the sanctions list (copy-engine sanctions.ts, a list in the repository:
   * nothing is fetched) is refused on every request that lets a wallet trade or be copied; what
   * already runs is held through policyFor. Stopping, pausing, cancelling and deleting the key stay open.
   */
  private screen(...addresses: Array<string | null | undefined>): void {
    const hit = sanctionedOf(addresses);
    if (hit !== null) throw new ApiError(451, 'sanctioned', hit === 0 ? SANCTIONED_WALLET_REASON : SANCTIONED_LEADER_REASON);
  }

  private needTerms(owner: string, ctx: RequestContext): void {
    this.screen(owner);
    const t = this.db.terms(owner);
    if (!t || t.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(412, 'terms', 'Accept the copy trading terms first.');
    const policy = regionPolicy(t.country, ctx.viewerCountry);
    if (!policy.allowed) throw new ApiError(451, 'region', policy.reason ?? 'Copy trading is not available in your region.');
  }

  async subscribe(req: unknown, ctx: RequestContext): Promise<CopyView> {
    const accepted = this.accept(req, 'subscribe', ctx);
    // A copy keeps its key here: none starts while the wallet's bots move to the VIP servers.
    if (this.vipMoving(accepted.owner)) throw new ApiError(409, 'vip-moving', 'Your bots are moving to the VIP servers right now. Wait for the move to finish, then try again.');
    return this.serial(accepted.owner, () => this.subscribeAccepted(accepted, ctx));
  }

  /**
   * A3: a live copy's allocation (new, or raised by a signed update) counts the wallet's running real bots' margin
   * too - together they set aside no more than the account holds. A wallet with no real bot running is not checked
   * here (copies alone keep their own rules).
   */
  private async copyMargin(owner: string, copy: { id: string | null; usd: number }): Promise<void> {
    const r = await this.reservedOf(owner, { copy });
    if (!r.nBots) return;
    const acct = await this.accountOf(owner);
    if (r.bots + r.copies > acct.equity + 1e-6) {
      const free = Math.max(0, acct.equity - (r.bots + r.copies - copy.usd));
      throw new ApiError(409, 'margin', `This copy sets aside ${usd(copy.usd)}, but only ${usd(free)} of your ${usd(acct.equity)} futures balance is free: your ${r.nBots} running ${r.nBots === 1 ? 'bot holds' : 'bots hold'} ${usd(r.bots)} as margin. Lower the allocation, or stop a bot.`, this.marginDetail(copy.usd, { bots: r.bots, copies: r.copies - copy.usd }, acct.equity));
    }
  }

  private async subscribeAccepted({ owner, payload, consent }: ReturnType<ExecutorService['accept']>, ctx: RequestContext): Promise<CopyView> {
    if (this.cfg.kind === 'hosted' && !this.cfg.open) throw new ApiError(503, 'closed', 'The ValueDesk executor takes no new copies right now. Running copies continue.');
    this.needTerms(owner, ctx);
    if (payload.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, 'terms-version', `ValueDesk's copy terms are now version ${COPY_TERMS_VERSION}. Accept them in the setup, then start again.`);
    let settings;
    try {
      settings = parseSettings(payload.settings);
    } catch (e) {
      throw new ApiError(400, 'settings', e instanceof SettingsError ? e.message : String(e));
    }
    this.screen(owner, settings.leader.address);
    const running = this.runtime.list(owner).filter((s) => s.status !== 'stopped');
    if (running.length >= this.cfg.maxCopiesPerOwner) throw new ApiError(429, 'limit', `At most ${this.cfg.maxCopiesPerOwner} copies run at once. Stop one first.`);
    if (running.some((s) => s.settings.leader.address === settings.leader.address && s.settings.leader.venue === settings.leader.venue && s.settings.paper === settings.paper)) {
      throw new ApiError(409, 'duplicate', 'You already copy this trader here. Change that copy instead.');
    }
    let accountId = 0;
    if (!settings.paper) {
      this.needNoBrake('copies');
      await this.verifyKey(owner, { confirm: true });
      const k = this.db.key(owner, 'active');
      if (!k || !k.registered) throw new ApiError(412, 'key', 'Register the copy key on SoDEX first (copy setup, "Approve agent").');
      accountId = await this.sodex.accountId(owner);
      if (!accountId) throw new ApiError(412, 'account', 'This wallet has no SoDEX account yet. Deposit first.');
      await this.copyMargin(owner, { id: null, usd: Math.max(0, Number(settings.allocationUsd) || 0) });
    }
    const t = this.db.terms(owner)!;
    const now = Date.now();
    const sub: Subscription = {
      id: randomId('c'),
      owner,
      accountId,
      mode: this.cfg.kind,
      settings,
      status: 'active',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      country: t.country,
      observedCountry: normaliseCountry(ctx.viewerCountry),
      termsVersion: COPY_TERMS_VERSION,
      consent,
    };
    await this.runtime.add(sub);
    this.deps.log.info('copy started', { owner, copy: sub.id, leader: settings.leader.address, venue: settings.leader.venue, paper: settings.paper });
    return this.runtime.view(sub.id)!;
  }

  async act(req: unknown, ctx: RequestContext): Promise<{ copies: CopyView[] }> {
    const accepted = this.accept(req, ['update', 'pause', 'resume', 'stop', 'stop-all'], ctx);
    return this.serial(accepted.owner, () => this.actAccepted(accepted, (req as SignedCopyRequest).action, ctx));
  }

  private async actAccepted({ owner, payload, consent }: ReturnType<ExecutorService['accept']>, action: CopyAction, ctx: RequestContext): Promise<{ copies: CopyView[] }> {
    const mine = (id: unknown): Subscription => {
      const s = typeof id === 'string' ? this.runtime.get(id) : null;
      if (!s || s.owner !== owner) throw new ApiError(404, 'copy', 'No such copy.');
      return s;
    };
    const fail = (e: unknown): never => {
      throw e instanceof ApiError ? e : new ApiError(409, 'state', e instanceof Error ? e.message : String(e));
    };
    let touched: Subscription[] = [];
    if (action === 'stop-all') {
      touched = await this.runtime.stopAll(owner, { close: payload.close === true }).catch(fail);
    } else {
      const s = mine(payload.id);
      if (action === 'update') {
        this.needTerms(owner, ctx);
        let settings;
        try {
          settings = parseSettings(payload.settings);
        } catch (e) {
          throw new ApiError(400, 'settings', e instanceof SettingsError ? e.message : String(e));
        }
        this.screen(owner, settings.leader.address);
        // A bigger live allocation counts the wallet's running real bots too (A3).
        if (!settings.paper && s.status !== 'stopped' && Number(settings.allocationUsd) > copyReserveUsd(s) + 1e-9) await this.copyMargin(owner, { id: s.id, usd: Number(settings.allocationUsd) });
        touched = [await this.runtime.update(s.id, { settings, consent }).catch(fail)];
      } else if (action === 'pause') touched = [await this.runtime.pause(s.id).catch(fail)];
      else if (action === 'resume') {
        if (!s.settings.paper) this.needNoBrake('copies');
        this.needTerms(owner, ctx);
        this.screen(owner, s.settings.leader.address);
        touched = [await this.runtime.resume(s.id).catch(fail)];
      } else touched = [await this.runtime.stopCopy(s.id, { close: payload.close === true }).catch(fail)];
    }
    return { copies: touched.map((s) => this.runtime.view(s.id)).filter((v): v is CopyView => v !== null) };
  }

  async activity(owner: string, subId: string, q: { limit?: number; before?: number }): Promise<ActivityEntry[]> {
    const s = this.runtime.get(subId);
    if (!s || s.owner !== owner) throw new ApiError(404, 'copy', 'No such copy.');
    return this.db.activity({ subId, limit: q.limit ?? 200, before: q.before });
  }

  /* ------------------------------------------------------------ algos ----- */

  /**
   * Whether real bots may start for this wallet: the live-algo wallets, or what server 1 answers - every wallet once
   * bots are open (VALUEDESK_BOTS_OPEN on server 1, owner 2026-11-13), else a wallet on the beta list - from
   * beta.valuedesk.so or the main site alike (owner, 2026-11-06: "if a wallet is whitelisted it can access it on
   * the normal domain"). `owner` is the wallet that signed the request, so the list is asked about the signer.
   */
  private async liveBotFor(owner: string, _ctx: RequestContext): Promise<boolean> {
    if (liveAlgosFor(this.cfg, owner)) return true;
    return this.betaListed(owner);
  }

  /**
   * The beta list, asked of the API server (EXECUTOR_BETA_URL) and kept a minute. Every answer is also kept in the
   * db (A2, 2026-11-08): a read that fails answers the last known one, however old - so a server-1 outage does not
   * hold every real bot. null: never answered (and unreadable now).
   */
  private betaCache = new Map<string, { at: number; listed: boolean }>();
  private async betaAnswer(owner: string): Promise<boolean | null> {
    const o = owner.toLowerCase();
    const hit = this.betaCache.get(o);
    if (hit && Date.now() - hit.at < BETA_TTL_MS) return hit.listed;
    if (!this.cfg.betaUrl) return null;
    try {
      const u = new URL(this.cfg.betaUrl);
      u.searchParams.set('address', o);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.cfg.builderToken) headers['X-Internal-Token'] = this.cfg.builderToken;
      if (this.cfg.originSecrets[0]) headers['X-Origin-Verify'] = this.cfg.originSecrets[0];
      const res = await this.deps.fetch(u.toString(), { headers, signal: AbortSignal.timeout(5_000) });
      const body = JSON.parse(await res.text()) as { ok?: boolean; listed?: unknown; bots?: unknown };
      if (!res.ok || !body.ok || typeof body.listed !== 'boolean') throw new Error(`HTTP ${res.status}`);
      // `bots` (server 1, routes/builder.ts): real bots may start - every wallet once VALUEDESK_BOTS_OPEN=1, else the
      // listed. An older server sends only `listed`.
      const listed = typeof body.bots === 'boolean' ? body.bots : body.listed;
      const now = Date.now();
      remember(this.betaCache, o, { at: now, listed });
      const kept = this.db.betaAnswer(o);
      // Written when it changes, else every 10 minutes (the time the last answer was confirmed).
      if (!kept || kept.listed !== listed || now - kept.at >= 10 * 60_000) this.db.setBetaAnswer(o, listed, now);
      return listed;
    } catch (e) {
      this.deps.log.warn('bots: the beta list could not be read; the last known answer stands', { owner: o, error: String(e) });
      const last = hit ?? this.db.betaAnswer(o);
      return last ? last.listed : null;
    }
  }

  /** For a new real bot: listed now, or last known listed when the list does not answer (never answered: refused). */
  private async betaListed(owner: string): Promise<boolean> {
    return (await this.betaAnswer(owner)) === true;
  }

  /** The builder fee on an algo's orders, tenths of a bp: a bot's from the bot ladder (botFeeFor), every other algo's the copy ladder's. */
  private async algoFee(a: AlgoRecord): Promise<number> {
    if (a.spec?.bot === true) return this.botFee(a.owner, await this.freshVolume(a.owner));
    return this.copyFee(a.owner, await this.freshVolume(a.owner));
  }

  /** The sink of an algo: the key this wallet registered for this executor, its fee (algoFee) as the builder. */
  private algoSink(a: AlgoRecord): AlgoSink | null {
    if (!this.db.key(a.owner, 'active')) return null;
    const builderOf = async (x: AlgoRecord): Promise<BuilderParams | null> =>
      this.cfg.builderId > 0 ? { id: this.cfg.builderId, fee: await this.algoFee(x) } : null;
    const sink = auditedAlgoSink(
      new KeyAlgoSink(this.sodex, () => this.signer(a.owner), this.nonces, SODEX_CHAIN_ID[this.cfg.network], builderOf),
      this.db,
      builderOf,
    );
    return guardedAlgoSink(sink, this.guard, this.sodex.budget);
  }

  /**
   * Why a live algo cannot trade now (it waits, and goes on by itself once
   * this clears): the key and the builder approval, as for a copy. The region
   * rules (blocked countries, the EEA 2x ceiling on leverage and exposure) are
   * applied by the runtime through `policyFor`.
   */
  private async algoProblem(a: AlgoRecord): Promise<string | null> {
    const key = await this.keyProblem(a.owner);
    if (key) return key;
    // A real bot runs while its wallet may run one: taken off the beta list, it is held (its quotes pulled) until it is back.
    // Only an explicit "not listed" holds it: a list that does not answer keeps the last known answer (A2).
    if (a.spec?.bot === true && !a.spec.paper && !liveAlgosFor(this.cfg, a.owner) && (await this.betaAnswer(a.owner)) === false) return 'Held: real bots are for beta testers only, and this wallet is no longer on the beta list.';
    if (this.cfg.builderId > 0) {
      const fee = await this.algoFee(a);
      const approved = await this.sodex.builderApproval(a.owner, this.cfg.builderId);
      if (approved === null || approved < fee) return `Your SoDEX account does not approve the ValueDesk fee (${fee / 10} bp) these orders carry. Approve it in copy setup.`;
    }
    return null;
  }

  /**
   * The region rules for a running algo: the country it started under, and the
   * one the wallet declares now (terms signed again later) - the stricter wins,
   * so a wallet that declares a blocked country has its live algos held at once.
   */
  private algoPolicy(a: AlgoRecord): RegionPolicy {
    return screenPolicy(this.policyNow(a.owner, a.country ?? null, a.observedCountry ?? null), a.owner);
  }

  /**
   * The region rule for a running copy or algo: the stricter of the country it
   * started with and the one in the wallet's current terms, so re-declaring a
   * blocked (or EEA) country holds it at once.
   */
  private policyNow(owner: string, country: string | null, observed: string | null): RegionPolicy {
    const atStart = regionPolicy(country, observed);
    const t = this.db.terms(owner);
    if (!t) return atStart;
    const now = regionPolicy(t.country, observed);
    if (!atStart.allowed) return atStart;
    if (!now.allowed) return now;
    if (now.maxLeverage !== null && (atStart.maxLeverage === null || now.maxLeverage < atStart.maxLeverage)) return now;
    return atStart;
  }

  /* ------------------------------------------------- bot margin and markets ----- */

  /** SoDEX's market list, kept 10 minutes (a real bot's start and its margin need each market's minimum order). */
  private marketCache: { at: number; rows: MarketInfo[] } | null = null;

  /**
   * The smallest order SoDEX takes on each market, in USD at the mark now (minChildQty: a step, the minimum quantity,
   * the minimum value): a bot's quote is raised to it, so its margin counts it (botMarginUsd's minOrderUsd). A market
   * not read is left out (the margin then counts the bot's own sizes).
   */
  /**
   * A bot's order is at least SoDEX's minimum order on its market (owner 2026-11-08: such a bot cannot be configured;
   * the engine no longer gets to raise every quote behind the user's back). Unreadable minimums let it through (the
   * engine still raises a quote to the minimum, and the cap and margin count that real size).
   */
  private async needOrderOverMinimum(symbol: string, orderUsd: number): Promise<void> {
    const min = (await this.minOrderUsd([symbol])).get(symbol);
    if (min !== undefined && orderUsd < min - 0.005) {
      throw new ApiError(400, 'size', `The order size ($${orderUsd.toFixed(2)}) is under SoDEX's minimum order on ${symbol} (about $${(Math.ceil(min * 100) / 100).toFixed(2)}). Raise it to at least that.`, { symbol, minUsd: min });
    }
  }

  private async minOrderUsd(symbols: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!symbols.length) return out;
    try {
      if (!this.marketCache || Date.now() - this.marketCache.at > 10 * 60_000) this.marketCache = { at: Date.now(), rows: await this.sodex.markets() };
      const marks = await this.sodex.markPrices();
      for (const sym of new Set(symbols)) {
        const m = this.marketCache.rows.find((r) => r.name === sym);
        const px = marks.find((r) => r.symbol === sym)?.price;
        if (m && px && px > 0) out.set(sym, minChildQty(m, px) * px);
      }
    } catch (e) {
      this.deps.log.warn('bots: market minimums could not be read; margin counts the bots\' own sizes', { error: String(e) });
    }
    return out;
  }

  /** The region's leverage ceiling for a wallet starting something now (EEA 2x), or undefined. */
  private ceilingFor(owner: string, ctx: RequestContext): number | undefined {
    const t = this.db.terms(owner);
    return this.policyNow(owner, t?.country ?? null, normaliseCountry(ctx.viewerCountry)).maxLeverage ?? undefined;
  }

  /** The wallet's futures account: equity and positions. Unreadable: a 503 (a real bot's margin is never guessed). */
  private async accountOf(owner: string): Promise<{ equity: number; positions: Record<string, { size: number }> }> {
    try {
      const f = await this.sodex.follower(owner);
      if (!Number.isFinite(f.equity)) throw new Error('no equity');
      return { equity: f.equity, positions: f.positions };
    } catch {
      throw new ApiError(503, 'margin-unknown', 'Your SoDEX balance could not be read just now, so the margin this needs cannot be checked. Try again in a moment.');
    }
  }

  /**
   * What the wallet already sets aside (owner 2026-11-08, smart margining): its running real bots' margin (each at
   * its leverage, its market's minimum order and its region ceiling) and its live copies' allocations. `skipAlgo`:
   * the bot being changed or replaced; `copy`: a copy's allocation as it would be (id null: a new one).
   */
  private async reservedOf(owner: string, o: { skipAlgo?: string; copy?: { id: string | null; usd: number } } = {}): Promise<{ bots: number; nBots: number; copies: number }> {
    const running = this.algos.list(owner).filter((x) => x.spec?.bot === true && !x.spec.paper && !FINAL_STATUSES.has(x.status) && x.id !== o.skipAlgo);
    const mins = await this.minOrderUsd(running.map((x) => x.spec.symbol));
    // Bots: no region ceiling, only the market's maximum (owner 2026-11-08).
    const bots = running.reduce((t, x) => t + marginOf(x.spec, mins.get(x.spec.symbol)), 0);
    let copies = 0;
    for (const c of this.runtime.list(owner)) copies += o.copy && c.id === o.copy.id ? o.copy.usd : copyReserveUsd(c);
    if (o.copy && o.copy.id === null) copies += o.copy.usd;
    return { bots, nBots: running.length, copies };
  }

  /** The figures of a margin refusal, for the page (ApiError.detail). */
  private marginDetail(need: number, r: { bots: number; copies: number }, equity: number): Record<string, unknown> {
    const reserved = r.bots + r.copies;
    return { needUsd: need, reservedUsd: reserved, botsUsd: r.bots, copiesUsd: r.copies, equityUsd: equity, freeUsd: Math.max(0, equity - reserved) };
  }

  /**
   * A3: a real bot does not share its market with anything else of the wallet's - its inventory, cap and close come
   * from its own fills, so another copy, algo or position on that market would be traded as if it were the bot's.
   * `old`: the bot a restart replaces (what it holds is the new one's to take over or close).
   */
  private marketConflict(owner: string, spec: AlgoSpec, live: AlgoRecord[], positions: Record<string, { size: number }> | null, old: AlgoRecord | null): void {
    const sym = spec.symbol;
    const coin = coinOf('sodex', sym);
    const algo = live.find((x) => x.spec?.bot !== true && !x.spec.paper && algoSymbols(x.spec).includes(sym));
    if (algo) throw new ApiError(409, 'market-algo', `Your ${ALGO_NAMES[algo.spec.kind] ?? 'algo'} order on ${sym} is still running. Let it finish or cancel it, then start the bot.`, { algoId: algo.id, symbol: sym });
    for (const c of this.runtime.list(owner)) {
      if (c.status === 'stopped' || c.settings.paper) continue;
      const v = this.runtime.view(c.id);
      const holds = !!v?.positions.some((p) => p.symbol === sym && p.size !== 0);
      const leaderHolds = Object.entries(v?.leader.positions ?? {}).some(([ls, size]) => size !== 0 && sodexNamesFor(c.settings.leader.venue, ls).includes(sym));
      const named = c.settings.assetAllow.includes(coin) && !c.settings.assetDeny.includes(coin);
      if (holds || leaderHolds || named) {
        const who = `${c.settings.leader.address.slice(0, 6)}…${c.settings.leader.address.slice(-4)}`;
        throw new ApiError(409, 'market-copy', `Your copy of ${who} trades ${sym}. Stop that copy, or start the bot on another market: both would trade the same position.`, { copyId: c.id, symbol: sym });
      }
    }
    const pos = positions?.[sym];
    if (pos && pos.size !== 0 && !(old && old.spec.symbol === sym)) {
      throw new ApiError(409, 'market-position', `You hold a ${sym} position (${pos.size}) that this bot did not open. Close it first, or pick another market: a bot only manages what it opened itself.`, { symbol: sym, size: pos.size });
    }
  }

  /** Real bots running on this executor, every wallet together (A7). */
  private liveBotCount(skip?: string): number {
    return this.algos.list().filter((x) => x.spec?.bot === true && !x.spec.paper && !FINAL_STATUSES.has(x.status) && x.id !== skip).length;
  }

  /** A wallet whose bots moved to the VIP executor starts none here; one whose move runs starts nothing until it ends. */
  private needNotMoved(owner: string): void {
    if (this.vipMoving(owner)) throw new ApiError(409, 'vip-moving', 'Your bots are moving to the VIP servers right now. Wait for the move to finish, then try again. Stopping a bot still works.');
    const away = this.movedAway(owner);
    if (away === 'vip') throw new ApiError(409, 'moved', 'Your bots run on the VIP servers now. Start and manage them there.');
    if (away === 'standard') throw new ApiError(409, 'moved', 'Your bots moved back to the standard servers (VIP ended). Start and manage them there.');
  }

  /** Start an algo order for the wallet that signed it. */
  async algoStart(req: unknown, ctx: RequestContext): Promise<AlgoView> {
    const accepted = this.accept(req, 'algo-start', ctx);
    // Refused at once while a VIP move runs (not queued behind it to start afterwards).
    if (this.vipMoving(accepted.owner)) this.needNotMoved(accepted.owner);
    return this.serial(accepted.owner, () => this.algoStartAccepted(accepted, ctx));
  }

  private async algoStartAccepted({ owner, payload, consent }: ReturnType<ExecutorService['accept']>, ctx: RequestContext): Promise<AlgoView> {
    if (this.cfg.kind === 'hosted' && !this.cfg.open) throw new ApiError(503, 'closed', 'The ValueDesk executor takes no new orders right now. Running ones continue.');
    this.needTerms(owner, ctx);
    let spec;
    try {
      spec = parseAlgoSpec(payload.spec);
    } catch (e) {
      throw new ApiError(400, 'spec', e instanceof AlgoSpecError ? e.message : String(e));
    }
    const seed = Number(payload.seed);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new ApiError(400, 'seed', 'seed must be a 32-bit whole number.');
    if (spec.bot) this.needNotMoved(owner);
    if (spec.kind === 'mm' || spec.kind === 'grid') await this.needOrderOverMinimum(spec.symbol, spec.orderUsd);
    // A hedge pair (owner 2026-11-14): its two legs are two wallets' own bots, each signed by its own wallet, each naming
    // the other - the runtime pairs only legs that name each other, so no wallet can attach itself to another's hedge.
    if (spec.kind === 'hedge') {
      if (spec.shape === 'pair' && spec.partner === owner) throw new ApiError(400, 'partner', 'The second leg must be another wallet: one account cannot hold both sides of a market.');
      // Real two-wallet pairs wait for the owner's terms decision (the bot terms forbid trading with accounts you
      // control): practice only, but for the live test's own wallets. A hedge against spot is one wallet: real is fine.
      const tester = Array.isArray(this.cfg.liveAlgoWallets) && this.cfg.liveAlgoWallets.includes(owner.toLowerCase());
      if (spec.shape === 'pair' && !spec.paper && !this.cfg.hedgePairsLive && !tester) {
        throw new ApiError(403, 'hedge-pair', 'Two-wallet hedges run as practice for now. A hedge against spot runs with real orders.');
      }
      await this.needOrderOverMinimum(spec.symbol, Math.min(spec.sliceUsd, spec.sizeUsd));
    }
    // A restart (feature 'bot-restart'): the bot it replaces is this wallet's own bot; a take-over keeps its market and mode.
    const r = payload.restart as { from?: unknown; how?: unknown } | undefined;
    let old: AlgoRecord | null = null;
    let how: 'clean' | 'takeover' | null = null;
    if (r !== undefined && r !== null) {
      if (typeof r !== 'object' || typeof r.from !== 'string' || (r.how !== 'clean' && r.how !== 'takeover')) throw new ApiError(400, 'restart', "restart must be { from: a bot's id, how: 'clean' or 'takeover' }.");
      old = this.algos.get(r.from) ?? null;
      how = r.how;
      if (!old || old.owner !== owner || !old.spec.bot) throw new ApiError(404, 'algo', 'No such bot to restart.');
      if (!spec.bot) throw new ApiError(400, 'restart', 'A bot restarts as a bot.');
      if (how === 'takeover' && (old.spec.symbol !== spec.symbol || old.spec.paper !== spec.paper)) throw new ApiError(400, 'restart', 'Taking over keeps the market and practice or real orders. Use the normal restart to change them.');
      if (FINAL_STATUSES.has(old.status) && how === 'takeover') throw new ApiError(409, 'restart', 'That bot has ended: start a new one instead.');
    }
    const live = this.algos.list(owner).filter((a) => !FINAL_STATUSES.has(a.status) && a.id !== old?.id);
    // A basket runs as itself and one algo per market (its legs, which count as they will run); a conditional's algo takes its place when it fires.
    const adds = 1 + (spec.kind === 'basket' ? spec.legs.length : 0);
    if (live.length + adds > this.cfg.maxAlgosPerOwner) {
      if (spec.bot) throw new ApiError(429, 'limit', `You already run ${live.length} bots and orders here; ${this.cfg.maxAlgosPerOwner} is the most at once. Stop one first.`);
      throw new ApiError(429, 'limit', adds > 1 ? `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here, and this basket runs ${adds} (itself and one per market). ${live.length ? 'Cancel one first, or use fewer markets.' : 'Use fewer markets.'}` : `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here. Cancel one first.`);
    }
    // Practice bots are off (owner 2026-11-15): no new one starts unless EXECUTOR_PRACTICE_BOTS=1. Practice bots that
    // already run keep running until they are stopped.
    if (spec.bot && spec.paper && !this.cfg.practiceBots) throw new ApiError(403, 'practice-off', 'Practice bots are off. Start it with real orders instead.');
    // One live bot per wallet and market: two would quote against each other's orders and share one position.
    if ((spec.kind === 'mm' || spec.kind === 'grid' || spec.kind === 'hedge') && !spec.paper) {
      const other = live.find((x) => (x.spec.kind === 'mm' || x.spec.kind === 'grid' || x.spec.kind === 'hedge') && !x.spec.paper && x.spec.symbol === spec.symbol);
      if (other) throw new ApiError(409, 'bot-market', `A bot of yours already trades ${spec.symbol}${other.spec.label ? ` ("${other.spec.label}")` : ''}. Stop it first, or choose another market.`, { algoId: other.id, symbol: spec.symbol });
    }
    // A real bot is always followed on SoDEX's live socket (owner 2026-11-09: "our bots always need to be connected via
    // ws. Always."): a new wallet beyond the sockets' places (10 per address, EXECUTOR_WS_ADDRESSES) is refused here, and
    // the operator is told, rather than run on REST reads.
    if (spec.bot && !spec.paper) {
      const botWallets = new Set(this.algos.list().filter((x) => x.spec?.bot === true && !x.spec.paper && !FINAL_STATUSES.has(x.status)).map((x) => x.owner));
      if (!botWallets.has(owner) && botWallets.size + 1 > this.algos.accountCapacity()) {
        this.deps.alerts?.raise('bot-health', 'slots', `A real bot of ${shortWallet(owner)} was refused: all ${this.algos.accountCapacity()} live socket places are taken by bot wallets. Add an address to EXECUTOR_WS_ADDRESSES.`);
        throw new ApiError(503, 'bot-capacity', 'Every live connection for real bots on this server is in use right now. Try again in a little while.');
      }
    }
    // Real BOTS: the wallets real algos are on for (the test follower), else a wallet on the beta list (either site).
    if (spec.bot && !spec.paper && !(await this.liveBotFor(owner, ctx))) {
      throw new ApiError(403, 'beta', 'Real bots are for beta testers for now: ask on Discord to join.');
    }
    // A7: this executor's hard cap on real bots (every wallet together): past it they would starve each other's fills.
    if (spec.bot && !spec.paper && this.liveBotCount(old?.id) >= this.cfg.maxLiveBots) {
      throw new ApiError(429, 'bot-capacity', `This server already runs as many real bots as it can take (${this.cfg.maxLiveBots}). Try again later.`);
    }
    // Real orders are off unless this executor is set to take them from every wallet (EXECUTOR_LIVE_ALGOS=1)
    // or from this one (EXECUTOR_LIVE_ALGOS_WALLETS) - for the algo itself and for one a conditional would start.
    if (!spec.bot && !liveAlgosFor(this.cfg, owner) && specsOf(spec, payload.spec).some((x) => !x.paper)) throw new ApiError(403, 'paper-only', 'Real algo orders are off for now. Turn on Practice run to try one against the live market.');
    let accountId = 0;
    if (!spec.paper) {
      this.needNoBrake('algos');
      await this.verifyKey(owner, { confirm: true });
      const k = this.db.key(owner, 'active');
      if (!k || !k.registered) {
        if (spec.bot) throw new ApiError(412, 'key', 'Set up real orders: approve the trading key first.');
        throw new ApiError(412, 'key', 'Register this executor\'s key on SoDEX first (copy setup, "Approve agent").');
      }
      accountId = await this.sodex.accountId(owner);
      if (!accountId) throw new ApiError(412, 'account', spec.bot ? 'Deposit to SoDEX first: this wallet has no SoDEX account yet.' : 'This wallet has no SoDEX account yet. Deposit first.');
      if (spec.bot) {
        // A3: nothing else of the wallet's on this market (an algo or a copy: no read needed; a position: read now).
        this.marketConflict(owner, spec, live, null, old);
        const acct = await this.accountOf(owner);
        this.marketConflict(owner, spec, live, acct.positions, old);
        // Smart margining (owner 2026-11-08): the wallet's real bots (their margin at their leverage, the market's
        // minimum order and the region ceiling) and its live copies (their allocation) set aside no more than it holds.
        const r = await this.reservedOf(owner, { skipAlgo: old?.id });
        const need = marginOf(spec, (await this.minOrderUsd([spec.symbol])).get(spec.symbol));
        if (r.bots + r.copies + need > acct.equity + 1e-6) {
          const free = Math.max(0, acct.equity - r.bots - r.copies);
          const held = [...(r.nBots ? [`${r.nBots} running ${r.nBots === 1 ? 'bot' : 'bots'} ${usd(r.bots)}`] : []), ...(r.copies > 0 ? [`copy trading ${usd(r.copies)}`] : [])];
          throw new ApiError(409, 'margin', `This bot needs ${usd(need)} of margin, but only ${usd(free)} of your ${usd(acct.equity)} futures balance is free${held.length ? ` (${held.join(', ')} already set aside)` : ''}. Lower its order size, levels or max holding, or stop another bot or copy.`, this.marginDetail(need, r, acct.equity));
        }
      }
    }
    // The old bot stops first, the way the restart says: closing what it holds (clean), or keeping it for the new one.
    if (old && !FINAL_STATUSES.has(old.status)) {
      const stopAs = how === 'clean' ? 'close' : 'keep';
      try {
        // The choice rides on the stop (no update first): an old bot already closing keeps closing on a clean restart
        // and the new one waits for it (audit 2026-11-09: it was ended with its position left).
        await this.algos.cancel(old.id, stopAs === 'keep' ? { keep: true } : { close: true });
      } catch (e) {
        throw new ApiError(409, 'restart', `The old bot could not be stopped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The checks it passed, for its activity (owner 2026-11-08: a status channel per bot; no server details there).
    const checks: string[] = [];
    if (spec.kind === 'hedge') {
      checks.push(`${spec.symbol} is trading on SoDEX, and each step is at least its minimum order.`);
      if (spec.shape === 'pair') checks.push(`It pairs only with a ${spec.role === 'main' ? 'second' : 'main'} leg that ${shortWallet(spec.partner ?? '')} signed and that names this wallet.`);
      if (!spec.paper) {
        checks.push('Your trading key is approved and your SoDEX account was found.');
        checks.push(`Nothing else of yours trades ${spec.symbol} (no other bot, position, copy or algo order).`);
      }
    }
    if (spec.kind === 'mm' || spec.kind === 'grid') {
      checks.push(`${spec.symbol} is trading on SoDEX, and the order size is at least its minimum order.`);
      if (!spec.paper) {
        checks.push('Your trading key is approved and your SoDEX account was found.');
        checks.push('Beta access and a place on the servers.');
        checks.push(`Nothing else of yours trades ${spec.symbol} (no other bot, position, copy or algo order).`);
        checks.push('Your free margin covers what it sets aside.');
      }
    }
    let a: AlgoRecord;
    try {
      const t = this.db.terms(owner);
      a = await this.algos.add({
        checks,
        owner, accountId, mode: this.cfg.kind, spec, consent, seed, country: t?.country ?? null, observedCountry: normaliseCountry(ctx.viewerCountry),
        ...(old && how === 'takeover' ? { takeOver: old.id } : old && !FINAL_STATUSES.has(old.status) ? { after: old.id } : {}),
      });
    } catch (e) {
      throw new ApiError(400, 'algo', e instanceof Error ? e.message : String(e));
    }
    this.deps.log.info('algo started', { owner, algo: a.id, kind: spec.kind, symbol: spec.symbol, paper: spec.paper });
    return this.algos.view(a.id)!;
  }

  /** Pause, resume or cancel one of the wallet's algos, or cancel all of them (the kill switch). */
  async algoAct(req: unknown, ctx: RequestContext): Promise<{ algos: AlgoView[] }> {
    const accepted = this.accept(req, 'algo-action', ctx);
    // A resume or a change while a VIP move runs is refused at once; a stop, a pause or a cancel always goes through.
    if ((accepted.payload.op === 'resume' || accepted.payload.op === 'update') && this.vipMoving(accepted.owner)) this.needNotMoved(accepted.owner);
    return this.serial(accepted.owner, () => this.algoActAccepted(accepted, ctx));
  }

  /**
   * A3: a signed change that makes a real bot need more margin (a bigger order size, max holding or more levels; a
   * lower leverage) passes the same check as its start: the wallet's other bots and copies plus its new need fit in
   * what the account holds. A change that needs no more is never refused for margin.
   */
  private async updateMargin(owner: string, a: AlgoRecord, patch: AlgoUpdatePatch, ctx: RequestContext): Promise<void> {
    if (a.spec?.bot !== true || a.spec.paper || FINAL_STATUSES.has(a.status)) return;
    const next = { ...a.spec, ...patch } as AlgoSpec;
    const min = (await this.minOrderUsd([a.spec.symbol])).get(a.spec.symbol);
    const before = marginOf(a.spec, min);
    const need = marginOf(next, min);
    if (!(need > before + 1e-9)) return;
    const acct = await this.accountOf(owner);
    const r = await this.reservedOf(owner, { skipAlgo: a.id });
    if (r.bots + r.copies + need > acct.equity + 1e-6) {
      const free = Math.max(0, acct.equity - r.bots - r.copies);
      throw new ApiError(409, 'margin', `This change needs ${usd(need)} of margin for the bot (now ${usd(before)}), but only ${usd(free)} of your ${usd(acct.equity)} futures balance is free for it. Keep a smaller order size, fewer levels or a lower max holding, or stop another bot or copy.`, this.marginDetail(need, r, acct.equity));
    }
  }

  private async algoActAccepted({ owner, payload }: ReturnType<ExecutorService['accept']>, ctx: RequestContext): Promise<{ algos: AlgoView[] }> {
    const op = payload.op;
    const fail = (e: unknown): never => {
      throw e instanceof ApiError ? e : new ApiError(409, 'state', e instanceof Error ? e.message : String(e));
    };
    let touched: AlgoRecord[];
    if (op === 'cancel-all') touched = await this.algos.cancelAll(owner).catch(fail);
    else {
      const a = typeof payload.id === 'string' ? this.algos.get(payload.id) : null;
      if (!a || a.owner !== owner) throw new ApiError(404, 'algo', 'No such algo order.');
      if (op === 'pause') touched = [await this.algos.pause(a.id).catch(fail)];
      else if (op === 'resume') {
        if (a.spec?.bot === true) this.needNotMoved(owner);
        if (!a.spec.paper) this.needNoBrake('algos');
        this.needTerms(owner, ctx);
        touched = [await this.algos.resume(a.id).catch(fail)];
      } else if (op === 'cancel') touched = [await this.algos.cancel(a.id, { now: payload.now === true, keep: payload.how === 'keep', close: payload.how === 'close' || payload.how === 'instant' }).catch(fail)];
      else if (op === 'archive') touched = [await this.algos.archive(a.id).catch(fail)];
      else if (op === 'close-rest') {
        // It trades (a top-up, then the close): the brake and the terms as for a resume.
        if (!a.spec.paper) this.needNoBrake('algos');
        this.needTerms(owner, ctx);
        touched = [await this.algos.closeRest(a.id).catch(fail)];
      }
      else if (op === 'update') {
        // A bigger size is more trading: the terms in force are needed, as for a resume.
        if (!a.spec.paper) this.needNoBrake('algos');
        this.needTerms(owner, ctx);
        const patch = algoPatch(payload.patch);
        await this.updateMargin(owner, a, patch, ctx);
        touched = [await this.algos.update(a.id, patch).catch(fail)];
      } else throw new ApiError(400, 'op', 'op must be pause, resume, cancel, cancel-all, update or archive.');
    }
    return { algos: touched.map((a) => this.algos.view(a.id)).filter((v): v is AlgoView => v !== null) };
  }

  /** What the wallet should hear of: its copies' and algos' notices, newest first (db.ts notices). */
  notices(owner: string, q: { limit?: number; before?: number; grades?: readonly string[] }): EngineNotice[] {
    return this.db.notices(owner, q);
  }

  /**
   * GET /bots/latency: the signed-write latency of this wallet's own SoDEX accounts (those its bots trade in), never
   * another wallet's or the executor's whole flow. A wallet whose bots only practise has no account here: empty.
   */
  botLatency(owner: string, hours: number, botId?: string | null): BotLatencyResponse {
    if (botId) {
      // One bot: its account's writes on its market (one live bot per account and market). A practice bot sends none.
      const a = this.algos.get(botId);
      if (!a || a.owner !== owner) throw new ApiError(404, 'algo', 'No such bot.');
      const sid = this.algos.marketId(a.spec.symbol);
      return this.latency.view(hours, a.accountId > 0 && sid ? [a.accountId] : [], sid ?? undefined);
    }
    const ids = [...new Set(this.algos.list(owner).map((a) => a.accountId).filter((x) => x > 0))];
    return this.latency.view(hours, ids);
  }

  /** One of the wallet's algos (the bot page's live read, every second while it is open). */
  algoOne(owner: string, id: string): AlgoView {
    const a = this.algos.get(id);
    if (!a || a.owner !== owner) throw new ApiError(404, 'algo', 'No such algo order.');
    return this.algos.view(id)!;
  }

  algoList(owner: string): AlgoView[] {
    return this.algos
      .list(owner)
      // Removed from the list by the wallet (archive): kept on record, not shown.
      .filter((a) => !a.k.archived)
      .map((a) => this.algos.view(a.id))
      .filter((v): v is AlgoView => v !== null);
  }

  async algoEvents(owner: string, id: string, q: { limit?: number; before?: number; after?: number }): Promise<AlgoEvent[]> {
    const a = this.algos.get(id);
    if (!a || a.owner !== owner) throw new ApiError(404, 'algo', 'No such algo order.');
    // A bot's log is read a page at a time (owner 2026-11-08: no bulk copy of how a bot works): at most 50 lines.
    const most = a.spec?.bot === true ? 50 : 1000;
    return this.algos.events(id, { limit: Math.min(most, q.limit ?? 200), before: q.before, after: q.after });
  }

  /** Every signed instruction of this wallet (newest first): the follower's own record. */
  consents(owner: string): Array<{ action: string; payload: string; at: number; digest: string }> {
    return this.db.consents(owner).map((c) => ({ action: c.action, payload: c.payload, at: c.at, digest: c.digest }));
  }

  /* ------------------------------------------------------------ volume ----- */

  /**
   * The follower's verified 14-day volume as known now (null: not known), for a
   * caller that cannot wait: the last answer, and a fresh read is started when
   * it is older than VOLUME_TTL_MS. Everything that sets a fee awaits freshVolume.
   */
  private volumeOf(owner: string): number | null {
    if (!this.cfg.builderId) return null;
    if (this.cfg.builderUrl) {
      const hit = this.volumes.get(owner);
      if (!hit || Date.now() - hit.at >= VOLUME_TTL_MS) void this.freshVolume(owner);
      return hit?.usd ?? null;
    }
    return this.volumeFromDb(owner);
  }

  /** The follower's volume, read again when the last answer is older than VOLUME_TTL_MS. */
  private async freshVolume(owner: string): Promise<number | null> {
    if (!this.cfg.builderId) return null;
    if (!this.cfg.builderUrl) return this.volumeFromDb(owner);
    const hit = this.volumes.get(owner);
    if (hit && Date.now() - hit.at < VOLUME_TTL_MS) return hit.usd;
    const pending = this.volumeReads.get(owner);
    if (pending) return pending;
    const read = this.volumeFromApi(owner).finally(() => this.volumeReads.delete(owner));
    this.volumeReads.set(owner, read);
    return read;
  }

  /**
   * The volume from the API server's ledger (GET /api/vs/builder/volume, the
   * internal token and the edge's origin secret). A failed read keeps the last
   * answer for another VOLUME_TTL_MS rather than dropping the follower to the
   * first (dearest) step.
   */
  private async volumeFromApi(owner: string): Promise<number | null> {
    const last = this.volumes.get(owner);
    try {
      const u = new URL(this.cfg.builderUrl!);
      u.searchParams.set('address', owner);
      u.searchParams.set('builder', String(this.cfg.builderId));
      u.searchParams.set('days', String(COPY_FEE_WINDOW_DAYS));
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.cfg.builderToken) headers['X-Internal-Token'] = this.cfg.builderToken;
      if (this.cfg.originSecrets[0]) headers['X-Origin-Verify'] = this.cfg.originSecrets[0];
      const res = await this.deps.fetch(u.toString(), { headers, signal: AbortSignal.timeout(5_000) });
      let body: { ok?: boolean; usd?: unknown; vip?: unknown; fees?: { copy?: unknown; bots?: unknown } } | null = null;
      try {
        body = JSON.parse(await res.text()) as { ok?: boolean; usd?: unknown; vip?: unknown; fees?: { copy?: unknown; bots?: unknown } };
      } catch {
        body = null;
      }
      if (!res.ok || !body?.ok || typeof body.usd !== 'number' || !Number.isFinite(body.usd)) throw new Error(`HTTP ${res.status}`);
      this.rememberVolume(owner, body.usd);
      const perk = (x: unknown): Perk | null => {
        const o = x as { fee?: unknown; until?: unknown; budget?: unknown } | null | undefined;
        if (!o || typeof o.fee !== 'number' || !Number.isFinite(o.fee)) return null;
        const out: Perk = { fee: o.fee, until: typeof o.until === 'number' ? o.until : null };
        if (o.budget !== undefined) {
          const b = readBudget(o.budget);
          // A budget that cannot be read: no perk (never a lowered fee without its limit).
          if (!b) return null;
          out.budget = b;
        }
        return out;
      };
      remember(this.perks, owner, { vip: body.vip === true, copy: perk(body.fees?.copy), bots: perk(body.fees?.bots), at: Date.now() });
      return body.usd;
    } catch (e) {
      this.deps.log.warn('copy fee: the builder volume could not be read', { owner, error: String(e) });
      this.rememberVolume(owner, last?.usd ?? null);
      return last?.usd ?? null;
    }
  }

  /** The follower's verified 14-day volume, USD, from the builder ledger on this server (null: not known). */
  private volumeFromDb(owner: string): number | null {
    if (!this.cfg.builderDb || !this.cfg.builderId) return null;
    const hit = this.volumes.get(owner);
    if (hit && Date.now() - hit.at < VOLUME_TTL_MS) return hit.usd;
    let usd: number | null = null;
    try {
      if (!this.builderDb) {
        if (!existsSync(this.cfg.builderDb)) return null;
        this.builderDb = new (sqlite().DatabaseSync)(this.cfg.builderDb, { readOnly: true });
        this.builderDb.exec('PRAGMA busy_timeout = 2000');
      }
      const fromDay = Math.floor(Date.now() / 86_400_000) - (COPY_FEE_WINDOW_DAYS - 1);
      const r = this.builderDb.prepare('SELECT sum(micro) AS m FROM days WHERE builder = ? AND address = ? AND day >= ?').get(this.cfg.builderId, owner, fromDay) as { m?: number | null } | undefined;
      usd = r && typeof r.m === 'number' ? r.m / 1e6 : 0;
    } catch (e) {
      this.deps.log.warn('copy fee: the builder ledger could not be read', { error: String(e) });
      // Opened anew at the next read: a handle on a file since replaced would fail, or read the old one, for ever.
      try { this.builderDb?.close(); } catch { /* closed */ }
      this.builderDb = null;
    }
    this.rememberVolume(owner, usd);
    return usd;
  }

  /** Bounded: anyone can sign in with a fresh wallet, so the map of volumes must not grow without end. */
  private rememberVolume(owner: string, usd: number | null): void {
    this.volumes.delete(owner);
    if (this.volumes.size >= VOLUMES_MAX) {
      const oldest = this.volumes.keys().next().value;
      if (oldest !== undefined) this.volumes.delete(oldest);
    }
    this.volumes.set(owner, { usd, at: Date.now() });
  }
}
