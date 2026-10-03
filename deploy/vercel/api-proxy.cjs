'use strict';
// The Vercel Function behind /api/* (Node.js, region fra1): the edge in front of the
// Valuescan instance, as CloudFront is in deploy/aws/edge.yaml.
//
//   browser -> Vercel (/api/... routed here by deploy/vercel/package.mjs)
//           -> https://<origin>/api/...  with X-Origin-Verify and the viewer's address
//           -> Caddy (refuses anything without the secret) -> the hosted API on loopback
//
// WHAT IT DOES, AND WHAT IT LEAVES TO THE API
//   - GET, HEAD and OPTIONS only (CloudFront's AllowedMethods); anything else is a
//     405 here and never reaches the origin.
//   - Forwards the path and query unchanged, and only the request headers the API
//     reads (Accept, Accept-Encoding, If-None-Match, If-Modified-Since, Origin). No
//     cookie, no Authorization, no user agent: the API needs none of them.
//   - Adds X-Origin-Verify (VALUESCAN_ORIGIN_SECRET, a Vercel environment variable
//     of the production environment only) and X-Forwarded-For: the viewer's address
//     as Vercel reports it (x-real-ip; Vercel overwrites these headers, a client
//     cannot set them). Caddy appends this function's own address, so the API, with
//     VALUESCAN_TRUST_PROXY=2 (Caddy, then this hop), keys its per-client limits on
//     the viewer - exactly as behind CloudFront.
//   - Streams the answer back byte for byte: status, Content-Encoding (the API
//     compresses), ETag, Cache-Control, Vary - minus hop-by-hop headers and any
//     Set-Cookie.
//   - Caching: the API decides (apps/server/src/perf.ts). Vercel's CDN only caches a
//     function's answer when told so in s-maxage or a CDN-Cache-Control header, and
//     the API sends neither, so this function translates, the way CloudFront's API
//     cache policy (edge.yaml ApiCachePolicy) reads the same header: a 200 that is
//     `public, max-age=N` may be kept at the edge N seconds (at most 60), with the
//     API's stale-while-revalidate (at most 60), through Vercel-CDN-Cache-Control,
//     which Vercel never passes on. The browser keeps the API's own Cache-Control.
//   - An origin that does not answer (a stopped instance) is a 502 within about 10 s
//     (two connection attempts of 5 s, like CloudFront), never a hang; the web then
//     says the index is unavailable. No answer in 30 s: 504.
//   - Never logs the secret, a query string or a header; an error line names the
//     path and the reason only.
//
// Configuration (deploy/vercel/package.mjs writes the first into the function's
// .vc-config.json; the second is set with `vercel env add ... production --sensitive`):
//   VALUESCAN_ORIGIN_URL     https://<origin name>  (https only; http only to loopback, for tests)
//   VALUESCAN_ORIGIN_SECRET  the value Caddy and the API accept; a "current,next" list
//                            is never expected here, but if given the first is sent
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'origin',
  'access-control-request-method', 'access-control-request-headers'];
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'server']);
const CONNECT_TIMEOUT_MS = 5000;
const CONNECT_ATTEMPTS = 2;
const READ_TIMEOUT_MS = 30000;
const EDGE_MAX_TTL_S = 60;
/** The function's own path: never forwarded (it is only ever reached through the /api rewrite). */
const SELF = '/api/__vs_proxy';

/** The viewer's address as Vercel reports it, or null. */
function viewerAddress(headers) {
  const candidates = [headers['x-real-ip'], headers['x-vercel-forwarded-for'], headers['x-forwarded-for']];
  for (const c of candidates) {
    const first = String(Array.isArray(c) ? c[0] : c ?? '').split(',')[0].trim();
    if (first && net.isIP(first)) return first;
  }
  return null;
}

/**
 * The edge cache rule for an origin answer: Vercel-CDN-Cache-Control or null.
 * Mirrors edge.yaml ApiCachePolicy: honour the origin's public max-age, at most 60 s.
 */
function edgeCacheControl(method, status, cacheControl) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (status !== 200) return null;
  const cc = String(cacheControl ?? '').toLowerCase();
  if (!/(^|,)\s*public\s*(,|$)/.test(cc)) return null;
  if (/(^|,)\s*(no-store|no-cache|private)\s*(,|=|$)/.test(cc)) return null;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(cc);
  if (!maxAge || Number(maxAge[1]) <= 0) return null;
  const parts = [`max-age=${Math.min(Number(maxAge[1]), EDGE_MAX_TTL_S)}`];
  const swr = /(?:^|,)\s*stale-while-revalidate\s*=\s*(\d+)/.exec(cc);
  if (swr && Number(swr[1]) > 0) parts.push(`stale-while-revalidate=${Math.min(Number(swr[1]), EDGE_MAX_TTL_S)}`);
  return parts.join(', ');
}

/** The origin URL from the environment, or an error text. */
function originFrom(env) {
  const raw = String(env.VALUESCAN_ORIGIN_URL ?? '').trim().replace(/\/+$/, '');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'VALUESCAN_ORIGIN_URL is not set to a URL' };
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return { error: 'VALUESCAN_ORIGIN_URL must be https' };
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return { error: 'VALUESCAN_ORIGIN_URL must be an origin, nothing after the host' };
  return { url: u };
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

/** One request to the origin; resolves with the response, rejects with a reason. */
function ask(origin, method, path, headers) {
  return new Promise((resolve, reject) => {
    const client = origin.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: origin.protocol,
      hostname: origin.hostname.replace(/^\[|\]$/g, ''),
      port: origin.port || undefined,
      servername: net.isIP(origin.hostname) ? undefined : origin.hostname,
      method,
      path,
      headers,
      agent: false,
    });
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) req.destroy(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }));
    }, CONNECT_TIMEOUT_MS);
    req.on('socket', (socket) => {
      const done = () => { connected = true; clearTimeout(connectTimer); };
      if (!socket.connecting) done();
      else socket.once(origin.protocol === 'https:' ? 'secureConnect' : 'connect', done);
    });
    req.setTimeout(READ_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('read timeout'), { code: 'READ_TIMEOUT' })));
    req.on('response', (r) => { clearTimeout(connectTimer); resolve({ res: r, connected: true }); });
    req.on('error', (e) => { clearTimeout(connectTimer); reject(Object.assign(e, { connected })); });
    req.end();
  });
}

async function handler(req, res) {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = String(req.url ?? '');
  const path = url.split('?')[0];
  if (!url.startsWith('/api/') || url.length > 4096 || url.includes('\\') || path === SELF) {
    return sendJson(res, 404, { error: 'not found', source: 'edge' });
  }
  if (!ALLOWED_METHODS.has(method)) {
    return sendJson(res, 405, { error: 'method not allowed', source: 'edge' }, { allow: 'GET, HEAD, OPTIONS' });
  }
  const origin = originFrom(process.env);
  const secret = String(process.env.VALUESCAN_ORIGIN_SECRET ?? '').split(',')[0].trim();
  if (origin.error || secret.length < 32) {
    // A preview deployment (the secret is a production-only variable) or a missing setting.
    console.error(`api-proxy: not configured (${origin.error ?? 'VALUESCAN_ORIGIN_SECRET is not set for this environment'})`);
    return sendJson(res, 503, { error: 'the index API is not configured for this deployment', source: 'edge' });
  }

  const headers = { 'x-origin-verify': secret, 'x-forwarded-proto': 'https' };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (v !== undefined) headers[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  const viewer = viewerAddress(req.headers);
  if (viewer) headers['x-forwarded-for'] = viewer;

  let upstream;
  for (let attempt = 1; ; attempt++) {
    try {
      upstream = (await ask(origin.url, method, url, headers)).res;
      break;
    } catch (e) {
      // Only a connection that never stood is retried: a request may have reached the API otherwise.
      if (!e.connected && attempt < CONNECT_ATTEMPTS) continue;
      const code = e.code ?? 'error';
      console.error(`api-proxy: ${method} ${path} failed: ${code}`);
      const timeout = code === 'READ_TIMEOUT';
      return sendJson(res, timeout ? 504 : 502, { error: timeout ? 'the index API did not answer in time' : 'the index API is not reachable', source: 'edge' });
    }
  }

  const out = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  const edge = edgeCacheControl(method, upstream.statusCode, upstream.headers['cache-control']);
  if (edge) out['vercel-cdn-cache-control'] = edge;
  res.writeHead(upstream.statusCode ?? 502, out);
  if (method === 'HEAD') {
    upstream.resume();
    res.end();
    return;
  }
  upstream.on('error', () => res.destroy());
  upstream.pipe(res);
}

module.exports = handler;
module.exports.default = handler;
// For the tests (deploy/vercel/vercel.test.mjs).
module.exports.viewerAddress = viewerAddress;
module.exports.edgeCacheControl = edgeCacheControl;
module.exports.originFrom = originFrom;
