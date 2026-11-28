/**
 * SoDEX's SSI index quote, relayed (owner 2026-11-28: "EVERYTHING should be fully doable on valuedesk"). ANT Believers
 * Index (fundType ssi-v2, channel ssi-v2-rfq) is bought and redeemed against a maker's signed order, and SoDEX hands
 * that order out only on wealth.sodex.dev, which answers no browser but sodex.com (CORS checked 2026-11-28). The
 * mainnet gateway's quote route answers this fund without the order. So this asks wealth.sodex.dev for the browser:
 *
 *   POST /api/vs/wealth/ssi-quote {fundId, side, owner, payAmount}  ->  {ok, data}  (SoDEX's `data`, as it is)
 *
 * WHY NO FUNDS ARE AT RISK. The quote is an offer the maker signed for this owner; nothing is signed here and no key is
 * involved. The browser checks the order against the fund and the amounts, simulates the transaction on ValueChain,
 * and only then asks the user's wallet (web trading/ssi.ts). Nothing is kept or logged: no address, amount or order.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';

const WEALTH = (process.env.VALUESCAN_SODEX_WEALTH?.trim() || 'https://wealth.sodex.dev/api/v1/wealth').replace(/\/+$/, '');
export const SSI_QUOTE_LIMIT: Limit = { max: 30, windowMs: 60_000 };
const FUND = /^[A-Za-z0-9_-]{1,32}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,39}$/;

export interface SsiQuoteIn { fundId: string; side: 'buy' | 'sell'; owner: string; payAmount: string }

/** The request as SoDEX takes it, or null when it is not one. */
export function parseSsiQuote(body: unknown): SsiQuoteIn | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.fundId !== 'string' || !FUND.test(b.fundId)) return null;
  if (b.side !== 'buy' && b.side !== 'sell') return null;
  if (typeof b.owner !== 'string' || !ADDRESS.test(b.owner)) return null;
  if (typeof b.payAmount !== 'string' || !AMOUNT.test(b.payAmount)) return null;
  return { fundId: b.fundId, side: b.side, owner: b.owner, payAmount: b.payAmount };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export function ssiQuoteRoutes(o: { fetch?: Fetch; now?: () => number } = {}) {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const limiter = new KeyedLimiter();
  const now = o.now ?? Date.now;
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post('/api/vs/wealth/ssi-quote', { bodyLimit: 4096 }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const wait = limiter.take(`ssi|${clientKey(req.ip)}`, SSI_QUOTE_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const q = parseSsiQuote(req.body);
      if (!q) return reply.code(400).send({ ok: false, error: 'fundId, side (buy or sell), owner (0x address) and payAmount (base units) are expected' });
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      try {
        const r = await doFetch(`${WEALTH}/funds/${encodeURIComponent(q.fundId)}/rfq/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ side: q.side, owner: q.owner, payAmount: q.payAmount }),
          signal: ac.signal,
        });
        const j = (await r.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null;
        if (r.status !== 200 || !j || j.code !== 0) return reply.code(502).send({ ok: false, error: j?.msg || `SoDEX answered ${r.status}` });
        return reply.send({ ok: true, data: j.data });
      } catch {
        return reply.code(504).send({ ok: false, error: 'SoDEX did not answer' });
      } finally {
        clearTimeout(t);
      }
    });
  };
}
