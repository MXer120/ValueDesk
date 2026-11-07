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
import { sqlite, type ExecutorDb, type KeyRow } from './db.ts';
import { auditedAlgoSink, auditedOrderSink } from './audited.ts';
import { Brake, type BrakeState } from './brake.ts';
import { KEY_IMPORT_ALG, importInfo, type ImportEnvelope, type Secrets } from './secrets.ts';
import { ErrorGuard, guardedAlgoSink, guardedOrderSink, type GuardTarget } from './guard.ts';
import { shortWallet, type Alerts } from './alerts.ts';
import { plainSockets } from './feed/binance.ts';
import { BinanceReference } from './feed/reference.ts';
import { DEFAULT_FEED_PATH } from './feed/ring.ts';

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
  for (const k of ['orderUsd', 'maxInventoryUsd', 'offsetTicks', 'chaseTicks', 'minRepriceMs', 'skewTicks', 'edgeBps', 'queueGuard', 'levels', 'moveGuard', 'refBps', 'pullBps'] as const) {
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
  return out;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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

const SESSION_TTL_MS = 12 * 60 * 60_000;
/** How long a follower's volume (the copy fee step) is used before it is read again. */
const VOLUME_TTL_MS = 10 * 60_000;
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
  readonly sodex: SodexClient;
  private readonly hyperliquid: HyperliquidClient;
  private readonly nonces = createMemoryNonceManager();
  private readonly paper = new PaperSink();
  private readonly signers = new Map<string, { ref: SigningKeyRef; usedAt: number }>();
  private signerSweep: ReturnType<typeof setInterval> | null = null;
  /** What SoDEX refused, and the copies and algos held for it (guard.ts). */
  readonly guard: ErrorGuard;
  private readonly volumes = new Map<string, { usd: number | null; at: number }>();
  private readonly volumeReads = new Map<string, Promise<number | null>>();
  private builderDb: DatabaseSync | null = null;
  /** Self-hosted, not yet paired: the code printed at start. */
  readonly pairingCode: string | null;
  private pairMisses = 0;
  private pairLockedUntil = 0;
  /** The operator's emergency brake (brake.ts): read from cfg.brakeFile. */
  readonly brake: Brake;

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
    this.sodex = new SodexClient({ network: cfg.network, fetch: deps.fetch });
    this.hyperliquid = new HyperliquidClient(deps.fetch);
    this.runtime = new CopyRuntime({
      store: db,
      sodex: this.sodex,
      hyperliquid: this.hyperliquid,
      factory: deps.factory,
      network: cfg.network,
      hlMode: cfg.kind === 'hosted' ? 'firehose' : 'user',
      log: deps.log,
      sinkFor: (s) => this.sinkFor(s),
      builderFor: async (s) => (cfg.builderId > 0 ? { id: cfg.builderId, fee: copyFeeFor(await this.freshVolume(s.owner)) } : null),
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
      // Reads that confirm a change outside the copier (copy-engine confirm.ts), as far apart as the key reads.
      confirmGapMs: deps.readGapMs,
    });
    const oracleFeed = new OracleFeed({ fetch: deps.fetch });
    // The Binance-led maker's reference: the box's shared Binance feed (valuescan-feed), own sockets while it is down. Hosted only.
    this.reference = cfg.kind === 'hosted' ? new BinanceReference({ path: process.env.EXECUTOR_FEED_PATH || DEFAULT_FEED_PATH, factory: plainSockets, log: deps.log }) : null;
    this.algos = new AlgoRuntime({
      store: db,
      sodex: this.sodex,
      network: cfg.network,
      factory: deps.factory,
      log: deps.log,
      sinkFor: (a) => this.algoSink(a),
      builderRate: (a) => (cfg.builderId > 0 ? (a.spec?.bot === true ? BOT_FEE : copyFeeFor(this.volumeOf(a.owner))) / 100_000 : 0),
      problem: async (a) => this.guard.holdOf({ kind: 'algo', id: a.id, owner: a.owner }) ?? this.algoProblem(a),
      brake: () => this.brakeText('algos'),
      // The copy region rules, from the country declared with the terms and the one the request came from.
      policyFor: (a) => this.algoPolicy(a),
      // A sweep's reference price: the shared oracle (oracle.ts) - Binance futures and spot, Bitget,
      // Hyperliquid, OKX and Bybit, each read at most once a second per coin for every algo here.
      oracle: (coin) => oracleFeed.quotes(coin),
      ...(this.reference ? { reference: this.reference } : {}),
      // An algo failed, stopped, held or finished: kept for the follower to read after signing in.
      onNotice: (n) => db.addNotice(n),
      confirmGapMs: deps.readGapMs,
    });
  }

  async start(): Promise<void> {
    this.signerSweep ??= setInterval(() => this.sweepSigners(), 30_000);
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
    if (this.signerSweep) clearInterval(this.signerSweep);
    this.signerSweep = null;
    await this.algos.stop();
    this.reference?.stop();
    await this.runtime.stop();
    // Last: a stop still signs (what a step had on its way, the bots' cancels), and a wiped key signs nothing valid.
    for (const owner of [...this.signers.keys()]) this.forgetSigner(owner, true);
    this.builderDb?.close();
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
      bots: { fee: BOT_FEE },
      features: [...EXECUTOR_FEATURES],
      brake: this.brakeView(),
    };
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

  /** What release.sh and the health check read: ok only while the database answers and the SoDEX feed is up. */
  health(): { ok: boolean; db: boolean; copies: number; active: number; algos: number; feeds: { sodex: boolean }; brake?: BrakeState | null; queue?: QueueStats } {
    let db = true;
    try {
      this.db.ping();
    } catch {
      db = false;
    }
    if (!db) return { ok: false, db, copies: 0, active: 0, algos: 0, feeds: { sodex: false }, brake: this.brake.current(), queue: this.sodex.queue.stats() };
    const all = this.runtime.list();
    const v = all[0] ? this.runtime.view(all[0].id) : null;
    const algos = this.algos.list().filter((a) => !FINAL_STATUSES.has(a.status)).length;
    const sodex = v?.feeds.sodex ?? true;
    // The send queue: how many signed writes wait, the oldest's age, the cooldown left (sodex.ts SendQueue).
    return { ok: sodex, db, copies: all.length, active: all.filter((s) => s.status === 'active').length, algos, feeds: { sodex }, brake: this.brake.current(), queue: this.sodex.queue.stats() };
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
    const v = verifyCopyRequest(req, { executor: siteTerms ? SITE_TERMS_EXECUTOR : termsWide ? COPY_TERMS_EXECUTOR : this.executorId });
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

  acceptTerms(req: unknown, ctx: RequestContext): MeResponse {
    const { owner, payload } = this.accept(req, 'accept-terms', ctx);
    const p = payload as Partial<AcceptTermsPayload>;
    if (p.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, 'terms-version', `These are the copy terms of ${COPY_TERMS_VERSION}; reload the page and accept them again.`);
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
    };
  }

  /* ------------------------------------------------------------- keys ----- */

  private keyInfo(owner: string): KeyInfo | null {
    const k = this.db.key(owner, 'pending') ?? this.db.key(owner, 'active');
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

  /** A new key for the follower to register on SoDEX (the previous one keeps trading until the new one is registered). */
  createKey(req: unknown, ctx: RequestContext): { address: string; name: string; maxDays: number; days: number } {
    const { owner, payload } = this.accept(req, 'create-key', ctx);
    this.needTerms(owner, ctx);
    const p = payload as Partial<CreateKeyPayload>;
    const days = Math.floor(Number(p.days));
    if (!Number.isFinite(days) || days < 1 || days > this.cfg.keyTtlDaysMax) throw new ApiError(400, 'days', `A key may live 1 to ${this.cfg.keyTtlDaysMax} days.`);
    const { address, sealed } = this.secrets.newKey(this.cfg.network, owner);
    this.db.putKey({ owner, slot: 'pending', address, name: this.keyName, sealed, createdAt: Date.now(), expiresAt: null, registered: false, checkedAt: null });
    this.deps.log.info('copy key created', { owner, key: address });
    return { address, name: this.keyName, maxDays: this.cfg.keyTtlDaysMax, days };
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
    return this.serial(accepted.owner, () => this.subscribeAccepted(accepted, ctx));
  }

  private async subscribeAccepted({ owner, payload, consent }: ReturnType<ExecutorService['accept']>, ctx: RequestContext): Promise<CopyView> {
    if (this.cfg.kind === 'hosted' && !this.cfg.open) throw new ApiError(503, 'closed', 'The ValueDesk executor takes no new copies right now. Running copies continue.');
    this.needTerms(owner, ctx);
    if (payload.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, 'terms-version', 'Reload the page: the copy terms changed.');
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
   * Whether real bots may start for this wallet: the live-algo wallets, or a wallet on the beta list - from
   * beta.valuedesk.so or the main site alike (owner, 2026-11-06: "if a wallet is whitelisted it can access it on
   * the normal domain"). `owner` is the wallet that signed the request, so the list is asked about the signer.
   */
  private async liveBotFor(owner: string, _ctx: RequestContext): Promise<boolean> {
    if (liveAlgosFor(this.cfg, owner)) return true;
    return this.betaListed(owner);
  }

  /** The beta list, asked of the API server (EXECUTOR_BETA_URL) and kept a minute; unreadable: not listed (fails closed). */
  private betaCache = new Map<string, { at: number; listed: boolean }>();
  private async betaListed(owner: string): Promise<boolean> {
    const o = owner.toLowerCase();
    const hit = this.betaCache.get(o);
    if (hit && Date.now() - hit.at < 60_000) return hit.listed;
    if (!this.cfg.betaUrl) return false;
    let listed = false;
    try {
      const u = new URL(this.cfg.betaUrl);
      u.searchParams.set('address', o);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.cfg.builderToken) headers['X-Internal-Token'] = this.cfg.builderToken;
      if (this.cfg.originSecrets[0]) headers['X-Origin-Verify'] = this.cfg.originSecrets[0];
      const res = await this.deps.fetch(u.toString(), { headers, signal: AbortSignal.timeout(5_000) });
      const body = JSON.parse(await res.text()) as { ok?: boolean; listed?: unknown };
      if (!res.ok || !body.ok) throw new Error(`HTTP ${res.status}`);
      listed = body.listed === true;
    } catch (e) {
      this.deps.log.warn('bots: the beta list could not be read', { owner: o, error: String(e) });
      // A read that failed keeps the last answer for a while (no flapping hold on a blip), else not listed.
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.listed;
    }
    this.betaCache.set(o, { at: Date.now(), listed });
    return listed;
  }

  /** The builder fee on an algo's orders, tenths of a bp: a bot's is BOT_FEE, every other algo's the copy ladder's. */
  private async algoFee(a: AlgoRecord): Promise<number> {
    return a.spec?.bot === true ? BOT_FEE : copyFeeFor(await this.freshVolume(a.owner));
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
    if (a.spec?.bot === true && !a.spec.paper && !liveAlgosFor(this.cfg, a.owner) && !(await this.betaListed(a.owner))) return 'Held: real bots are for beta testers only, and this wallet is not on the beta list.';
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

  /** Start an algo order for the wallet that signed it. */
  async algoStart(req: unknown, ctx: RequestContext): Promise<AlgoView> {
    const accepted = this.accept(req, 'algo-start', ctx);
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
    const live = this.algos.list(owner).filter((a) => !FINAL_STATUSES.has(a.status));
    // A basket runs as itself and one algo per market (its legs, which count as they will run); a conditional's algo takes its place when it fires.
    const adds = 1 + (spec.kind === 'basket' ? spec.legs.length : 0);
    if (live.length + adds > this.cfg.maxAlgosPerOwner) {
      throw new ApiError(429, 'limit', adds > 1 ? `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here, and this basket runs ${adds} (itself and one per market). ${live.length ? 'Cancel one first, or use fewer markets.' : 'Use fewer markets.'}` : `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here. Cancel one first.`);
    }
    // One live bot per wallet and market: two would quote against each other's orders and share one position.
    if ((spec.kind === 'mm' || spec.kind === 'grid') && !spec.paper) {
      const other = live.find((x) => (x.spec.kind === 'mm' || x.spec.kind === 'grid') && !x.spec.paper && x.spec.symbol === spec.symbol);
      if (other) throw new ApiError(409, 'bot-market', `A bot of yours already trades ${spec.symbol}${other.spec.label ? ` ("${other.spec.label}")` : ''}. Stop it first, or choose another market.`);
    }
    // Real BOTS: the wallets real algos are on for (the test follower), else beta.valuedesk.so for a wallet on the beta list.
    if (spec.bot && !spec.paper && !(await this.liveBotFor(owner, ctx))) {
      throw new ApiError(403, 'paper-only', 'Real bots run on beta.valuedesk.so for beta testers only for now. Turn on Practice to run one against the live market.');
    }
    // Real orders are off unless this executor is set to take them from every wallet (EXECUTOR_LIVE_ALGOS=1)
    // or from this one (EXECUTOR_LIVE_ALGOS_WALLETS) - for the algo itself and for one a conditional would start.
    if (!spec.bot && !liveAlgosFor(this.cfg, owner) && specsOf(spec, payload.spec).some((x) => !x.paper)) throw new ApiError(403, 'paper-only', 'Real algo orders are off for now. Turn on Practice run to try one against the live market.');
    let accountId = 0;
    if (!spec.paper) {
      this.needNoBrake('algos');
      await this.verifyKey(owner, { confirm: true });
      const k = this.db.key(owner, 'active');
      if (!k || !k.registered) throw new ApiError(412, 'key', 'Register this executor\'s key on SoDEX first (copy setup, "Approve agent").');
      accountId = await this.sodex.accountId(owner);
      if (!accountId) throw new ApiError(412, 'account', 'This wallet has no SoDEX account yet. Deposit first.');
    }
    let a: AlgoRecord;
    try {
      const t = this.db.terms(owner);
      a = await this.algos.add({ owner, accountId, mode: this.cfg.kind, spec, consent, seed, country: t?.country ?? null, observedCountry: normaliseCountry(ctx.viewerCountry) });
    } catch (e) {
      throw new ApiError(400, 'algo', e instanceof Error ? e.message : String(e));
    }
    this.deps.log.info('algo started', { owner, algo: a.id, kind: spec.kind, symbol: spec.symbol, paper: spec.paper });
    return this.algos.view(a.id)!;
  }

  /** Pause, resume or cancel one of the wallet's algos, or cancel all of them (the kill switch). */
  async algoAct(req: unknown, ctx: RequestContext): Promise<{ algos: AlgoView[] }> {
    const accepted = this.accept(req, 'algo-action', ctx);
    return this.serial(accepted.owner, () => this.algoActAccepted(accepted, ctx));
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
        if (!a.spec.paper) this.needNoBrake('algos');
        this.needTerms(owner, ctx);
        touched = [await this.algos.resume(a.id).catch(fail)];
      } else if (op === 'cancel') touched = [await this.algos.cancel(a.id).catch(fail)];
      else if (op === 'archive') touched = [await this.algos.archive(a.id).catch(fail)];
      else if (op === 'update') {
        // A bigger size is more trading: the terms in force are needed, as for a resume.
        if (!a.spec.paper) this.needNoBrake('algos');
        this.needTerms(owner, ctx);
        touched = [await this.algos.update(a.id, algoPatch(payload.patch)).catch(fail)];
      } else throw new ApiError(400, 'op', 'op must be pause, resume, cancel, cancel-all, update or archive.');
    }
    return { algos: touched.map((a) => this.algos.view(a.id)).filter((v): v is AlgoView => v !== null) };
  }

  /** What the wallet should hear of: its copies' and algos' notices, newest first (db.ts notices). */
  notices(owner: string, q: { limit?: number; before?: number; grades?: readonly string[] }): EngineNotice[] {
    return this.db.notices(owner, q);
  }

  algoList(owner: string): AlgoView[] {
    return this.algos
      .list(owner)
      // Removed from the list by the wallet (archive): kept on record, not shown.
      .filter((a) => !a.k.archived)
      .map((a) => this.algos.view(a.id))
      .filter((v): v is AlgoView => v !== null);
  }

  async algoEvents(owner: string, id: string, q: { limit?: number; before?: number }): Promise<AlgoEvent[]> {
    const a = this.algos.get(id);
    if (!a || a.owner !== owner) throw new ApiError(404, 'algo', 'No such algo order.');
    return this.algos.events(id, { limit: q.limit ?? 200, before: q.before });
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
      let body: { ok?: boolean; usd?: unknown } | null = null;
      try {
        body = JSON.parse(await res.text()) as { ok?: boolean; usd?: unknown };
      } catch {
        body = null;
      }
      if (!res.ok || !body?.ok || typeof body.usd !== 'number' || !Number.isFinite(body.usd)) throw new Error(`HTTP ${res.status}`);
      this.rememberVolume(owner, body.usd);
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
