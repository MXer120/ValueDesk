/**
 * A shared secret for the local API.
 *
 * WHAT THIS IS FOR. Binding to 127.0.0.1 keeps the network out, and the Origin
 * check keeps hostile *web pages* out. Neither keeps out another PROCESS on this
 * machine: loopback is open to every process, and a non-browser client simply
 * omits Origin. Until now that was an accepted gap, on the reasoning that
 * malware running as the user has already won.
 *
 * That reasoning is right about same-user malware and wrong about everything
 * else. Requiring a token that lives in a 0600 file outside the project closes:
 *
 *   - other user accounts on a shared machine;
 *   - sandboxed or containerised processes that can reach loopback but not this
 *     user's home directory;
 *   - anything that reaches the port after a misconfigured HOST bind;
 *   - a browser extension or page that finds a way past the Origin check, since
 *     the token is never exposed to page JavaScript (the Vite proxy injects it
 *     server-side, so an XSS in our own app still cannot read it).
 *
 * It does NOT stop malware running as this user, which can read the file. That
 * is an OS boundary, not one an application can draw. The defence that survives
 * that case is the permission mask on the resting key - see elevation.ts.
 *
 * Stored next to the device key, for the same reason: never inside the
 * OneDrive-synced project directory.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from './deviceKey.js';

export function localTokenPath(): string {
  const override = process.env.VALUETRADE_LOCAL_TOKEN_FILE?.trim();
  if (override) return override;
  return join(dirname(deviceKeyPath()), 'local-api.token');
}

let cached: string | null = null;

/** Load the token, creating it on first use. 64 hex chars. */
export function localToken(): string {
  if (cached) return cached;
  const path = localTokenPath();
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      cached = hex.toLowerCase();
      return cached;
    }
    // Malformed: mint a fresh one rather than refusing to start. Unlike the
    // device key, nothing is encrypted under this - rotating it costs nothing
    // beyond a dev-server restart.
  }
  mkdirSync(dirname(path), { recursive: true });
  const tok = randomBytes(32).toString('hex');
  writeFileSync(path, tok, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* no-op on Windows */
  }
  cached = tok;
  return tok;
}

/** Constant-time compare, so a wrong token leaks nothing through timing. */
export function tokenMatches(presented: string | undefined | null): boolean {
  if (!presented) return false;
  const expect = Buffer.from(localToken(), 'utf8');
  const got = Buffer.from(String(presented).trim().toLowerCase(), 'utf8');
  if (got.length !== expect.length) return false;
  return timingSafeEqual(got, expect);
}

export const LOCAL_TOKEN_HEADER = 'x-valuetrade-token';

/**
 * Enforcement can be turned off for a headless/CI setup that cannot read the
 * file. Off by default would defeat the point, so it is opt-out and loud.
 */
export const TOKEN_REQUIRED = process.env.VALUETRADE_REQUIRE_TOKEN?.trim() !== '0';
