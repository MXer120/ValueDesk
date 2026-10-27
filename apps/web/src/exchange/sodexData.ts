/**
 * SoDEX's analytics host (mainnet-data.sodex.dev) and sodex.com's own API
 * (alpha-biz.sodex.dev), read straight from the user's browser.
 *
 * The data host's paths, caches and answer rule are the server's
 * (valuedesk/sodex/dataCore.ts); so is its politeness - one limiter, 4 in
 * flight and >= 80 ms apart (valuedesk/sodex/util.ts Limiter). A rate limit
 * (or an unreadable failure, which is what Cloudflare's 1015 looks like from a
 * browser) opens a cooldown shared by every tab instead of being retried.
 */
import { SodexApiError } from '@sodex-core';
import {
  DATA_ATTEMPTS,
  DATA_CONCURRENCY,
  DATA_GAP_MS,
  DATA_TIMEOUT_MS,
  dataHostReads,
  parseDataBody,
  type Priority,
} from '@sign/valuedesk/sodex/dataCore.js';
import { Limiter, noteRateLimited } from '@sign/valuedesk/sodex/util.js';
import { priceKlinesReader, type PriceKlineQuery } from '@sign/sodex/priceKlinesCore.js';
import { RateLimitedError, UnreachableError, isAbort, isRateLimitError } from './errors';
import { BIZ_ORIGIN, dataOrigin } from './hosts';
import { RequestGate } from './gate';
import { SharedCooldowns } from './ledger';
import { isTransient } from './sodexGateway';

const limiter = new Limiter(DATA_CONCURRENCY, DATA_GAP_MS);
const cool = new SharedCooldowns('sodex-data', 15_000, 5 * 60_000);
const HOST_KEY = 'host';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; ok: boolean; text: string }> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (e) {
    if (signal?.aborted && isAbort(e)) throw e;
    throw new UnreachableError(new URL(url).host, timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One data-host GET (path relative to the host), limited; resolves with `data`. */
export function dataGet<T>(path: string, priority: Priority = 'high'): Promise<T> {
  const host = new URL(dataOrigin()).host;
  return limiter.run(async () => {
    for (let attempt = 1; ; attempt++) {
      const left = cool.left(HOST_KEY);
      if (left > 0) throw new RateLimitedError(host, left);
      try {
        const r = await fetchText(dataOrigin() + path, { headers: { Accept: 'application/json' } }, DATA_TIMEOUT_MS);
        const data = parseDataBody<T>(r.status, r.ok, r.text, path, (code, message, httpStatus, p, body) => new SodexApiError(code, message, httpStatus, p, body));
        cool.clear(HOST_KEY);
        return data;
      } catch (err) {
        if (isRateLimitError(err) || err instanceof UnreachableError) {
          // An unreadable failure on this host is treated like its 1015 (see errors.ts).
          if (isRateLimitError(err) || !(err as UnreachableError).timedOut) {
            cool.hit(HOST_KEY);
            noteRateLimited();
          }
          throw err;
        }
        if (attempt >= DATA_ATTEMPTS || !isTransient(err)) throw err;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }, priority);
}

/** The server's data-host reads (leaderboard pages, a wallet's rank, portfolio charts), over this client. */
export const dataReads = dataHostReads(dataGet);

/** Mark / index candles from the data host, in the gateway's kline shape. */
export const priceKlines: (o: PriceKlineQuery) => Promise<unknown[]> = priceKlinesReader('', async (url) => {
  const left = cool.left(HOST_KEY);
  if (left > 0) throw new RateLimitedError(new URL(dataOrigin()).host, left);
  const r = await fetchText(dataOrigin() + url, { headers: { Accept: 'application/json' } }, 15_000);
  if (r.status === 429) {
    cool.hit(HOST_KEY);
    throw new RateLimitedError(new URL(dataOrigin()).host, cool.left(HOST_KEY));
  }
  let body: unknown = null;
  try {
    body = r.text ? JSON.parse(r.text) : null;
  } catch {
    body = null;
  }
  return { ok: r.ok, status: r.status, body };
});

/**
 * One read or post on sodex.com's own API. `code` 0 / "0" / 200 is success
 * (the hosts disagree on its type); resolves with `data`.
 */
export async function bizCall<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const host = new URL(BIZ_ORIGIN).host;
  const left = cool.left(`biz`);
  if (left > 0) throw new RateLimitedError(host, left);
  const r = await fetchText(
    BIZ_ORIGIN + path,
    init.method === 'POST'
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(init.body ?? {}), cache: 'no-store' }
      : { headers: { Accept: 'application/json' } },
    init.timeoutMs ?? 15_000,
    init.signal,
  );
  if (r.status === 429) {
    cool.hit('biz');
    throw new RateLimitedError(host, cool.left('biz'));
  }
  let json: { code?: unknown; data?: unknown; msg?: string; message?: string } | null = null;
  try {
    json = r.text ? JSON.parse(r.text) : null;
  } catch {
    /* reported below */
  }
  const code = json?.code;
  if (!r.ok || !json || (code !== undefined && code !== null && String(code) !== '0' && String(code) !== '200')) {
    throw new Error(json?.msg || json?.message || `${path}: HTTP ${r.status}`);
  }
  cool.clear('biz');
  return json.data as T;
}

// --- SoDEX's official leaderboard (the data host) ---------------------------------------------

const boards = new RequestGate(200);

/**
 * One page of SoDEX's own leaderboard, as the data host answers it (strings stay
 * strings). The snapshot only moves when upstream recomputes it: 30 s shared.
 */
export function leaderboardPage<T = unknown>(q: { window_type: string; sort_by: string; sort_order: string; page: number; page_size: number }): Promise<T> {
  const qs = new URLSearchParams({
    window_type: q.window_type,
    sort_by: q.sort_by,
    sort_order: q.sort_order,
    page: String(q.page),
    page_size: String(q.page_size),
  });
  const path = `/api/v1/leaderboard?${qs}`;
  return boards.run(path, 30_000, () => dataGet<T>(path));
}

/** One wallet's standing (`found:false` is an answer - not ranked in that window). */
export const walletRank = (windowType: string, sortBy: 'pnl' | 'volume', address: string) =>
  dataReads.lbRank(windowType as Parameters<typeof dataReads.lbRank>[0], sortBy, address);
