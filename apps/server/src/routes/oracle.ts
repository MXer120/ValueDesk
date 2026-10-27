/**
 * GET /api/vs/oracle?coin=BTC&venues=binanceFutures,bybit
 *
 * The shared price oracle (valuedesk/oracle.ts): each venue's bid, ask, mid
 * and mark for the coin with its age, the stale ones flagged, and the combined
 * oracle mid and fair price. `venues` is optional (all when absent).
 *
 * One OracleFeed for the whole server: a venue and coin is read at most once
 * a second and one read at a time, however many users ask - so each venue sees
 * at most one request (two for Binance futures and OKX: book and mark) per coin
 * per second from us. Fill fast in the browser reads it here; the browser never
 * contacts the venues.
 */
import type { FastifyInstance } from 'fastify';
import { gwGet } from '../valuedesk/sodex/gateway.js';
import { ORACLE_VENUES, OracleFeed, isOracleVenue, type FetchLike, type OracleSnapshot, type OracleVenue } from '../valuedesk/oracle.js';

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

/** coin: 1-20 letters and digits ('BTC', or 'BTC-USD' / 'BTCUSDT' trimmed to it); venues: known ones, at least one. */
export function parseOracleQuery(q: Record<string, string | undefined>): { coin: string; venues: OracleVenue[] } {
  const coin = (q.coin ?? '').trim().toUpperCase().replace(/-USD$|USDT$/, '');
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) throw bad('coin must be a coin name such as BTC');
  if (q.venues === undefined || q.venues.trim() === '') return { coin, venues: [...ORACLE_VENUES] };
  const asked = q.venues.split(',').map((v) => v.trim()).filter(Boolean);
  const unknown = asked.filter((v) => !isOracleVenue(v));
  if (unknown.length) throw bad(`unknown venue ${unknown[0]}: one of ${ORACLE_VENUES.join(', ')}`);
  const venues = [...new Set(asked)] as OracleVenue[];
  if (!venues.length) throw bad('at least one venue');
  return { coin, venues };
}

/**
 * What leaves the server. One venue asked: its quote, as asked. Several: only
 * the combined price and the venues it is made of (owner, 2026-10-26) - no
 * venue's own bid, ask or mark is handed on - with `ageMs`, the age of the
 * oldest quote in it, so a reader can still tell a stale price.
 */
export function publicSnapshot(snap: OracleSnapshot, venues: readonly OracleVenue[]) {
  if (venues.length <= 1) return snap;
  const used = snap.quotes.filter((q) => snap.used.includes(q.venue));
  const { quotes: _quotes, errors: _errors, ...combined } = snap;
  return { ...combined, ageMs: used.length ? Math.max(...used.map((q) => q.ageMs)) : null };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

/** The coins in one of SoDEX's symbol lists: perps by name ('BTC-USD'), spot by display name ('BTC/USDC'). */
export function coinsOfSymbols(list: unknown): string[] {
  const rows = (Array.isArray(list) ? list : Array.isArray((list as { data?: unknown })?.data) ? (list as { data: unknown[] }).data : []) as Array<{ name?: unknown; displayName?: unknown }>;
  const out: string[] = [];
  for (const r of rows) {
    const s = typeof r.displayName === 'string' && r.displayName.includes('/') ? r.displayName.split('/')[0] : typeof r.name === 'string' ? r.name : '';
    const coin = (s ?? '').trim().toUpperCase().replace(/-USD$/, '');
    if (/^[A-Z0-9]{1,20}$/.test(coin)) out.push(coin);
  }
  return out;
}

/**
 * The coins the oracle answers for: SoDEX's own, re-read every 10 minutes. A coin
 * SoDEX does not list is a 404 - before, any made-up coin made the server ask up
 * to 19 venues about it, from its own address (security pass 2026-10-27). While
 * SoDEX's lists cannot be read (`null`), every well-formed coin is answered, as
 * before: Fill fast keeps working through a SoDEX outage.
 */
export function listedCoins(read: () => Promise<unknown[]>, now: () => number = Date.now, ttlMs = 600_000): () => Promise<ReadonlySet<string> | null> {
  let set: ReadonlySet<string> | null = null;
  let at = -Infinity;
  let pending: Promise<void> | null = null;
  const refresh = () =>
    (pending ??= read()
      .then((lists) => {
        const coins = lists.flatMap(coinsOfSymbols);
        if (coins.length) set = new Set(coins);
      })
      .catch(() => {
        /* keep the last list (or none) */
      })
      .finally(() => {
        at = now();
        pending = null;
      }));
  return async () => {
    if (now() - at >= ttlMs) await refresh();
    return set;
  };
}

const sodexLists = () =>
  Promise.all([gwGet<unknown>('/api/v1/perps/markets/symbols'), gwGet<unknown>('/api/v1/spot/markets/symbols')]);

export function oracleRoutes(
  app: FastifyInstance,
  feed: OracleFeed = new OracleFeed({ fetch: nodeFetch }),
  listed: () => Promise<ReadonlySet<string> | null> = listedCoins(sodexLists),
) {
  app.get('/api/vs/oracle', async (req, reply) => {
    let parsed: { coin: string; venues: OracleVenue[] };
    try {
      parsed = parseOracleQuery(req.query as Record<string, string | undefined>);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    const coins = await listed();
    if (coins && !coins.has(parsed.coin)) return reply.code(404).send({ ok: false, error: `SoDEX does not list ${parsed.coin}` });
    try {
      const snap = await feed.snapshot(parsed.coin, parsed.venues);
      reply.header('Cache-Control', 'no-store');
      return { ok: true, ...publicSnapshot(snap, parsed.venues) };
    } catch (e) {
      return reply.code(200).send({ ok: false, code: 'upstream', error: (e as Error).message });
    }
  });
}
