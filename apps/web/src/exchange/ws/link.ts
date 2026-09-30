/**
 * How this tab reaches the socket host - the one place in this browser that
 * holds SoDEX connections for every tab.
 *
 *  1. A SharedWorker (every desktop browser): all tabs of this origin share
 *     it, so they share its connections.
 *  2. Where there is none (Chrome on Android, older Safari): the tabs elect a
 *     leader with a Web Lock; the leader runs the host in its page and the
 *     others talk to it over a BroadcastChannel. When the leader tab closes,
 *     its lock passes to the next tab, which takes over and everyone
 *     re-subscribes.
 *  3. Neither: the tab runs its own host.
 *
 * Whatever the mode, ws.ts sees the same thing: a link that becomes `open`
 * (after which it re-sends its subscriptions) and messages in the old hub's
 * shapes.
 */
import type { SubParams } from '@sign/sodex/wsProtocol.js';
import { SocketHub, asToHost } from './socketHub';
import { WS_PROTOCOL_VERSION, type ClientPort, type ToHost, type ToTab } from './messages';
import { logger } from '../../log';

const log = logger('ws');

export type LinkState = 'connecting' | 'open' | 'reconnecting';
export type LinkMode = 'worker' | 'leader' | 'follower' | 'local';

/** Messages a tab sends, before the link stamps its client id on them. */
export type Outgoing =
  | { op: 'subscribe'; engine: 'spot' | 'perps'; params: SubParams; wsBase: string }
  | { op: 'unsubscribe'; engine: 'spot' | 'perps'; params: SubParams };

export interface HostLink {
  readonly clientId: string;
  mode(): LinkMode;
  state(): LinkState;
  post(msg: Outgoing): void;
  onMessage(cb: (msg: ToTab) => void): () => void;
  onState(cb: (s: LinkState) => void): () => void;
}

const CHANNEL = `vs-exchange-v${WS_PROTOCOL_VERSION}`;
const LEADER_LOCK = `vs-exchange-leader-v${WS_PROTOCOL_VERSION}`;
const PING_MS = 10_000;
const HELLO_RETRY_MS = 2_000;
/** A SharedWorker that has not said hello by then is treated as unavailable. */
// A dev server compiles the worker on first use, which can take a while on a cold start.
const WORKER_HELLO_TIMEOUT_MS = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? 20_000 : 5_000;

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Shared plumbing: listeners, state, the client id. */
abstract class BaseLink implements HostLink {
  readonly clientId = randomId();
  protected current: LinkState = 'connecting';
  protected msgListeners = new Set<(msg: ToTab) => void>();
  protected stateListeners = new Set<(s: LinkState) => void>();

  abstract mode(): LinkMode;
  abstract post(msg: Outgoing): void;

  state(): LinkState {
    return this.current;
  }

  onMessage(cb: (msg: ToTab) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  protected setState(s: LinkState): void {
    if (this.current === s) return;
    this.current = s;
    for (const cb of [...this.stateListeners]) cb(s);
  }

  protected deliver(msg: ToTab): void {
    if (msg.to && !msg.to.includes(this.clientId)) return;
    if (msg.type === 'hello') {
      this.setState('open');
      return;
    }
    for (const cb of [...this.msgListeners]) {
      try {
        cb(msg);
      } catch (e) {
        console.error('[ws] listener threw', e);
      }
    }
  }
}

// --- 3. this tab only ------------------------------------------------------------------------

class LocalLink extends BaseLink {
  private hub = new SocketHub({ host: 'local' });
  private port: ClientPort = { id: this.clientId, send: (m) => queueMicrotask(() => this.deliver(m)) };

  constructor() {
    super();
    this.hub.handle({ op: 'hello', client: this.clientId, v: WS_PROTOCOL_VERSION }, this.port);
    setInterval(() => this.hub.handle({ op: 'ping', client: this.clientId }, this.port), PING_MS);
  }

  mode(): LinkMode {
    return 'local';
  }

  post(msg: Outgoing): void {
    this.hub.handle({ ...msg, client: this.clientId } as ToHost, this.port);
  }
}

// --- 1. SharedWorker --------------------------------------------------------------------------

class WorkerLink extends BaseLink {
  private port: MessagePort;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onUnavailable: () => void) {
    super();
    // A literal name and options: Vite bundles the worker from this exact expression.
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'vs-exchange-v1' });
    this.port = worker.port;
    this.port.onmessage = (e: MessageEvent) => this.deliver(e.data as ToTab);
    worker.onerror = () => this.fail('the shared worker failed to start');
    this.port.start();
    this.hello();
    this.helloTimer = setTimeout(() => {
      if (this.current !== 'open') this.fail('the shared worker did not answer');
    }, WORKER_HELLO_TIMEOUT_MS);
    setInterval(() => this.send({ op: 'ping', client: this.clientId }), PING_MS);
    addEventListener('pagehide', () => this.send({ op: 'bye', client: this.clientId }));
    addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) {
        // Back from the bfcache: the worker forgot this tab. Say hello again -
        // and if the browser stopped the worker meanwhile, nothing answers:
        // then the tabs elect a leader, as when the worker never started.
        this.setState('reconnecting');
        this.hello();
        clearTimeout(this.helloTimer);
        this.helloTimer = setTimeout(() => {
          if (this.current !== 'open') this.fail('the shared worker did not answer after the page came back');
        }, WORKER_HELLO_TIMEOUT_MS);
      }
    });
  }

  private failed = false;

  private fail(why: string): void {
    if (this.failed || this.current === 'open') return;
    this.failed = true;
    log.warn(`${why}; the tabs elect a leader instead`);
    this.onUnavailable();
  }

  private hello(): void {
    this.send({ op: 'hello', client: this.clientId, v: WS_PROTOCOL_VERSION });
  }

  private send(msg: ToHost): void {
    try {
      this.port.postMessage(msg);
    } catch {
      /* worker gone */
    }
  }

  protected override deliver(msg: ToTab): void {
    if (msg && msg.type === 'error' && /unknown client/.test(msg.message)) {
      // The worker restarted under us: register again, then re-subscribe.
      this.setState('reconnecting');
      this.hello();
      return;
    }
    if (msg?.type === 'hello' && this.helloTimer !== undefined) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
    super.deliver(msg);
  }

  mode(): LinkMode {
    return 'worker';
  }

  post(msg: Outgoing): void {
    this.send({ ...msg, client: this.clientId } as ToHost);
  }
}

// --- 2. leader election over a BroadcastChannel ------------------------------------------------

/** What leader election needs from the browser - injectable, so two "tabs" can be tested in Node. */
export interface LeaderDeps {
  /** A BroadcastChannel-like channel every tab of this origin shares. */
  channel(): { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null; close(): void };
  /** Web Locks: `cb` runs once this tab holds `name`; the lock is held while its promise is pending. */
  requestLock(name: string, cb: () => Promise<void>): void;
  /** The page is going away (pagehide). */
  onPageHide(cb: () => void): void;
  /** The socket host a tab runs once it leads (tests pass one with fake sockets). */
  makeHub(): SocketHub;
}

const browserLeaderDeps = (): LeaderDeps => ({
  channel: () => new BroadcastChannel(CHANNEL) as unknown as ReturnType<LeaderDeps['channel']>,
  requestLock: (name, cb) => {
    void (navigator as Navigator & { locks: { request(n: string, c: () => Promise<void>): Promise<void> } }).locks.request(name, cb);
  },
  onPageHide: (cb) => addEventListener('pagehide', cb),
  makeHub: () => new SocketHub({ host: 'leader' }),
});

export class LeaderLink extends BaseLink {
  private bc: ReturnType<LeaderDeps['channel']>;
  private hub: SocketHub | null = null;
  private helloTimer: ReturnType<typeof setInterval> | undefined;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private closed = false;
  /** Releases the leader lock (tests: "this tab closed"). The browser releases it by itself. */
  private release: (() => void) | null = null;
  private selfPort: ClientPort = { id: this.clientId, send: (m) => queueMicrotask(() => this.deliver(m)) };

  constructor(private readonly deps: LeaderDeps = browserLeaderDeps()) {
    super();
    this.bc = deps.channel();
    this.bc.onmessage = (e) => this.onChannel(e.data);
    deps.requestLock(LEADER_LOCK, () => {
      if (this.closed) return Promise.resolve();
      this.becomeLeader();
      // Held for the life of this tab; the browser releases it when the tab goes.
      return new Promise<void>((resolve) => (this.release = resolve));
    });
    this.startHello();
    this.timers.push(setInterval(() => {
      if (this.hub) this.hub.handle({ op: 'ping', client: this.clientId }, this.selfPort);
      else this.bc.postMessage({ op: 'ping', client: this.clientId } satisfies ToHost);
    }, PING_MS));
    deps.onPageHide(() => {
      if (!this.hub) this.bc.postMessage({ op: 'bye', client: this.clientId } satisfies ToHost);
    });
  }

  mode(): LinkMode {
    return this.hub ? 'leader' : 'follower';
  }

  /** Say hello until a host answers (at start, and after a leader change). */
  private startHello(): void {
    if (this.helloTimer !== undefined) clearInterval(this.helloTimer);
    const hello = () => {
      if (this.current === 'open' || this.closed) {
        clearInterval(this.helloTimer);
        this.helloTimer = undefined;
        return;
      }
      if (this.hub) this.hub.handle({ op: 'hello', client: this.clientId, v: WS_PROTOCOL_VERSION }, this.selfPort);
      else this.bc.postMessage({ op: 'hello', client: this.clientId, v: WS_PROTOCOL_VERSION } satisfies ToHost);
    };
    hello();
    this.helloTimer = setInterval(hello, HELLO_RETRY_MS);
  }

  private becomeLeader(): void {
    log.info('this tab now holds the exchange connections for every tab');
    this.hub = this.deps.makeHub();
    this.timers.push(setInterval(() => this.hub?.sweep(), 10_000));
    // Everyone re-registers with the new host (and re-subscribes once it answers).
    this.bc.postMessage({ type: 'leader', id: this.clientId } satisfies ToTab);
    this.setState('reconnecting');
    this.startHello();
  }

  private portFor(client: string): ClientPort {
    return {
      id: client,
      send: (m) => {
        try {
          this.bc.postMessage({ ...m, to: [client] });
        } catch {
          /* channel closed */
        }
      },
    };
  }

  private onChannel(data: unknown): void {
    if (this.closed) return;
    // As the host: a follower's request.
    if (this.hub) {
      const msg = asToHost(data);
      if (msg && msg.client !== this.clientId) this.hub.handle(msg, this.portFor(msg.client));
      return;
    }
    // As a follower: the host's answer, or a new leader.
    const m = data as ToTab | null;
    if (!m || typeof m !== 'object' || !('type' in m)) return;
    if (m.type === 'leader') {
      this.setState('reconnecting');
      this.startHello();
      return;
    }
    this.deliver(m);
  }

  post(msg: Outgoing): void {
    const full = { ...msg, client: this.clientId } as ToHost;
    if (this.hub) this.hub.handle(full, this.selfPort);
    else this.bc.postMessage(full);
  }

  /** The tab goes away: its sockets close, its channel closes, the lock passes on. */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.helloTimer !== undefined) clearInterval(this.helloTimer);
    this.hub?.close();
    this.hub = null;
    this.bc.close();
    this.release?.();
  }
}

// --- choosing ---------------------------------------------------------------------------------

/** A link that starts on the best transport and falls back if it does not come up. */
class AdaptiveLink implements HostLink {
  private inner: HostLink;
  private offMsg: () => void = () => {};
  private offState: () => void = () => {};
  private msgListeners = new Set<(msg: ToTab) => void>();
  private stateListeners = new Set<(s: LinkState) => void>();
  private last: LinkState = 'connecting';

  constructor() {
    this.inner = this.pick();
    this.attach();
  }

  get clientId(): string {
    return this.inner.clientId;
  }

  private pick(): HostLink {
    const g = globalThis as { SharedWorker?: unknown; BroadcastChannel?: unknown; navigator?: { locks?: unknown } };
    if (typeof g.SharedWorker === 'function') {
      try {
        return new WorkerLink(() => this.fallBack());
      } catch (e) {
        log.warn('shared worker unavailable', { error: String(e) });
      }
    }
    return this.second();
  }

  private second(): HostLink {
    const g = globalThis as { BroadcastChannel?: unknown; navigator?: { locks?: unknown } };
    if (typeof g.BroadcastChannel === 'function' && g.navigator?.locks) return new LeaderLink();
    return new LocalLink();
  }

  private fallBack(): void {
    this.offMsg();
    this.offState();
    this.inner = this.second();
    this.attach();
  }

  private attach(): void {
    this.offMsg = this.inner.onMessage((m) => {
      for (const cb of [...this.msgListeners]) cb(m);
    });
    this.offState = this.inner.onState((s) => this.emit(s));
    this.emit(this.inner.state());
  }

  private emit(s: LinkState): void {
    if (s === this.last) return;
    this.last = s;
    for (const cb of [...this.stateListeners]) cb(s);
  }

  mode(): LinkMode {
    return this.inner.mode();
  }

  state(): LinkState {
    return this.last;
  }

  post(msg: Outgoing): void {
    this.inner.post(msg);
  }

  onMessage(cb: (msg: ToTab) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }
}

let link: HostLink | null = null;

/** This tab's link to the socket host, opened on first use. */
export function hostLink(): HostLink {
  link ??= new AdaptiveLink();
  return link;
}
