/**
 * The executor's way out to SoDEX and Hyperliquid.
 *
 * WHY AN ADDRESS OF ITS OWN. SoDEX bills its REST budget per IP, and its
 * Cloudflare answers an IP that asked too much with 429 on EVERY path for up
 * to five minutes (apps/server/src/sodex/rest.ts, "RATE-LIMIT COOLDOWN"). On
 * ValueDesk's server the indexer shares the instance: a ban it earns must not
 * stop the copies. With EXECUTOR_LOCAL_ADDRESS set (a secondary private IP of
 * the instance with an Elastic IP of its own) every request and socket of the
 * executor leaves from that address; without it, the host's default route.
 */
import { Agent, request as httpsRequest } from 'node:https';
import { isIPv6 } from 'node:net';
import WebSocket from 'ws';
import type { FetchLike, ResponseLike, WebSocketFactory, WebSocketLike } from '../../../packages/copy-engine/src/index.ts';

export interface Egress {
  fetch: FetchLike;
  factory: WebSocketFactory;
  localAddress: string | null;
}

export function egress(localAddress: string | null): Egress {
  if (!localAddress) {
    return {
      fetch: fetch as unknown as FetchLike,
      factory: (url) => new globalThis.WebSocket(url) as unknown as WebSocketLike,
      localAddress: null,
    };
  }
  // The destination must be of the bound address's family: SoDEX's gateway also has IPv6 addresses.
  const family = isIPv6(localAddress) ? 6 : 4;
  const agent = new Agent({ keepAlive: true, localAddress, family, maxSockets: 64 });
  const bound: FetchLike = (url, init) =>
    new Promise<ResponseLike>((resolve, reject) => {
      const u = new URL(url);
      if (u.protocol !== 'https:') {
        reject(new TypeError(`only https is allowed from the executor's own address (${u.protocol})`));
        return;
      }
      const req = httpsRequest(u, { method: init?.method ?? 'GET', headers: init?.headers, agent, family }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          const h = res.headers;
          const headers = { get: (name: string): string | null => { const v = h[name.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v); } };
          resolve({ status, ok: status >= 200 && status < 300, text: async () => body, headers });
        });
        res.on('error', reject);
      });
      const signal = init?.signal as { aborted?: boolean; addEventListener?: (t: string, f: () => void) => void } | undefined;
      if (signal?.aborted) req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener?.('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      req.on('error', (e) => reject(e.name === 'AbortError' ? e : Object.assign(new TypeError(`fetch failed: ${e.message}`), { cause: e })));
      if (init?.body !== undefined) req.write(init.body);
      req.end();
    });
  const factory: WebSocketFactory = (url) => {
    const ws = new WebSocket(url, { localAddress, family, perMessageDeflate: false });
    // `ws` can hand a text frame to `onmessage` as a Buffer; the feeds expect a string.
    const like = ws as unknown as WebSocketLike;
    return new Proxy(like, {
      set(target, prop, value) {
        if (prop === 'onmessage' && typeof value === 'function') {
          (target as unknown as { onmessage: unknown }).onmessage = (ev: { data: unknown }) => value({ data: typeof ev.data === 'string' ? ev.data : String(ev.data) });
          return true;
        }
        (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
        return true;
      },
    });
  };
  return { fetch: bound, factory, localAddress };
}
