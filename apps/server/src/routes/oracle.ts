/**
 * GET /api/vs/oracle?coin=BTC&venues=binanceFutures,bybit
 *
 * The shared price oracle (valuescan/oracle.ts): each venue's bid, ask, mid
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
import { ORACLE_VENUES, OracleFeed, isOracleVenue, type FetchLike, type OracleSnapshot, type OracleVenue } from '../valuescan/oracle.js';

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

export function oracleRoutes(app: FastifyInstance, feed: OracleFeed = new OracleFeed({ fetch: nodeFetch })) {
  app.get('/api/vs/oracle', async (req, reply) => {
    let parsed: { coin: string; venues: OracleVenue[] };
    try {
      parsed = parseOracleQuery(req.query as Record<string, string | undefined>);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    try {
      const snap = await feed.snapshot(parsed.coin, parsed.venues);
      reply.header('Cache-Control', 'no-store');
      return { ok: true, ...publicSnapshot(snap, parsed.venues) };
    } catch (e) {
      return reply.code(200).send({ ok: false, code: 'upstream', error: (e as Error).message });
    }
  });
}
