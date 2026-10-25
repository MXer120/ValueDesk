/**
 * Response performance for the JSON API: compression and HTTP caching.
 *
 *   import { perfPlugin } from './perf.js';
 *   await app.register(perfPlugin);
 *
 * Register it right after CORS, before the routes. Its hooks apply to every
 * route (the plugin opts out of encapsulation), and running before index.ts's
 * security-header hook means the Cache-Control it sets on index routes is the
 * one that hook then keeps (it only fills in `no-store` when none is set).
 *
 * COMPRESSION. Every JSON response of 1 KiB or more is sent brotli- or
 * gzip-encoded when the client accepts it (the index pages are 10-66 KB of
 * JSON that compress 3-5x). Compression runs on zlib's thread pool, never on
 * the event loop, and index responses - identical for every client until the
 * index moves - are compressed once per content and encoding and served from
 * a small memory cache. `Vary: Accept-Encoding` keeps shared caches honest.
 *
 * CACHING, INDEX ROUTES ONLY. Everything else keeps index.ts's `no-store`:
 * account data must never land in a disk or shared cache. The index is
 * different - public, the same for everyone, and rebuilt on a clock:
 *   - boards, cohorts, the screener and Explore are rebuilt about once a
 *     minute (docs/INDEXER.md), so a response may be reused for 10 s, and
 *     handed out for 20 s more while the cache fetches the next one
 *     (`stale-while-revalidate`): a page reopened within that half minute has
 *     its rows at once instead of waiting for a round trip. What that costs:
 *     a client that polls INSIDE the window (the leaderboard asks every 15 s)
 *     is handed the copy its last poll left behind - one poll late for as long
 *     as it runs. The web's polls therefore revalidate
 *     (apps/web/src/serverFetch.ts `revalidating`); a CDN in front may still
 *     answer a lone visitor's poll with a copy up to 30 s old, which is what
 *     this policy allows;
 *   - the price chart is Hyperliquid candles the server itself caches for 60 s;
 *   - the whale tape and positioning move with the trade streams: they are
 *     revalidated on every use (`no-cache`), and only ever answered 304 when
 *     truly unchanged.
 * Each carries a weak ETag (weak: the same JSON is sent in three encodings), so
 * a revalidation that finds nothing new costs a 304 and no body.
 * A FAILURE IS NEVER CACHED, whatever its status: the index routes answer a
 * venue that is down as HTTP 200 {ok:false,...} (routes/valuescan.ts `fail`),
 * and that answer keeps `no-store` like any other error - or a cache would go
 * on serving "unavailable" after the venue is back.
 *
 * TRIMS, INDEX ROUTES ONLY. No username is shown anywhere (valuescan/labels.ts),
 * so every trader row leaves its route with `label: null`, and no client reads
 * it. That member is dropped here, on the way out and before the ETag, rather
 * than in each of the dozen places a row is built: the routes keep answering
 * their own shape, and a row that DOES carry a name is sent unchanged.
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress as brotliCb, constants as Z, gzip as gzipCb } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const brotli = promisify(brotliCb);
const gzip = promisify(gzipCb);

/** Below this a JSON body is sent as is: framing overhead outweighs the saving. */
export const COMPRESS_MIN_BYTES = 1024;

export interface CachePolicy {
  /** The Cache-Control value for a 200. */
  cacheControl: string;
}

const BOARD: CachePolicy = { cacheControl: 'public, max-age=10, stale-while-revalidate=20' };
const PRICE: CachePolicy = { cacheControl: 'public, max-age=30, stale-while-revalidate=30' };
const LIVE: CachePolicy = { cacheControl: 'public, no-cache' };

/** Route PATTERN (req.routeOptions.url) -> policy. Only GET/HEAD 200s that are not {ok:false} are affected. */
export const CACHE_POLICIES: Readonly<Record<string, CachePolicy>> = {
  '/api/vs/leaderboard': BOARD,
  '/api/vs/explore': BOARD,
  '/api/vs/cohorts': BOARD,
  '/api/vs/cohorts/detail': BOARD,
  '/api/vs/cohorts/map': BOARD,
  '/api/vs/cohorts/focus': BOARD,
  '/api/vs/cohorts/wallets': BOARD,
  '/api/vs/screener': BOARD,
  // One Hyperliquid leaderboard row: it moves when the leaderboard file does.
  '/api/vs/lbrow': BOARD,
  '/api/vs/price': PRICE,
  // The liquidation heatmap moves every second (the live feed; the page streams it over /ws/liq):
  // the edge may share one answer per coin for five seconds.
  '/api/vs/liquidations': { cacheControl: 'public, max-age=5, stale-while-revalidate=5' },
  '/api/vs/liquidations/wallets': BOARD,
  // Snapshots are written every 15 minutes.
  '/api/vs/liquidations/history': { cacheControl: 'public, max-age=300, stale-while-revalidate=300' },
  '/api/vs/whales': LIVE,
  '/api/vs/positioning': LIVE,
  // The process already holds the page for five minutes. The edge may keep a minute of it.
  '/api/vs/news': { cacheControl: 'public, max-age=60, stale-while-revalidate=60' },
  // Release calendars change a few times a year; the process reads them twice a day.
  '/api/vs/calendar': { cacheControl: 'public, max-age=600, stale-while-revalidate=1800' },
};

export type Encoding = 'br' | 'gzip';

/**
 * The encoding to answer with, from an Accept-Encoding header: brotli, then
 * gzip, honouring q-values (`br;q=0` refuses it) and `*`. Null: send identity.
 */
export function pickEncoding(header: string | string[] | undefined): Encoding | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const q = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (Number.isFinite(weight)) q.set(name, weight);
  }
  const accepts = (name: string, alias?: string): boolean => {
    const own = q.get(name) ?? (alias ? q.get(alias) : undefined);
    if (own !== undefined) return own > 0;
    const star = q.get('*');
    return star !== undefined && star > 0;
  };
  if (accepts('br')) return 'br';
  if (accepts('gzip', 'x-gzip')) return 'gzip';
  return null;
}

/** Does an If-None-Match header match this ETag? Weak comparison, lists and `*` understood. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw.trim() === '*') return true;
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  const want = opaque(etag);
  return raw.split(',').some((t) => opaque(t) === want);
}

/**
 * Compact JSON (what JSON.stringify writes) without its `"label":null`
 * members. Exact, not a guess at the grammar: outside a string, the text
 * `"label":null` can only be an object member named `label` whose value is
 * null. Inside a string both quotes would be escaped, and a longer key ending
 * in `\"label` has a backslash before that quote, which the pattern refuses.
 * The member takes one comma with it: the one before, else the one after.
 */
export function omitNullLabels(json: string): string {
  if (!json.includes('"label":null')) return json;
  return json.replace(/,"label":null|(?<!\\)"label":null,?/g, '');
}

/** The routes' own failure answer, sent with status 200: `{"ok":false,...}`. */
const FAILED = '{"ok":false';
export function isFailure(payload: string | Buffer): boolean {
  return typeof payload === 'string' ? payload.startsWith(FAILED) : payload.subarray(0, FAILED.length).toString('latin1') === FAILED;
}

/** A weak ETag over the exact response body. */
export function weakEtag(body: Buffer): string {
  return `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/**
 * Compressed index bodies, by content hash and encoding. Bounded by count and
 * bytes; content-addressed, so an entry can never be stale - only evicted.
 */
export class CompressedCache {
  private map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxEntries = 128, private readonly maxBytes = 8 * 1024 * 1024) {}
  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v); // most recently used
    }
    return v;
  }
  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.bytes -= old.length;
    }
    this.map.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
  get size(): number {
    return this.map.size;
  }
}

export async function compress(body: Buffer, enc: Encoding): Promise<Buffer> {
  return enc === 'br'
    ? brotli(body, {
        params: {
          // Quality 5: most of brotli's gain at a small fraction of 11's cost - these are live responses.
          [Z.BROTLI_PARAM_QUALITY]: 5,
          [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT,
          [Z.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzip(body, { level: 6 });
}

function appendVary(reply: FastifyReply, value: string): void {
  const cur = reply.getHeader('Vary');
  const list = (Array.isArray(cur) ? cur.join(',') : cur ? String(cur) : '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.some((v) => v.toLowerCase() === value.toLowerCase())) return;
  reply.header('Vary', [...list, value].join(', '));
}

export interface PerfOptions {
  /** Override the policy table (tests). */
  policies?: Readonly<Record<string, CachePolicy>>;
  /** Override the compression threshold (tests). */
  minBytes?: number;
}

async function perf(app: FastifyInstance, opts: PerfOptions): Promise<void> {
  const policies = opts.policies ?? CACHE_POLICIES;
  const minBytes = opts.minBytes ?? COMPRESS_MIN_BYTES;
  const cache = new CompressedCache();

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    const status = reply.statusCode;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload; // streams, null
    const type = String(reply.getHeader('Content-Type') ?? '');
    if (!/\bjson\b/i.test(type)) return payload;

    const policy = isGet && status === 200 && !isFailure(payload) ? policies[req.routeOptions.url ?? ''] : undefined;
    // What is sent when nothing below replaces it: an index answer, trimmed.
    const plain: string | Buffer = policy && typeof payload === 'string' ? omitNullLabels(payload) : payload;
    let body = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
    let etag: string | undefined;

    if (policy) {
      reply.header('Cache-Control', policy.cacheControl);
      etag = weakEtag(body);
      reply.header('ETag', etag);
      appendVary(reply, 'Accept-Encoding');
      if (etagMatches(req.headers['if-none-match'], etag)) {
        reply.code(304);
        reply.removeHeader('Content-Length');
        reply.removeHeader('Content-Type');
        return '';
      }
    }

    if (req.method === 'HEAD' || status === 204 || status === 304) return plain;
    if (body.length < minBytes || reply.hasHeader('Content-Encoding')) return plain;
    if (/\bno-transform\b/i.test(String(reply.getHeader('Cache-Control') ?? ''))) return plain;
    appendVary(reply, 'Accept-Encoding');
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return plain;

    const key = etag ? `${enc}:${etag}` : undefined;
    let out = key ? cache.get(key) : undefined;
    if (!out) {
      try {
        out = await compress(body, enc);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'response compression failed; sent uncompressed');
        return plain;
      }
      if (out.length >= body.length) return plain;
      if (key) cache.set(key, out);
    }
    body = out;
    reply.header('Content-Encoding', enc);
    reply.removeHeader('Content-Length');
    return body;
  });
}

// Not encapsulated: the hook must see every route, like fastify-plugin would arrange.
(perf as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
(perf as unknown as Record<symbol, string>)[Symbol.for('fastify.display-name')] = 'valuescan-perf';

export const perfPlugin = perf;
