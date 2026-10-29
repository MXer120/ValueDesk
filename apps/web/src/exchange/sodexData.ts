/**
 * SoDEX's analytics host (mainnet-data.sodex.dev) and sodex.com's own API
 * (alpha-biz.sodex.dev), read straight from the user's browser.
 *
 * The data host's paths, caches and answer rule are the server's
 * (valuedesk/sodex/dataCore.ts); so is its politeness - one limiter, 4 in
 * flight and >= 80 ms apart (valuedesk/sodex/util.ts Limiter). A rate limit
 * opens a cooldown shared by every tab instead of being retried; so does a
 * second unreadable failure in a row (what Cloudflare's 1015 looks like from a
 * browser) - the first is tried once more, as the gateway's quick reads are,
 * since a dropped connection is usually just that. A read that meets a short
 * cooldown waits it out, as the gateway's do (COOL_WAIT_MAX_MS): one blip must
 * not blank the leaderboard, a rank and the portfolio charts in every tab.
 */
import { SodexApiError } from '@sodex-core';
import { COOL_WAIT_MAX_MS } from '@sign/sodex/restCore.js';
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
import { RateLimitedError, UnreachableError, isAbort, isOffline, isRateLimitError } from './errors';
import { BIZ_ORIGIN, dataOrigin } from './hosts';
import { RequestGate } from './gate';
import { SharedCooldowns, defaultLedgerDeps, type LedgerDeps } from './ledger';
import { isTransient } from './sodexGateway';

const HOST_KEY = 'host';
/** The page's fetch, looked up when called (so a test's stand-in is the one used). */
const pageFetch: typeof fetch = (...a) => fetch(...a);

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; text: string }> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (e) {
    if (signal?.aborted && isAbort(e)) throw e;
    throw new UnreachableError(new URL(url).host, timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface DataHostOptions {
  deps?: LedgerDeps;
  fetchImpl?: typeof fetch;
  origin?: () => string;
  /** Whether the browser says it has no network: an unreadable answer is then no refusal. */
  offline?: () => boolean;
}

/** The data host's client: its limiter, and its cooldown shared by every tab. The app uses the one below; tests make their own. */
export function dataHostClient(o: DataHostOptions = {}) {
  const deps = o.deps ?? defaultLedgerDeps();
  const fetchImpl = o.fetchImpl ?? pageFetch;
  const origin = o.origin ?? dataOrigin;
  const offline = o.offline ?? isOffline;
  const limiter = new Limiter(DATA_CONCURRENCY, DATA_GAP_MS);
  const cool = new SharedCooldowns('sodex-data', 15_000, 5 * 60_000, deps);
  const backoff = (attempt: number) => 250 * 2 ** (attempt - 1);

  /** One data-host GET (path relative to the host), limited; resolves with `data`. */
  function get<T>(path: string, priority: Priority = 'high'): Promise<T> {
    const host = new URL(origin()).host;
    return limiter.run(async () => {
      for (let attempt = 1; ; attempt++) {
        const left = cool.left(HOST_KEY);
        if (left > COOL_WAIT_MAX_MS) throw new RateLimitedError(host, left);
        if (left > 0) await deps.sleep(left);
        try {
          const r = await fetchText(fetchImpl, origin() + path, { headers: { Accept: 'application/json' } }, DATA_TIMEOUT_MS);
          const data = parseDataBody<T>(r.status, r.ok, r.text, path, (code, message, httpStatus, p, body) => new SodexApiError(code, message, httpStatus, p, body));
          cool.clear(HOST_KEY);
          return data;
        } catch (err) {
          if (err instanceof UnreachableError) {
            // No readable answer: once more first. A second in a row is treated
            // like this host's 1015 (see errors.ts) - unless it only ran out of
            // time, or the browser has no network at all.
            if (attempt < 2) {
              await deps.sleep(backoff(attempt));
              continue;
            }
            if (!err.timedOut && !offline()) {
              cool.hit(HOST_KEY);
              noteRateLimited();
            }
            throw err;
          }
          if (isRateLimitError(err)) {
            cool.hit(HOST_KEY);
            noteRateLimited();
            throw err;
          }
          if (attempt >= DATA_ATTEMPTS || !isTransient(err)) throw err;
          await deps.sleep(backoff(attempt));
        }
      }
    }, priority);
  }

  return { get, cool };
}

const dataHost = dataHostClient();
/** The data host's cooldown (mark / index candles and sodex.com's API keep to it too). */
const cool = dataHost.cool;

/** One data-host GET through this app's client (path relative to the host); resolves with `data`. */
export const dataGet = <T>(path: string, priority: Priority = 'high'): Promise<T> => dataHost.get<T>(path, priority);

/** The server's data-host reads (leaderboard pages, a wallet's rank, portfolio charts), over this client. */
export const dataReads = dataHostReads(dataGet);

/** Mark / index candles from the data host, in the gateway's kline shape. */
export const priceKlines: (o: PriceKlineQuery) => Promise<unknown[]> = priceKlinesReader('', async (url) => {
  const left = cool.left(HOST_KEY);
  if (left > 0) throw new RateLimitedError(new URL(dataOrigin()).host, left);
  const r = await fetchText(pageFetch, dataOrigin() + url, { headers: { Accept: 'application/json' } }, 15_000);
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
    pageFetch,
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
