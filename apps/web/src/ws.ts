/**
 * Live SoDEX streams for this tab.
 *
 * The connections themselves are NOT this tab's: one socket host per browser
 * (a SharedWorker, else an elected leader tab - exchange/ws/link.ts) holds them
 * for every tab, straight to the SoDEX gateway from the user's own IP. Nothing
 * goes through a Valuescan server. The gateway allows 10 connections per IP;
 * shared, all tabs together use at most 2 market + 6 wallet connections.
 *
 * This client keeps the old hub's interface exactly - `hub.subscribe`,
 * `hub.onState`, `hub.state`, `hub.upstream` - so every panel is unchanged.
 * Subscriptions are refcounted here too: two panels watching the same book
 * share one subscription, and a host change (leader tab closed) re-arms every
 * live subscription, invisible to the panels above.
 *
 * `state` is this tab's link to the host; `upstream[engine]` is the host's
 * market connection for that engine - the same split the server hub reported.
 */
import type { Engine } from './api';
import type { SubParams } from '@sign/sodex/wsProtocol.js';
import { gatewayWsOrigin } from './exchange/hosts';
import { hostLink, type HostLink } from './exchange/ws/link';
import type { ToTab } from './exchange/ws/messages';

export type { SubParams };

export type ConnState = 'connecting' | 'open' | 'closed' | 'reconnecting';

type Handler = (data: any, pushType: 'snapshot' | 'update') => void;

/**
 * How a host's market-connection status reads to the panels. The server hub's
 * upstream was simply always up, so 'open' meant "nothing is wrong" - and it
 * still does: a connection made for the first time ('connecting') or closed
 * because nothing needs it any more ('closed', always deliberate) is not an
 * outage, so neither flashes the chart's "Delayed" notice or the footer's
 * warning. Only a connection that dropped and is retrying reads as such.
 */
const UPSTREAM_SHOWN: Record<string, string> = { connecting: 'open', closed: 'open' };

const keyOf = (engine: Engine, p: SubParams): string =>
  [
    engine,
    p.channel,
    p.symbol ?? '',
    (p.symbols ?? []).slice().sort().join('|'),
    p.interval ?? '',
    p.level ?? '',
    (p.user ?? '').toLowerCase(),
  ].join(':');

class HubClient {
  private link: HostLink | null = null;
  private subs = new Map<string, { engine: Engine; params: SubParams; handlers: Set<Handler> }>();
  private stateHandlers = new Set<(s: ConnState, detail?: string) => void>();
  state: ConnState = 'closed';
  /** The host's market connection status per engine (SoDEX-side), as panels read it (UPSTREAM_SHOWN). */
  upstream: Partial<Record<Engine, string>> = { spot: 'open', perps: 'open' };

  connect(): void {
    if (this.link) return;
    const link = hostLink();
    this.link = link;
    link.onMessage((m) => this.onMessage(m));
    link.onState((s) => {
      if (s === 'open') {
        this.setState('open');
        // (Re-)arm every live subscription on the host that now answers.
        for (const s2 of this.subs.values()) this.sendSubscribe(s2.engine, s2.params);
      } else {
        this.setState(s === 'reconnecting' ? 'reconnecting' : 'connecting');
      }
    });
    if (link.state() === 'open') {
      this.setState('open');
      for (const s of this.subs.values()) this.sendSubscribe(s.engine, s.params);
    } else {
      this.setState(link.state() === 'reconnecting' ? 'reconnecting' : 'connecting');
    }
  }

  private onMessage(m: ToTab): void {
    if (m.type === 'status') {
      this.upstream[m.engine] = UPSTREAM_SHOWN[m.status] ?? m.status;
      this.setState(this.state, `${m.engine}:${m.status}`);
      return;
    }
    if (m.type !== 'push') return;

    // Fan out to every handler whose subscription matches this push. One
    // handler throwing (e.g. a chart series rejecting an out-of-order
    // update during a brief resubscribe window) must not stop the others
    // for this same message.
    const data = m.data as any;
    for (const s of this.subs.values()) {
      if (s.engine !== m.engine || s.params.channel !== m.channel) continue;
      if (s.params.interval && data?.i && data.i !== s.params.interval) continue;
      // One wallet's account pushes go to that wallet's listeners only: a
      // scanned wallet's fills must never reach your own fill notifications.
      if (s.params.user && String(m.user ?? '').toLowerCase() !== s.params.user.toLowerCase()) continue;
      // Two symbols on one channel (two charts, two books): each gets its own.
      if (s.params.symbol && data && !Array.isArray(data) && data.s && data.s !== s.params.symbol) continue;
      for (const h of s.handlers) {
        try {
          h(data, m.pushType);
        } catch (e) {
          console.error(`[hub] handler for ${s.params.channel} threw`, e);
        }
      }
    }
  }

  private setState(s: ConnState, detail?: string) {
    this.state = s;
    for (const h of this.stateHandlers) h(s, detail);
  }

  private sendSubscribe(engine: Engine, params: SubParams): void {
    if (this.link?.state() !== 'open') return; // armed when the link opens
    this.link.post({ op: 'subscribe', engine, params, wsBase: gatewayWsOrigin() });
  }

  private sendUnsubscribe(engine: Engine, params: SubParams): void {
    if (this.link?.state() !== 'open') return;
    this.link.post({ op: 'unsubscribe', engine, params });
  }

  onState(h: (s: ConnState, detail?: string) => void): () => void {
    this.stateHandlers.add(h);
    h(this.state);
    return () => this.stateHandlers.delete(h);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(engine: Engine, params: SubParams, handler: Handler): () => void {
    this.connect();
    const key = keyOf(engine, params);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { engine, params, handlers: new Set() };
      this.subs.set(key, entry);
      this.sendSubscribe(engine, params);
    }
    entry.handlers.add(handler);

    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (e.handlers.size === 0) {
        this.subs.delete(key);
        this.sendUnsubscribe(engine, params);
      }
    };
  }
}

export const hub = new HubClient();
