'use strict';
// The Vercel Function behind /api/* (Node.js, region hnd1, Tokyo - next to the
// instance in ap-northeast-1): the edge in front of the Valuescan instance, as
// CloudFront is in deploy/aws/edge.yaml.
//
//   browser -> Vercel (/api/... routed here by deploy/vercel/package.mjs)
//           -> https://<origin>/api/...  with X-Origin-Verify and the viewer's address
//           -> Caddy (refuses anything without the secret) -> the hosted API on loopback,
//              or, for /api/copy/*, the copy executor on loopback
//
// WHAT IT DOES, AND WHAT IT LEAVES TO THE ORIGIN
//   - GET, HEAD and OPTIONS (CloudFront's AllowedMethods). POST as well, but only
//     under /api/copy/ - the copy executor's signed requests (apps/executor). Any
//     other method or path is a 405 here and never reaches the origin.
//   - A path with a dot segment, an encoded slash, backslash, dot or NUL is a 404
//     here: what this function judges is then the path the origin routes.
//   - Forwards the path and query unchanged, and only the request headers the
//     origin reads (Accept, Accept-Encoding, If-None-Match, If-Modified-Since,
//     Origin). No cookie, no user agent. Under /api/copy/ also Content-Type and
//     Authorization (a follower's read token, Bearer) - nowhere else.
//   - A POST's body is read here first (at most 64 KB, 413 above) and sent on with
//     its length; a body is never sent with any other method.
//   - Adds X-Origin-Verify (VALUESCAN_ORIGIN_SECRET, a Vercel environment variable
//     of the production environment only) and X-Forwarded-For: the viewer's address
//     as Vercel reports it (x-real-ip; Vercel overwrites these headers, a client
//     cannot set them). Caddy appends this function's own address, so the API, with
//     VALUESCAN_TRUST_PROXY=2 (Caddy, then this hop), keys its per-client limits on
//     the viewer - exactly as behind CloudFront.
//   - Under /api/copy/ also X-Viewer-Country: the viewer's country as Vercel's edge
//     reports it (x-vercel-ip-country, two letters, or nothing). The executor
//     applies the country rules by it (EXECUTOR_TRUST_EDGE=1). A client's own
//     X-Viewer-Country is never passed on: no header outside the lists above is.
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
//     /api/copy/* is NEVER cached: its answers belong to one follower. They go out
//     with Cache-Control: no-store (the executor's own value), and any CDN cache
//     header from the origin is dropped.
//   - An origin that does not answer (a stopped instance) is a 502 within about 10 s
//     (two connection attempts of 5 s, like CloudFront), never a hang; the web then
//     says the index is unavailable. No answer in 30 s: 504. Only a connection that
//     never stood is retried, so a POST reaches the origin at most once.
//   - Never logs the secret, a query string, a body or a header; an error line names
//     the path and the reason only.
//   - GET /api/edge/geo is answered HERE, never by the origin (so also in a preview, and
//     while the instance is down): the viewer's country and region as Vercel's edge
//     reports them - {"country":"DE","region":"BY"}, null where unknown - no-store. The
//     web reads it to apply the regional rules site-wide (apps/web/src/legal/geo.ts);
//     nothing is logged or stored.
//   - A viewer from a sanctioned country or region (VALUESCAN_GEO_BLOCK, written by
//     package.mjs from apps/web/src/legal/jurisdictions.mjs) gets 451 for every other
//     /api path - the routes already answer 451 before this function; this is the
//     second check.
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
/** The copy executor's paths (apps/executor, every route under /api/copy/v1/). */
const COPY_PREFIX = '/api/copy/';
const COPY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST']);
/** The executor's own limit (apps/executor/src/server.ts BODY_LIMIT). */
const BODY_LIMIT = 64 * 1024;
const BODY_TIMEOUT_MS = 10000;
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'origin',
  'access-control-request-method', 'access-control-request-headers'];
/** Only under /api/copy/: the signed request's type and a follower's read token. */
const COPY_REQUEST_HEADERS = ['content-type', 'authorization'];
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'server']);
/** Headers that could make a CDN keep an answer: never on /api/copy/*. */
const CDN_CACHE_HEADERS = new Set(['cdn-cache-control', 'vercel-cdn-cache-control', 'surrogate-control']);
const CONNECT_TIMEOUT_MS = 5000;
const CONNECT_ATTEMPTS = 2;
const READ_TIMEOUT_MS = 30000;
const EDGE_MAX_TTL_S = 60;
/** The function's own path: never forwarded (it is only ever reached through the /api rewrite). */
const SELF = '/api/__vs_proxy';
/** Answered here: where the viewer is, as Vercel's edge sees it. */
const GEO_PATH = '/api/edge/geo';

const isCopyPath = (path) => String(path ?? '').startsWith(COPY_PREFIX);

/** A path whose meaning could differ between this check and the origin's router. */
function oddPath(path) {
  if (/%(2e|2f|5c|00)/i.test(path)) return true;
  return path.split('/').some((seg, i, all) => seg === '.' || seg === '..' || (seg === '' && i > 0 && i < all.length - 1));
}

/** The viewer's address as Vercel reports it, or null. */
function viewerAddress(headers) {
  const candidates = [headers['x-real-ip'], headers['x-vercel-forwarded-for'], headers['x-forwarded-for']];
  for (const c of candidates) {
    const first = String(Array.isArray(c) ? c[0] : c ?? '').split(',')[0].trim();
    if (first && net.isIP(first)) return first;
  }
  return null;
}

/** The viewer's country as Vercel's edge reports it (x-vercel-ip-country), two capital letters, or null. */
function viewerCountry(headers) {
  const c = headers['x-vercel-ip-country'];
  const v = String(Array.isArray(c) ? c[0] : c ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** The viewer's first-level region (x-vercel-ip-country-region: ISO 3166-2 without the country), or null. */
function viewerRegion(headers) {
  const c = headers['x-vercel-ip-country-region'];
  const v = String(Array.isArray(c) ? c[0] : c ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(v) ? v : null;
}

/** The blocked places from the environment ({countries, regions}), or none. A broken value blocks nothing and says so. */
function geoBlockFrom(env) {
  const raw = String(env.VALUESCAN_GEO_BLOCK ?? '').trim();
  if (!raw) return { countries: [], regions: [] };
  try {
    const v = JSON.parse(raw);
    const countries = Array.isArray(v.countries) ? v.countries.filter((c) => /^[A-Z]{2}$/.test(c)) : [];
    const regions = Array.isArray(v.regions) ? v.regions.filter((r) => r && /^[A-Z]{2}$/.test(r.country) && /^[A-Z0-9]{1,3}$/.test(r.region)) : [];
    return { countries, regions };
  } catch {
    console.error('api-proxy: VALUESCAN_GEO_BLOCK is not JSON; no place is refused here (the routes still refuse them)');
    return { countries: [], regions: [] };
  }
}

/** Whether the viewer is in a blocked place. */
function geoBlocked(block, country, region) {
  if (!country) return false;
  if (block.countries.includes(country)) return true;
  return !!region && block.regions.some((r) => r.country === country && r.region === region);
}

/**
 * The edge cache rule for an origin answer: Vercel-CDN-Cache-Control or null.
 * Mirrors edge.yaml ApiCachePolicy: honour the origin's public max-age, at most 60 s.
 * Never for the copy executor's paths.
 */
function edgeCacheControl(method, status, cacheControl, path) {
  if (isCopyPath(path)) return null;
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

/**
 * The request body, at most `limit` bytes. Rejects with code TOO_LARGE (the rest is
 * read and dropped, so the answer reaches the client), BODY_TIMEOUT or the stream's error.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => done(reject, Object.assign(new Error('body timeout'), { code: 'BODY_TIMEOUT' })), BODY_TIMEOUT_MS);
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) done(reject, Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
      else done(resolve, Buffer.concat(chunks));
    });
    req.on('error', (e) => done(reject, e));
  });
}

/** One request to the origin; resolves with the response, rejects with a reason. */
function ask(origin, method, path, headers, body) {
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
    req.end(body);
  });
}

async function handler(req, res) {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = String(req.url ?? '');
  const path = url.split('?')[0];
  if (!url.startsWith('/api/') || url.length > 4096 || url.includes('\\') || path === SELF || oddPath(path)) {
    return sendJson(res, 404, { error: 'not found', source: 'edge' });
  }
  const country = viewerCountry(req.headers);
  const region = viewerRegion(req.headers);
  if (path === GEO_PATH) {
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed', source: 'edge' }, { allow: 'GET, HEAD' });
    return sendJson(res, 200, { country, region });
  }
  if (geoBlocked(geoBlockFrom(process.env), country, region)) {
    return sendJson(res, 451, { error: 'ValueDesk is not available in your country or region: the sanctions and legal restrictions that apply there do not allow us to offer it.', code: 'region', source: 'edge' });
  }
  const copy = isCopyPath(path);
  const methods = copy ? COPY_METHODS : ALLOWED_METHODS;
  if (!methods.has(method)) {
    return sendJson(res, 405, { error: 'method not allowed', source: 'edge' }, { allow: [...methods].join(', ') });
  }
  const origin = originFrom(process.env);
  const secret = String(process.env.VALUESCAN_ORIGIN_SECRET ?? '').split(',')[0].trim();
  if (origin.error || secret.length < 32) {
    // A preview deployment (the secret is a production-only variable) or a missing setting.
    console.error(`api-proxy: not configured (${origin.error ?? 'VALUESCAN_ORIGIN_SECRET is not set for this environment'})`);
    return sendJson(res, 503, { error: 'the index API is not configured for this deployment', source: 'edge' });
  }

  let body;
  if (method === 'POST') {
    try {
      body = await readBody(req, BODY_LIMIT);
    } catch (e) {
      if (e.code === 'TOO_LARGE') return sendJson(res, 413, { error: 'the request is too large', source: 'edge' });
      console.error(`api-proxy: ${method} ${path}: the request body could not be read (${e.code ?? 'error'})`);
      return sendJson(res, e.code === 'BODY_TIMEOUT' ? 408 : 400, { error: 'the request body could not be read', source: 'edge' });
    }
  }

  const headers = { 'x-origin-verify': secret, 'x-forwarded-proto': 'https' };
  for (const name of copy ? [...FORWARDED_REQUEST_HEADERS, ...COPY_REQUEST_HEADERS] : FORWARDED_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (v !== undefined) headers[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  const viewer = viewerAddress(req.headers);
  if (viewer) headers['x-forwarded-for'] = viewer;
  if (copy && country) headers['x-viewer-country'] = country;
  if (body !== undefined) headers['content-length'] = String(body.length);

  let upstream;
  for (let attempt = 1; ; attempt++) {
    try {
      upstream = (await ask(origin.url, method, url, headers, body)).res;
      break;
    } catch (e) {
      // Only a connection that never stood is retried: a request may have reached the origin otherwise.
      if (!e.connected && attempt < CONNECT_ATTEMPTS) continue;
      const code = e.code ?? 'error';
      console.error(`api-proxy: ${method} ${path} failed: ${code}`);
      const timeout = code === 'READ_TIMEOUT';
      const what = copy ? 'the copy executor' : 'the index API';
      return sendJson(res, timeout ? 504 : 502, { error: timeout ? `${what} did not answer in time` : `${what} is not reachable`, source: 'edge' });
    }
  }

  const out = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (copy && CDN_CACHE_HEADERS.has(lower)) continue;
    out[name] = value;
  }
  if (copy) {
    // One follower's answers: never kept by the CDN, nor by the browser.
    for (const k of Object.keys(out)) if (k.toLowerCase() === 'cache-control') delete out[k];
    out['cache-control'] = 'no-store';
  } else {
    const edge = edgeCacheControl(method, upstream.statusCode, upstream.headers['cache-control'], path);
    if (edge) out['vercel-cdn-cache-control'] = edge;
  }
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
module.exports.viewerCountry = viewerCountry;
module.exports.viewerRegion = viewerRegion;
module.exports.geoBlockFrom = geoBlockFrom;
module.exports.geoBlocked = geoBlocked;
module.exports.edgeCacheControl = edgeCacheControl;
module.exports.originFrom = originFrom;
module.exports.oddPath = oddPath;
module.exports.BODY_LIMIT = BODY_LIMIT;
