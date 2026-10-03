/**
 * LOCAL MODE's Host check (audit S-12: DNS rebinding).
 *
 * The local server answers GETs with no Origin and no token, and it binds to
 * loopback. A hostile page can still reach it: it serves its own hostname,
 * waits for the browser to cache the answer, then re-points that name's DNS at
 * 127.0.0.1. The browser now treats requests to the SERVER as same-origin with
 * the page, so CORS never applies and the page reads every local GET.
 *
 * What the attacker cannot change is the Host header. The browser sends the
 * hostname the page was loaded from - `evil.example:8797` - never a loopback
 * name, because a page on a loopback name is not the attacker's page. So the
 * check is on the header alone: local mode answers only when Host is
 * `127.0.0.1`, `localhost` or `[::1]` (any case, with or without a port).
 *
 * Why ANY port and not just the one this server listens on: the dev proxy
 * does not always rewrite Host. Vite's `/api` entry sets `changeOrigin` (the
 * server sees `127.0.0.1:<its own port>`), but its `/ws` entry does not, so a
 * WebSocket upgrade arrives with the browser's own `localhost:5180` or
 * `127.0.0.1:5180`; the perf preview proxy (apps/web/tools/perf) forwards
 * neither entry rewritten. Pinning the port would break the account stream
 * for the app's owner. A loopback NAME with a foreign port is something a
 * rebinding page cannot produce, so allowing it costs nothing.
 *
 * Deliberately NOT accepted: other addresses in 127.0.0.0/8, 0.0.0.0, a
 * trailing dot, `*.localhost`, an IPv6 spelling other than `[::1]`, a LAN
 * address. None is needed by a client that reaches this server today (the
 * Origin rule in origin.ts and the CORS list in index.ts already name only
 * localhost and the loopback addresses), and each is a wider door than the
 * problem needs.
 *
 * HOSTED MODE is never affected. It sits behind Caddy with the public Host
 * and has its own gate (hosted.ts); installLocalHostGate does nothing there.
 */
import type { FastifyInstance } from 'fastify';

/** 421 Misdirected Request: this server does not answer for that authority. */
export const LOCAL_HOST_REFUSED_STATUS = 421;

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;

/**
 * Whether a Host header names this machine the way a local client does:
 * `127.0.0.1`, `localhost` or `[::1]`, any case, optionally with a port in
 * 1..65535. Anything else - another name, a loopback name as a prefix of one
 * (`127.0.0.1.evil.example`), a name with userinfo or a path, an empty or
 * missing header - is not.
 */
export function isLocalHostHeader(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const m = LOCAL_HOST.exec(host);
  if (!m) return false;
  if (m[1] === undefined) return true;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

/** One log line per this many ms, however many requests a rebinding page fires. */
const LOG_EVERY_MS = 10_000;
/** What of an attacker-chosen header reaches the log. */
const LOGGED_HOST_CHARS = 100;

/**
 * Refuse every request - and WebSocket upgrade, which @fastify/websocket
 * dispatches through the same hooks - whose Host is not a local one.
 *
 * Install it FIRST, before CORS and the routes: nothing may answer, not even a
 * preflight, to a Host that is not ours. A no-op when `hosted` is true.
 *
 * The answer is 421, not 403, so that "wrong Host" is not mistaken for the
 * token and Origin refusals (403/401) the same server gives; it uses the
 * server's usual `{ error, source }` shape and never echoes the header back.
 *
 * `Connection: close` ends an ordinary connection after the answer. An upgrade
 * request is different: Node has handed its socket over (the 'upgrade' event)
 * and nothing is left to close it, so a refused WebSocket handshake would stay
 * half-open after the client hangs up - and hold up app.close() at shutdown.
 * @fastify/websocket destroys that socket in its own onResponse hook, but only
 * for a request ITS onRequest hook has seen, and this hook runs before it. So
 * the socket is destroyed here, once the 421 has been written.
 */
export function installLocalHostGate(app: FastifyInstance, hosted: boolean): void {
  if (hosted) return;
  let lastLogged = 0;
  let suppressed = 0;
  app.addHook('onRequest', async (req, reply) => {
    if (isLocalHostHeader(req.headers.host)) return;
    if (req.headers.upgrade) reply.raw.once('finish', () => req.raw.socket?.destroy());
    const now = Date.now();
    if (now - lastLogged >= LOG_EVERY_MS) {
      app.log.warn(
        { host: String(req.headers.host ?? '').slice(0, LOGGED_HOST_CHARS) || null, suppressed },
        'refused a request whose Host is not localhost, 127.0.0.1 or [::1] (DNS rebinding?)',
      );
      lastLogged = now;
      suppressed = 0;
    } else {
      suppressed++;
    }
    return reply
      .code(LOCAL_HOST_REFUSED_STATUS)
      .header('Connection', 'close')
      .send({
        error: 'host not allowed',
        source: 'server',
        hint: 'The local server answers only to localhost, 127.0.0.1 and [::1]. Open the app through one of those names.',
      });
  });
}
