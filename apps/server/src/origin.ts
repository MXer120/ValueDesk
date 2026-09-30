/**
 * Origin allow-listing for a loopback-only server.
 *
 * WebSocket upgrades are NOT covered by CORS: a browser will happily open a
 * socket to 127.0.0.1 from any origin, and the page on the other end could then
 * read this user's account stream. CORS also does not *prevent* a cross-origin
 * POST from executing - it only stops the response being read - and for a signed
 * trading action the side effect is the whole problem.
 *
 * A missing Origin is allowed: native clients (curl, the sodex CLI, test
 * scripts) omit it, and they can reach loopback regardless. The threat being
 * closed off is a malicious *web page*, and browsers always attach an Origin.
 *
 * Note this parses the URL rather than substring-matching, so
 * `http://localhost.evil.example` is correctly rejected.
 */
export function isAllowedOrigin(origin: string | undefined | null, extra: readonly string[] = []): boolean {
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  // A hosted deployment's own site(s), by exact origin (VALUETRADE_ALLOWED_ORIGINS).
  return extra.some((e) => {
    try {
      return new URL(e).origin === u.origin;
    } catch {
      return false;
    }
  });
}

/**
 * The serialized origin of `value` (`https://app.example`), or null when it is
 * not an http(s) origin with nothing after the host. Used to normalise the
 * configured site origins once, so that matching is exact string equality -
 * the same comparison @fastify/cors makes against the request's Origin header.
 */
export function normaliseOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  return u.origin;
}

/**
 * HOSTED MODE's origin rule: the request must name one of the site's own
 * origins, exactly. Unlike `isAllowedOrigin` there is no loopback allowance and
 * a missing Origin is refused - on a public server the only legitimate caller
 * of a state-changing route is the site's own page, and a browser always sends
 * Origin with a POST.
 */
export function isSiteOrigin(origin: string | undefined | null, site: readonly string[]): boolean {
  if (!origin) return false;
  const o = normaliseOrigin(origin);
  return o !== null && site.includes(o);
}
