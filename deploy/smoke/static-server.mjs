#!/usr/bin/env node
// A tiny stand-in for the production edge (CloudFront + the site bucket), for the
// local smoke test. It serves a built site with EXACTLY the response headers of
// deploy/aws/edge.yaml (deploy/smoke/prod-headers.mjs) and forwards /api/* to a
// hosted-mode server with the origin secret, the way CloudFront does.
//
//   node deploy/smoke/static-server.mjs --dist <dir> [--port 4280] [--api http://127.0.0.1:8890]
//
// The origin secret for --api is read from the environment variable
// SMOKE_ORIGIN_SECRET (never from the command line).
//
// WHAT IT COPIES FROM THE EDGE
//   - the per-path policies: site, /scan/* (script hash), /logos/* and /addrbook/* (images)
//   - Cache-Control as the publish script sets it on the objects
//   - the SPA rewrite of the CloudFront function (a path without a dot gets the shell)
//   - a missing file is a 403, as from a private bucket - never the shell
//   - /api/*: GET, HEAD and OPTIONS only; X-Origin-Verify added; the viewer's
//     address appended to X-Forwarded-For; the API's own headers left alone, HSTS
//     added only when it sent none
//   - no API configured: 503, the way a stopped instance looks through CloudFront
//
// WHAT IT DOES NOT COPY: TLS, compression, edge caching, WAF.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HEADERS, headersFor, rewrite } from './prod-headers.mjs';

/** Content types exactly as deploy/release/publish-web.sh stores them on the objects. */
export const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const ACCESS_DENIED = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';

/**
 * @param {{ dist: string, port: number, host?: string, api?: { target: string, secret: string } | null }} o
 * @returns {Promise<{ url: string, requests: Array<object>, close(): Promise<void> }>}
 */
export function startStaticServer({ dist, port, host = '127.0.0.1', api = null }) {
  const root = resolve(dist);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${root} has no index.html`);
  const requests = [];
  const target = api ? new URL(api.target) : null;

  const record = (req, status, kind, extra = {}) => requests.push({ t: Date.now(), method: req.method, path: req.url, status, kind, ...extra });

  function serveSite(req, res, pathname) {
    const headers = headersFor(pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('This distribution is not configured to allow the HTTP request that was used.');
      return record(req, 403, 'site');
    }
    const object = rewrite(pathname);
    // Inside the build directory, whatever the path says.
    const file = normalize(join(root, decodeURIComponent(object)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(400, { ...headers, 'Cache-Control': 'no-store' });
      res.end();
      return record(req, 400, 'site');
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // A private bucket without s3:ListBucket answers a missing key with 403.
      res.writeHead(403, { ...headers, 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : ACCESS_DENIED);
      return record(req, 403, 'site', { object });
    }
    const type = CONTENT_TYPES[extname(file).slice(1).toLowerCase()];
    if (!type) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`no content type for ${object}: the publish script would refuse this build`);
      return record(req, 500, 'site', { object });
    }
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': statSync(file).size });
    record(req, 200, 'site', { object });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  function serveApi(req, res) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('This distribution is not configured to allow the HTTP request that was used.');
      return record(req, 403, 'api', { blockedBy: 'edge' });
    }
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Strict-Transport-Security': HEADERS['Strict-Transport-Security'] });
      res.end(JSON.stringify({ error: 'no index API in this smoke run', source: 'smoke' }));
      return record(req, 503, 'api', { blockedBy: 'no-api' });
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    const viewer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${viewer}` : viewer;
    headers['x-origin-verify'] = api.secret;
    headers.host = target.host;
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers, timeout: 30_000 },
      (up) => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && k !== 'server') out[k] = v;
        if (!out['strict-transport-security']) out['strict-transport-security'] = HEADERS['Strict-Transport-Security'];
        res.writeHead(up.statusCode ?? 502, out);
        record(req, up.statusCode ?? 502, 'api', { cacheControl: up.headers['cache-control'] ?? null, encoding: up.headers['content-encoding'] ?? null });
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('origin timeout')));
    upstream.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'the origin did not answer', source: 'smoke' }));
      record(req, 502, 'api', { blockedBy: 'origin-down', error: String(e.message) });
    });
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (pathname.startsWith('/api/')) return serveApi(req, res);
    return serveSite(req, res, pathname);
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      ok({
        url: `http://${host}:${port}`,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

// Run directly: serve until interrupted.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const dist = arg('dist');
  if (!dist) {
    console.error('usage: node deploy/smoke/static-server.mjs --dist <dir> [--port 4280] [--api http://127.0.0.1:8890]   (secret: SMOKE_ORIGIN_SECRET)');
    process.exit(2);
  }
  const apiTarget = arg('api');
  const secret = process.env.SMOKE_ORIGIN_SECRET ?? '';
  if (apiTarget && secret.length < 32) {
    console.error('SMOKE_ORIGIN_SECRET must hold the origin secret (32+ characters) when --api is used');
    process.exit(2);
  }
  const s = await startStaticServer({ dist, port: Number(arg('port', '4280')), api: apiTarget ? { target: apiTarget, secret } : null });
  console.log(`serving ${resolve(dist)} with the production headers on ${s.url}${apiTarget ? `, /api -> ${apiTarget}` : ' (no API: /api answers 503)'}`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
