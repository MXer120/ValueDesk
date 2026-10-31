/**
 * Mode 1, "This browser": the copy engine runs in this tab.
 *
 * THE KEY. A copy key of its own (`vd-copy-browser`), generated here, kept in
 * this browser's vault under the 'copy' slot (sealed under a non-extractable
 * device key, like the trading key), registered on the follower's perps
 * account with one wallet signature for at most 7 days. It never leaves this
 * browser; no ValueDesk server sees it, an order, or the copy rules.
 *
 * ONE TAB RUNS. Every tab asks for the Web Lock `vd-copy-run:<wallet>`; the
 * tab that holds it runs the copier, the others wait in line (and take over
 * when that tab closes). The running tab publishes its views to IndexedDB;
 * the others read them, and send commands (start, pause, stop, ...) over a
 * BroadcastChannel to the running tab. Without Web Locks the tab just runs.
 *
 * WHILE NO TAB IS OPEN NOTHING IS COPIED. Stop-loss / take-profit orders the
 * copier placed stay on SoDEX; leader trades in the meantime are not copied,
 * and when a tab opens again the copier re-reads the leader and the account.
 */
import {
  CopyRuntime,
  HyperliquidClient,
  KeySink,
  PaperSink,
  SodexClient,
  WeightBudget,
  copyFeeFor,
  randomId,
  regionPolicy,
  type CopySettings,
  type CopyView,
  type Intent,
  type LeaderEvent,
  type Subscription,
  type WebSocketLike,
} from '@copy-engine';
import { destroyTradingKey, generateTradingKey, signingKeyFrom, type SigningKeyRef } from '@sodex-core';
import { tradingConfig } from '../trading/config';
import { nonces } from '../trading/session';
import { openVault, type KeyVault, type StoredKey } from '../trading/vault';
import { logger } from '../log';
import { openBrowserStore, type BrowserStore } from './browserStore';
import { copyKeyRegistered } from './sodexSetup';
import { holdReloadWhile } from '../lazyPage';
import { takeEngineNotice } from '../engineNotices';

const log = logger('copy');

export const BROWSER_KEY_NAME = 'vd-copy-browser';
const CHANNEL = 'vd-copy';

export type CopierRole = 'off' | 'starting' | 'runner' | 'standby';

export interface BrowserKey {
  address: string;
  name: string;
  expiresAt: number;
  accountId: number;
}

export interface PendingConfirm {
  id: string;
  sub: Subscription;
  intents: Intent[];
  event: LeaderEvent;
  expiresAt: number;
}

type Command =
  | { op: 'add'; sub: Subscription }
  | { op: 'update'; id: string; settings: CopySettings }
  | { op: 'pause'; id: string }
  | { op: 'resume'; id: string }
  | { op: 'stop'; id: string; close: boolean }
  | { op: 'stop-all'; close: boolean };

type Msg =
  | { t: 'cmd'; rid: string; owner: string; cmd: Command }
  | { t: 'res'; rid: string; ok: boolean; error?: string }
  | { t: 'changed'; owner: string };

const CONFIRM_MS = 60_000;

/**
 * THE COPY FEE this browser's orders carry, tenths of a bp: the copy ladder's
 * top step (COPY_FEE_MAX, 2.5 bp), whatever the follower's volume.
 *
 * The ladder's step is that of the follower's verified volume of the last
 * COPY_FEE_WINDOW_DAYS (14) days, and the executors read it from the builder
 * ledger: on the API server's GET /api/vs/builder/volume, which answers only
 * the internal token (a browser cannot ask it). The signed fee terms
 * (trading/terms.ts) carry a volume too, but it is display data - not signed,
 * so it decides no fee - and counted over the server's own window (lifetime,
 * or 1 to 90 days), not necessarily 14. With no source here that is both
 * verified and of the ladder's window, the browser charges the top step, as a
 * self-hosted executor (which reads no volume either) does, rather than a step
 * from the wrong number. The follower's approval (COPY_FEE_MAX) covers it.
 */
export function browserCopyFee(): number {
  return copyFeeFor(null);
}

const lockManager = (): { request: (name: string, cb: () => Promise<void>) => Promise<void> } | null => {
  const l = (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<void>) => Promise<void> } }).locks;
  return l ?? null;
};

class BrowserCopier {
  role: CopierRole = 'off';
  owner: string | null = null;
  key: BrowserKey | null = null;
  views: CopyView[] = [];
  confirms: PendingConfirm[] = [];
  /** The country the hosted executor saw this browser come from (null: not asked / unknown). */
  viewerCountry: string | null = null;
  persistent = true;

  private runtime: CopyRuntime | null = null;
  private store: BrowserStore | null = null;
  private signer: SigningKeyRef | null = null;
  private vaultP: Promise<KeyVault> | null = null;
  private release: (() => void) | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  private waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private confirmResolvers = new Map<string, (yes: boolean | 'timeout') => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (this.channel) this.channel.onmessage = (e) => void this.onMessage(e.data as Msg);
    // Outside a browser (tests, tooling) nothing here may keep the process alive.
    (this.channel as unknown as { unref?: () => void } | null)?.unref?.();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private vault(): Promise<KeyVault> {
    return (this.vaultP ??= openVault('copy'));
  }

  /* ------------------------------------------------------------- wallet ----- */

  /** Follow the connected wallet: load its copy key and copies, and run them in one tab. */
  async follow(owner: string | null): Promise<void> {
    const next = owner ? owner.toLowerCase() : null;
    if (next === this.owner) return;
    await this.shutdown();
    this.owner = next;
    this.key = null;
    this.views = [];
    this.confirms = [];
    if (!next) {
      this.role = 'off';
      this.emit();
      return;
    }
    const gen = ++this.generation;
    this.store = await openBrowserStore();
    this.persistent = this.store.persistent;
    await this.loadKey(next);
    if (gen !== this.generation) return;
    const subs = (await this.store.subscriptions()).filter((s) => s.owner === next);
    // Nothing to run and no key: nothing to hold a lock for.
    if (!subs.length) {
      this.role = 'off';
      await this.refreshViews();
      return;
    }
    this.acquire(next, gen);
  }

  private acquire(owner: string, gen: number): void {
    const locks = lockManager();
    this.role = 'starting';
    this.emit();
    const run = async () => {
      if (gen !== this.generation) return;
      this.stopPolling();
      await this.startRuntime(owner);
      await new Promise<void>((r) => (this.release = r));
      await this.stopRuntime();
    };
    if (!locks) {
      void run();
      return;
    }
    // Until the lock is ours, another tab runs the copier: read what it publishes.
    this.role = 'standby';
    this.startPolling();
    this.emit();
    void locks.request(`vd-copy-run:${owner}`, run).catch((e) => log.warn('copy: lock failed', { error: String(e) }));
  }

  private async shutdown(): Promise<void> {
    this.generation++;
    this.stopPolling();
    const r = this.release;
    this.release = null;
    if (r) r();
    else await this.stopRuntime();
    this.signer = null;
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => void this.refreshViews(), 3_000);
    void this.refreshViews();
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async refreshViews(): Promise<void> {
    if (!this.store || !this.owner) return;
    if (this.runtime) {
      this.views = this.runtime.list(this.owner).map((s) => this.runtime!.view(s.id)).filter((v): v is CopyView => !!v);
    } else {
      this.views = (await this.store.views()).filter((v) => v.subscription.owner === this.owner);
    }
    this.views.sort((a, b) => b.subscription.createdAt - a.subscription.createdAt);
    this.emit();
  }

  /* ---------------------------------------------------------------- key ----- */

  private async loadKey(owner: string): Promise<void> {
    const cfg = tradingConfig();
    const v = await this.vault();
    const hit = await v.load(cfg.network, owner);
    if (!hit) {
      this.key = null;
      this.signer = null;
      return;
    }
    this.key = { address: hit.meta.keyAddress, name: hit.meta.name, expiresAt: hit.meta.expiresAt, accountId: hit.meta.accountId };
    this.signer = signingKeyFrom({ privateKey: hit.privateKey, address: hit.meta.keyAddress }, { name: hit.meta.name, expiresAt: hit.meta.expiresAt });
  }

  /** A fresh key for the follower's wallet to register. Kept only once registered (`adoptKey`). */
  newKey(): { address: string; privateKey: Uint8Array } {
    const k = generateTradingKey();
    const out = { address: k.address.toLowerCase(), privateKey: k.privateKey.slice() };
    destroyTradingKey(k);
    return out;
  }

  /** The key was registered on SoDEX: keep it in this browser's vault and use it. */
  async adoptKey(owner: string, k: { address: string; privateKey: Uint8Array }, reg: { expiresAt: number; accountId: number }): Promise<void> {
    const cfg = tradingConfig();
    const meta: StoredKey = {
      v: 1,
      network: cfg.network,
      owner: owner.toLowerCase(),
      accountId: reg.accountId,
      name: BROWSER_KEY_NAME,
      keyAddress: k.address,
      expiresAt: reg.expiresAt,
      createdAt: Date.now(),
      builder: null,
      engines: ['perps'],
    };
    const v = await this.vault();
    await v.save(meta, k.privateKey, { persist: true });
    k.privateKey.fill(0);
    if (this.owner === owner.toLowerCase()) {
      await this.loadKey(this.owner);
      for (const s of this.runtime?.list(this.owner) ?? []) void this.runtime!.checkReady(s);
    }
    this.emit();
  }

  /** Forget the key here (its revocation on SoDEX is the wallet's, sodexSetup.revokeCopyKey). */
  async dropKey(): Promise<void> {
    if (!this.owner) return;
    const v = await this.vault();
    await v.remove(tradingConfig().network, this.owner);
    this.key = null;
    this.signer = null;
    this.emit();
  }

  /* ------------------------------------------------------------ runtime ----- */

  private async startRuntime(owner: string): Promise<void> {
    const cfg = tradingConfig();
    const fetchFn = (url: string, init?: RequestInit) => fetch(url, { ...init, credentials: 'omit', mode: 'cors', cache: 'no-store' });
    // Half of this IP's REST budget (the app's own reads draw on the rest); half of the limit SoDEX reports, once it does.
    const sodex = new SodexClient({ network: cfg.network, gateway: cfg.gateway, fetch: fetchFn as never, budget: new WeightBudget(600) });
    const paper = new PaperSink();
    const store = this.store!;
    // The runtime runs every copy in this browser's store; only this wallet's are ours to run.
    const scoped: BrowserStore = {
      persistent: store.persistent,
      subscriptions: async () => (await store.subscriptions()).filter((s) => s.owner === owner),
      subscription: (id) => store.subscription(id),
      saveSubscription: (s) => store.saveSubscription(s),
      state: (id) => store.state(id),
      saveState: (s) => store.saveState(s),
      addActivity: (e) => store.addActivity(e),
      activity: (q) => store.activity(q),
      views: () => store.views(),
      putViews: (v) => store.putViews(v),
    };
    this.runtime = new CopyRuntime({
      store: scoped,
      sodex,
      hyperliquid: new HyperliquidClient(fetchFn as never),
      factory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      network: cfg.network,
      hlMode: 'user',
      log,
      sinkFor: (s) => (s.settings.paper ? paper : this.signer ? new KeySink(sodex, () => this.signer, nonces(), cfg.chainId) : null),
      builderFor: async () => (cfg.builder ? { id: cfg.builder.id, fee: browserCopyFee() } : null),
      policyFor: (s) => regionPolicy(s.country, s.observedCountry ?? this.viewerCountry),
      keyProblem: async (s) => {
        const k = this.key;
        if (!k || !this.signer) return 'No copy key in this browser. Approve one in copy setup.';
        if (k.expiresAt <= Date.now()) return 'The copy key in this browser expired. Approve a new one in copy setup.';
        const r = await copyKeyRegistered(s.owner, k.name, k.address).catch(() => null);
        if (r && !r.ok) return 'The copy key is no longer registered on SoDEX (revoked, replaced or expired). Approve a new one in copy setup.';
        return null;
      },
      // The operator's emergency brake (/api/health): nothing is sent while it is on.
      brake: () => {
        const b = tradingConfig().brake;
        return b?.copies || b?.trading ? `ValueDesk paused copy trading: ${b.reason}` : null;
      },
      confirm: (s, intents, event) => this.askConfirm(s, intents, event),
      onChange: () => this.schedulePublish(),
      // Halted, held, stopped, a position closed outside the copier: the bell, the wallet's inbox (engineNotices.ts).
      onNotice: (n) => takeEngineNotice(n),
    });
    await this.runtime.start();
    this.role = 'runner';
    await this.refreshViews();
    this.schedulePublish();
    log.info('browser copier running', { owner, copies: this.runtime.list(owner).length });
  }

  private async stopRuntime(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (rt) await rt.stop().catch(() => {});
    for (const [, resolve] of this.confirmResolvers) resolve(false);
    this.confirmResolvers.clear();
    this.confirms = [];
  }

  private schedulePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publish();
    }, 500);
  }

  private async publish(): Promise<void> {
    if (!this.runtime || !this.store || !this.owner) return;
    await this.refreshViews();
    const all = (await this.store.views()).filter((v) => v.subscription.owner !== this.owner);
    await this.store.putViews([...all, ...this.views]).catch(() => {});
    this.channel?.postMessage({ t: 'changed', owner: this.owner } satisfies Msg);
  }

  /* --------------------------------------------------------- commands ----- */

  /** Run a command here when this tab runs the copier, else in the tab that does. */
  private async command(cmd: Command): Promise<void> {
    if (!this.owner) throw new Error('Connect your wallet first.');
    if (this.runtime) return this.apply(cmd);
    if (this.role === 'off') {
      // The first copy of this wallet in this browser: this tab starts the copier, then adds it
      // (adding is what reads the leader and leaves positions already open alone).
      if (cmd.op !== 'add') throw new Error('No copy is running in this browser.');
      this.acquire(this.owner, this.generation);
      await this.whenRunning(5_000);
      if (this.runtime) return this.apply(cmd);
    }
    if (!this.channel) throw new Error('Copying runs in another tab of this browser. Use that tab.');
    const rid = randomId('r');
    const done = new Promise<void>((resolve, reject) => {
      this.waiting.set(rid, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.delete(rid)) reject(new Error('The tab that runs your copies did not answer. Close other ValueDesk tabs and try again.'));
      }, 10_000);
    });
    this.channel.postMessage({ t: 'cmd', rid, owner: this.owner, cmd } satisfies Msg);
    await done;
  }

  private async whenRunning(ms: number): Promise<void> {
    const t0 = Date.now();
    while (!this.runtime && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  }

  private async apply(cmd: Command): Promise<void> {
    const rt = this.runtime!;
    switch (cmd.op) {
      case 'add':
        // The runtime loaded the store at start: a copy saved since is added, not re-added.
        if (!rt.get(cmd.sub.id)) await rt.add(cmd.sub);
        break;
      case 'update':
        await rt.update(cmd.id, { settings: cmd.settings });
        break;
      case 'pause':
        await rt.pause(cmd.id);
        break;
      case 'resume':
        await rt.resume(cmd.id);
        break;
      case 'stop':
        await rt.stopCopy(cmd.id, { close: cmd.close });
        break;
      case 'stop-all':
        await rt.stopAll(this.owner!, { close: cmd.close });
        break;
    }
    await this.publish();
  }

  private async onMessage(m: Msg): Promise<void> {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'changed' && m.owner === this.owner && !this.runtime) {
      await this.refreshViews();
      return;
    }
    if (m.t === 'res') {
      const w = this.waiting.get(m.rid);
      if (!w) return;
      this.waiting.delete(m.rid);
      if (m.ok) w.resolve();
      else w.reject(new Error(m.error ?? 'The command failed.'));
      return;
    }
    if (m.t === 'cmd' && this.runtime && m.owner === this.owner) {
      try {
        await this.apply(m.cmd);
        this.channel?.postMessage({ t: 'res', rid: m.rid, ok: true } satisfies Msg);
      } catch (e) {
        this.channel?.postMessage({ t: 'res', rid: m.rid, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Msg);
      }
    }
  }

  /* -------------------------------------------------------- the copies ----- */

  async start(o: { owner: string; settings: CopySettings; country: string; termsVersion: string }): Promise<void> {
    if (!o.settings.paper && !this.key) throw new Error('Approve a copy key for this browser first.');
    const now = Date.now();
    const sub: Subscription = {
      id: randomId('b'),
      owner: o.owner.toLowerCase(),
      accountId: this.key?.accountId ?? 0,
      mode: 'browser',
      settings: o.settings,
      status: 'active',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      country: o.country,
      observedCountry: this.viewerCountry,
      termsVersion: o.termsVersion,
      consent: null,
    };
    await this.command({ op: 'add', sub });
  }

  update = (id: string, settings: CopySettings) => this.command({ op: 'update', id, settings });
  pause = (id: string) => this.command({ op: 'pause', id });
  resume = (id: string) => this.command({ op: 'resume', id });
  stop = (id: string, close: boolean) => this.command({ op: 'stop', id, close });
  stopAll = (close: boolean) => this.command({ op: 'stop-all', close });

  async activity(id: string, limit = 300) {
    return (await openBrowserStore()).activity({ subId: id, limit });
  }

  /* ------------------------------------------------------- confirmation ----- */

  private askConfirm(sub: Subscription, intents: Intent[], event: LeaderEvent): Promise<boolean | 'timeout'> {
    const id = randomId('q');
    const item: PendingConfirm = { id, sub, intents, event, expiresAt: Date.now() + CONFIRM_MS };
    this.confirms = [...this.confirms, item];
    this.emit();
    return new Promise<boolean | 'timeout'>((resolve) => {
      const done = (yes: boolean | 'timeout') => {
        if (!this.confirmResolvers.delete(id)) return;
        this.confirms = this.confirms.filter((c) => c.id !== id);
        this.emit();
        resolve(yes);
      };
      this.confirmResolvers.set(id, done);
      // Unanswered: the copy's activity says "not confirmed in time", not that the follower declined.
      setTimeout(() => done('timeout'), CONFIRM_MS);
    });
  }

  answer(id: string, yes: boolean): void {
    this.confirmResolvers.get(id)?.(yes);
  }
}

export const browserCopier = new BrowserCopier();

// A release never reloads the tab that runs live copies (lazyPage.ts): a leader's trade could be missed meanwhile.
holdReloadWhile(() => {
  if (browserCopier.role !== 'runner') return null;
  const n = browserCopier.views.filter((v) => v.subscription.status === 'active').length;
  return n ? `${n} live cop${n === 1 ? 'y' : 'ies'}` : null;
});
