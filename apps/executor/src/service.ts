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
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  AlgoRuntime,
  AlgoSpecError,
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
  normaliseCountry,
  parseAlgoSpec,
  parseSettings,
  randomId,
  regionPolicy,
  fetchQuotes,
  verifyCopyRequest,
  type AcceptSiteTermsPayload,
  type AcceptTermsPayload,
  type ActivityEntry,
  type AlgoEvent,
  type AlgoRecord,
  type AlgoSink,
  type AlgoView,
  type CopyAction,
  type CopyView,
  type CreateKeyPayload,
  type ExecutorInfo,
  type FetchLike,
  type KeyInfo,
  type Logger,
  type MeResponse,
  type OrderSink,
  type SessionGrant,
  type SignedCopyRequest,
  type SiteTermsRecord,
  type Subscription,
  type WebSocketFactory,
} from '../../../packages/copy-engine/src/index.ts';
import { SODEX_CHAIN_ID, createMemoryNonceManager, type SigningKeyRef } from '../../../packages/sodex-core/src/index.ts';
import type { ExecutorConfig } from './config.ts';
import type { ExecutorDb, KeyRow } from './db.ts';
import type { Secrets } from './secrets.ts';

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
}

export interface ServiceDeps {
  fetch: FetchLike;
  factory: WebSocketFactory;
  log: Logger;
}

const SESSION_TTL_MS = 12 * 60 * 60_000;
const KEY_RECHECK_MS = 10 * 60_000;

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
  readonly sodex: SodexClient;
  private readonly hyperliquid: HyperliquidClient;
  private readonly nonces = createMemoryNonceManager();
  private readonly paper = new PaperSink();
  private readonly signers = new Map<string, SigningKeyRef>();
  private readonly volumes = new Map<string, { usd: number | null; at: number }>();
  private builderDb: DatabaseSync | null = null;
  /** Self-hosted, not yet paired: the code printed at start. */
  readonly pairingCode: string | null;

  constructor(
    readonly cfg: ExecutorConfig,
    readonly db: ExecutorDb,
    private readonly secrets: Secrets,
    private readonly deps: ServiceDeps,
  ) {
    this.executorId = cfg.kind === 'hosted' ? `valuedesk-${cfg.network}-tokyo` : this.selfId();
    this.keyName = cfg.kind === 'hosted' ? 'vd-copy-tokyo' : 'vd-copy-self';
    this.pairingCode = cfg.kind === 'self' && !this.owner() ? randomId().slice(0, 8).toUpperCase() : null;
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
      builderFor: async (s) => (cfg.builderId > 0 ? { id: cfg.builderId, fee: copyFeeFor(this.volumeOf(s.owner)) } : null),
      policyFor: (s) => regionPolicy(s.country, s.observedCountry),
      keyProblem: (s) => this.keyProblem(s.owner),
    });
    this.algos = new AlgoRuntime({
      store: db,
      sodex: this.sodex,
      network: cfg.network,
      factory: deps.factory,
      log: deps.log,
      sinkFor: (a) => this.algoSink(a),
      builderRate: (a) => (cfg.builderId > 0 ? copyFeeFor(this.volumeOf(a.owner)) / 100_000 : 0),
      problem: (a) => this.algoProblem(a),
      // The copy region rules, from the country declared with the terms and the one the request came from.
      policyFor: (a) => regionPolicy(a.country ?? null, a.observedCountry ?? null),
      // A sweep's reference price: Binance USD-M futures and Binance spot (sweep.ts).
      oracle: (coin) => fetchQuotes(coin, { weights: { binance: 1, binanceSpot: 1 } }, { fetch: deps.fetch, timeoutMs: 2_000 }),
    });
  }

  async start(): Promise<void> {
    await this.runtime.start();
    await this.algos.start();
  }

  async stop(): Promise<void> {
    await this.algos.stop();
    await this.runtime.stop();
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
      algos: { maxPerOwner: this.cfg.maxAlgosPerOwner },
      features: [...EXECUTOR_FEATURES],
    };
  }

  health(): { ok: boolean; copies: number; active: number; algos: number; feeds: { sodex: boolean } } {
    const all = this.runtime.list();
    const v = all[0] ? this.runtime.view(all[0].id) : null;
    const algos = this.algos.list().filter((a) => !FINAL_STATUSES.has(a.status)).length;
    return { ok: true, copies: all.length, active: all.filter((s) => s.status === 'active').length, algos, feeds: { sodex: v?.feeds.sodex ?? true } };
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
        const code = ctx.pairingCode?.trim().toUpperCase();
        if (r.action !== 'session' || !code || code !== this.pairingCode) {
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
      policy: regionPolicy(current?.country ?? null, ctx.viewerCountry),
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

  /** Ask SoDEX whether the follower registered the key; a registered pending key becomes the active one. */
  async verifyKey(owner: string): Promise<KeyInfo | null> {
    const pending = this.db.key(owner, 'pending');
    if (pending) {
      const r = await this.sodex.keyRegistered(owner, pending.name, pending.address);
      if (r.ok) {
        this.db.markKey(owner, 'pending', true, r.expiresAt, Date.now());
        this.db.promoteKey(owner);
        this.signers.delete(owner);
        for (const s of this.runtime.list(owner)) void this.runtime.checkReady(s);
      }
    }
    const active = this.db.key(owner, 'active');
    if (active && (!pending || this.db.key(owner, 'pending'))) {
      const r = await this.sodex.keyRegistered(owner, active.name, active.address);
      this.db.markKey(owner, 'active', r.ok, r.expiresAt, Date.now());
    }
    return this.keyInfo(owner);
  }

  /** Stop every copy and algo and forget the keys. The follower revokes the key on SoDEX with their wallet. */
  async deleteKey(req: unknown, ctx: RequestContext): Promise<MeResponse> {
    const { owner, payload } = this.accept(req, 'delete-key', ctx);
    await this.algos.cancelAll(owner);
    await this.runtime.stopAll(owner, { close: payload.close === true });
    this.db.deleteKeys(owner);
    this.signers.delete(owner);
    return this.me(owner, ctx);
  }

  private async keyProblem(owner: string): Promise<string | null> {
    const k = this.db.key(owner, 'active');
    if (!k) return 'No copy key is registered for this executor. Approve one in copy setup.';
    const now = Date.now();
    if (!k.registered || !k.checkedAt || now - k.checkedAt > KEY_RECHECK_MS) {
      const r = await this.sodex.keyRegistered(owner, k.name, k.address);
      this.db.markKey(owner, 'active', r.ok, r.expiresAt, now);
      if (!r.ok) {
        this.signers.delete(owner);
        return r.expiresAt && r.expiresAt <= now ? 'The copy key expired. Approve a new one in copy setup.' : 'The copy key is no longer registered on SoDEX (revoked or replaced). Approve a new one in copy setup.';
      }
      return null;
    }
    if (k.expiresAt && k.expiresAt <= now) return 'The copy key expired. Approve a new one in copy setup.';
    return null;
  }

  private signer(owner: string): SigningKeyRef | null {
    const hit = this.signers.get(owner);
    if (hit) return hit;
    const k: KeyRow | null = this.db.key(owner, 'active');
    if (!k || !k.registered) return null;
    try {
      const ref = this.secrets.open(this.cfg.network, owner, k.address, k.sealed, { name: k.name, expiresAt: k.expiresAt });
      this.signers.set(owner, ref);
      return ref;
    } catch (e) {
      this.deps.log.error('copy key could not be opened', { owner, error: String(e) });
      return null;
    }
  }

  private sinkFor(s: Subscription): OrderSink | null {
    if (s.settings.paper) return this.paper;
    if (!this.db.key(s.owner, 'active')) return null;
    return new KeySink(this.sodex, () => this.signer(s.owner), this.nonces, SODEX_CHAIN_ID[this.cfg.network]);
  }

  /* ----------------------------------------------------------- copies ----- */

  private needTerms(owner: string, ctx: RequestContext): void {
    const t = this.db.terms(owner);
    if (!t || t.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(412, 'terms', 'Accept the copy trading terms first.');
    const policy = regionPolicy(t.country, ctx.viewerCountry);
    if (!policy.allowed) throw new ApiError(451, 'region', policy.reason ?? 'Copy trading is not available in your region.');
  }

  async subscribe(req: unknown, ctx: RequestContext): Promise<CopyView> {
    const { owner, payload, consent } = this.accept(req, 'subscribe', ctx);
    if (this.cfg.kind === 'hosted' && !this.cfg.open) throw new ApiError(503, 'closed', 'The ValueDesk executor takes no new copies right now. Running copies continue.');
    this.needTerms(owner, ctx);
    if (payload.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, 'terms-version', 'Reload the page: the copy terms changed.');
    let settings;
    try {
      settings = parseSettings(payload.settings);
    } catch (e) {
      throw new ApiError(400, 'settings', e instanceof SettingsError ? e.message : String(e));
    }
    const running = this.runtime.list(owner).filter((s) => s.status !== 'stopped');
    if (running.length >= this.cfg.maxCopiesPerOwner) throw new ApiError(429, 'limit', `At most ${this.cfg.maxCopiesPerOwner} copies run at once. Stop one first.`);
    if (running.some((s) => s.settings.leader.address === settings.leader.address && s.settings.leader.venue === settings.leader.venue && s.settings.paper === settings.paper)) {
      throw new ApiError(409, 'duplicate', 'You already copy this trader here. Change that copy instead.');
    }
    let accountId = 0;
    if (!settings.paper) {
      await this.verifyKey(owner);
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
    const { owner, payload, consent } = this.accept(req, ['update', 'pause', 'resume', 'stop', 'stop-all'], ctx);
    const action = (req as SignedCopyRequest).action;
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
        touched = [await this.runtime.update(s.id, { settings, consent }).catch(fail)];
      } else if (action === 'pause') touched = [await this.runtime.pause(s.id).catch(fail)];
      else if (action === 'resume') {
        this.needTerms(owner, ctx);
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

  /** The sink of an algo: the key this wallet registered for this executor, the copy fee ladder as the builder. */
  private algoSink(a: AlgoRecord): AlgoSink | null {
    if (!this.db.key(a.owner, 'active')) return null;
    return new KeyAlgoSink(this.sodex, () => this.signer(a.owner), this.nonces, SODEX_CHAIN_ID[this.cfg.network], async (x) =>
      this.cfg.builderId > 0 ? { id: this.cfg.builderId, fee: copyFeeFor(this.volumeOf(x.owner)) } : null,
    );
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
    if (this.cfg.builderId > 0) {
      const fee = copyFeeFor(this.volumeOf(a.owner));
      const approved = await this.sodex.builderApproval(a.owner, this.cfg.builderId);
      if (approved === null || approved < fee) return `Your SoDEX account does not approve the ValueDesk fee (${fee / 10} bp) these orders carry. Approve it in copy setup.`;
    }
    return null;
  }

  /** Start an algo order for the wallet that signed it. */
  async algoStart(req: unknown, ctx: RequestContext): Promise<AlgoView> {
    const { owner, payload, consent } = this.accept(req, 'algo-start', ctx);
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
    if (live.length >= this.cfg.maxAlgosPerOwner) throw new ApiError(429, 'limit', `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here. Cancel one first.`);
    let accountId = 0;
    if (!spec.paper) {
      await this.verifyKey(owner);
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
    const { owner, payload } = this.accept(req, 'algo-action', ctx);
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
        this.needTerms(owner, ctx);
        touched = [await this.algos.resume(a.id).catch(fail)];
      } else if (op === 'cancel') touched = [await this.algos.cancel(a.id).catch(fail)];
      else throw new ApiError(400, 'op', 'op must be pause, resume, cancel or cancel-all.');
    }
    return { algos: touched.map((a) => this.algos.view(a.id)).filter((v): v is AlgoView => v !== null) };
  }

  algoList(owner: string): AlgoView[] {
    return this.algos
      .list(owner)
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

  /** The follower's verified 14-day volume, USD, from the builder ledger on this server (null: not known). */
  private volumeOf(owner: string): number | null {
    if (!this.cfg.builderDb || !this.cfg.builderId) return null;
    const hit = this.volumes.get(owner);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.usd;
    let usd: number | null = null;
    try {
      if (!this.builderDb) {
        if (!existsSync(this.cfg.builderDb)) return null;
        this.builderDb = new DatabaseSync(this.cfg.builderDb, { readOnly: true });
        this.builderDb.exec('PRAGMA busy_timeout = 2000');
      }
      const fromDay = Math.floor(Date.now() / 86_400_000) - (COPY_FEE_WINDOW_DAYS - 1);
      const r = this.builderDb.prepare('SELECT sum(micro) AS m FROM days WHERE builder = ? AND address = ? AND day >= ?').get(this.cfg.builderId, owner, fromDay) as { m?: number | null } | undefined;
      usd = r && typeof r.m === 'number' ? r.m / 1e6 : 0;
    } catch (e) {
      this.deps.log.warn('copy fee: the builder ledger could not be read', { error: String(e) });
    }
    this.volumes.set(owner, { usd, at: Date.now() });
    return usd;
  }
}
