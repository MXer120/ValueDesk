/**
 * Which proxied requests the dev/preview server may add the local API token to
 * (vite.config.ts). Node-side only: the app never imports this.
 *
 * ONLY THE APP'S OWN (security audit W-04). The backend accepts any loopback
 * Origin, so adding the token to EVERY proxied request handed token-backed
 * writes and the account stream to any page on another loopback port that
 * could reach the proxy: a second dev server, a local tool with an XSS. The
 * token now goes only to requests that:
 *   - carry this server's own origin (http, a loopback host, one of its ports),
 *     which every POST and WebSocket from the app does; or
 *   - carry no Origin at all, which is what the app's same-origin GETs look
 *     like and what native clients (curl, the e2e tools) send - unless
 *     Sec-Fetch-Site says a browser sent it from another site (the no-cors
 *     requests of an <img> or a <script> on someone else's page).
 */

/** The request headers this needs (a subset of Node's IncomingHttpHeaders). */
export interface OriginHeaders {
  origin?: string | string[];
  'sec-fetch-site'?: string | string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function fromAppOrigin(headers: OriginHeaders, ports: ReadonlySet<number>): boolean {
  const origin = headers.origin;
  if (origin === undefined) {
    const site = headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }
  if (Array.isArray(origin)) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, file://) and anything malformed
  }
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname) && ports.has(Number(u.port || 80));
}
