/**
 * How the exchange layer names its failures.
 *
 * A browser sees one failure the server never did: Cloudflare's rate-limit
 * answer (HTTP 429, "error code: 1015") carries no CORS header, so fetch()
 * cannot read it and rejects exactly like a dropped connection. On a SoDEX
 * host an unreadable failure is therefore treated as a possible rate limit:
 * it opens a cooldown instead of being replayed straight back into the ban.
 */
import { SodexApiError } from '@sodex-core';

/** The request was refused (or skipped) because this IP is rate-limited there. */
export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  readonly status = 429;
  constructor(
    readonly host: string,
    readonly retryInMs: number,
    what = 'requests',
  ) {
    super(`${host} is rate-limiting this connection; ${what} paused for ${Math.max(1, Math.ceil(retryInMs / 1000))} s. Try again shortly.`);
  }
}

/** No readable HTTP answer at all (offline, DNS, a CORS-less error page, a timeout). */
export class UnreachableError extends Error {
  override name = 'UnreachableError';
  readonly status = 0;
  constructor(
    readonly host: string,
    readonly timedOut: boolean,
  ) {
    super(timedOut ? `${host} did not answer in time.` : `${host} could not be reached.`);
  }
}

/** HTTP 429 or Cloudflare 1015, from any SoDEX-shaped error. */
export function isRateLimitError(e: unknown): boolean {
  if (e instanceof RateLimitedError) return true;
  const x = e as { httpStatus?: number; status?: number; code?: number; message?: string } | null;
  return (
    x?.httpStatus === 429 ||
    x?.status === 429 ||
    x?.code === 429 ||
    /\b1015\b|too many requests|rate.?limit/i.test(String(x?.message ?? ''))
  );
}

/** A caller cancelled (AbortController), as opposed to a failure. */
export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

/** HTTP status of an exchange error, 0 when there was no answer. */
export function statusOf(e: unknown): number {
  if (e instanceof SodexApiError) return e.httpStatus;
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : 0;
}
