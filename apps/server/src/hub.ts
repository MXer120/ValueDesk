/**
 * Browser-facing WebSocket hub.
 *
 * Browser tabs never talk to SoDEX directly. They subscribe here; the hub keeps
 * one refcounted upstream subscription per (channel, params) and fans pushes out,
 * filtered to exactly what each client asked for.
 *
 * Client -> server:
 *   {op:"subscribe",   engine, params:{channel, symbol|symbols, interval, level, user}}
 *   {op:"unsubscribe", engine, params:{...}}
 *   {op:"ping"}
 * Server -> client:
 *   {type:"push",   engine, channel, pushType:"snapshot"|"update", data}
 *   {type:"status", engine, status}
 *   {type:"ack"|"error"|"pong", ...}
 */
import type { WebSocket } from 'ws';
import type { Engine } from './config.js';
import {
  ACCOUNT_CHANNELS,
  ARRAY_CHANNELS,
  accountStats,
  onAccountUpstream,
  releaseUpstream,
  subKey,
  symbolsIn,
  upstreamFor,
  upstreams,
  type SubParams,
  type Upstream,
} from './sodex/ws.js';

/**
 * Whether an account push belongs to a subscription: only when the wallet that
 * received it is exactly the one subscribed. A push that names no wallet goes
 * nowhere - one wallet's fills must never reach another wallet's listeners.
 */
export function accountPushFor(subUser: string | undefined, msgUser: unknown): boolean {
  const want = subUser?.trim().toLowerCase();
  const got = typeof msgUser === 'string' ? msgUser.trim().toLowerCase() : '';
  return !!want && !!got && want === got;
}

interface ClientSub {
  engine: Engine;
  /** The connection holding it: the shared one, or the wallet's own (account channels). */
  up: Upstream;
  params: SubParams;
  /** Upstream key held on this client's behalf, for refcount release. */
  key: string;
  /** Symbols this client wants; empty means "everything on the channel". */
  wanted: Set<string>;
}

let nextClientId = 1;

/**
 * Per-connection subscription ceiling.
 *
 * Each local subscription can pin an upstream one, so an unbounded client can
 * grow this process's memory and the gateway's connection state without limit.
 * The real UI holds well under 100 across every panel; 512 is far above that and
 * far below anything that hurts.
 */
const MAX_SUBS_PER_CLIENT = 512;

export class HubClient {
  readonly id = nextClientId++;
  private subs = new Map<string, ClientSub>();
  private alive = true;

  constructor(private readonly ws: WebSocket) {}

  send(obj: unknown): void {
    if (this.alive && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  handle(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send({ type: 'error', message: 'invalid JSON' });
    }

    if (msg.op === 'ping') return this.send({ type: 'pong' });

    const engine: Engine = msg.engine === 'spot' ? 'spot' : 'perps';
    const params = msg.params as SubParams | undefined;
    if (!params?.channel) return this.send({ type: 'error', message: 'params.channel is required' });

    if (msg.op === 'subscribe') return this.subscribe(engine, params);
    if (msg.op === 'unsubscribe') return this.unsubscribe(engine, params);
    this.send({ type: 'error', message: `unknown op ${msg.op}` });
  }

  /**
   * A note on account channels, because this looks like a missing check.
   *
   * `accountOrderUpdate`, `accountTrade`, `accountUpdate` and `accountState`
   * carry one wallet's orders, fills and balance changes, and this hub forwards
   * `params.user` to the gateway verbatim for whatever address is asked for.
   * There is deliberately no ownership check here, and adding one would be
   * theatre:
   *
   *   SoDEX serves this data publicly and unauthenticated. `GET /api/v1/perps/
   *   accounts/<any address>/state` and the spot balances endpoint both answer
   *   200 for an address you have never controlled, and the upstream WebSocket
   *   is opened with no credentials at all. Anyone can read any wallet's
   *   activity by talking to the gateway directly.
   *
   * So gating it here would remove nothing from an attacker (this socket already
   * requires the local API token) while breaking a flow that must work: seeing
   * your own balances after connecting a wallet but BEFORE enabling trading,
   * when no signing session exists yet. The Scan and Portfolio features are
   * built on the same public-by-upstream data.
   *
   * This is worth knowing about, and worth raising with SoDEX - it is their
   * authorisation gap, not ours - but it is not one this process can close.
   */
  private subscribe(engine: Engine, params: SubParams): void {
    const localKey = `${engine}:${subKey(params)}`;
    if (this.subs.has(localKey)) return; // idempotent
    if (this.subs.size >= MAX_SUBS_PER_CLIENT) {
      return this.send({
        type: 'error',
        op: 'subscribe',
        channel: params.channel,
        message: `subscription limit reached (${MAX_SUBS_PER_CLIENT})`,
      });
    }

    const up = upstreamFor(engine, params);
    if (!up) {
      // An account channel with no wallet, or no room for another wallet's
      // connection: no live stream, the page's polling covers it.
      return this.send({ type: 'error', op: 'subscribe', engine, channel: params.channel, message: 'account stream unavailable' });
    }
    const { key, snapshot } = up.subscribe(params);
    const wanted = new Set<string>(
      [params.symbol, ...(params.symbols ?? [])].filter(Boolean) as string[],
    );
    this.subs.set(localKey, { engine, up, params, key, wanted });
    this.send({ type: 'ack', op: 'subscribe', engine, channel: params.channel, key: localKey });

    // Seed a late joiner from the cached snapshot so its panel is never blank.
    if (snapshot) this.deliver(engine, snapshot);
  }

  private unsubscribe(engine: Engine, params: SubParams): void {
    const localKey = `${engine}:${subKey(params)}`;
    const sub = this.subs.get(localKey);
    if (!sub) return;
    this.subs.delete(localKey);
    sub.up.unsubscribe(sub.key);
    releaseUpstream(sub.up);
    this.send({ type: 'ack', op: 'unsubscribe', engine, channel: params.channel, key: localKey });
  }

  /**
   * Route one upstream push to this client, narrowed to its subscriptions.
   *
   * Array payloads are filtered per-client rather than forwarded whole: a client
   * watching BTC-USD should not receive (or have to discard) 40 other symbols.
   */
  deliver(engine: Engine, msg: any): void {
    const channel = msg?.channel;
    if (!channel) return;

    for (const sub of this.subs.values()) {
      if (sub.engine !== engine || sub.params.channel !== channel) continue;

      if (ACCOUNT_CHANNELS.has(channel)) {
        if (!accountPushFor(sub.params.user, msg?.user ?? msg?.data?.user)) continue;
        this.push(engine, msg, msg.data, sub.params.user?.toLowerCase());
        continue;
      }

      if (Array.isArray(msg.data) && ARRAY_CHANNELS.has(channel)) {
        const data = sub.wanted.size
          ? msg.data.filter((e: any) => sub.wanted.has(e?.s))
          : msg.data;
        if (data.length) this.push(engine, msg, data);
        continue;
      }

      const syms = symbolsIn(msg);
      if (sub.wanted.size && !syms.some((s) => sub.wanted.has(s))) continue;
      if (sub.params.interval && msg?.data?.i && msg.data.i !== sub.params.interval) continue;
      this.push(engine, msg, msg.data);
    }
  }

  /** `user`: the wallet an account push belongs to, so the browser can route it exactly too. */
  private push(engine: Engine, msg: any, data: unknown, user?: string): void {
    this.send({ type: 'push', engine, channel: msg.channel, pushType: msg.type, data, ...(user ? { user } : {}) });
  }

  close(): void {
    this.alive = false;
    for (const sub of this.subs.values()) {
      sub.up.unsubscribe(sub.key);
      releaseUpstream(sub.up);
    }
    this.subs.clear();
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }
}

// --- registry ----------------------------------------------------------------

const clients = new Set<HubClient>();

export function addClient(ws: WebSocket): HubClient {
  const c = new HubClient(ws);
  clients.add(c);
  for (const engine of ['spot', 'perps'] as Engine[]) {
    c.send({ type: 'status', engine, status: upstreams[engine].status });
  }
  return c;
}

export function removeClient(c: HubClient): void {
  c.close();
  clients.delete(c);
}

/** Wire upstream events into the fan-out. Call once at boot. */
export function startHub(): void {
  for (const engine of ['spot', 'perps'] as Engine[]) {
    const up = upstreams[engine];
    up.on('push', (msg: unknown) => {
      for (const c of clients) c.deliver(engine, msg);
    });
    up.on('status', (status: string) => {
      for (const c of clients) c.send({ type: 'status', engine, status });
    });
    up.on('upstream-error', (err: Error) => {
      for (const c of clients) c.send({ type: 'error', engine, message: err.message });
    });
  }
  // Each wallet's own account connection: its pushes only. Its status and errors
  // are not the engine's (a closed idle wallet connection is not an outage).
  onAccountUpstream((up) => {
    up.on('push', (msg: unknown) => {
      for (const c of clients) c.deliver(up.engine, msg);
    });
    up.on('upstream-error', () => { /* retried by the connection itself */ });
  });
}

export const hubStats = () => ({
  clients: clients.size,
  subscriptions: [...clients].reduce((n, c) => n + c.subscriptionCount, 0),
  upstreams: { spot: upstreams.spot.stats(), perps: upstreams.perps.stats() },
  accounts: accountStats(),
});
