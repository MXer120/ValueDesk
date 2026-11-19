// Serves one built dist like Vercel does: brotli for text, immutable /assets/, SPA fallback.
// /api and /ws go to the prod-mode dev server (it adds production's origin).
//   DIST=<dir> PORT=4193 API=127.0.0.1:5193 node tools/perf/serve-br.mjs
import http from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const DIST = process.env.DIST;
const PORT = Number(process.env.PORT || 4193);
const [AH, AP] = (process.env.API || '127.0.0.1:5193').split(':');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.avif': 'image/avif', '.mp4': 'video/mp4' };
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.ico', '.wasm']);
const cache = new Map();

function file(p) {
  let f = join(DIST, normalize(decodeURIComponent(p)).replace(/^([/\\])+/, ''));
  if (!f.startsWith(normalize(DIST))) return null;
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) {
    if (extname(p)) return null;
    f = join(DIST, 'index.html');
  }
  return f;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const out = http.request({ host: AH, port: AP, path: req.url, method: req.method, headers: { ...req.headers, host: `${AH}:${AP}` } }, (pr) => { res.writeHead(pr.statusCode ?? 502, pr.headers); pr.pipe(res); });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(out);
    return;
  }
  const f = file(url.pathname);
  if (!f) { res.writeHead(404); return res.end(); }
  const ext = extname(f);
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate' };
  let body = readFileSync(f);
  if (TEXT.has(ext) && /\bbr\b/.test(String(req.headers['accept-encoding'] || ''))) {
    let c = cache.get(f);
    if (!c) { c = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }); cache.set(f, c); }
    body = c;
    headers['Content-Encoding'] = 'br';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}).on('upgrade', (req, sock, head) => {
  const up = net.connect(Number(AP), AH, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: `${AH}:${AP}` }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${DIST} on ${PORT}`));
