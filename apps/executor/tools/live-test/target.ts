/**
 * WHERE THE SCENARIOS RUN (--target). The catalogue is the same for every
 * target; what changes is which executor takes the signed requests, and what
 * the runner can do to it:
 *
 *   self     a real executor process started on this machine from this
 *            checkout (executor.ts), for the follower wallet only. The runner
 *            can kill it hard and start it again on the same data, and it
 *            reads the follower's volume from the runner's own stub
 *            (feeStub.ts): $0, the copy fee ladder's top step, unless a fee
 *            scenario sets another. What the suite always did; the default.
 *   hosted   ValueDesk's own executor, through the site's edge
 *            (https://www.valuedesk.so/api/copy/v1: Vercel adds the origin
 *            secret and the viewer's country, which server 2 needs). Its ids
 *            and key name come from its /info. Nothing of it can be restarted
 *            from here, so the restart scenarios are skipped; its fee is the
 *            step of the follower's 14-day volume, which only its own ledger
 *            knows, so any ladder step SoDEX shows is accepted and noted. Its
 *            limits are shared by everyone behind the same address: requests
 *            are paced under them. Closed to new orders or braked, it is not
 *            failing: those scenarios are inconclusive (run again later). Real
 *            algo orders reach it only for a wallet the owner lets
 *            (EXECUTOR_LIVE_ALGOS_WALLETS on server 2). What it records stays:
 *            the terms, the keys, the algos and copies of the wallets used.
 *   browser  the web app's own runtime (apps/web/src/algo, copy, trading) in a
 *            tab of Microsoft Edge on the local dev web, through the dev-only
 *            web test bridge (BrowserDriver below; browserDriver.ts). Its
 *            restart is a reload: the page goes away and comes back in the
 *            same profile, which the web app keeps its algos running through
 *            (tabLife.ts) - not hard, so `kill` stays false. It also closes the
 *            tab (tabClose), after which the app stops them for good. It makes
 *            its own copy key: nothing is imported into it. Real algo orders
 *            start there only for a wallet the dev web lets
 *            (VITE_LIVE_ALGOS_WALLETS in apps/web/.env.local).
 *
 * What a target cannot do, a scenario that needs it (`needs`, scenario.ts) is
 * skipped for, with why. Nothing else about a scenario changes; it reaches the
 * target as `t.exec` (harness.ts).
 */
import type { AlgoEvent, AlgoView, ActivityEntry, CopyView, EngineNotice, ExecutorInfo, MeResponse } from '../../../../packages/copy-engine/src/index.ts';
import { ExecutorClient, assertPaper, type CopyWallet, type ExecutorError, type ExecutorProcess } from './executor.ts';
import { Inconclusive, Unavailable } from './harness.ts';
import type { ExecutorRecord, Mode } from './state.ts';
import { readFileSync } from 'node:fs';

export const TARGETS = ['self', 'hosted', 'browser'] as const;
export type TargetName = (typeof TARGETS)[number];

export function targetName(v: string | undefined): TargetName {
  const x = (v ?? '').trim();
  if (!(TARGETS as readonly string[]).includes(x)) throw new Error(`--target must be ${TARGETS.join(', ')} (got "${x}")`);
  return x as TargetName;
}

export interface TargetCapabilities {
  /** Stopped and started again on the same data, by the runner (the restart scenarios): killed hard where `kill`; the browser reloads. */
  restart: boolean;
  /** Killed hard by the runner (no shutdown code runs). */
  kill: boolean;
  /** Paper specs only: a live run on it is refused at the start. */
  paperOnly?: boolean;
  /**
   * The follower's volume it charges the copy fee step of is the runner's to set: a local executor
   * reads it from the runner's loopback stub (feeStub.ts; $0, the ladder's top step, unless a fee
   * scenario sets another), so the fee checks know the exact rate, and the fee scenarios can walk
   * the ladder. Without it any step of the ladder the exchange shows is accepted, and noted.
   */
  localFeeStub: boolean;
  /** It takes a SoDEX key the follower made (key import); a browser makes its own copy key. */
  keyImport: boolean;
  /** The runner closes the browser tab that runs the algos and opens the app again later (ExecutorTarget.closeTab). */
  tabClose: boolean;
}

/** What a scenario may need of a target. */
export type Capability = 'restart' | 'kill' | 'localFeeStub' | 'keyImport' | 'tabClose';

export const CAPABILITIES: Readonly<Record<TargetName, TargetCapabilities>> = {
  self: { restart: true, kill: true, localFeeStub: true, keyImport: true, tabClose: false },
  hosted: { restart: false, kill: false, localFeeStub: false, keyImport: true, tabClose: false },
  // A restart is a reload of the page (not hard); real algos need the dev web's VITE_LIVE_ALGOS_WALLETS, copies nothing.
  browser: { restart: true, kill: false, localFeeStub: false, keyImport: false, tabClose: true },
};

const CAN: Record<Capability, string> = {
  restart: 'kill the executor and start it again on the same data',
  kill: 'kill the executor hard',
  localFeeStub: 'answer the executor\'s reads of the follower\'s volume (the copy fee step) itself',
  keyImport: 'be given a SoDEX key the follower made (key import)',
  tabClose: 'close the browser tab that runs the algos and open the app again',
};

/** Why a scenario cannot run on a target (what it needs that the target lacks), or null. */
export function cannotRun(s: { needs?: readonly Capability[] }, target: TargetName, caps: TargetCapabilities = CAPABILITIES[target]): string | null {
  const missing = (s.needs ?? []).filter((c) => !caps[c]);
  return missing.length ? `the ${target} target cannot ${missing.map((c) => CAN[c]).join(' or ')} from here` : null;
}

/** The executor's API the scenarios use (what the web app sends), the same on every target. */
export interface ExecutorApi {
  info(): Promise<ExecutorInfo>;
  acceptTerms(country: string, termsHash: string): Promise<MeResponse>;
  me(): Promise<MeResponse>;
  /** A new session (the executor reads the follower's volume, the copy fee step, on each). */
  signIn(): Promise<void>;
  createKey(days: number): Promise<{ address: string; name: string; maxDays: number; days: number }>;
  verifyKey(): Promise<MeResponse['key']>;
  importKey(name: string, envelope: unknown): Promise<MeResponse['key']>;
  algoStart(spec: Record<string, unknown>, seed?: number): Promise<AlgoView>;
  algoAct(op: 'pause' | 'resume' | 'cancel' | 'cancel-all', id?: string): Promise<AlgoView[]>;
  algoUpdate(id: string, patch: Record<string, unknown>): Promise<AlgoView[]>;
  algos(): Promise<AlgoView[]>;
  algo(id: string): Promise<AlgoView>;
  events(id: string, limit?: number): Promise<AlgoEvent[]>;
  subscribe(settings: Record<string, unknown>): Promise<CopyView>;
  copyAct(action: 'update' | 'pause' | 'resume' | 'stop' | 'stop-all', payload: Record<string, unknown>): Promise<CopyView[]>;
  copy(id: string): Promise<CopyView>;
  activity(id: string, limit?: number): Promise<ActivityEntry[]>;
  /** What it keeps for the wallet to hear of (an executor's GET /notices); absent where they are not read from here (the browser's bell). */
  notices?(limit?: number): Promise<EngineNotice[]>;
  /**
   * "Ask me each time": the copied trades waiting for the follower's answer, and the answer, as the
   * prompt at the bottom of the page gives it. The browser only: an executor has nobody to ask (absent).
   */
  copyConfirms?(): Promise<Array<{ id: string; subId: string; symbol: string; expiresAt: number }>>;
  answerCopyConfirm?(id: string, yes: boolean): Promise<void>;
  /** Everything this wallet runs there stops: the kill switch for algos, every copy stopped and closed. */
  stopEverything(): Promise<void>;
}

/** One executor the suite runs against: its API, what the runner can do to it, and its lifecycle. */
export interface ExecutorTarget extends ExecutorApi {
  readonly name: TargetName;
  readonly capabilities: TargetCapabilities;
  /** Where its requests go, for the log. */
  readonly where: string;
  /** Its data folder on this machine (self), deleted at the end unless --keep-data; null: none here. */
  readonly dataDir: string | null;
  /** Ready to take requests (self: the process started; hosted: its /info and /health read). */
  start(): Promise<void>;
  /** The end of a run: nothing of it left running here. ValueDesk's executor runs on. */
  stop(): Promise<void>;
  /**
   * Take it down for a restart; start() brings it back on the same data. Hard, no shutdown code
   * runs, where capability kill; the browser's page navigates away instead (a reload's first half).
   */
  kill(): Promise<void>;
  /** Close the browser tab that runs the algos (capability tabClose); start() opens the app again in a new one. */
  closeTab?(): Promise<void>;
  /** Whether it answers now. */
  health(): Promise<{ ok: boolean; why?: string }>;
  /** Set when it went away on its own (a local process that exited): why. A scenario waiting on it fails with it. */
  gone(): string | null;
  /** The operator alerts it raised since `fromMs` that point at a refusal nobody planned for (self: from its own log). Absent: not readable from here. */
  refusalAlertsSince?(fromMs: number): string[];
  /** The country it sees the requests come from (ValueDesk's executor: its edge's), for the region rule; null: none. */
  observedCountry(): Promise<string | null>;
  /** What it runs that this checkout does not show (ValueDesk's executor: its version, from /info), for the code hash; null: this checkout. */
  release(info: ExecutorInfo): string | null;
  /** The local process to record in the state file (a crashed run's one is stopped by the next start); null: none. */
  processRecord(): ExecutorRecord | null;
}

/* --------------------------------------------------------------------- self ----- */

/** The executor process on this machine (executor.ts): what the suite always ran against. */
export class SelfTarget extends ExecutorClient implements ExecutorTarget {
  readonly name = 'self' as const;
  readonly capabilities = CAPABILITIES.self;
  /** Killed by the runner (a restart scenario), not gone on its own: a wait meanwhile goes on. */
  private killed = false;

  constructor(
    readonly proc: ExecutorProcess,
    wallet: CopyWallet,
    mode: Mode,
  ) {
    super(proc, wallet, proc.o.executorId, mode);
  }

  get where(): string {
    return `${this.proc.base} (log ${this.proc.o.logFile})`;
  }

  /** Its log's alert lines (alerts.ts logs every alert) of an unknown refusal or a refused key since `fromMs`. */
  refusalAlertsSince(fromMs: number): string[] {
    let text = '';
    try {
      text = readFileSync(this.proc.o.logFile, 'utf8');
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"msg":"alert"')) continue;
      try {
        const j = JSON.parse(line) as { t?: string; kind?: string; text?: string };
        if ((j.kind === 'order-rejected' || j.kind === 'key-refused') && Date.parse(j.t ?? '') >= fromMs) out.push(`${j.kind}: ${j.text ?? ''}`);
      } catch {
        /* not a JSON line */
      }
    }
    return out;
  }

  get dataDir(): string {
    return this.proc.o.dataDir;
  }

  async start(): Promise<void> {
    await this.proc.start();
    this.killed = false;
  }

  async stop(): Promise<void> {
    await this.proc.kill();
    this.proc.close();
  }

  async kill(): Promise<void> {
    this.killed = true;
    await this.proc.kill();
  }

  async health(): Promise<{ ok: boolean; why?: string }> {
    return this.proc.running ? { ok: true } : { ok: false, why: 'the executor process is not running' };
  }

  gone(): string | null {
    const x = this.proc.exited;
    return x && !this.killed ? `the executor process exited (code ${x.code})` : null;
  }

  async observedCountry(): Promise<string | null> {
    return null;
  }

  release(): string | null {
    return null;
  }

  processRecord(): ExecutorRecord {
    return { target: 'self', pid: this.proc.pid ?? 0, port: this.proc.port, executorId: this.executorId, dataDir: this.proc.o.dataDir, startedAt: Date.now() };
  }

  /** The kill switch, while the process runs (the cleanup starts a dead one again first). */
  override async stopEverything(): Promise<void> {
    if (this.proc.running) await super.stopEverything();
  }
}

/* ------------------------------------------------------------------- hosted ----- */

/** ValueDesk's executor, as the site reaches it: Vercel's function adds the origin secret and the viewer's country. */
export const HOSTED_BASE = 'https://www.valuedesk.so/api/copy/v1';

/**
 * Spaces requests so that no minute holds more than `perMinute` of them: one
 * waits until the oldest of the last `perMinute` is a minute old. Any window of
 * a minute then holds at most that many, so the executor's own fixed windows
 * (server.ts Limiter) never fill.
 */
export class Pacer {
  private readonly sent: number[] = [];
  constructor(
    readonly perMinute: number,
    private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ) {}

  async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.sent.length && now - this.sent[0]! >= 60_000) this.sent.shift();
      if (this.sent.length < this.perMinute) {
        this.sent.push(now);
        return;
      }
      await this.clock.sleep(60_000 - (now - this.sent[0]!) + 25);
    }
  }
}

/**
 * ValueDesk's executor allows 240 reads and 40 writes a minute per client address, and 12 key
 * checks (/keys/verify, a write too) per wallet (server.ts). Paced well under that: whoever else
 * shares this address (the site in a browser here) keeps some.
 */
export const HOSTED_PACE = { reads: 200, writes: 30, keyChecks: 10 } as const;

/**
 * What ValueDesk's executor answers when it cannot take something now - never a
 * failure of the code under test. Closed to new orders (EXECUTOR_OPEN=0) or the
 * operator's brake (503), and real algo orders not let for this wallet (403
 * paper-only): inconclusive, since they lift - the scenario runs again next
 * time. A region or sanctions refusal (451): skipped, with its words.
 */
export function hostedRefusal(e: ExecutorError): Error | null {
  if (e.status === 503 && (e.code === 'closed' || e.code === 'brake')) return new Inconclusive(`ValueDesk's executor takes nothing new right now (${e.message}): run again later`);
  if (e.status === 403 && e.code === 'paper-only') return new Inconclusive('ValueDesk\'s executor takes no real algo orders from this wallet: the owner adds the follower to EXECUTOR_LIVE_ALGOS_WALLETS on server 2 (README.md); it runs again next time');
  if (e.status === 451) return new Unavailable(`ValueDesk's executor refuses this here (${e.message})`);
  return null;
}

function hostedOptions() {
  const reads = new Pacer(HOSTED_PACE.reads);
  const writes = new Pacer(HOSTED_PACE.writes);
  const keyChecks = new Pacer(HOSTED_PACE.keyChecks);
  return {
    pace: async (kind: 'read' | 'write' | 'key-check') => {
      if (kind === 'key-check') await keyChecks.take();
      await (kind === 'read' ? reads : writes).take();
    },
    refusal: hostedRefusal,
  };
}

export class HostedTarget extends ExecutorClient implements ExecutorTarget {
  readonly name = 'hosted' as const;
  readonly capabilities = CAPABILITIES.hosted;
  readonly dataDir = null;
  /** The key name the follower registers for it (its /info: vd-copy-tokyo). */
  keyName = '';

  constructor(
    wallet: CopyWallet,
    mode: Mode,
    readonly base: string = HOSTED_BASE,
  ) {
    super({ base }, wallet, '', mode, hostedOptions());
  }

  get where(): string {
    return `ValueDesk's executor (${this.base})`;
  }

  /** Its ids from its /info (it must be ValueDesk's mainnet executor), and its /health ok. */
  async start(): Promise<void> {
    const i = await this.info();
    if (i.kind !== 'hosted' || i.network !== 'mainnet') throw new Error(`${this.base} answers as a ${i.kind} executor on ${i.network}, not ValueDesk's executor on mainnet`);
    this.executorId = i.executorId;
    this.keyName = i.keyName;
    const h = await this.health();
    if (!h.ok) throw new Error(`ValueDesk's executor is not healthy (${h.why}): run again later`);
  }

  async stop(): Promise<void> {
    /* it is ValueDesk's: what this run started there, the cleanup stopped */
  }

  async kill(): Promise<void> {
    throw new Unavailable('ValueDesk\'s executor cannot be killed from here');
  }

  async health(): Promise<{ ok: boolean; why?: string }> {
    try {
      const h = await this.call<{ ok?: boolean; feeds?: { sodex?: boolean } }>('GET', '/health');
      return h.ok ? { ok: true } : { ok: false, why: h.feeds?.sodex === false ? 'its SoDEX feed is down' : 'it says it is not ok' };
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
  }

  gone(): string | null {
    return null;
  }

  async observedCountry(): Promise<string | null> {
    return (await this.info()).viewerCountry;
  }

  release(info: ExecutorInfo): string | null {
    // /info names its engine version; a commit too, once it carries one.
    const commit = (info as ExecutorInfo & { commit?: unknown }).commit;
    return [info.version, typeof commit === 'string' ? commit : null].filter(Boolean).join('+') || 'unknown';
  }

  processRecord(): null {
    return null;
  }
}

/* ------------------------------------------------------------------ browser ----- */

/**
 * THE SEAM FOR THE BROWSER TARGET. The web app's own runtime in a page, driven
 * through the dev-only test bridge (window.__vsTest) and the browser tooling
 * that live in apps/web (e2e/ui); browserDriver.ts is the driver, and loads the
 * page from there - no browser automation lives in this folder. A driver
 * answers the same calls as the executor's API, in its shapes, so every
 * scenario runs unchanged, and opens, leaves and closes the page. The
 * harness's checks still read SoDEX (live) or the runtime's paper book through
 * these calls (dry).
 */
export interface BrowserDriver extends ExecutorApi {
  /** Where the page runs, for the log. */
  readonly where?: string;
  /** Open the page with the follower's wallet (again, after leave), and wait until the runtime answers. */
  open(): Promise<void>;
  /** The page goes away: 'reload' navigates it away (open() then reloads it), 'close' closes the tab (open() opens a new one). */
  leave(how: 'reload' | 'close'): Promise<void>;
  /** The end: the browser closed (its runtime stops). */
  close(): Promise<void>;
  /** Whether the page and its runtime answer. */
  ready(): Promise<boolean>;
  /** Set when the browser went away on its own (closed, crashed): why. */
  gone?(): string | null;
  /** The country the page's ValueDesk executor sees it in (the region rule), or null; read without the page. */
  viewerCountry?(): Promise<string | null>;
}

const NO_BRIDGE = 'the browser target needs the web test bridge (apps/web e2e): pass a BrowserDriver to BrowserTarget';

export class BrowserTarget implements ExecutorTarget {
  readonly name = 'browser' as const;
  readonly capabilities = CAPABILITIES.browser;
  readonly dataDir = null;

  constructor(
    private readonly mode: Mode,
    private readonly driver: BrowserDriver | null = null,
  ) {}

  get where(): string {
    const w = this.driver?.where;
    return typeof w === 'string' ? w : 'the web app\'s runtime in a browser (the web test bridge)';
  }

  private d(): BrowserDriver {
    if (!this.driver) throw new Error(NO_BRIDGE);
    return this.driver;
  }

  async start(): Promise<void> {
    return this.d().open();
  }
  async stop(): Promise<void> {
    await this.driver?.close();
  }
  /** A restart's first half: the page navigates away, as on a reload (its pagehide runs: not hard). start() loads it again. */
  async kill(): Promise<void> {
    await this.d().leave('reload');
  }
  /** The tab closes; start() opens the app in a new one, in the same profile. */
  async closeTab(): Promise<void> {
    await this.d().leave('close');
  }
  async health(): Promise<{ ok: boolean; why?: string }> {
    return this.driver && (await this.driver.ready()) ? { ok: true } : { ok: false, why: this.driver ? 'the page does not answer' : NO_BRIDGE };
  }
  gone(): string | null {
    const g = this.driver?.gone?.();
    return typeof g === 'string' ? g : null;
  }
  /** The country the dev web's ValueDesk executor sees the page in: the region rule takes the stricter of it and the declared one. */
  async observedCountry(): Promise<string | null> {
    return (await this.driver?.viewerCountry?.()) ?? null;
  }
  release(): string | null {
    return null;
  }
  processRecord(): null {
    return null;
  }

  async info() {
    return this.d().info();
  }
  async acceptTerms(country: string, termsHash: string) {
    return this.d().acceptTerms(country, termsHash);
  }
  async me() {
    return this.d().me();
  }
  async signIn() {
    return this.d().signIn();
  }
  async createKey(days: number) {
    return this.d().createKey(days);
  }
  async verifyKey() {
    return this.d().verifyKey();
  }
  async importKey(name: string, envelope: unknown) {
    return this.d().importKey(name, envelope);
  }
  // A dry run refuses anything but paper before it reaches the page, as ExecutorClient does before signing.
  async algoStart(spec: Record<string, unknown>, seed?: number) {
    if (this.mode === 'dry') assertPaper(spec);
    return this.d().algoStart(spec, seed);
  }
  async algoAct(op: 'pause' | 'resume' | 'cancel' | 'cancel-all', id?: string) {
    return this.d().algoAct(op, id);
  }
  async algoUpdate(id: string, patch: Record<string, unknown>) {
    return this.d().algoUpdate(id, patch);
  }
  async algos() {
    return this.d().algos();
  }
  async algo(id: string) {
    return this.d().algo(id);
  }
  async events(id: string, limit?: number) {
    return this.d().events(id, limit);
  }
  async subscribe(settings: Record<string, unknown>) {
    if (this.mode === 'dry' && settings.paper !== true) throw new Error('dry run: refusing a copy that is not paper');
    return this.d().subscribe(settings);
  }
  async copyAct(action: 'update' | 'pause' | 'resume' | 'stop' | 'stop-all', payload: Record<string, unknown>) {
    if (this.mode === 'dry' && action === 'update' && (payload.settings as { paper?: unknown } | undefined)?.paper !== true) throw new Error('dry run: refusing a copy update that is not paper');
    return this.d().copyAct(action, payload);
  }
  async copy(id: string) {
    return this.d().copy(id);
  }
  async activity(id: string, limit?: number) {
    return this.d().activity(id, limit);
  }
  async copyConfirms() {
    return (await this.d().copyConfirms?.()) ?? [];
  }
  async answerCopyConfirm(id: string, yes: boolean) {
    await this.d().answerCopyConfirm?.(id, yes);
  }
  async stopEverything(): Promise<void> {
    if (this.driver) await this.driver.stopEverything();
  }
}
