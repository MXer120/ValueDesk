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
import { NET, NETWORK } from '../config.js';
import { sodex } from '../sodex/rest.js';
import { gatewayWeightSpent, gwGet } from '../valuedesk/sodex/gateway.js';
import { cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { TiersSource, defaultFee, type Fee, type LogLike, type TiersConfig } from './config.js';
import { EXPLORER_BASE } from './explorer.js';
import { builderDbPath, termsKeyPath, tiersPath } from './paths.js';
import { BuilderStore, type WalletRow } from './store.js';
import { dayOf } from './counting.js';
import { KeySource, TERMS_TTL_MS, termsMessage } from './terms.js';
import { MICRO, NO_FACTS, decide, type Decision, type Flag, type NextTier, type WalletFacts } from './tiers.js';
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
    this.runtime?.verifier.start();
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
    const d = decide(cfg, address, factsOf(w, counted), now);
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
    const fields = { chain: this.o.chainId, builderId: cfg.builderId, address: req.address, perps: d.fee.perps, spot: d.fee.spot, nonce: req.nonce, issued: now, ttl: TERMS_TTL_MS };
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
    instance = new BuilderService({
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
    });
    instance.start();
  }
  return instance;
}
