// `vite preview` config for measurements: serves ONE built dist on a port of its own
// and forwards /api (and /ws) to a running ValueDesk API. Nothing is built with it.
//
//   DIST=<abs dist dir> PORT=4180 [API=http://127.0.0.1:5180] [ACCESS_LOG=<file>] \
//     npx vite preview --config tools/perf/preview.config.mjs
//
// API defaults to the dev server (:5180), not the backend: in local mode the backend
// only answers requests that carry its local API token, and the dev server's proxy
// is what adds it. The dev server adds the token for its own app and for native
// clients only (audit W-04), so this proxy forwards like a native client - no
// Origin, no Sec-Fetch-Site. Against a hosted-mode server (no token) point API at it.
//
// ACCESS_LOG: one JSON line per /api answer as it left the API -
// {t, method, url, status, bytes, revalidated} - which is what rates.mjs counts as
// "requests that reached our server" (the browser's own view also holds cache hits).
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const dist = process.env.DIST;
if (!dist) throw new Error('DIST=<absolute dist directory> is required');
const api = process.env.API || 'http://127.0.0.1:5180';
const accessLog = process.env.ACCESS_LOG || '';

function configureApi(proxy) {
  proxy.on('proxyReq', (req) => { req.removeHeader('origin'); req.removeHeader('sec-fetch-site'); });
  if (!accessLog) return;
  proxy.on('proxyRes', (proxyRes, req) => {
    let bytes = 0;
    proxyRes.on('data', (chunk) => { bytes += chunk.length; });
    proxyRes.on('end', () => {
      const line = { t: Date.now(), method: req.method, url: req.url, status: proxyRes.statusCode, bytes, revalidated: Boolean(req.headers['if-none-match']) };
      try { appendFileSync(accessLog, JSON.stringify(line) + '\n'); } catch { /* a measurement aid; never fail a request over it */ }
    });
  });
}

export default {
  root: dirname(dist),
  build: { outDir: dist },
  logLevel: 'warn',
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.PORT || 4180),
    strictPort: true,
    // What production sends with the site (docs/deploy/SECURITY-HEADERS.md), minus the
    // CSP's connect-src: the page's own <meta> policy carries that.
    headers: {
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    proxy: {
      '/api': { target: api, configure: configureApi },
      '/ws': {
        target: api.replace(/^http/, 'ws'),
        ws: true,
        configure: (proxy) => proxy.on('proxyReqWs', (req) => { req.removeHeader('origin'); req.removeHeader('sec-fetch-site'); }),
      },
    },
  },
};
