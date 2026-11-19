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
 * venue that is down as HTTP 200 {ok:false,...} (routes/valuedesk.ts `fail`),
 * and that answer keeps `no-store` like any other error - or a cache would go
 * on serving "unavailable" after the venue is back.
 *
 * TRIMS, INDEX ROUTES ONLY. No username is shown anywhere (valuedesk/labels.ts),
 * so every trader row leaves its route with `label: null`, and no client reads
 * it. That member is dropped here, on the way out and before the ETag, rather
 * than in each of the dozen places a row is built: the routes keep answering
 * their own shape, and a row that DOES carry a name is sent unchanged. Routes
 * that only borrow the ETag and the compressed cache (`trim: false`) are sent
 * exactly as built.
 *
 * PREPARED BODIES. A route that hands out an answer it keeps (the cohort answers,
 * indexer/cohortThread.ts) sends it with sendPrepared: the body already trimmed
 * and its ETag already worked out, once per kept answer instead of per request.
 *
 * SERVER-TIMING on every answer (2026-11-18, the phone pass): where a request's
 * time went, so a slow first answer on a phone can be split into its parts with
 * curl -D or PerformanceResourceTiming.serverTiming. Durations in ms, no data:
 *   pre    arrival to the handler (the gates, the body)
 *   app    the handler
 *   json   its return value serialized
 *   thr    waiting for the cohort thread (the route says so: indexer/cohortThread.ts)
 *   memo   desc=hit|joined|miss|off - an answer kept here, another request's build, built for this one
 *   etag   the label trim and the ETag
 *   cmp    compression (0 when the compressed body was kept)
 *   tot    arrival to the body leaving this hook
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
  /**
   * The route picks per answer: a Cache-Control the handler set stands (cacheControl when it set
   * none). The heatmap's tiles: a final tile is kept a day, the index and a slot still filling a
   * minute (indexer/liqTiles.ts).
   */
  own?: boolean;
  /** False: sent exactly as built - no `label: null` trim (that is for trader rows). Default true. */
  trim?: boolean;
}

const BOARD: CachePolicy = { cacheControl: 'public, max-age=10, stale-while-revalidate=20' };
const PRICE: CachePolicy = { cacheControl: 'public, max-age=30, stale-while-revalidate=30' };
const LIVE: CachePolicy = { cacheControl: 'public, no-cache' };
/**
 * The cohort pages: their numbers come from the cohort load, rebuilt about once a minute (indexer/read.ts LOAD_TTL_MS), so a
 * 10 s edge copy only made a crowd ask the origin six times per load. 30 s + swr 30 (2026-11-09): the page gets each new load
 * pushed over /ws/liq (routes/liveHub.ts) and reads HTTP only on opening it or while the socket is down.
 */
const COHORT: CachePolicy = { cacheControl: 'public, max-age=30, stale-while-revalidate=30' };

/** Route PATTERN (req.routeOptions.url) -> policy. Only GET/HEAD 200s that are not {ok:false} are affected. */
export const CACHE_POLICIES: Readonly<Record<string, CachePolicy>> = {
  '/api/vs/leaderboard': BOARD,
  '/api/vs/explore': BOARD,
  '/api/vs/wallet-history': BOARD,
  '/api/vs/cohorts': COHORT,
  '/api/vs/cohorts/detail': COHORT,
  '/api/vs/cohorts/map': COHORT,
  '/api/vs/excluded': BOARD,
  // The process holds it 15 s (valuedesk/sodex/oiExcluded.ts). No older copy on top: the pages subtract it.
  '/api/vs/sodex/oi-excluded': { cacheControl: 'public, max-age=10' },
  '/api/vs/cohorts/focus': COHORT,
  '/api/vs/cohorts/wallets': COHORT,
  '/api/vs/screener': BOARD,
  // One Hyperliquid leaderboard row: it moves when the leaderboard file does.
  '/api/vs/lbrow': BOARD,
  // A wallet's held fills (indexer/walletFills.ts): the process keeps an answer five minutes; an older copy only
  // makes the browser's venue tail (after `heldTo`) longer, never wrong.
  '/api/vs/wallet/fills': { cacheControl: 'public, max-age=60, stale-while-revalidate=240' },
  // The copy cards' hint (indexer/walletFills.ts lastTrades): kept a minute by the process.
  '/api/vs/last-trades': BOARD,
  // The Copy page's cards (valuedesk/copyCards.ts): each says its own age, so a shared copy for seconds is fine.
  '/api/vs/copy/cards': BOARD,
  '/api/vs/price': PRICE,
  // The liquidation heatmap moves every second (the live feed; the page streams it over /ws/liq):
  // the edge may share one answer per coin for five seconds.
  '/api/vs/liquidations': { cacheControl: 'public, max-age=5, stale-while-revalidate=5' },
  '/api/vs/liquidations/wallets': BOARD,
  // A wallet's positions, every coin (the wallet filter).
  '/api/vs/liquidations/positions': BOARD,
  // Snapshots are written every 15 minutes.
  // Its fine tiles (`every=` / `pool=`) pick their own: a final one a day (routes/valuedesk.ts).
  '/api/vs/liquidations/history': { cacheControl: 'public, max-age=300, stale-while-revalidate=300', own: true },
  // The same in tiles (indexer/liqTiles.ts): the route says which answer is final.
  '/api/vs/liquidations/tiles': { cacheControl: 'public, max-age=60, stale-while-revalidate=120', own: true },
  // One cell at a past time: the log does not change behind it (the newest step may still fill in).
  '/api/vs/liquidations/at': { cacheControl: 'public, max-age=300, stale-while-revalidate=300' },
  // Who traded a window (flow/read.ts): the route says whether the window has passed (kept a day) or still forms.
  '/api/vs/flow': { cacheControl: 'public, max-age=10, stale-while-revalidate=10', own: true },
  '/api/vs/flow/wallet': { cacheControl: 'public, max-age=10, stale-while-revalidate=10', own: true },
  // Per day against SoDEX's own count (flow/ledger.ts): written every 15 minutes.
  '/api/vs/activity/coverage': { cacheControl: 'public, max-age=60, stale-while-revalidate=60' },
  '/api/vs/whales': LIVE,
  '/api/vs/positioning': LIVE,
  // The process already holds the page for five minutes. The edge may keep a minute of it.
  '/api/vs/news': { cacheControl: 'public, max-age=60, stale-while-revalidate=60' },
  // Release calendars change a few times a year; the process reads them twice a day.
  '/api/vs/calendar': { cacheControl: 'public, max-age=600, stale-while-revalidate=1800' },
  // The status page (routes/status.ts): rebuilt at most every 30 s, the same for everyone.
  '/api/vs/status': { cacheControl: 'public, max-age=30, stale-while-revalidate=30' },
  // SoDEX's maintenance flag (routes/external.ts): the same for everyone, already held 15 s by the
  // process, and polled every 45 s by every open tab's banner. The edge may share one answer for
  // ten seconds, so a crowd of tabs costs one /api function call per ten seconds, not one per tab.
  '/api/external/maintenance/status': { cacheControl: 'public, max-age=10' },
  // The app's health poll (every open tab, every 30 s: App.tsx): the same for everyone (network, brake, notices, the API
  // thread's stalls - index.ts). It had no policy, so every poll of every tab was a Vercel function call; ten seconds at the
  // edge makes a crowd one call per ten seconds per region. No stale copy: an API that stops answering still shows within
  // the web's HEALTH_DOWN_MS (45 s).
  '/api/health': { cacheControl: 'public, max-age=10' },
  // Routes that set their own public Cache-Control (2026-11-18): they had no ETag, so a poll that found nothing new took
  // the whole body again, and each answer was compressed again per request. Their Cache-Control stands (`own`), their
  // bodies are sent as built (`trim: false`), a failure is never cached. Not /api/vs/calendar/results: its body carries
  // the request's own time (`now`), so it is new every request and would only push others out of the compressed cache.
  '/api/vs/bots/markets': { cacheControl: 'public, max-age=60, stale-while-revalidate=300', own: true, trim: false },
  '/api/vs/bots/regime': { cacheControl: 'public, max-age=30, stale-while-revalidate=30', own: true, trim: false },
  '/api/vs/sodex/mm-daily': { cacheControl: 'public, max-age=600', own: true, trim: false },
  '/api/vs/sodex/lottery/meta': { cacheControl: 'public, max-age=60', own: true, trim: false },
  '/api/vs/sodex/lottery/feed': { cacheControl: 'public, max-age=10', own: true, trim: false },
  '/api/vs/sodex/wealth/maintenance': { cacheControl: 'public, max-age=30', own: true, trim: false },
  '/api/vs/fed/live': { cacheControl: 'public, max-age=0, s-maxage=10', own: true, trim: false },
  '/api/vs/fedwatch': { cacheControl: 'public, max-age=0, s-maxage=30', own: true, trim: false },
  '/api/vs/fedwatch/history': { cacheControl: 'public, max-age=0, s-maxage=300', own: true, trim: false },
  '/api/vs/indicator': { cacheControl: 'public, max-age=0, s-maxage=300', own: true, trim: false },
  '/api/vs/etf/flows': { cacheControl: 'public, max-age=0, s-maxage=300', own: true, trim: false },
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

export async function compress(body: Buffer, enc: Encoding, quality = 5): Promise<Buffer> {
  return enc === 'br'
    ? brotli(body, {
        params: {
          // Quality 5: most of brotli's gain at a small fraction of 11's cost - these are live responses.
          [Z.BROTLI_PARAM_QUALITY]: quality,
          [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT,
          [Z.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzip(body, { level: 6 });
}

/** A JSON body made ready once for many replies: trimmed as an index route sends it, and its ETag. */
export interface Prepared {
  buf: Buffer;
  etag: string;
}

/** The body perf.ts would send for this JSON text on a trimmed index route, and its ETag. */
export function prepareJson(json: string, trim = true): Prepared {
  const buf = Buffer.from(trim ? omitNullLabels(json) : json, 'utf8');
  return { buf, etag: weakEtag(buf) };
}

const preparedOf = new WeakMap<FastifyReply, Prepared>();

/** Send a prepared body (prepareJson): the hook below then neither trims nor hashes it again. */
export function sendPrepared(reply: FastifyReply, p: Prepared): FastifyReply {
  preparedOf.set(reply, p);
  return reply.type('application/json; charset=utf-8').send(p.buf);
}

interface Timing {
  t0: number;
  handler?: number;
  serialize?: number;
  parts: string[];
}
const timingOf = new WeakMap<FastifyRequest, Timing>();
const ms = (x: number): string => (Math.round(x * 100) / 100).toString();

/**
 * A part of this request's Server-Timing, from the route: `dur` in ms and/or a `desc` (letters, digits, `-`, `_` only).
 * Ignored for a request the plugin did not see arrive.
 */
export function serverTiming(reply: FastifyReply, name: string, dur?: number, desc?: string): void {
  const t = timingOf.get(reply.request);
  if (!t || !/^[a-z][a-z0-9]{0,15}$/.test(name)) return;
  const d = desc !== undefined && /^[\w-]{1,32}$/.test(desc) ? `;desc=${desc}` : '';
  t.parts.push(`${name}${dur !== undefined && Number.isFinite(dur) ? `;dur=${ms(dur)}` : ''}${d}`);
}

/**
 * ANSWERS KEPT A DAY (a final heatmap tile, a passed flow window: max-age of a day or more) never change, and the edge
 * and the browser keep each copy they get. They are answered at quality 5 as any other (never 11 inline: +147 ms for its
 * first viewer), and the same body is then compressed once at 11 in the background - on zlib's pool, one at a time - and
 * every later miss (another edge region, a browser) gets that. Measured 2026-11-17 on a 1-day BTC band tile (159 KB of
 * JSON): 42.1 KB at 5, 29.9 KB at 11 (-29%), 150 ms of the pool once. The same bytes once decoded.
 */
export const LONG_LIVED_S = 86_400;
const BEST_MAX_BYTES = 64 * 1024 * 1024;
/** Bodies waiting for their quality-11 copy at most (more are left at 5: a burst of new tiles waits for none). */
const BEST_QUEUE_MAX = 64;
const best = new CompressedCache(8_192, BEST_MAX_BYTES);
const bestWaiting = new Map<string, Buffer>();
let bestRunning: Promise<void> | null = null;

/** Does this Cache-Control keep an answer a day or more (max-age=N, N >= LONG_LIVED_S)? */
export function isLongLived(cacheControl: unknown): boolean {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(String(cacheControl ?? ''));
  return !!m && Number(m[1]) >= LONG_LIVED_S;
}

function queueBest(key: string, body: Buffer): void {
  if (best.get(key) || bestWaiting.has(key) || bestWaiting.size >= BEST_QUEUE_MAX) return;
  bestWaiting.set(key, body);
  bestRunning ??= (async () => {
    for (let next = bestWaiting.entries().next(); !next.done; next = bestWaiting.entries().next()) {
      const [k, b] = next.value;
      try { best.set(k, await compress(b, 'br', 11)); } catch { /* left at quality 5 */ }
      bestWaiting.delete(k);
    }
  })().finally(() => { bestRunning = null; });
}

/** Tests: the quality-11 copies being made are done. */
export async function bestCompressionIdle(): Promise<void> {
  while (bestRunning) await bestRunning;
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

  app.addHook('onRequest', async (req: FastifyRequest) => {
    timingOf.set(req, { t0: performance.now(), parts: [] });
  });
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const t = timingOf.get(req);
    if (t) t.handler = performance.now();
  });
  // Only for a handler that returned an object (Fastify serializes it after this): a string or a Buffer is not serialized.
  app.addHook('preSerialization', async (req: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
    const t = timingOf.get(req);
    if (t) t.serialize = performance.now();
    return payload;
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const t = timingOf.get(req);
    const sent = performance.now();
    let etagMs: number | undefined;
    let cmpMs: number | undefined;
    const done = <T>(out: T): T => {
      if (t) {
        const parts: string[] = [];
        if (t.handler !== undefined) {
          parts.push(`pre;dur=${ms(t.handler - t.t0)}`);
          parts.push(`app;dur=${ms((t.serialize ?? sent) - t.handler)}`);
          if (t.serialize !== undefined) parts.push(`json;dur=${ms(sent - t.serialize)}`);
        }
        parts.push(...t.parts);
        if (etagMs !== undefined) parts.push(`etag;dur=${ms(etagMs)}`);
        if (cmpMs !== undefined) parts.push(`cmp;dur=${ms(cmpMs)}`);
        parts.push(`tot;dur=${ms(performance.now() - t.t0)}`);
        reply.header('Server-Timing', parts.join(', '));
      }
      return out;
    };

    const isGet = req.method === 'GET' || req.method === 'HEAD';
    const status = reply.statusCode;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return done(payload); // streams, null
    const type = String(reply.getHeader('Content-Type') ?? '');
    if (!/\bjson\b/i.test(type)) return done(payload);

    const routePolicy = policies[req.routeOptions.url ?? ''];
    const policy = isGet && status === 200 && !isFailure(payload) ? routePolicy : undefined;
    // A failure is never cached, whatever the route set before it failed (mm-daily set its max-age=600 before the read).
    if (routePolicy?.own && !policy) reply.header('Cache-Control', 'no-store');
    const prepared = preparedOf.get(reply);
    const ready = prepared !== undefined && payload === prepared.buf ? prepared : undefined;
    const e0 = performance.now();
    // What is sent when nothing below replaces it: an index answer, trimmed (a prepared one is already).
    const plain: string | Buffer = !ready && policy && policy.trim !== false && typeof payload === 'string' ? omitNullLabels(payload) : payload;
    let body = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
    let etag: string | undefined;

    if (policy) {
      const own = policy.own ? reply.getHeader('Cache-Control') : undefined;
      reply.header('Cache-Control', typeof own === 'string' && own ? own : policy.cacheControl);
      etag = ready ? ready.etag : weakEtag(body);
      etagMs = performance.now() - e0;
      reply.header('ETag', etag);
      appendVary(reply, 'Accept-Encoding');
      if (etagMatches(req.headers['if-none-match'], etag)) {
        reply.code(304);
        reply.removeHeader('Content-Length');
        reply.removeHeader('Content-Type');
        return done('');
      }
    }

    if (req.method === 'HEAD' || status === 204 || status === 304) return done(plain);
    if (body.length < minBytes || reply.hasHeader('Content-Encoding')) return done(plain);
    if (/\bno-transform\b/i.test(String(reply.getHeader('Cache-Control') ?? ''))) return done(plain);
    appendVary(reply, 'Accept-Encoding');
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return done(plain);

    const key = etag ? `${enc}:${etag}` : undefined;
    const c0 = performance.now();
    // Kept a day: its quality-11 copy once made, else quality 5 now and the 11 made after (queueBest).
    const longLived = !!key && enc === 'br' && isLongLived(reply.getHeader('Cache-Control'));
    let out = key && longLived ? best.get(key) : undefined;
    if (!out && key) {
      out = cache.get(key);
      if (out && longLived) queueBest(key, body);
    }
    if (!out) {
      try {
        out = await compress(body, enc);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'response compression failed; sent uncompressed');
        return done(plain);
      }
      if (out.length >= body.length) return done(plain);
      if (key) cache.set(key, out);
      if (longLived) queueBest(key!, body);
    }
    cmpMs = performance.now() - c0;
    body = out;
    reply.header('Content-Encoding', enc);
    reply.removeHeader('Content-Length');
    return done(body);
  });
}

// Not encapsulated: the hook must see every route, like fastify-plugin would arrange.
(perf as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
(perf as unknown as Record<symbol, string>)[Symbol.for('fastify.display-name')] = 'valuedesk-perf';

export const perfPlugin = perf;
