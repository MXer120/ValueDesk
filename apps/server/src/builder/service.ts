/**
 * Builder fee tiers, put together: the configuration, the signing key, the
 * ledger and the verifier behind `GET /api/vs/builder/terms`
 * (docs/BUILDER-TIERS.md).
 *
 * WHAT A REQUEST CAN DO: ask which fee a wallet is signed, and leave a hint
 * that the wallet may have traded. It cannot report volume, name a fee or
 * change anything about a wallet. A request for a wallet the ledger does not
 * know reads one row that is not there and writes nothing - however many
 * arrive, `builder.db` does not grow.
 *
 * WHAT IS ANSWERED is read from the ledger on every request, never from a
 * copy in memory: the operator's `forget` (tools/builderTiers.ts) removes a
 * wallet while the server runs, and its next request must start from nothing.
 *
 * With no configuration file the feature is off: no database is opened, no
 * timer but the one that looks for the file, and the answer says so.
 */
import { AdminStore, type FeeProduct, type FeeProgram } from '../admin/store.js';
import { VIP_PROGRAM_FEE, botLadderFee, lowered, soonestEnd, type Lowered } from './programs.js';
import { channelFrom } from '../beta/gate.js';
import { NET, NETWORK } from '../config.js';
import { sodex } from '../sodex/rest.js';
import { gatewayWeightLimit, gatewayWeightSpent, gwGet } from '../valuedesk/sodex/gateway.js';
import { cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { TiersSource, defaultFee, type Fee, type LogLike, type TiersConfig } from './config.js';
import { EXPLORER_BASE } from './explorer.js';
import { builderDbPath, termsKeyPath, tiersPath } from './paths.js';
import { BuilderStore, type WalletRow } from './store.js';
import { dayOf } from './counting.js';
import type { PerkBudget } from '../invites/service.js';
import { KeySource, TERMS_TTL_MS, termsMessage } from './terms.js';
import { COPY_LADDER_DAYS, MICRO, NO_FACTS, copyLadderFee, decide, type Decision, type Flag, type NextTier, type WalletFacts } from './tiers.js';
import {
  APPROVALS_PER_MIN_DEFAULT, APPROVALS_PER_MIN_MAX, EXPLORER_PER_MIN_DEFAULT, EXPLORER_PER_MIN_MAX, ExplorerError, VERIFY_PER_MIN_DEFAULT,
  VERIFY_PER_MIN_MAX, Verifier, perMinFrom, type VerifierIo,
} from './verifier.js';

/** The answer of the terms route (docs/BUILDER-TIERS.md §3). Only the first block is signed. */
export type TermsBody =
  | { ok: true; builderId: null }
  | {
      ok: true;
      chain: number;
      builderId: number;
      address: string;
      fee: Fee;
      nonce: string;
      issued: number;
      ttl: number;
      keyId: string | null;
      sig: string | null;
      // For display. Not signed; decides nothing.
      default: Fee;
      /** `days`: the window the volume covers (the file's volumeDays), null for lifetime. */
      volume: { perpsUsd: number; spotUsd: number; totalUsd: number; days: number | null; verifiedAt: number | null; pending: boolean };
      tier: { index: number; next: NextTier | null };
      flags: Flag[];
    };

export interface TermsRequest {
  /** Lower-case wallet address, already checked. */
  address: string;
  /** Already checked against NONCE_RE. */
  nonce: string;
  hint: boolean;
  /** Who asks, as the rate limits see them (hosted.ts clientKey). */
  client: string;
}

export interface BuilderServiceOptions {
  /** A wallet's running fee programs (the dev page's, admin/store.ts); default: the admin store on this server. */
  programs?: (address: string, now: number) => FeeProgram[];
  /** Wallets a VIP program may be running for (vipWallets asks vipProgramOf of each). */
  vipCandidates?: (now: number) => string[];
  tiersPath: string;
  keyPath: string;
  dbPath: string;
  chainId: number;
  io: VerifierIo;
  log: LogLike;
  now?: () => number;
  verifyPerMin?: number;
  approvalsPerMin?: number;
  explorerPerMin?: number;
  lookbackMs?: number;
  /** How often the two files are looked at (ms). */
  refreshMs?: number;
  /** False: read the ledger, never verify (the beta API - the main API's verifier keeps the one ledger). */
  verify?: boolean;
}

/** After the ledger could not be opened it is tried again this much later. */
const REOPEN_MS = 30_000;

const factsOf = (w: WalletRow | null, counted: { perps: number; spot: number }): WalletFacts =>
  w ? { perpsMicro: counted.perps, spotMicro: counted.spot, underpaidAt: w.underpaidAt, tamperedAt: w.tamperedAt, noBuilderAt: w.noBuilderAt } : NO_FACTS;

/**
 * The volume the tiers go by: the last `volumeDays` UTC days (today included) when the file sets them,
 * else lifetime. A ledger that cannot be read counts nothing - the default fee, never a lower one.
 */
function countedOf(cfg: TiersConfig, store: BuilderStore | null, w: WalletRow | null, now: number): { perps: number; spot: number } {
  if (!w) return { perps: 0, spot: 0 };
  if (cfg.volumeDays === null) return { perps: w.perpsMicro, spot: w.spotMicro };
  if (!store) return { perps: 0, spot: 0 };
  try {
    return store.windowMicro(cfg.builderId, w.address, dayOf(now) - (cfg.volumeDays - 1));
  } catch {
    return { perps: 0, spot: 0 };
  }
}

/** VIP (owner 2026-11-08, "No its $1m of 14day volume. ignore the 1% thing"): $1M of the wallet's own counted volume in 14 days. */
export const VIP_DAYS = 14;
/** VIP from $1M of the wallet's own 14-day volume (owner 2026-11-23; $5M from 2026-11-10). */
export const VIP_MIN_USD = 1_000_000;
/** VIP by the wallet's own 14-day volume (only counts while vipByVolume() is on). */
export const isVip = (v: { volumeUsd: number } | null): boolean => !!v && v.volumeUsd >= VIP_MIN_USD;

/**
 * Owner 2026-11-13, bots opening for everyone: "no one gets vip, but the people currently being assigned vip e.g. early
 * access still have/get it". So VIP by volume is OFF unless VALUEDESK_VIP_BY_VOLUME=1; VIP comes only from what is
 * assigned by hand - the beta list's early-access days (admin/store.ts), the dev page's programs, the executor's
 * EXECUTOR_VIP_WALLETS - and VALUEDESK_VIP_KEEP (comma-separated wallets that held VIP by volume when it was turned off).
 */
export function vipByVolume(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VALUEDESK_VIP_BY_VOLUME?.trim() === '1';
}
export function vipKept(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return (env.VALUEDESK_VIP_KEEP ?? '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x));
}

/** Bots with real orders for every wallet (VALUEDESK_BOTS_OPEN=1); off: the beta list only (owner 2026-11-13: live on his word). */
export function botsOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VALUEDESK_BOTS_OPEN?.trim() === '1';
}

export class BuilderService {
  readonly tiers: TiersSource;
  readonly keys: KeySource;
  private readonly now: () => number;
  private runtime: { store: BuilderStore; verifier: Verifier } | null = null;
  private openFailedAt = 0;
  /** The default fee last put on record (store.noteDefault), so a request need not read it. */
  private noted: { builder: number; perps: number; spot: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** Programs from elsewhere on this server (the fee credits and the invite welcome: invites/service.ts). */
  private extra: ((address: string, now: number) => FeeProgram[]) | null = null;

  /** Add a source of programs (the invites' credits and welcome), read with the dev page's on every fee decision. */
  setExtraPrograms(f: ((address: string, now: number) => FeeProgram[]) | null): void {
    this.extra = f;
  }

  private gifts: ((address: string, now: number) => FeeProgram[]) | null = null;

  /**
   * VIP days a wallet was given by joining with a VIP code (invites). Since 2026-11-28 they are VIP standing for their days
   * (owner: "users joining with a vip link actually get vip for 7days"): vipProgramOf sees them unless asked without gifts.
   */
  setGiftPrograms(f: ((address: string, now: number) => FeeProgram[]) | null): void {
    this.gifts = f;
  }

  /**
   * The least volume a wallet's fee is read at (USD; invites/service.ts: a wallet that joined through a referral starts
   * at REFERRED_START_USD). Its site tier and its copy and bot ladder steps use the higher of this and its own volume.
   */
  private floor: ((address: string) => number) | null = null;

  setVolumeFloor(f: ((address: string) => number) | null): void {
    this.floor = f;
  }

  private floorUsd(address: string): number {
    if (!this.floor) return 0;
    try {
      const v = this.floor(address.toLowerCase());
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /** Facts with the volume raised to the wallet's floor (the difference is added to perps; only the total is tiered). */
  private floored(address: string, f: WalletFacts): WalletFacts {
    const min = Math.round(this.floorUsd(address) * MICRO);
    const total = f.perpsMicro + f.spotMicro;
    return total >= min ? f : { ...f, perpsMicro: f.perpsMicro + (min - total) };
  }

  /** The volume a wallet's copy and bot ladder step is read at: its own, or its floor when that is higher (USD). */
  ladderVolumeUsd(builder: number, address: string, days: number): number | null {
    const v = this.volumeUsd(builder, address, days);
    return v === null ? null : Math.max(v, this.floorUsd(address));
  }

  /** What bounds those programs' lowered fee in the executor (invites/service.ts perkBudget). */
  private budget: ((address: string, now: number) => PerkBudget | null) | null = null;

  setPerkBudget(f: ((address: string, now: number) => PerkBudget | null) | null): void {
    this.budget = f;
  }

  /** The executor's budget for a wallet's lowered fee from credits or the welcome (null: none, or no source). */
  perkBudget(address: string, now = this.now()): PerkBudget | null {
    try {
      return this.budget ? this.budget(address.toLowerCase(), now) : null;
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: the credit budget could not be read');
      // No budget known: the lowered fee is not handed to the executor at all (see routes/builder.ts).
      return { kind: 'credits', capUsd: 0, perUsd: { copy: 1, bots: 1 }, through: now };
    }
  }

  constructor(private readonly o: BuilderServiceOptions) {
    this.tiers = new TiersSource(o.tiersPath, o.log);
    this.keys = new KeySource(o.keyPath, o.log);
    this.now = o.now ?? Date.now;
  }

  /** Read both files and open the ledger if the feature is on. Starts nothing: no timer, no request. */
  load(): void {
    this.tiers.loadSync();
    this.keys.loadSync();
    if (this.tiers.current()) this.open();
  }

  /** `load`, then keep looking at the files and let the verifier run by itself. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.load();
    if (this.o.verify !== false) this.runtime?.verifier.start();
    this.timer = setInterval(() => void this.refresh(), this.o.refreshMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runtime?.verifier.stop();
    this.runtime?.store.close();
    this.runtime = null;
  }

  /** Look at the two files again (the timer does this; a test may call it). */
  async refresh(): Promise<void> {
    try {
      await this.tiers.refresh();
      await this.keys.refresh();
      const cfg = this.tiers.current();
      const rt = cfg ? this.open() : null;
      // A changed first tier goes on record when the file is read, not when somebody next asks.
      if (cfg && rt) this.noteDefault(cfg, rt.store, this.now());
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: the files could not be looked at');
    }
  }

  /** The ledger and the verifier, opened on first need. Null while the ledger cannot be opened. */
  private open(): { store: BuilderStore; verifier: Verifier } | null {
    if (this.runtime) return this.runtime;
    const now = this.now();
    if (this.openFailedAt && now - this.openFailedAt < REOPEN_MS) return null;
    try {
      const store = new BuilderStore(this.o.dbPath, { now });
      const verifier = new Verifier({
        store,
        config: () => this.tiers.current(),
        io: this.o.io,
        chainId: this.o.chainId,
        log: this.o.log,
        now: this.now,
        verifyPerMin: this.o.verifyPerMin,
        approvalsPerMin: this.o.approvalsPerMin,
        explorerPerMin: this.o.explorerPerMin,
        lookbackMs: this.o.lookbackMs,
        onChange: (address) => this.settled(address),
        engineFloor: (address, at) => {
          const l = this.loweredFor(address, at);
          return Math.min(l.fees.copy?.fee ?? Infinity, l.fees.bots?.fee ?? Infinity);
        },
      });
      this.runtime = { store, verifier };
      this.openFailedAt = 0;
      const cfg = this.tiers.current();
      if (cfg) this.noteDefault(cfg, store, now);
      if (this.started) verifier.start();
    } catch (e) {
      this.openFailedAt = now;
      this.o.log.error({ path: this.o.dbPath, err: e instanceof Error ? e.message : String(e) }, 'builder tiers: the ledger cannot be opened - every wallet is answered the default fee');
    }
    return this.runtime;
  }

  /** The verifier, for tests that drive it by hand. */
  get verifier(): Verifier | null {
    return this.runtime?.verifier ?? null;
  }

  get store(): BuilderStore | null {
    return this.runtime?.store ?? null;
  }

  /**
   * A wallet's counted volume for `builder` over the last `days` UTC days, in USD
   * (both engines), or null while the ledger is not open. What the copy
   * executor's fee ladder reads (routes/builder.ts, /api/vs/builder/volume).
   */
  volumeUsd(builder: number, address: string, days: number): number | null {
    const store = this.store;
    if (!store) return null;
    const w = store.windowMicro(builder, address, dayOf(this.now()) - (days - 1));
    return (w.perps + w.spot) / 1e6;
  }

  /**
   * VIP (owner 2026-11-08): over $1M of counted volume in 14 days, or over 1% of all ValueDesk's. A wallet's
   * volume and its share, or null while the ledger is not open or no builder is set.
   */
  /** A wallet's own counted volume over the VIP window, or null while the ledger is not open or no builder is set. */
  vipOf(address: string, days = VIP_DAYS): { volumeUsd: number } | null {
    const store = this.store;
    const cfg = this.tiers.current();
    if (!store || !cfg?.builderId) return null;
    const w = store.windowMicro(cfg.builderId, address, dayOf(this.now()) - (days - 1));
    return { volumeUsd: (w.perps + w.spot) / 1e6 };
  }

  /**
   * The default fee over time, on record before any order is judged against
   * it. One comparison in memory; a write only when the first tier changed.
   */
  private noteDefault(cfg: TiersConfig, store: BuilderStore, now: number): void {
    const dflt = defaultFee(cfg);
    const n = this.noted;
    if (n && n.builder === cfg.builderId && n.perps === dflt.perps && n.spot === dflt.spot) return;
    store.noteDefault(cfg.builderId, dflt, now);
    this.noted = { builder: cfg.builderId, perps: dflt.perps, spot: dflt.spot };
  }

  /**
   * The fee a wallet is signed now - and a row in its fee history when that
   * differs from the last one on record. A wallet at the default fee with no
   * history gets no row: owing the default is what having no row means.
   */
  private settle(cfg: TiersConfig, store: BuilderStore | null, address: string, w: WalletRow | null, now: number, counted = countedOf(cfg, store, w, now)): Decision {
    const d0 = decide(cfg, address, this.floored(address, factsOf(w, counted)), now);
    // VIP and the dev page's programs: the lower of them and the tier, per engine (programs.ts).
    const lw = this.loweredFor(address, now);
    const perps = Math.min(d0.fee.perps, lw.fees.perps?.fee ?? Infinity);
    const spot = Math.min(d0.fee.spot, lw.fees.spot?.fee ?? Infinity);
    const d: Decision = perps !== d0.fee.perps || spot !== d0.fee.spot ? { ...d0, fee: { perps, spot }, flags: d0.flags.includes('override') ? d0.flags : [...d0.flags, 'override'] } : d0;
    if (store) {
      try {
        this.noteDefault(cfg, store, now);
        const last = store.lastFee(cfg.builderId, address) ?? d.default;
        if (last.perps !== d.fee.perps || last.spot !== d.fee.spot) store.recordFee(cfg.builderId, address, { at: now, perps: d.fee.perps, spot: d.fee.spot });
      } catch (e) {
        this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: a fee change could not be recorded');
      }
    }
    return d;
  }

  /**
   * The wallets that are VIP now as the app shows it (the invites' one-time VIP credit): kept, over the volume line while
   * VIP by volume is on, and those a VIP program runs for (the dev page's, the beta's 30 days).
   */
  vipWallets(now = this.now()): string[] {
    const out = new Set<string>(vipKept());
    const cfg = this.tiers.current();
    const store = this.store;
    if (vipByVolume() && cfg?.builderId && store) {
      for (const a of store.walletsOver(cfg.builderId, dayOf(now) - (VIP_DAYS - 1), VIP_MIN_USD * MICRO)) out.add(a);
    }
    try {
      for (const a of this.o.vipCandidates?.(now) ?? []) if (this.vipProgramOf(a, now)) out.add(a.toLowerCase());
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: the VIP programs could not be listed');
    }
    return [...out];
  }

  /** The wallet's running programs (never throws: an unreadable store means none; no source given, none). */
  private programsOf(address: string, now: number, withExtra = true, withGifts = true): FeeProgram[] {
    let out: FeeProgram[] = [];
    try {
      out = this.o.programs ? this.o.programs(address, now) : [];
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: fee programs could not be read');
    }
    if (withGifts && this.gifts) {
      try {
        out = [...out, ...this.gifts(address, now)];
      } catch (e) {
        this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: gift programs could not be read');
      }
    }
    if (withExtra && this.extra) {
      try {
        out = [...out, ...this.extra(address, now)];
      } catch (e) {
        this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: credit programs could not be read');
      }
    }
    return out;
  }

  /**
   * The builder fee a wallet would pay on a product now WITHOUT the fee credits and the invite welcome (tenths of a bp):
   * its tier (site trading), its ladder step (copy trading, bots), lowered by VIP and the dev page's programs. What a
   * fee paid by credits is valued at (invites/service.ts). Null while the ledger or the tiers cannot be read.
   */
  standardFee(address: string, product: FeeProduct, now = this.now()): number | null {
    const cfg = this.tiers.current();
    const rt = cfg ? this.open() : null;
    if (!cfg || !rt) return null;
    const a = address.toLowerCase();
    let base: number;
    try {
      if (product === 'perps' || product === 'spot') {
        const w = rt.store.wallet(cfg.builderId, a);
        base = decide(cfg, a, this.floored(a, factsOf(w, countedOf(cfg, rt.store, w, now))), now).fee[product];
      } else {
        const v = this.ladderVolumeUsd(cfg.builderId, a, COPY_LADDER_DAYS) ?? 0;
        base = product === 'copy' ? copyLadderFee(v) : botLadderFee(v);
      }
    } catch {
      return null;
    }
    const l = lowered(this.programsOf(a, now, false), this.vipNow(a), cfg, now);
    return Math.min(base, l.fees[product]?.fee ?? Infinity);
  }

  /** Whether a wallet is VIP now by its standing: kept (VALUEDESK_VIP_KEEP), or by volume while that is on (vipByVolume). */
  vipNow(address: string): boolean {
    const a = address.toLowerCase();
    if (vipKept().includes(a)) return true;
    return vipByVolume() && isVip(this.vipOf(a));
  }

  /**
   * The VIP program running for this wallet now (a program whose fee is VIP_PROGRAM_FEE: the beta's 30 days from its
   * listing, or one set on the dev page), or null. Of several, the one that lasts longest (no end counts longest).
   * Told by its fee, never by its label (a label is free text on the dev page). With gifts (default): also a VIP code's days
   * (invites giftsFor); withGifts false: the wallet's own standing only (what lets its own code give VIP days).
   */
  vipProgramOf(address: string, now = this.now(), withGifts = true): FeeProgram | null {
    let best: FeeProgram | null = null;
    for (const g of this.programsOf(address.toLowerCase(), now, true, withGifts)) {
      if (g.fee !== VIP_PROGRAM_FEE || g.from > now || (g.until !== null && g.until <= now)) continue;
      if (!best || (best.until !== null && (g.until === null || g.until > best.until))) best = g;
    }
    return best;
  }

  /** What VIP and the running programs lower each product to, for this wallet now (programs.ts). */
  loweredFor(address: string, now = this.now()): Lowered {
    const a = address.toLowerCase();
    return lowered(this.programsOf(a, now), this.vipNow(a), this.tiers.current(), now);
  }

  /** A wallet's volume or flags changed: put its fee on record now, not when it next asks. */
  private settled(address: string): void {
    const cfg = this.tiers.current();
    const rt = this.runtime;
    if (!cfg || !rt) return;
    try {
      this.settle(cfg, rt.store, address, rt.store.wallet(cfg.builderId, address), this.now());
    } catch {
      /* the next request settles it */
    }
  }

  /**
   * A wallet may have traded where the site did not see it - through the hosted executor or a
   * self-hosted copier, with no tab open (owner 2026-11-01: only 2 wallets counted). The
   * executor's volume read (routes/builder.ts, internal token only) leaves this hint, so every
   * follower it trades for is verified like a site user. Same rules as a terms hint: a wallet
   * without our builder approved writes nothing. Never throws.
   */
  hint(address: string, client: string): void {
    const rt = this.tiers.current() ? this.open() : null;
    if (!rt) return;
    try {
      rt.verifier.hint(address, client);
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: a hint could not be taken');
    }
  }

  /** Answer one request. Never throws: a ledger that cannot be read means the default fee. */
  terms(req: TermsRequest): TermsBody {
    const cfg = this.tiers.current();
    if (!cfg) return { ok: true, builderId: null };
    const now = this.now();
    const rt = this.open();
    let w: WalletRow | null = null;
    try {
      w = rt ? rt.store.wallet(cfg.builderId, req.address) : null;
    } catch (e) {
      this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: the ledger could not be read');
    }
    const counted = countedOf(cfg, rt?.store ?? null, w, now);
    const d = this.settle(cfg, rt?.store ?? null, req.address, w, now, counted);
    if (req.hint && rt) {
      try {
        rt.verifier.hint(req.address, req.client);
      } catch (e) {
        this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'builder tiers: a hint could not be taken');
      }
    }
    const signer = this.keys.current();
    // A lowered fee that ends sooner than the terms would last: the terms end with it (the page asks again then,
    // and gets the tier's fee), never sooner than a minute.
    const ends = soonestEnd(this.loweredFor(req.address, now), ['perps', 'spot']);
    const ttl = ends === null ? TERMS_TTL_MS : Math.max(60_000, Math.min(TERMS_TTL_MS, ends - now));
    const fields = { chain: this.o.chainId, builderId: cfg.builderId, address: req.address, perps: d.fee.perps, spot: d.fee.spot, nonce: req.nonce, issued: now, ttl };
    const perps = counted.perps;
    const spot = counted.spot;
    return {
      ok: true,
      chain: fields.chain,
      builderId: fields.builderId,
      address: fields.address,
      fee: d.fee,
      nonce: fields.nonce,
      issued: fields.issued,
      ttl: fields.ttl,
      keyId: signer?.keyId ?? null,
      sig: signer ? signer.sign(termsMessage(fields)) : null,
      default: d.default,
      volume: {
        perpsUsd: perps / MICRO,
        spotUsd: spot / MICRO,
        totalUsd: (perps + spot) / MICRO,
        days: cfg.volumeDays,
        verifiedAt: w && w.verifiedAt > 0 ? w.verifiedAt : null,
        // A verification is queued or running, or orders wait for the explorer.
        pending: (rt?.verifier.pending(req.address) ?? false) || (w?.openN ?? 0) > 0,
      },
      tier: d.tier,
      flags: d.flags,
    };
  }
}

// --- the one instance of a running server -------------------------------------------------

/** No answer after this long counts as a failed explorer request. */
const EXPLORER_TIMEOUT_MS = 15_000;

/** `VALUESCAN_BUILDER_EXPLORER`: an https origin, nothing after it. Anything else is ignored. */
export function explorerBase(raw: string | undefined, network: 'mainnet' | 'testnet'): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(v) ? v : EXPLORER_BASE[network];
}

/** The verifier's requests, bound to this server's shared SoDEX client and to the explorer. */
export function liveIo(base: string = explorerBase(process.env.VALUESCAN_BUILDER_EXPLORER, NETWORK)): VerifierIo {
  return {
    get: (path, weight) => gwGet<unknown>(path, weight),
    explorer: async (path) => {
      const res = await fetch(base + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS) });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new ExplorerError(res.status, `the explorer answered HTTP ${res.status}`);
      }
      return (await res.json()) as unknown;
    },
    cooldownMs: (path) => Math.max(cooldownLeftMs(), sodex.cooldownLeft(path)),
    weightSpent: () => gatewayWeightSpent(),
    weightLimit: () => gatewayWeightLimit(),
  };
}

const consoleLog: LogLike = {
  info: (o, msg) => console.log(`[builder] ${msg}`, JSON.stringify(o)),
  warn: (o, msg) => console.warn(`[builder] ${msg}`, JSON.stringify(o)),
  error: (o, msg) => console.error(`[builder] ${msg}`, JSON.stringify(o)),
};

let instance: BuilderService | null = null;

/** The running server's service, started on first use. */
export function builderService(log: LogLike = consoleLog): BuilderService {
  if (!instance) {
    const days = Number(process.env.VALUESCAN_BUILDER_LOOKBACK_DAYS);
    let admin: AdminStore | null = null;
    instance = new BuilderService({
      // The dev page's fee programs, from the admin store on this server.
      programs: (address, at) => (admin ??= new AdminStore()).activeFeePrograms(address, at),
      // Wallets a VIP program may run for: the dev page's VIP programs and the beta list (vipWallets checks each).
      vipCandidates: (at) => {
        const s = (admin ??= new AdminStore());
        return [...s.feePrograms().filter((g) => g.fee === VIP_PROGRAM_FEE && g.from <= at && (g.until === null || g.until > at)).map((g) => g.address), ...s.betaWallets().map((b) => b.address)];
      },
      tiersPath: tiersPath(),
      keyPath: termsKeyPath(),
      dbPath: builderDbPath(),
      chainId: NET.chainId,
      io: liveIo(),
      log,
      verifyPerMin: perMinFrom(process.env.VALUESCAN_BUILDER_VERIFY_PER_MIN, VERIFY_PER_MIN_DEFAULT, VERIFY_PER_MIN_MAX),
      approvalsPerMin: perMinFrom(process.env.VALUESCAN_BUILDER_APPROVALS_PER_MIN, APPROVALS_PER_MIN_DEFAULT, APPROVALS_PER_MIN_MAX),
      explorerPerMin: process.env.VALUESCAN_BUILDER_EXPLORER_PER_MIN?.trim() === '0' ? 0 : perMinFrom(process.env.VALUESCAN_BUILDER_EXPLORER_PER_MIN, EXPLORER_PER_MIN_DEFAULT, EXPLORER_PER_MIN_MAX),
      lookbackMs: Number.isFinite(days) && days >= 0 && days <= 90 && process.env.VALUESCAN_BUILDER_LOOKBACK_DAYS?.trim() ? days * 86_400_000 : undefined,
      verify: channelFrom(process.env) === 'main',
    });
    instance.start();
  }
  return instance;
}
