/**
 * Talking to SoDEX straight from the browser.
 *
 * The gateway serves permissive CORS on its signed routes - `access-control-
 * allow-origin: *` with the four X-API-* signing headers allowed - and a
 * cross-origin signed POST was confirmed from a real browser with a readable
 * response (see the note in git history of web/src/signing.ts). So orders
 * leave from the user's own browser and IP: no Valuescan server sees them,
 * signs them, or can stall them, and SoDEX's per-IP budget is per user.
 *
 * NEVER RETRY A SIGNED WRITE. A request that got no answer (network drop,
 * timeout) may still have been executed by the engine. The error says so
 * (`outcomeUnknown`) and the caller must re-read open orders / positions
 * instead of sending again. Reads are safe to retry.
 */
import { SodexApiError, parseEnvelope } from '@sodex-core';
import { tradingConfig } from './config';
import { logger } from '../log';
import { gateway as exchangeGateway } from '../exchange/sodexGateway';

const log = logger('trade');

/** A signed write that did not come back: it may or may not have executed. */
export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
  readonly outcomeUnknown = true;
}

export interface SignedHttpRequest {
  method: 'POST' | 'DELETE';
  /** Gateway-relative, e.g. '/api/v1/perps/trade/orders'. */
  gatewayPath: string;
  headers: Record<string, string>;
  body: string;
}

const WRITE_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;

/**
 * Send one signed request and return the envelope's `data`. Throws
 * SodexApiError for a gateway rejection (with a hint), OutcomeUnknownError when
 * no answer arrived.
 */
export async function sendSigned<T = unknown>(req: SignedHttpRequest, what: string): Promise<T> {
  const { gateway } = tradingConfig();
  const url = gateway + req.gatewayPath;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WRITE_TIMEOUT_MS);
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch (e) {
    const timedOut = ctl.signal.aborted;
    log.error(`${what}: no answer from SoDEX - it may or may not have gone through`, {
      path: req.gatewayPath,
      timedOut,
      error: String(e),
    });
    throw new OutcomeUnknownError(
      timedOut
        ? `SoDEX did not answer within ${WRITE_TIMEOUT_MS / 1000}s. The ${what} may still have gone through - check your open orders and positions before trying again.`
        : `Could not reach SoDEX. The ${what} may still have gone through - check your open orders and positions before trying again.`,
    );
  } finally {
    clearTimeout(timer);
  }
  // Counted against this browser's per-IP budget (never delayed, never retried).
  exchangeGateway.chargeWrite(1);
  const text = await res.text().catch(() => '');
  const ms = Math.round(performance.now() - t0);
  // A server error or an unreadable answer is NOT a "no": the engine may have
  // executed the write before a proxy or the gateway failed. Treat it exactly
  // like no answer, so nobody is invited to send the same thing again.
  const unreadable = res.status < 400 && text.trim() !== '' && !/^[\[{]/.test(text.trim());
  if (res.status >= 500 || unreadable) {
    log.error(`${what}: unclear answer from SoDEX - it may or may not have gone through`, {
      path: req.gatewayPath,
      status: res.status,
      ms,
      body: text.slice(0, 200),
    });
    throw new OutcomeUnknownError(
      `SoDEX answered with an error (HTTP ${res.status}) after receiving the ${what}. It may still have gone through - check your open orders, positions and balances before trying again.`,
    );
  }
  try {
    const data = parseEnvelope<T>(res.status, text, req.gatewayPath);
    log.debug(`${what}: accepted`, { path: req.gatewayPath, status: res.status, ms });
    return data;
  } catch (e) {
    if (e instanceof SodexApiError) {
      log.warn(`${what}: rejected by SoDEX`, { path: req.gatewayPath, status: res.status, code: e.code, message: e.message, ms });
    } else {
      log.error(`${what}: unreadable answer from SoDEX`, { path: req.gatewayPath, status: res.status, ms, error: String(e) });
    }
    throw e;
  }
}

/**
 * An unsigned read straight from the gateway (public account/market data),
 * through the browser's exchange layer: the per-IP budget every tab shares,
 * dedupe of identical concurrent reads, and SoDEX's rate-limit cooldown.
 * `attempts` covers transient failures; a definite rejection is final.
 * `weight` books the path's real cost when it is not the table's default.
 */
export async function readGateway<T = unknown>(path: string, attempts = 2, weight?: number): Promise<T> {
  return exchangeGateway.get<T>(path, weight === undefined ? { attempts } : { attempts, weight });
}
